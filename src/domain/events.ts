import type {
  ContinuationId,
  ContinuationSchemaVersion,
  ContinuationVersion,
  CorrelationId,
  IdempotencyKey,
  IsoTimestamp,
  JsonObject,
  JsonValue,
  ResumeTokenHash,
} from "./types.js";

export interface ContinuationEventBaseV1 {
  readonly schemaVersion: ContinuationSchemaVersion;
  readonly continuationId: ContinuationId;
  readonly version: ContinuationVersion;
  readonly occurredAt: IsoTimestamp;
}

export interface ContinuationCreatedV1 extends ContinuationEventBaseV1 {
  readonly type: "continuation.created";
  readonly correlationId: CorrelationId;
  readonly expiresAt: IsoTimestamp;
  readonly payload: JsonValue;
  readonly metadata: JsonObject;
  readonly resumeTokenHash: ResumeTokenHash;
}

export interface ContinuationResumedV1 extends ContinuationEventBaseV1 {
  readonly type: "continuation.resumed";
  readonly idempotencyKey: IdempotencyKey;
  readonly resumePayload: JsonValue;
}

export interface ContinuationCancelledV1 extends ContinuationEventBaseV1 {
  readonly type: "continuation.cancelled";
  readonly reason?: string;
}

export interface ContinuationExpiredV1 extends ContinuationEventBaseV1 {
  readonly type: "continuation.expired";
}

/** Persisted lifecycle event union. It intentionally contains token hashes, never raw tokens. */
export type ContinuationEventV1 =
  | ContinuationCreatedV1
  | ContinuationResumedV1
  | ContinuationCancelledV1
  | ContinuationExpiredV1;

export type ContinuationEvent = ContinuationEventV1;
export type ContinuationEventType = ContinuationEventV1["type"];
