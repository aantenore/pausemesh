import { VersionConflictError } from "../../domain/errors.js";
import type { ContinuationEventV1 } from "../../domain/events.js";
import type { ContinuationId, ContinuationVersion } from "../../domain/types.js";
import type { EventStore } from "../../ports/event-store.js";
import type { ReadinessProbe } from "../../ports/readiness.js";
import { deserializeEvent, serializeAppendBatch } from "./event-serialization.js";

/**
 * Process-local event store with the same JSON snapshot and optimistic concurrency semantics as
 * the durable SQLite adapter.
 */
export class InMemoryEventStore implements EventStore, ReadinessProbe {
  readonly #streams = new Map<ContinuationId, readonly string[]>();

  async load(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]> {
    return (this.#streams.get(continuationId) ?? []).map(deserializeEvent);
  }

  async append(
    continuationId: ContinuationId,
    expectedVersion: ContinuationVersion,
    events: readonly ContinuationEventV1[],
  ): Promise<void> {
    const stream = this.#streams.get(continuationId) ?? [];
    const actualVersion = stream.length;
    if (actualVersion !== expectedVersion) {
      throw new VersionConflictError(continuationId, expectedVersion, actualVersion);
    }

    const serializedEvents = serializeAppendBatch(continuationId, expectedVersion, events);
    if (serializedEvents.length > 0) {
      this.#streams.set(continuationId, [...stream, ...serializedEvents]);
    }
  }

  async checkReadiness(): Promise<void> {}
}
