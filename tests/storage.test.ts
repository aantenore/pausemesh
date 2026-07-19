import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEventStore } from "../src/adapters/storage/in-memory-event-store.js";
import { SqliteEventStore } from "../src/adapters/storage/sqlite-event-store.js";
import { VersionConflictError } from "../src/domain/errors.js";
import type {
  ContinuationCancelledV1,
  ContinuationCreatedV1,
  ContinuationResumedV1,
} from "../src/domain/events.js";

const CONTINUATION_ID = "continuation-storage-1";

function createdEvent(overrides: Partial<ContinuationCreatedV1> = {}): ContinuationCreatedV1 {
  return {
    type: "continuation.created",
    schemaVersion: 1,
    continuationId: CONTINUATION_ID,
    correlationId: "correlation-storage-1",
    version: 1,
    occurredAt: "2026-07-15T10:00:00.000Z",
    expiresAt: "2026-07-15T10:15:00.000Z",
    payload: { action: "approve", nested: { amount: 42 } },
    metadata: { source: "storage-test" },
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
    occurredAt: "2026-07-15T10:01:00.000Z",
    idempotencyKey: "storage-request-1",
    resumePayload: { approved: true },
    ...overrides,
  };
}

function cancelledEvent(overrides: Partial<ContinuationCancelledV1> = {}): ContinuationCancelledV1 {
  return {
    type: "continuation.cancelled",
    schemaVersion: 1,
    continuationId: CONTINUATION_ID,
    version: 2,
    occurredAt: "2026-07-15T10:02:00.000Z",
    reason: "operator request",
    ...overrides,
  };
}

describe("InMemoryEventStore", () => {
  it("appends and loads an ordered JSON snapshot", async () => {
    const store = new InMemoryEventStore();
    const created = createdEvent();
    const resumed = resumedEvent();

    await store.append(CONTINUATION_ID, 0, [created, resumed]);

    expect(await store.load(CONTINUATION_ID)).toEqual([created, resumed]);
    expect(await store.load("missing-continuation")).toEqual([]);
  });

  it("reports stale compare-and-swap attempts with VersionConflictError", async () => {
    const store = new InMemoryEventStore();
    await store.append(CONTINUATION_ID, 0, [createdEvent()]);

    await expect(store.append(CONTINUATION_ID, 0, [createdEvent()])).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      expectedVersion: 0,
      actualVersion: 1,
    });
  });

  it("rejects non-sequential batches atomically", async () => {
    const store = new InMemoryEventStore();

    await expect(
      store.append(CONTINUATION_ID, 0, [createdEvent(), resumedEvent({ version: 3 })]),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.load(CONTINUATION_ID)).toEqual([]);
  });

  it("rejects malformed events at the persistence boundary", async () => {
    const store = new InMemoryEventStore();
    const malformed = createdEvent({ resumeTokenHash: "not-a-sha256-digest" });

    await expect(store.append(CONTINUATION_ID, 0, [malformed])).rejects.toThrow(
      /does not match schema version 1/,
    );
    expect(await store.load(CONTINUATION_ID)).toEqual([]);
  });
});

describe("SqliteEventStore", () => {
  const stores = new Set<SqliteEventStore>();
  const temporaryDirectories = new Set<string>();

  async function temporaryDatabasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pausemesh-storage-"));
    temporaryDirectories.add(directory);
    return join(directory, "events.sqlite");
  }

  function openStore(databasePath: string): SqliteEventStore {
    const store = new SqliteEventStore(databasePath);
    stores.add(store);
    return store;
  }

  afterEach(async () => {
    for (const store of stores) {
      store.close();
    }
    stores.clear();

    await Promise.all(
      [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.clear();
  });

  it("appends and loads events in stream-version order using WAL", async () => {
    const databasePath = await temporaryDatabasePath();
    const store = openStore(databasePath);
    const created = createdEvent();
    const resumed = resumedEvent();

    await store.append(CONTINUATION_ID, 0, [created]);
    await store.append(CONTINUATION_ID, 1, [resumed]);

    expect(await store.load(CONTINUATION_ID)).toEqual([created, resumed]);
    expect(await store.load("missing-continuation")).toEqual([]);

    const inspector = new DatabaseSync(databasePath);
    try {
      expect(inspector.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      const stored = inspector
        .prepare("SELECT event_json AS eventJson FROM continuation_events ORDER BY version LIMIT 1")
        .get() as { eventJson?: unknown } | undefined;
      expect(typeof stored?.eventJson).toBe("string");
      expect(JSON.parse(String(stored?.eventJson ?? "null"))).toEqual(created);
      expect(() =>
        inspector.prepare("UPDATE continuation_events SET event_json = event_json").run(),
      ).toThrow(/append-only/);
      expect(() => inspector.prepare("DELETE FROM continuation_events").run()).toThrow(
        /append-only/,
      );
    } finally {
      inspector.close();
    }
  });

  it("reports stale compare-and-swap attempts and leaves the stream unchanged", async () => {
    const store = openStore(await temporaryDatabasePath());
    const created = createdEvent();
    await store.append(CONTINUATION_ID, 0, [created]);

    await expect(store.append(CONTINUATION_ID, 0, [createdEvent()])).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      expectedVersion: 0,
      actualVersion: 1,
    });
    expect(await store.load(CONTINUATION_ID)).toEqual([created]);
  });

  it("closes, reopens, and reconstructs the stream by replay", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = openStore(databasePath);
    const events = [createdEvent(), resumedEvent()] as const;
    await first.append(CONTINUATION_ID, 0, events);
    first.close();

    const reopened = openStore(databasePath);
    expect(await reopened.load(CONTINUATION_ID)).toEqual(events);

    expect(() => reopened.close()).not.toThrow();
    expect(() => reopened.close()).not.toThrow();
  });

  it("reports readiness only while the SQLite dependency is open", async () => {
    const store = openStore(await temporaryDatabasePath());

    await expect(store.checkReadiness()).resolves.toBeUndefined();
    store.close();
    await expect(store.checkReadiness()).rejects.toThrow();
  });

  it("allows only one winner when two instances append at the same expected version", async () => {
    const databasePath = await temporaryDatabasePath();
    const first = openStore(databasePath);
    const second = openStore(databasePath);
    await first.append(CONTINUATION_ID, 0, [createdEvent()]);

    const outcomes = await Promise.allSettled([
      first.append(CONTINUATION_ID, 1, [resumedEvent()]),
      second.append(CONTINUATION_ID, 1, [cancelledEvent()]),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toBeInstanceOf(VersionConflictError);
    expect(losers[0]?.reason).toMatchObject({ expectedVersion: 1, actualVersion: 2 });

    const replayed = await first.load(CONTINUATION_ID);
    expect(replayed).toHaveLength(2);
    expect(replayed.map((event) => event.version)).toEqual([1, 2]);
    expect(["continuation.resumed", "continuation.cancelled"]).toContain(replayed[1]?.type);
  });

  it("rejects non-sequential batches without partially appending", async () => {
    const store = openStore(await temporaryDatabasePath());

    await expect(
      store.append(CONTINUATION_ID, 0, [createdEvent(), resumedEvent({ version: 3 })]),
    ).rejects.toMatchObject({ expectedVersion: 2, actualVersion: 3 });
    expect(await store.load(CONTINUATION_ID)).toEqual([]);
  });
});
