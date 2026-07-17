import { describe, expect, it } from "vitest";
import { Sha256TokenIssuer } from "../src/adapters/crypto/sha256-token-issuer.js";
import { InMemoryEventStore } from "../src/adapters/storage/index.js";
import { ContinuationService } from "../src/application/index.js";
import {
  ContinuationCancelledError,
  type ContinuationEventV1,
  ContinuationExpiredError,
  type ContinuationId,
  type ContinuationVersion,
  IdempotencyConflictError,
  InvalidTransitionError,
  TokenAlreadyUsedError,
  TokenMismatchError,
  VersionConflictError,
} from "../src/domain/index.js";
import type { Clock, ContinuationObservation, EventStore, Observer } from "../src/ports/index.js";

class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class RecordingObserver implements Observer {
  readonly events: ContinuationObservation[] = [];

  observe(event: ContinuationObservation): void {
    this.events.push(event);
  }
}

class CancellationInterceptingStore implements EventStore {
  readonly inner = new InMemoryEventStore();
  beforeCancellation: (() => Promise<void>) | undefined;

  load(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]> {
    return this.inner.load(continuationId);
  }

  async append(
    continuationId: ContinuationId,
    expectedVersion: ContinuationVersion,
    events: readonly ContinuationEventV1[],
  ): Promise<void> {
    if (events.some((event) => event.type === "continuation.cancelled")) {
      const intercept = this.beforeCancellation;
      this.beforeCancellation = undefined;
      await intercept?.();
    }
    await this.inner.append(continuationId, expectedVersion, events);
  }
}

function harness() {
  const clock = new FakeClock(new Date("2026-07-15T08:00:00.000Z"));
  const observer = new RecordingObserver();
  const eventStore = new InMemoryEventStore();
  const service = new ContinuationService({
    clock,
    eventStore,
    generateId: (() => {
      let next = 0;
      return () => `generated-${++next}`;
    })(),
    observer,
    tokenIssuer: new Sha256TokenIssuer(),
    tokenTtlSeconds: 60,
  });
  return { clock, eventStore, observer, service };
}

describe("ContinuationService", () => {
  it("creates and resumes a continuation while persisting only the token hash", async () => {
    const { eventStore, service } = harness();
    const created = await service.create({
      continuationId: "cont-1",
      correlationId: "thread-1",
      payload: { kind: "input", message: "Choose a region" },
    });

    const serializedEvents = JSON.stringify(await eventStore.load("cont-1"));
    expect(serializedEvents).not.toContain(created.resumeToken);
    expect(created.continuation.status).toBe("pending");

    const resumed = await service.resume({
      continuationId: "cont-1",
      idempotencyKey: "request-1",
      resumePayload: { region: "eu-west" },
      resumeToken: created.resumeToken,
    });

    expect(resumed).toMatchObject({
      status: "resumed",
      idempotencyKey: "request-1",
      resumePayload: { region: "eu-west" },
      version: 2,
    });
    expect("resumeTokenHash" in resumed).toBe(false);
  });

  it("returns the first result for an exact idempotent retry", async () => {
    const { service } = harness();
    const created = await service.create({ continuationId: "cont-2", payload: {} });
    const input = {
      continuationId: "cont-2",
      idempotencyKey: "request-2",
      resumePayload: { answer: 42 },
      resumeToken: created.resumeToken,
    };

    const first = await service.resume(input);
    const retry = await service.resume(input);
    expect(retry).toEqual(first);

    await expect(service.resume({ ...input, resumeToken: "wrong-token" })).rejects.toBeInstanceOf(
      TokenMismatchError,
    );

    await expect(
      service.resume({ ...input, resumePayload: { answer: 43 } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      service.resume({ ...input, idempotencyKey: "request-other" }),
    ).rejects.toBeInstanceOf(TokenAlreadyUsedError);
  });

  it("allows exactly one concurrent resume winner", async () => {
    const { service } = harness();
    const created = await service.create({ continuationId: "cont-race", payload: {} });

    const attempts = await Promise.allSettled([
      service.resume({
        continuationId: "cont-race",
        idempotencyKey: "winner-a",
        resumePayload: { answer: "a" },
        resumeToken: created.resumeToken,
      }),
      service.resume({
        continuationId: "cont-race",
        idempotencyKey: "winner-b",
        resumePayload: { answer: "b" },
        resumeToken: created.resumeToken,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("rejects a wrong token without leaking token or payload to observations", async () => {
    const { observer, service } = harness();
    await service.create({ continuationId: "cont-3", payload: { secret: "private" } });

    await expect(
      service.resume({
        continuationId: "cont-3",
        idempotencyKey: "request-3",
        resumePayload: { credential: "do-not-log" },
        resumeToken: "wrong-token",
      }),
    ).rejects.toBeInstanceOf(TokenMismatchError);

    const observations = JSON.stringify(observer.events);
    expect(observations).not.toContain("wrong-token");
    expect(observations).not.toContain("private");
    expect(observations).not.toContain("do-not-log");
    expect(observer.events.at(-1)).toMatchObject({
      code: "TOKEN_MISMATCH",
      name: "continuation.rejected",
    });
  });

  it("expires pending continuations and rejects later resume", async () => {
    const { clock, service } = harness();
    const created = await service.create({ continuationId: "cont-4", payload: {} });
    clock.advance(60_000);

    await expect(
      service.resume({
        continuationId: "cont-4",
        idempotencyKey: "request-4",
        resumePayload: {},
        resumeToken: created.resumeToken,
      }),
    ).rejects.toBeInstanceOf(ContinuationExpiredError);
    expect(await service.inspect("cont-4")).toMatchObject({ status: "expired", version: 2 });
  });

  it("cancels idempotently and prevents resume", async () => {
    const { service } = harness();
    const created = await service.create({ continuationId: "cont-5", payload: {} });
    const cancelled = await service.cancel({ continuationId: "cont-5", reason: "operator" });
    expect(await service.cancel({ continuationId: "cont-5", reason: "operator" })).toEqual(
      cancelled,
    );
    await expect(service.cancel({ continuationId: "cont-5" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    await expect(
      service.resume({
        continuationId: "cont-5",
        idempotencyKey: "request-5",
        resumePayload: {},
        resumeToken: created.resumeToken,
      }),
    ).rejects.toBeInstanceOf(ContinuationCancelledError);
  });

  it("allows only the matching concurrent cancellation outcome", async () => {
    const { service } = harness();
    await service.create({ continuationId: "cont-cancel-race", payload: {} });

    const outcomes = await Promise.allSettled([
      service.cancel({
        continuationId: "cont-cancel-race",
        expectedVersion: 1,
        reason: "first",
      }),
      service.cancel({
        continuationId: "cont-cancel-race",
        expectedVersion: 1,
        reason: "second",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection?.reason).toBeInstanceOf(InvalidTransitionError);
    expect(await service.history("cont-cancel-race")).toHaveLength(2);
  });

  it("fences cancellation with the issued version and replays the exact decision", async () => {
    const { service } = harness();
    await service.create({ continuationId: "cont-cancel-fence", payload: {} });

    await expect(
      service.cancel({
        continuationId: "cont-cancel-fence",
        expectedVersion: 0,
        reason: "agui:cancelled",
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const input = {
      continuationId: "cont-cancel-fence",
      expectedVersion: 1,
      reason: "agui:cancelled",
    } as const;
    const cancelled = await service.cancel(input);
    expect(await service.cancel(input)).toEqual(cancelled);

    await expect(service.cancel({ ...input, expectedVersion: 2 })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });

  it("materializes expiry before executing a previously issued cancellation", async () => {
    const { clock, service } = harness();
    await service.create({ continuationId: "cont-cancel-expired", payload: {} });
    clock.advance(60_000);

    await expect(
      service.cancel({
        continuationId: "cont-cancel-expired",
        expectedVersion: 1,
        reason: "agui:cancelled",
      }),
    ).rejects.toBeInstanceOf(ContinuationExpiredError);
    expect(await service.inspect("cont-cancel-expired")).toMatchObject({
      status: "expired",
      version: 2,
    });
    expect(await service.history("cont-cancel-expired")).toHaveLength(2);
  });

  it("lets expiry win a concurrent inspect and cancellation at the deadline", async () => {
    const { clock, service } = harness();
    await service.create({ continuationId: "cont-cancel-expiry-race", payload: {} });
    clock.advance(60_000);

    const [cancellation, inspection] = await Promise.allSettled([
      service.cancel({
        continuationId: "cont-cancel-expiry-race",
        expectedVersion: 1,
        reason: "agui:cancelled",
      }),
      service.inspect("cont-cancel-expiry-race"),
    ]);

    expect(cancellation.status).toBe("rejected");
    if (cancellation.status === "rejected") {
      expect(cancellation.reason).toBeInstanceOf(ContinuationExpiredError);
    }
    expect(inspection).toMatchObject({
      status: "fulfilled",
      value: { status: "expired", version: 2 },
    });
    expect(await service.history("cont-cancel-expiry-race")).toHaveLength(2);
  });

  it("reports expiry when it wins after cancellation captured a pre-expiry decision", async () => {
    const clock = new FakeClock(new Date("2026-07-15T08:00:00.000Z"));
    const eventStore = new CancellationInterceptingStore();
    const service = new ContinuationService({
      clock,
      eventStore,
      observer: new RecordingObserver(),
      tokenIssuer: new Sha256TokenIssuer(),
      tokenTtlSeconds: 60,
    });
    await service.create({ continuationId: "cont-cancel-expiry-window", payload: {} });
    eventStore.beforeCancellation = async () => {
      clock.advance(60_000);
      expect(await service.inspect("cont-cancel-expiry-window")).toMatchObject({
        status: "expired",
        version: 2,
      });
    };

    await expect(
      service.cancel({
        continuationId: "cont-cancel-expiry-window",
        expectedVersion: 1,
        reason: "agui:cancelled",
      }),
    ).rejects.toBeInstanceOf(ContinuationExpiredError);
    expect(await service.history("cont-cancel-expiry-window")).toHaveLength(2);
  });
});
