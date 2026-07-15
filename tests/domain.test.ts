import { describe, expect, it } from "vitest";
import {
  ContinuationIdMismatchError,
  InvalidTransitionError,
  VersionConflictError,
} from "../src/domain/errors.js";
import type {
  ContinuationCancelledV1,
  ContinuationCreatedV1,
  ContinuationExpiredV1,
  ContinuationResumedV1,
} from "../src/domain/events.js";
import { reduceContinuation, replayContinuation } from "../src/domain/reducer.js";

const RAW_TOKEN = "raw-token-that-must-never-be-persisted";
const TOKEN_HASH = "sha256:97ea58d8";

function createdEvent(overrides: Partial<ContinuationCreatedV1> = {}): ContinuationCreatedV1 {
  return {
    type: "continuation.created",
    schemaVersion: 1,
    continuationId: "cont-1",
    correlationId: "corr-1",
    version: 1,
    occurredAt: "2026-07-15T10:00:00.000Z",
    expiresAt: "2026-07-15T10:15:00.000Z",
    payload: { action: "approve", amount: 42 },
    metadata: { source: "test" },
    resumeTokenHash: TOKEN_HASH,
    ...overrides,
  };
}

function resumedEvent(overrides: Partial<ContinuationResumedV1> = {}): ContinuationResumedV1 {
  return {
    type: "continuation.resumed",
    schemaVersion: 1,
    continuationId: "cont-1",
    version: 2,
    occurredAt: "2026-07-15T10:01:00.000Z",
    idempotencyKey: "request-1",
    resumePayload: { approved: true },
    ...overrides,
  };
}

describe("continuation reducer", () => {
  it("creates a versioned pending ContinuationEnvelope v1", () => {
    const state = reduceContinuation(undefined, createdEvent());

    expect(state).toMatchObject({
      schemaVersion: 1,
      continuationId: "cont-1",
      correlationId: "corr-1",
      version: 1,
      status: "pending",
      resumeTokenHash: TOKEN_HASH,
    });
  });

  it("resumes once, models idempotency, and consumes the token hash", () => {
    const pending = reduceContinuation(undefined, createdEvent());
    const resumed = reduceContinuation(pending, resumedEvent());

    expect(resumed).toMatchObject({
      status: "resumed",
      version: 2,
      resumedAt: "2026-07-15T10:01:00.000Z",
      idempotencyKey: "request-1",
      resumePayload: { approved: true },
    });
    expect("resumeTokenHash" in resumed).toBe(false);

    expect(() =>
      reduceContinuation(resumed, resumedEvent({ version: 3, idempotencyKey: "request-2" })),
    ).toThrowError(InvalidTransitionError);
  });

  it("transitions pending continuations to cancelled", () => {
    const pending = reduceContinuation(undefined, createdEvent());
    const event: ContinuationCancelledV1 = {
      type: "continuation.cancelled",
      schemaVersion: 1,
      continuationId: "cont-1",
      version: 2,
      occurredAt: "2026-07-15T10:02:00.000Z",
      reason: "operator request",
    };

    const cancelled = reduceContinuation(pending, event);

    expect(cancelled).toMatchObject({
      status: "cancelled",
      version: 2,
      cancelledAt: event.occurredAt,
      reason: "operator request",
    });
    expect("resumeTokenHash" in cancelled).toBe(false);
  });

  it("transitions pending continuations to expired", () => {
    const pending = reduceContinuation(undefined, createdEvent());
    const event: ContinuationExpiredV1 = {
      type: "continuation.expired",
      schemaVersion: 1,
      continuationId: "cont-1",
      version: 2,
      occurredAt: "2026-07-15T10:15:00.000Z",
    };

    const expired = reduceContinuation(pending, event);

    expect(expired).toMatchObject({
      status: "expired",
      version: 2,
      expiredAt: event.occurredAt,
    });
    expect("resumeTokenHash" in expired).toBe(false);
  });

  it("reconstructs the same idempotent result by replay", () => {
    const state = replayContinuation([createdEvent(), resumedEvent()]);

    expect(state).toMatchObject({
      status: "resumed",
      idempotencyKey: "request-1",
      resumePayload: { approved: true },
    });
  });

  it("rejects missing or stale event versions with a typed CAS error", () => {
    const pending = reduceContinuation(undefined, createdEvent());

    expect(() => reduceContinuation(pending, resumedEvent({ version: 4 }))).toThrowError(
      VersionConflictError,
    );

    try {
      reduceContinuation(pending, resumedEvent({ version: 1 }));
      throw new Error("expected version conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({
        code: "VERSION_CONFLICT",
        expectedVersion: 2,
        actualVersion: 1,
      });
    }
  });

  it("rejects events from another continuation", () => {
    const pending = reduceContinuation(undefined, createdEvent());

    expect(() =>
      reduceContinuation(pending, resumedEvent({ continuationId: "cont-other" })),
    ).toThrowError(ContinuationIdMismatchError);
  });

  it("cannot start a stream with a terminal event", () => {
    expect(() => reduceContinuation(undefined, resumedEvent({ version: 1 }))).toThrowError(
      InvalidTransitionError,
    );
  });

  it("never serializes the raw token in persisted events or envelopes", () => {
    const event = createdEvent();
    const state = reduceContinuation(undefined, event);

    expect(JSON.stringify([event, state])).not.toContain(RAW_TOKEN);
    expect(Object.keys(event)).not.toContain("token");
    expect(Object.keys(state)).not.toContain("token");
  });
});
