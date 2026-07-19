import { createHash } from "node:crypto";
import { VersionConflictError } from "../../domain/errors.js";
import type { ContinuationEventV1 } from "../../domain/events.js";
import type { ContinuationId, ContinuationVersion } from "../../domain/types.js";
import type { EventStore } from "../../ports/event-store.js";
import type { ReadinessProbe } from "../../ports/readiness.js";
import { deserializeEvent, serializeAppendBatch } from "./event-serialization.js";

const DEFAULT_SCHEMA = "pausemesh";
const DEFAULT_MAX_EVENTS_PER_STREAM = 32;
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;
const MIGRATION_LOCK_NAMESPACE = 1_347_566_917;
const MIGRATION_LOCK_KEY = 1;
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export const POSTGRES_EVENT_STORE_SCHEMA_VERSION = 1 as const;

export interface PostgresQueryResultLike {
  readonly rowCount: number | null;
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresQueryableLike {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResultLike>;
}

export interface PostgresClientLike extends PostgresQueryableLike {
  release(error?: Error | boolean): void;
}

/**
 * Minimal structural contract accepted by the adapter. The application composition root owns the
 * actual pool, its idle-error listener, timeouts, and shutdown; the store never calls `end()`.
 */
export interface PostgresPoolLike extends PostgresQueryableLike {
  connect(): Promise<PostgresClientLike>;
}

export interface PostgresEventStoreOptions {
  /** Maximum number of lifecycle events reconstructed for one continuation. */
  readonly maxEventsPerStream?: number;
  /** Dedicated PostgreSQL schema. ASCII identifiers only; defaults to `pausemesh`. */
  readonly schema?: string;
}

export interface MigratePostgresEventStoreOptions {
  /** Dedicated PostgreSQL schema. ASCII identifiers only; defaults to `pausemesh`. */
  readonly schema?: string;
}

export type PostgresEventStoreErrorCode =
  | "CORRUPT_STREAM"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_REQUIRED"
  | "MIGRATION_VERSION_AHEAD"
  | "SCHEMA_INCOMPLETE"
  | "STREAM_TOO_LARGE";

export class PostgresEventStoreError extends Error {
  constructor(
    readonly code: PostgresEventStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PostgresEventStoreError";
  }
}

interface MigrationDefinition {
  readonly checksum: string;
  readonly name: string;
  readonly statements: readonly string[];
  readonly version: number;
}

interface MigrationRow {
  readonly checksum: unknown;
  readonly name: unknown;
  readonly version: unknown;
}

interface SchemaNames {
  readonly migrationTable: string;
  readonly schema: string;
  readonly schemaSql: string;
  readonly streamsTable: string;
  readonly eventsTable: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function schemaNames(schemaOption: string | undefined): SchemaNames {
  const schema = schemaOption ?? DEFAULT_SCHEMA;
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new TypeError(
      "PostgreSQL schema must be a 1-63 character ASCII identifier starting with a letter or underscore",
    );
  }

  const schemaSql = quoteIdentifier(schema);
  return {
    schema,
    schemaSql,
    migrationTable: `${schemaSql}."pausemesh_schema_migrations"`,
    streamsTable: `${schemaSql}."continuation_streams"`,
    eventsTable: `${schemaSql}."continuation_events"`,
  };
}

function canonicalMigrationStatements(): readonly string[] {
  const schema = "{{schema}}";
  return [
    `CREATE TABLE ${schema}."continuation_streams" (
      continuation_id TEXT PRIMARY KEY,
      current_version BIGINT NOT NULL CHECK (
        current_version BETWEEN 0 AND ${MAX_SAFE_VERSION}
      )
    )`,
    `CREATE TABLE ${schema}."continuation_events" (
      continuation_id TEXT NOT NULL REFERENCES ${schema}."continuation_streams" (continuation_id),
      version BIGINT NOT NULL CHECK (version BETWEEN 1 AND ${MAX_SAFE_VERSION}),
      event_json TEXT NOT NULL CHECK (jsonb_typeof(event_json::jsonb) = 'object'),
      PRIMARY KEY (continuation_id, version)
    )`,
    `CREATE FUNCTION ${schema}."pausemesh_reject_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'PauseMesh persistence is append-only';
      END;
      $$`,
    `CREATE TRIGGER pausemesh_events_no_update_delete
      BEFORE UPDATE OR DELETE ON ${schema}."continuation_events"
      FOR EACH ROW EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
    `CREATE TRIGGER pausemesh_events_no_truncate
      BEFORE TRUNCATE ON ${schema}."continuation_events"
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
    `CREATE TRIGGER pausemesh_streams_no_delete
      BEFORE DELETE ON ${schema}."continuation_streams"
      FOR EACH ROW EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
    `CREATE TRIGGER pausemesh_streams_no_truncate
      BEFORE TRUNCATE ON ${schema}."continuation_streams"
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
    `CREATE TRIGGER pausemesh_migrations_no_update_delete
      BEFORE UPDATE OR DELETE ON ${schema}."pausemesh_schema_migrations"
      FOR EACH ROW EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
    `CREATE TRIGGER pausemesh_migrations_no_truncate
      BEFORE TRUNCATE ON ${schema}."pausemesh_schema_migrations"
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}."pausemesh_reject_mutation"()`,
  ];
}

function migrationFor(names: SchemaNames): MigrationDefinition {
  const canonicalStatements = canonicalMigrationStatements();
  return {
    version: POSTGRES_EVENT_STORE_SCHEMA_VERSION,
    name: "postgres_multi_replica_event_store",
    checksum: createHash("sha256").update(canonicalStatements.join(";\n")).digest("hex"),
    statements: canonicalStatements.map((statement) =>
      statement.replaceAll("{{schema}}", names.schemaSql),
    ),
  };
}

export const POSTGRES_EVENT_STORE_SCHEMA_CHECKSUM = migrationFor(
  schemaNames(DEFAULT_SCHEMA),
).checksum;

function parseDatabaseVersion(value: unknown, label: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\d+$/.test(value))
  ) {
    throw new PostgresEventStoreError("CORRUPT_STREAM", `${label} is not an integer`);
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PostgresEventStoreError("CORRUPT_STREAM", `${label} is outside the safe range`);
  }
  return parsed;
}

function validateExpectedVersion(expectedVersion: number, eventCount: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new RangeError("expectedVersion must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(expectedVersion + eventCount)) {
    throw new RangeError("The appended stream version exceeds the safe integer range");
  }
}

function actualVersionFromRows(rows: readonly Record<string, unknown>[]): number {
  const row = rows[0];
  return row === undefined ? 0 : parseDatabaseVersion(row.current_version, "current_version");
}

function releaseFailure(error: unknown): Error | boolean {
  return error instanceof Error ? error : true;
}

async function rollbackPreservingPrimaryError(
  client: PostgresClientLike,
  primaryError: unknown,
): Promise<Error | boolean | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (rollbackError) {
    if (primaryError instanceof Error && rollbackError instanceof Error) {
      Object.defineProperty(primaryError, "rollbackError", {
        configurable: true,
        enumerable: false,
        value: rollbackError,
      });
    }
    return releaseFailure(rollbackError);
  }
}

function requireMigrationRows(
  rows: readonly Record<string, unknown>[],
  migration: MigrationDefinition,
): void {
  const migrations = rows as readonly unknown[] as readonly MigrationRow[];
  const future = migrations.find(
    (row) => parseDatabaseVersion(row.version, "migration version") > migration.version,
  );
  if (future !== undefined) {
    throw new PostgresEventStoreError(
      "MIGRATION_VERSION_AHEAD",
      "PostgreSQL event-store schema is newer than this PauseMesh adapter",
    );
  }

  const applied = migrations.find(
    (row) => parseDatabaseVersion(row.version, "migration version") === migration.version,
  );
  if (applied === undefined) {
    throw new PostgresEventStoreError(
      "MIGRATION_REQUIRED",
      "PostgreSQL event-store migration is not applied",
    );
  }
  if (applied.name !== migration.name || applied.checksum !== migration.checksum) {
    throw new PostgresEventStoreError(
      "MIGRATION_CHECKSUM_MISMATCH",
      "PostgreSQL event-store migration checksum does not match the adapter",
    );
  }
}

async function readMigrationRows(
  queryable: PostgresQueryableLike,
  names: SchemaNames,
): Promise<readonly Record<string, unknown>[]> {
  const result = await queryable.query(
    `SELECT version::text AS version, name, checksum
     FROM ${names.migrationTable}
     ORDER BY version ASC`,
  );
  return result.rows;
}

async function requireSchemaObjects(
  queryable: PostgresQueryableLike,
  names: SchemaNames,
): Promise<void> {
  const result = await queryable.query(
    `WITH expected_triggers(table_name, trigger_name) AS (
       VALUES
         ('continuation_events', 'pausemesh_events_no_update_delete'),
         ('continuation_events', 'pausemesh_events_no_truncate'),
         ('continuation_streams', 'pausemesh_streams_no_delete'),
         ('continuation_streams', 'pausemesh_streams_no_truncate'),
         ('pausemesh_schema_migrations', 'pausemesh_migrations_no_update_delete'),
         ('pausemesh_schema_migrations', 'pausemesh_migrations_no_truncate')
     ), valid_triggers AS (
       SELECT expected.trigger_name
       FROM expected_triggers expected
       JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.nspname = $1
       JOIN pg_catalog.pg_class table_class
         ON table_class.relnamespace = table_namespace.oid
        AND table_class.relname = expected.table_name
        AND table_class.relkind = 'r'
       JOIN pg_catalog.pg_trigger trigger
         ON trigger.tgrelid = table_class.oid
        AND trigger.tgname = expected.trigger_name
        AND NOT trigger.tgisinternal
        AND trigger.tgenabled IN ('O', 'A')
       JOIN pg_catalog.pg_proc trigger_function ON trigger_function.oid = trigger.tgfoid
       JOIN pg_catalog.pg_namespace function_namespace
         ON function_namespace.oid = trigger_function.pronamespace
        AND function_namespace.nspname = $1
       WHERE trigger_function.proname = 'pausemesh_reject_mutation'
         AND trigger_function.pronargs = 0
     )
     SELECT
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = 'continuation_streams' AND c.relkind = 'r'
       ) AS streams_exists,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = 'continuation_events' AND c.relkind = 'r'
       ) AS events_exists,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relname = 'pausemesh_schema_migrations'
           AND c.relkind = 'r'
       ) AS migrations_exists,
       (
         SELECT COUNT(*)::text FROM expected_triggers
         WHERE trigger_name NOT IN (SELECT trigger_name FROM valid_triggers)
       ) AS missing_trigger_count`,
    [names.schema],
  );
  const row = result.rows[0];
  const missingTriggerCount = row?.missing_trigger_count;
  if (
    row?.streams_exists !== true ||
    row.events_exists !== true ||
    row.migrations_exists !== true ||
    parseDatabaseVersion(missingTriggerCount, "missing_trigger_count") !== 0
  ) {
    throw new PostgresEventStoreError(
      "SCHEMA_INCOMPLETE",
      "PostgreSQL event-store schema objects are incomplete",
    );
  }

  // These zero-row reads verify that the runtime role can access both tables.
  await queryable.query(`SELECT current_version FROM ${names.streamsTable} WHERE FALSE`);
  await queryable.query(`SELECT event_json FROM ${names.eventsTable} WHERE FALSE`);
}

/**
 * Applies and validates the explicit PostgreSQL schema migration. Run this with a DDL-capable
 * migration role before starting application replicas; constructors deliberately never migrate.
 */
export async function migratePostgresEventStore(
  pool: PostgresPoolLike,
  options: MigratePostgresEventStoreOptions = {},
): Promise<void> {
  const names = schemaNames(options.schema);
  const migration = migrationFor(names);
  const client = await pool.connect();
  let releaseError: Error | boolean | undefined;

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_KEY,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${names.schemaSql}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${names.migrationTable} (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );

    const before = await readMigrationRows(client, names);
    const future = before.find(
      (row) => parseDatabaseVersion(row.version, "migration version") > migration.version,
    );
    if (future !== undefined) {
      throw new PostgresEventStoreError(
        "MIGRATION_VERSION_AHEAD",
        "PostgreSQL event-store schema is newer than this PauseMesh adapter",
      );
    }

    const existing = before.find(
      (row) => parseDatabaseVersion(row.version, "migration version") === migration.version,
    );
    if (existing !== undefined) {
      requireMigrationRows(before, migration);
    } else {
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ${names.migrationTable} (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
    }

    requireMigrationRows(await readMigrationRows(client, names), migration);
    await requireSchemaObjects(client, names);
    await client.query("COMMIT");
  } catch (error) {
    releaseError = await rollbackPreservingPrimaryError(client, error);
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/** Multi-replica append-only event store backed by an externally owned PostgreSQL pool. */
export class PostgresEventStore implements EventStore, ReadinessProbe {
  readonly #maxEventsPerStream: number;
  readonly #migration: MigrationDefinition;
  readonly #names: SchemaNames;
  readonly #pool: PostgresPoolLike;

  constructor(pool: PostgresPoolLike, options: PostgresEventStoreOptions = {}) {
    const maxEventsPerStream = options.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
    if (!Number.isSafeInteger(maxEventsPerStream) || maxEventsPerStream <= 0) {
      throw new RangeError("maxEventsPerStream must be a positive safe integer");
    }

    this.#pool = pool;
    this.#names = schemaNames(options.schema);
    this.#migration = migrationFor(this.#names);
    this.#maxEventsPerStream = maxEventsPerStream;
  }

  async load(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]> {
    const result = await this.#pool.query(
      `SELECT
         streams.current_version::text AS current_version,
         events.version::text AS version,
         events.event_json
       FROM ${this.#names.streamsTable} AS streams
       LEFT JOIN LATERAL (
         SELECT version, event_json
         FROM ${this.#names.eventsTable}
         WHERE continuation_id = streams.continuation_id
         ORDER BY version ASC
         LIMIT $2
       ) AS events ON TRUE
       WHERE streams.continuation_id = $1
       ORDER BY events.version ASC`,
      [continuationId, this.#maxEventsPerStream + 1],
    );

    if (result.rows.length === 0) return [];

    const currentVersion = parseDatabaseVersion(result.rows[0]?.current_version, "current_version");
    if (
      currentVersion > this.#maxEventsPerStream ||
      result.rows.length > this.#maxEventsPerStream
    ) {
      throw new PostgresEventStoreError(
        "STREAM_TOO_LARGE",
        `Continuation stream exceeds the configured ${this.#maxEventsPerStream}-event limit`,
      );
    }
    if (currentVersion === 0 || result.rows.length !== currentVersion) {
      throw new PostgresEventStoreError(
        "CORRUPT_STREAM",
        "Continuation stream head does not match its event count",
      );
    }

    return result.rows.map((row, index) => {
      const expectedVersion = index + 1;
      const storedVersion = parseDatabaseVersion(row.version, "event version");
      if (storedVersion !== expectedVersion) {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "Stored continuation stream contains a version gap",
        );
      }
      if (typeof row.event_json !== "string") {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "Stored continuation event is not a JSON text snapshot",
        );
      }

      let event: ContinuationEventV1;
      try {
        event = deserializeEvent(row.event_json);
      } catch (cause) {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "Stored continuation event does not match the persistence contract",
          { cause },
        );
      }
      if (event.continuationId !== continuationId) {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "Stored continuation event belongs to a different stream",
        );
      }
      if (event.version !== storedVersion) {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "Stored continuation event embeds a different version",
        );
      }
      return event;
    });
  }

  async append(
    continuationId: ContinuationId,
    expectedVersion: ContinuationVersion,
    events: readonly ContinuationEventV1[],
  ): Promise<void> {
    validateExpectedVersion(expectedVersion, events.length);
    if (expectedVersion + events.length > this.#maxEventsPerStream) {
      throw new PostgresEventStoreError(
        "STREAM_TOO_LARGE",
        `Continuation stream exceeds the configured ${this.#maxEventsPerStream}-event limit`,
      );
    }
    const serializedEvents = serializeAppendBatch(continuationId, expectedVersion, events);

    // A no-op still compares the head, but does not create a ghost stream or open a transaction.
    if (serializedEvents.length === 0) {
      const current = await this.#pool.query(
        `SELECT current_version::text AS current_version
         FROM ${this.#names.streamsTable}
         WHERE continuation_id = $1`,
        [continuationId],
      );
      const actualVersion = actualVersionFromRows(current.rows);
      if (actualVersion !== expectedVersion) {
        throw new VersionConflictError(continuationId, expectedVersion, actualVersion);
      }
      return;
    }

    const nextVersion = expectedVersion + serializedEvents.length;
    const client = await this.#pool.connect();
    let releaseError: Error | boolean | undefined;

    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      if (expectedVersion === 0) {
        await client.query(
          `INSERT INTO ${this.#names.streamsTable} (continuation_id, current_version)
           VALUES ($1, 0)
           ON CONFLICT (continuation_id) DO NOTHING`,
          [continuationId],
        );
      }

      const fenced = await client.query(
        `UPDATE ${this.#names.streamsTable}
         SET current_version = $3
         WHERE continuation_id = $1 AND current_version = $2
         RETURNING current_version::text AS current_version`,
        [continuationId, expectedVersion, nextVersion],
      );
      if (fenced.rowCount !== 1) {
        const current = await client.query(
          `SELECT current_version::text AS current_version
           FROM ${this.#names.streamsTable}
           WHERE continuation_id = $1`,
          [continuationId],
        );
        throw new VersionConflictError(
          continuationId,
          expectedVersion,
          actualVersionFromRows(current.rows),
        );
      }

      const versions = serializedEvents.map((_, index) => String(expectedVersion + index + 1));
      const inserted = await client.query(
        `INSERT INTO ${this.#names.eventsTable} (continuation_id, version, event_json)
         SELECT $1, batch.version, batch.event_json
         FROM UNNEST($2::bigint[], $3::text[]) AS batch(version, event_json)`,
        [continuationId, versions, [...serializedEvents]],
      );
      if (inserted.rowCount !== serializedEvents.length) {
        throw new PostgresEventStoreError(
          "CORRUPT_STREAM",
          "PostgreSQL did not persist the complete continuation event batch",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      releaseError = await rollbackPreservingPrimaryError(client, error);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async checkReadiness(): Promise<void> {
    requireMigrationRows(await readMigrationRows(this.#pool, this.#names), this.#migration);
    await requireSchemaObjects(this.#pool, this.#names);
  }
}
