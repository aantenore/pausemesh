import {
  ContinuationIdMismatchError,
  InvalidTransitionError,
  UnsupportedSchemaVersionError,
  VersionConflictError,
} from "./errors.js";
import type { ContinuationEventV1 } from "./events.js";
import {
  CONTINUATION_SCHEMA_VERSION,
  type ContinuationEnvelopeBaseV1,
  type ContinuationEnvelopeV1,
  type PendingContinuationEnvelopeV1,
} from "./types.js";

function terminalBase(
  state: PendingContinuationEnvelopeV1,
  version: number,
): ContinuationEnvelopeBaseV1 {
  return {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    continuationId: state.continuationId,
    correlationId: state.correlationId,
    version,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    payload: state.payload,
    metadata: state.metadata,
  };
}

function assertEventIdentity(state: ContinuationEnvelopeV1, event: ContinuationEventV1): void {
  if (state.continuationId !== event.continuationId) {
    throw new ContinuationIdMismatchError(state.continuationId, event.continuationId);
  }
}

function assertVersion(
  state: ContinuationEnvelopeV1 | undefined,
  event: ContinuationEventV1,
): void {
  const expectedVersion = (state?.version ?? 0) + 1;
  if (event.version !== expectedVersion) {
    throw new VersionConflictError(event.continuationId, expectedVersion, event.version);
  }
}

function assertPending(
  state: ContinuationEnvelopeV1,
  event: ContinuationEventV1,
): asserts state is PendingContinuationEnvelopeV1 {
  if (state.status !== "pending") {
    throw new InvalidTransitionError(state.continuationId, state.status, event.type);
  }
}

/**
 * Pure continuation state machine. Persistence adapters must perform the same version check
 * atomically when appending; this reducer validates event streams during live use and replay.
 */
export function reduceContinuation(
  state: ContinuationEnvelopeV1 | undefined,
  event: ContinuationEventV1,
): ContinuationEnvelopeV1 {
  if (event.schemaVersion !== CONTINUATION_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(event.schemaVersion);
  }

  if (state !== undefined) {
    assertEventIdentity(state, event);
  }
  assertVersion(state, event);

  if (state === undefined) {
    if (event.type !== "continuation.created") {
      throw new InvalidTransitionError(event.continuationId, "missing", event.type);
    }

    return {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      continuationId: event.continuationId,
      correlationId: event.correlationId,
      version: event.version,
      status: "pending",
      createdAt: event.occurredAt,
      expiresAt: event.expiresAt,
      payload: event.payload,
      metadata: event.metadata,
      resumeTokenHash: event.resumeTokenHash,
    };
  }

  if (event.type === "continuation.created") {
    throw new InvalidTransitionError(state.continuationId, state.status, event.type);
  }

  assertPending(state, event);
  const base = terminalBase(state, event.version);

  switch (event.type) {
    case "continuation.resumed":
      return {
        ...base,
        status: "resumed",
        resumedAt: event.occurredAt,
        idempotencyKey: event.idempotencyKey,
        resumePayload: event.resumePayload,
      };
    case "continuation.cancelled":
      return {
        ...base,
        status: "cancelled",
        cancelledAt: event.occurredAt,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
    case "continuation.expired":
      return {
        ...base,
        status: "expired",
        expiredAt: event.occurredAt,
      };
  }
}

export function replayContinuation(
  events: readonly ContinuationEventV1[],
): ContinuationEnvelopeV1 | undefined {
  return events.reduce<ContinuationEnvelopeV1 | undefined>(reduceContinuation, undefined);
}
