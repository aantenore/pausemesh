import { describe, expect, it } from "vitest";
import type { ContinuationCreatedV1, ContinuationResumedV1 } from "../src/domain/events.js";
import {
  migratePostgresEventStore,
  POSTGRES_EVENT_STORE_SCHEMA_CHECKSUM,
  type PostgresClientLike,
  PostgresEventStore,
  PostgresEventStoreError,
  type PostgresPoolLike,
  type PostgresQueryResultLike,
} from "../src/postgres.js";

const CONTINUATION_ID = "continuation-postgres-1";

function createdEvent(overrides: Partial<ContinuationCreatedV1> = {}): ContinuationCreatedV1 {
  return {
    type: "continuation.created",
    schemaVersion: 1,
    continuationId: CONTINUATION_ID,
    correlationId: "correlation-postgres-1",
    version: 1,
    occurredAt: "2026-07-19T08:00:00.000Z",
    expiresAt: "2026-07-19T08:15:00.000Z",
    payload: { action: "approve" },
    metadata: { source: "postgres-unit-test" },
    resumeTokenHash: "a".repeat(64),
    ...overrides,
  };
}

function resumedEvent(overrides: Partial<ContinuationResumedV1> = {}): ContinuationResumedV1 {
  return {
    type: "continuation.resumed",
    schemaVersion: 1,
    continuationId: CONTINUATION_ID,
    version: 2,
    occurredAt: "2026-07-19T08:01:00.000Z",
    idempotencyKey: "postgres-request-1",
    resumePayload: { approved: true },
    ...overrides,
  };
}

function result(
  rows: readonly Record<string, unknown>[] = [],
  rowCount: number | null = rows.length,
): PostgresQueryResultLike {
  return { rowCount, rows };
}

interface QueryStep {
  readonly error?: unknown;
  readonly result?: PostgresQueryResultLike;
  readonly text: RegExp | string;
  readonly values?: readonly unknown[];
  readonly verifyValues?: (values: readonly unknown[] | undefined) => void;
}

interface RecordedQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

class ScriptedQueryable {
  readonly queries: RecordedQuery[] = [];
  readonly #steps: QueryStep[];

  constructor(steps: readonly QueryStep[] = []) {
    this.#steps = [...steps];
  }

  async query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error(`Unexpected query: ${normalized(text)}`);
    }

    const actual = normalized(text);
    if (typeof step.text === "string") {
      expect(actual).toContain(step.text);
    } else {
      expect(actual).toMatch(step.text);
    }
    if (step.values !== undefined) expect(values).toEqual(step.values);
    step.verifyValues?.(values);
    if ("error" in step) throw step.error;
    return step.result ?? result();
  }

  expectConsumed(): void {
    expect(this.#steps, "unconsumed scripted queries").toEqual([]);
  }
}

class ScriptedClient implements PostgresClientLike {
  readonly script: ScriptedQueryable;
  readonly releases: (Error | boolean | undefined)[] = [];

  constructor(steps: readonly QueryStep[]) {
    this.script = new ScriptedQueryable(steps);
  }

  query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike> {
    return this.script.query(text, values);
  }

  release(error?: Error | boolean): void {
    this.releases.push(error);
  }
}

class ScriptedPool implements PostgresPoolLike {
  readonly direct: ScriptedQueryable;
  readonly clients: ScriptedClient[];
  connectCount = 0;

  constructor(directSteps: readonly QueryStep[] = [], clients: readonly ScriptedClient[] = []) {
    this.direct = new ScriptedQueryable(directSteps);
    this.clients = [...clients];
  }

  query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike> {
    return this.direct.query(text, values);
  }

  async connect(): Promise<PostgresClientLike> {
    this.connectCount += 1;
    const client = this.clients.shift();
    if (client === undefined) throw new Error("Unexpected pool.connect() call");
    return client;
  }
}

function migrationRow(
  overrides: Partial<Record<"checksum" | "name" | "version", unknown>> = {},
): Record<string, unknown> {
  return {
    version: "1",
    name: "postgres_multi_replica_event_store",
    checksum: POSTGRES_EVENT_STORE_SCHEMA_CHECKSUM,
    ...overrides,
  };
}

function schemaValidationSteps(missingTriggerCount = "0"): readonly QueryStep[] {
  return [
    {
      text: "FROM pg_catalog.pg_class",
      values: ["pausemesh"],
      result: result([
        {
          streams_exists: true,
          events_exists: true,
          migrations_exists: true,
          missing_trigger_count: missingTriggerCount,
        },
      ]),
    },
    { text: 'SELECT current_version FROM "pausemesh"."continuation_streams" WHERE FALSE' },
    { text: 'SELECT event_json FROM "pausemesh"."continuation_events" WHERE FALSE' },
  ];
}

function migrationPrefix(rows: readonly Record<string, unknown>[]): readonly QueryStep[] {
  return [
    { text: "BEGIN" },
    {
      text: "SELECT pg_advisory_xact_lock($1, $2)",
      values: [1_347_566_917, 1],
    },
    { text: 'CREATE SCHEMA IF NOT EXISTS "pausemesh"' },
    { text: 'CREATE TABLE IF NOT EXISTS "pausemesh"."pausemesh_schema_migrations"' },
    {
      text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
      result: result(rows),
    },
  ];
}

function newMigrationSteps(): readonly QueryStep[] {
  return [
    ...migrationPrefix([]),
    { text: 'CREATE TABLE "pausemesh"."continuation_streams"' },
    { text: 'CREATE TABLE "pausemesh"."continuation_events"' },
    { text: 'CREATE FUNCTION "pausemesh"."pausemesh_reject_mutation"()' },
    { text: "CREATE TRIGGER pausemesh_events_no_update_delete" },
    { text: "CREATE TRIGGER pausemesh_events_no_truncate" },
    { text: "CREATE TRIGGER pausemesh_streams_no_delete" },
    { text: "CREATE TRIGGER pausemesh_streams_no_truncate" },
    { text: "CREATE TRIGGER pausemesh_migrations_no_update_delete" },
    { text: "CREATE TRIGGER pausemesh_migrations_no_truncate" },
    {
      text: 'INSERT INTO "pausemesh"."pausemesh_schema_migrations"',
      values: [1, "postgres_multi_replica_event_store", POSTGRES_EVENT_STORE_SCHEMA_CHECKSUM],
    },
    {
      text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
      result: result([migrationRow()]),
    },
    ...schemaValidationSteps(),
    { text: "COMMIT" },
  ];
}

function existingMigrationSteps(): readonly QueryStep[] {
  return [
    ...migrationPrefix([migrationRow()]),
    {
      text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
      result: result([migrationRow()]),
    },
    ...schemaValidationSteps(),
    { text: "COMMIT" },
  ];
}

describe("PostgreSQL migration", () => {
  it("applies the versioned schema on one checked-out client", async () => {
    const client = new ScriptedClient(newMigrationSteps());
    const pool = new ScriptedPool([], [client]);

    await migratePostgresEventStore(pool);

    expect(pool.connectCount).toBe(1);
    expect(client.releases).toEqual([undefined]);
    client.script.expectConsumed();
  });

  it("is idempotent when the exact migration checksum is already present", async () => {
    const client = new ScriptedClient(existingMigrationSteps());

    await migratePostgresEventStore(new ScriptedPool([], [client]));

    expect(
      client.script.queries.some((query) => normalized(query.text).startsWith("CREATE TRIGGER")),
    ).toBe(false);
    expect(client.releases).toEqual([undefined]);
    client.script.expectConsumed();
  });

  it.each([
    {
      code: "MIGRATION_CHECKSUM_MISMATCH",
      row: migrationRow({ checksum: "0".repeat(64) }),
    },
    {
      code: "MIGRATION_VERSION_AHEAD",
      row: migrationRow({ version: "2" }),
    },
  ])("rolls back incompatible migration metadata: $code", async ({ code, row }) => {
    const client = new ScriptedClient([...migrationPrefix([row]), { text: "ROLLBACK" }]);

    await expect(migratePostgresEventStore(new ScriptedPool([], [client]))).rejects.toMatchObject({
      code,
    });
    expect(client.releases).toEqual([undefined]);
    client.script.expectConsumed();
  });

  it("fails closed and rolls back when required schema objects are absent", async () => {
    const client = new ScriptedClient([
      ...migrationPrefix([migrationRow()]),
      {
        text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
        result: result([migrationRow()]),
      },
      {
        text: "FROM pg_catalog.pg_class",
        result: result([
          {
            streams_exists: true,
            events_exists: false,
            migrations_exists: true,
            missing_trigger_count: "0",
          },
        ]),
      },
      { text: "ROLLBACK" },
    ]);

    await expect(migratePostgresEventStore(new ScriptedPool([], [client]))).rejects.toMatchObject({
      code: "SCHEMA_INCOMPLETE",
    });
    client.script.expectConsumed();
  });

  it("preserves the primary error and discards a client when rollback also fails", async () => {
    const rollbackError = new Error("rollback connection failure");
    const client = new ScriptedClient([
      ...migrationPrefix([migrationRow({ version: "2" })]),
      { text: "ROLLBACK", error: rollbackError },
    ]);

    const failure = migratePostgresEventStore(new ScriptedPool([], [client]));
    await expect(failure).rejects.toMatchObject({ code: "MIGRATION_VERSION_AHEAD" });
    expect(client.releases).toEqual([rollbackError]);
    client.script.expectConsumed();
  });

  it("rejects unsafe configurable schema names before acquiring a connection", async () => {
    const pool = new ScriptedPool();

    await expect(
      migratePostgresEventStore(pool, { schema: 'tenant";DROP SCHEMA public' }),
    ).rejects.toThrow(/ASCII identifier/);
    expect(pool.connectCount).toBe(0);
  });
});

describe("PostgresEventStore", () => {
  it("rejects invalid bounds and schema configuration", () => {
    const pool = new ScriptedPool();

    expect(() => new PostgresEventStore(pool, { maxEventsPerStream: 0 })).toThrow(
      /positive safe integer/,
    );
    expect(() => new PostgresEventStore(pool, { schema: "invalid-schema" })).toThrow(
      /ASCII identifier/,
    );
  });

  it("pre-validates the complete batch before acquiring a client", async () => {
    const pool = new ScriptedPool();
    const store = new PostgresEventStore(pool);

    await expect(
      store.append(CONTINUATION_ID, 0, [createdEvent(), resumedEvent({ version: 3 })]),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(store.append(CONTINUATION_ID, -1, [])).rejects.toThrow(/non-negative/);
    await expect(
      store.append(CONTINUATION_ID, Number.MAX_SAFE_INTEGER, [createdEvent()]),
    ).rejects.toThrow(/exceeds the safe integer range/);
    await expect(
      new PostgresEventStore(pool, { maxEventsPerStream: 1 }).append(CONTINUATION_ID, 1, [
        resumedEvent(),
      ]),
    ).rejects.toMatchObject({ code: "STREAM_TOO_LARGE" });
    expect(pool.connectCount).toBe(0);
  });

  it("compares an empty batch without a transaction or ghost stream", async () => {
    const pool = new ScriptedPool([
      {
        text: 'SELECT current_version::text AS current_version FROM "pausemesh"."continuation_streams"',
        values: [CONTINUATION_ID],
        result: result([]),
      },
      {
        text: 'SELECT current_version::text AS current_version FROM "pausemesh"."continuation_streams"',
        values: [CONTINUATION_ID],
        result: result([{ current_version: "2" }]),
      },
    ]);
    const store = new PostgresEventStore(pool);

    await store.append(CONTINUATION_ID, 0, []);
    await expect(store.append(CONTINUATION_ID, 1, [])).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(pool.connectCount).toBe(0);
    expect(pool.direct.queries.every((query) => !normalized(query.text).includes("INSERT"))).toBe(
      true,
    );
    pool.direct.expectConsumed();
  });

  it("atomically creates a head, fences it, and inserts one ordered batch", async () => {
    const client = new ScriptedClient([
      { text: "BEGIN" },
      {
        text: 'INSERT INTO "pausemesh"."continuation_streams"',
        values: [CONTINUATION_ID],
      },
      {
        text: 'UPDATE "pausemesh"."continuation_streams" SET current_version = $3',
        values: [CONTINUATION_ID, 0, 2],
        result: result([{ current_version: "2" }], 1),
      },
      {
        text: 'INSERT INTO "pausemesh"."continuation_events"',
        verifyValues: (values) => {
          expect(values).toBeDefined();
          if (values === undefined) throw new Error("Expected query values");
          expect(values?.[0]).toBe(CONTINUATION_ID);
          expect(values?.[1]).toEqual(["1", "2"]);
          expect((values[2] as string[]).map((event) => JSON.parse(event))).toEqual([
            createdEvent(),
            resumedEvent(),
          ]);
        },
        result: result([], 2),
      },
      { text: "COMMIT" },
    ]);
    const pool = new ScriptedPool([], [client]);

    await new PostgresEventStore(pool).append(CONTINUATION_ID, 0, [createdEvent(), resumedEvent()]);

    expect(client.releases).toEqual([undefined]);
    client.script.expectConsumed();
  });

  it("does not recreate a head when appending to an existing stream", async () => {
    const client = new ScriptedClient([
      { text: "BEGIN" },
      {
        text: 'UPDATE "pausemesh"."continuation_streams" SET current_version = $3',
        values: [CONTINUATION_ID, 1, 2],
        result: result([{ current_version: "2" }], 1),
      },
      {
        text: 'INSERT INTO "pausemesh"."continuation_events"',
        result: result([], 1),
      },
      { text: "COMMIT" },
    ]);

    await new PostgresEventStore(new ScriptedPool([], [client])).append(CONTINUATION_ID, 1, [
      resumedEvent(),
    ]);

    client.script.expectConsumed();
  });

  it("translates a lost CAS fence to VersionConflictError and rolls back", async () => {
    const client = new ScriptedClient([
      { text: "BEGIN" },
      { text: 'INSERT INTO "pausemesh"."continuation_streams"' },
      {
        text: 'UPDATE "pausemesh"."continuation_streams" SET current_version = $3',
        result: result([], 0),
      },
      {
        text: 'SELECT current_version::text AS current_version FROM "pausemesh"."continuation_streams"',
        result: result([{ current_version: "1" }]),
      },
      { text: "ROLLBACK" },
    ]);

    await expect(
      new PostgresEventStore(new ScriptedPool([], [client])).append(CONTINUATION_ID, 0, [
        createdEvent(),
      ]),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      expectedVersion: 0,
      actualVersion: 1,
    });
    expect(client.releases).toEqual([undefined]);
    client.script.expectConsumed();
  });

  it("rolls back when PostgreSQL reports a partial batch insert", async () => {
    const client = new ScriptedClient([
      { text: "BEGIN" },
      { text: 'INSERT INTO "pausemesh"."continuation_streams"' },
      {
        text: 'UPDATE "pausemesh"."continuation_streams" SET current_version = $3',
        result: result([{ current_version: "2" }], 1),
      },
      { text: 'INSERT INTO "pausemesh"."continuation_events"', result: result([], 1) },
      { text: "ROLLBACK" },
    ]);

    await expect(
      new PostgresEventStore(new ScriptedPool([], [client])).append(CONTINUATION_ID, 0, [
        createdEvent(),
        resumedEvent(),
      ]),
    ).rejects.toMatchObject({ code: "CORRUPT_STREAM" });
    client.script.expectConsumed();
  });

  it("loads and validates a complete ordered stream", async () => {
    const pool = new ScriptedPool([
      {
        text: 'FROM "pausemesh"."continuation_streams" AS streams LEFT JOIN LATERAL',
        values: [CONTINUATION_ID, 33],
        result: result([
          {
            current_version: "2",
            version: "1",
            event_json: JSON.stringify(createdEvent()),
          },
          {
            current_version: "2",
            version: "2",
            event_json: JSON.stringify(resumedEvent()),
          },
        ]),
      },
      {
        text: 'FROM "pausemesh"."continuation_streams" AS streams LEFT JOIN LATERAL',
        result: result([]),
      },
    ]);
    const store = new PostgresEventStore(pool);

    expect(await store.load(CONTINUATION_ID)).toEqual([createdEvent(), resumedEvent()]);
    expect(await store.load("missing")).toEqual([]);
    pool.direct.expectConsumed();
  });

  it.each([
    {
      label: "head count mismatch",
      rows: [{ current_version: "2", version: "1", event_json: JSON.stringify(createdEvent()) }],
      expected: { code: "CORRUPT_STREAM" },
    },
    {
      label: "version gap",
      rows: [{ current_version: "1", version: "2", event_json: JSON.stringify(createdEvent()) }],
      expected: { code: "CORRUPT_STREAM" },
    },
    {
      label: "non-text snapshot",
      rows: [{ current_version: "1", version: "1", event_json: createdEvent() }],
      expected: { code: "CORRUPT_STREAM" },
    },
    {
      label: "embedded continuation mismatch",
      rows: [
        {
          current_version: "1",
          version: "1",
          event_json: JSON.stringify(createdEvent({ continuationId: "other" })),
        },
      ],
      expected: { code: "CORRUPT_STREAM" },
    },
    {
      label: "embedded version mismatch",
      rows: [
        {
          current_version: "1",
          version: "1",
          event_json: JSON.stringify(createdEvent({ version: 2 })),
        },
      ],
      expected: { code: "CORRUPT_STREAM" },
    },
  ])("rejects corrupted storage: $label", async ({ rows, expected }) => {
    const store = new PostgresEventStore(
      new ScriptedPool([{ text: "LEFT JOIN LATERAL", result: result(rows) }]),
    );

    await expect(store.load(CONTINUATION_ID)).rejects.toMatchObject(expected);
  });

  it("bounds reconstruction and rejects unsafe database BIGINT values", async () => {
    const oversized = new PostgresEventStore(
      new ScriptedPool([
        {
          text: "LEFT JOIN LATERAL",
          result: result([{ current_version: "3", version: "1", event_json: "{}" }]),
        },
      ]),
      { maxEventsPerStream: 2 },
    );
    await expect(oversized.load(CONTINUATION_ID)).rejects.toMatchObject({
      code: "STREAM_TOO_LARGE",
    });

    const unsafe = new PostgresEventStore(
      new ScriptedPool([
        {
          text: "LEFT JOIN LATERAL",
          result: result([
            {
              current_version: "9007199254740992",
              version: "1",
              event_json: JSON.stringify(createdEvent()),
            },
          ]),
        },
      ]),
    );
    await expect(unsafe.load(CONTINUATION_ID)).rejects.toMatchObject({ code: "CORRUPT_STREAM" });
  });

  it("reports ready only for the exact migration and complete accessible schema", async () => {
    const pool = new ScriptedPool([
      {
        text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
        result: result([migrationRow()]),
      },
      ...schemaValidationSteps(),
    ]);

    await new PostgresEventStore(pool).checkReadiness();

    pool.direct.expectConsumed();
  });

  it.each([
    { rows: [], code: "MIGRATION_REQUIRED" },
    {
      rows: [migrationRow({ checksum: "f".repeat(64) })],
      code: "MIGRATION_CHECKSUM_MISMATCH",
    },
    { rows: [migrationRow({ version: "2" })], code: "MIGRATION_VERSION_AHEAD" },
  ])("fails readiness for incompatible ledger state: $code", async ({ rows, code }) => {
    const store = new PostgresEventStore(
      new ScriptedPool([
        {
          text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
          result: result(rows),
        },
      ]),
    );

    await expect(store.checkReadiness()).rejects.toBeInstanceOf(PostgresEventStoreError);
    await expect(
      new PostgresEventStore(
        new ScriptedPool([
          {
            text: 'FROM "pausemesh"."pausemesh_schema_migrations" ORDER BY version ASC',
            result: result(rows),
          },
        ]),
      ).checkReadiness(),
    ).rejects.toMatchObject({ code });
  });
});
