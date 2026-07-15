export const CONTINUATION_SCHEMA_VERSION = 1 as const;
export const INITIAL_CONTINUATION_VERSION = 0 as const;

export type ContinuationSchemaVersion = typeof CONTINUATION_SCHEMA_VERSION;
export type ContinuationVersion = number;
export type ContinuationId = string;
export type CorrelationId = string;
export type IdempotencyKey = string;
export type IsoTimestamp = string;
export type ResumeTokenHash = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ContinuationStatus = "pending" | "resumed" | "cancelled" | "expired";
export type TerminalContinuationStatus = Exclude<ContinuationStatus, "pending">;

export interface ContinuationEnvelopeBaseV1 {
  readonly schemaVersion: ContinuationSchemaVersion;
  readonly continuationId: ContinuationId;
  readonly correlationId: CorrelationId;
  readonly version: ContinuationVersion;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly payload: JsonValue;
  readonly metadata: JsonObject;
}

export interface PendingContinuationEnvelopeV1 extends ContinuationEnvelopeBaseV1 {
  readonly status: "pending";
  readonly resumeTokenHash: ResumeTokenHash;
}

export interface ResumedContinuationEnvelopeV1 extends ContinuationEnvelopeBaseV1 {
  readonly status: "resumed";
  readonly resumedAt: IsoTimestamp;
  readonly idempotencyKey: IdempotencyKey;
  readonly resumePayload: JsonValue;
  readonly resumeTokenHash?: never;
}

export interface CancelledContinuationEnvelopeV1 extends ContinuationEnvelopeBaseV1 {
  readonly status: "cancelled";
  readonly cancelledAt: IsoTimestamp;
  readonly reason?: string;
  readonly resumeTokenHash?: never;
}

export interface ExpiredContinuationEnvelopeV1 extends ContinuationEnvelopeBaseV1 {
  readonly status: "expired";
  readonly expiredAt: IsoTimestamp;
  readonly resumeTokenHash?: never;
}

/**
 * Canonical persisted state. Raw resume tokens deliberately have no place in this type.
 */
export type ContinuationEnvelopeV1 =
  | PendingContinuationEnvelopeV1
  | ResumedContinuationEnvelopeV1
  | CancelledContinuationEnvelopeV1
  | ExpiredContinuationEnvelopeV1;

export type ContinuationEnvelope = ContinuationEnvelopeV1;
