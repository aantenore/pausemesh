import Database from "better-sqlite3";
import { ContinuationIdMismatchError, VersionConflictError } from "../../domain/errors.js";
import type { ContinuationEventV1 } from "../../domain/events.js";
import type { ContinuationId, ContinuationVersion } from "../../domain/types.js";
import type { EventStore } from "../../ports/event-store.js";
import { deserializeEvent, serializeAppendBatch } from "./event-serialization.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS continuation_events (
    continuation_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    UNIQUE (continuation_id, version)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS continuation_events_no_update
  BEFORE UPDATE ON continuation_events
  BEGIN
    SELECT RAISE(ABORT, 'continuation_events is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS continuation_events_no_delete
  BEFORE DELETE ON continuation_events
  BEGIN
    SELECT RAISE(ABORT, 'continuation_events is append-only');
  END;
`;

interface CurrentVersionRow {
  readonly version: number;
}

interface StoredEventRow {
  readonly eventJson: string;
  readonly version: number;
}

export interface SqliteEventStoreOptions {
  /** Time SQLite may wait for another writer before reporting SQLITE_BUSY. */
  readonly busyTimeoutMs?: number;
}

/** Durable append-only event store backed by SQLite in WAL mode. */
export class SqliteEventStore implements EventStore {
  readonly #database: Database.Database;

  constructor(databasePath: string, options: SqliteEventStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError("busyTimeoutMs must be a non-negative safe integer");
    }

    this.#database = new Database(databasePath, { timeout: busyTimeoutMs });

    try {
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.#database.exec(SCHEMA);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async load(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]> {
    const rows = this.#database
      .prepare<[ContinuationId], StoredEventRow>(
        `SELECT version, event_json AS eventJson
         FROM continuation_events
         WHERE continuation_id = ?
         ORDER BY version ASC`,
      )
      .all(continuationId);

    return rows.map((row, index) => {
      const expectedVersion = index + 1;
      if (row.version !== expectedVersion) {
        throw new VersionConflictError(continuationId, expectedVersion, row.version);
      }

      const event = deserializeEvent(row.eventJson);
      if (event.continuationId !== continuationId) {
        throw new ContinuationIdMismatchError(continuationId, event.continuationId);
      }
      if (event.version !== row.version) {
        throw new VersionConflictError(continuationId, row.version, event.version);
      }

      return event;
    });
  }

  async append(
    continuationId: ContinuationId,
    expectedVersion: ContinuationVersion,
    events: readonly ContinuationEventV1[],
  ): Promise<void> {
    const appendTransaction = this.#database.transaction(() => {
      const currentVersion = this.#database
        .prepare<[ContinuationId], CurrentVersionRow>(
          `SELECT COALESCE(MAX(version), 0) AS version
           FROM continuation_events
           WHERE continuation_id = ?`,
        )
        .get(continuationId);
      const actualVersion = currentVersion?.version ?? 0;

      if (actualVersion !== expectedVersion) {
        throw new VersionConflictError(continuationId, expectedVersion, actualVersion);
      }

      const serializedEvents = serializeAppendBatch(continuationId, expectedVersion, events);
      const insert = this.#database.prepare<[ContinuationId, ContinuationVersion, string]>(
        `INSERT INTO continuation_events (continuation_id, version, event_json)
         VALUES (?, ?, ?)`,
      );

      for (const [index, serializedEvent] of serializedEvents.entries()) {
        insert.run(continuationId, expectedVersion + index + 1, serializedEvent);
      }
    });

    // `immediate()` issues BEGIN IMMEDIATE, taking the writer reservation before the CAS read.
    appendTransaction.immediate();
  }

  close(): void {
    if (this.#database.open) {
      this.#database.close();
    }
  }
}
