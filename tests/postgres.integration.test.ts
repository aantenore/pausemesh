import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sha256TokenIssuer } from "../src/adapters/crypto/sha256-token-issuer.js";
import { ContinuationService } from "../src/application/continuation-service.js";
import type { ContinuationCreatedV1, ContinuationResumedV1 } from "../src/domain/events.js";
import { NoopObserver } from "../src/observability/pino-observer.js";
import {
  migratePostgresEventStore,
  PostgresEventStore,
  type PostgresPoolLike,
} from "../src/postgres.js";

const connectionString = process.env.PAUSEMESH_TEST_POSTGRES_URL;
if (process.env.PAUSEMESH_REQUIRE_POSTGRES_TEST === "1" && connectionString === undefined) {
  throw new Error("PAUSEMESH_TEST_POSTGRES_URL is required for the PostgreSQL CI integration test");
}

const describeWithPostgres = connectionString === undefined ? describe.skip : describe;

describeWithPostgres("PostgresEventStore real multi-replica integration", () => {
  const schema = `pausemesh_test_${randomUUID().replaceAll("-", "_")}`;
  const activePools = new Set<Pool>();
  const idleErrors: Error[] = [];
  let firstPool: Pool;
  let secondPool: Pool;

  function openPool(): Pool {
    if (connectionString === undefined) throw new Error("PostgreSQL test URL is unavailable");
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 4,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    pool.on("error", (error) => idleErrors.push(error));
    activePools.add(pool);
    return pool;
  }

  async function closePool(pool: Pool): Promise<void> {
    if (activePools.delete(pool)) await pool.end();
  }

  function asPoolLike(pool: Pool): PostgresPoolLike {
    return pool;
  }

  function service(eventStore: PostgresEventStore): ContinuationService {
    return new ContinuationService({
      clock: { now: () => new Date("2026-07-19T08:00:00.000Z") },
      eventStore,
      observer: new NoopObserver(),
      tokenIssuer: new Sha256TokenIssuer(),
      tokenTtlSeconds: 900,
    });
  }

  function directCreatedEvent(continuationId: string): ContinuationCreatedV1 {
    return {
      type: "continuation.created",
      schemaVersion: 1,
      continuationId,
      correlationId: `correlation-${continuationId}`,
      version: 1,
      occurredAt: "2026-07-19T08:00:00.000Z",
      expiresAt: "2026-07-19T08:15:00.000Z",
      payload: { action: "choose" },
      metadata: {},
      resumeTokenHash: "b".repeat(64),
    };
  }

  function directResumedEvent(
    continuationId: string,
    idempotencyKey: string,
  ): ContinuationResumedV1 {
    return {
      type: "continuation.resumed",
      schemaVersion: 1,
      continuationId,
      version: 2,
      occurredAt: "2026-07-19T08:01:00.000Z",
      idempotencyKey,
      resumePayload: { winner: idempotencyKey },
    };
  }

  beforeAll(() => {
    firstPool = openPool();
    secondPool = openPool();
  });

  afterAll(async () => {
    const cleanupPool = [...activePools][0];
    if (cleanupPool !== undefined) {
      await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await Promise.all([...activePools].map((pool) => closePool(pool)));
    expect(idleErrors).toEqual([]);
  });

  it("migrates concurrently and preserves CAS, idempotency, restart replay, and append-only data", async () => {
    await Promise.all([
      migratePostgresEventStore(asPoolLike(firstPool), { schema }),
      migratePostgresEventStore(asPoolLike(secondPool), { schema }),
    ]);
    // Explicit reruns validate the same version and checksum without replaying DDL.
    await migratePostgresEventStore(asPoolLike(firstPool), { schema });

    const firstStore = new PostgresEventStore(asPoolLike(firstPool), { schema });
    const secondStore = new PostgresEventStore(asPoolLike(secondPool), { schema });
    await expect(firstStore.checkReadiness()).resolves.toBeUndefined();
    await expect(secondStore.checkReadiness()).resolves.toBeUndefined();

    const directId = "postgres-direct-cas";
    await firstStore.append(directId, 0, [directCreatedEvent(directId)]);
    const directOutcomes = await Promise.allSettled([
      firstStore.append(directId, 1, [directResumedEvent(directId, "replica-a")]),
      secondStore.append(directId, 1, [directResumedEvent(directId, "replica-b")]),
    ]);
    expect(directOutcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const directLoser = directOutcomes.find((outcome) => outcome.status === "rejected");
    expect(directLoser?.reason).toMatchObject({
      code: "VERSION_CONFLICT",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(await secondStore.load(directId)).toHaveLength(2);

    const firstService = service(firstStore);
    const secondService = service(secondStore);
    const continuationId = "postgres-service-multireplica";
    const created = await firstService.create({
      continuationId,
      correlationId: "thread-postgres-integration",
      payload: { kind: "input", message: "Choose" },
    });
    await expect(secondService.inspect(continuationId)).resolves.toMatchObject({
      status: "pending",
      version: 1,
    });

    const resumeInputs = [
      {
        continuationId,
        idempotencyKey: "resume-from-a",
        resumePayload: { choice: "a" },
        resumeToken: created.resumeToken,
      },
      {
        continuationId,
        idempotencyKey: "resume-from-b",
        resumePayload: { choice: "b" },
        resumeToken: created.resumeToken,
      },
    ] as const;
    const outcomes = await Promise.allSettled([
      firstService.resume(resumeInputs[0]),
      secondService.resume(resumeInputs[1]),
    ]);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")?.reason).toMatchObject({
      code: "TOKEN_ALREADY_USED",
    });

    const winner = outcomes[winnerIndex];
    if (winner?.status !== "fulfilled") throw new Error("Expected one successful resume");
    const oppositeService = winnerIndex === 0 ? secondService : firstService;
    const winningInput = resumeInputs[winnerIndex];
    if (winningInput === undefined) throw new Error("Expected a winning resume input");
    await expect(oppositeService.resume(winningInput)).resolves.toEqual(winner.value);
    await expect(
      oppositeService.resume({ ...winningInput, resumePayload: { choice: "changed" } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await firstService.history(continuationId)).toHaveLength(2);

    await expect(
      firstPool.query(
        `UPDATE "${schema}"."continuation_events" SET event_json = event_json WHERE continuation_id = $1`,
        [continuationId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    expect(await secondService.history(continuationId)).toHaveLength(2);

    await closePool(firstPool);
    await closePool(secondPool);
    const restartedPool = openPool();
    const restartedStore = new PostgresEventStore(asPoolLike(restartedPool), { schema });
    await expect(restartedStore.checkReadiness()).resolves.toBeUndefined();
    await expect(service(restartedStore).inspect(continuationId)).resolves.toEqual(winner.value);
  });
});
