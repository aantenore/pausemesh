import type { ContinuationEventV1 } from "../domain/events.js";
import type { ContinuationId, ContinuationVersion } from "../domain/types.js";

/**
 * Append-only continuation event store.
 *
 * `append` must atomically compare the stream's current version with `expectedVersion` and append
 * all events or none. Implementations report a mismatch with `VersionConflictError`. Version zero
 * represents a stream that does not yet exist.
 */
export interface EventStore {
  load(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]>;

  append(
    continuationId: ContinuationId,
    expectedVersion: ContinuationVersion,
    events: readonly ContinuationEventV1[],
  ): Promise<void>;
}
