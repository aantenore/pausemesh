import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  CONTINUATION_SCHEMA_VERSION,
  ContinuationCancelledError,
  type ContinuationCancelledV1,
  type ContinuationCreatedV1,
  type ContinuationEnvelopeV1,
  type ContinuationEventV1,
  ContinuationExpiredError,
  type ContinuationExpiredV1,
  type ContinuationId,
  ContinuationNotFoundError,
  type ContinuationResumedV1,
  type CorrelationId,
  canonicalJson,
  IdempotencyConflictError,
  type IdempotencyKey,
  InvalidTransitionError,
  type JsonObject,
  type JsonValue,
  type PendingContinuationEnvelopeV1,
  type ResumeTokenHash,
  reduceContinuation,
  replayContinuation,
  TokenAlreadyUsedError,
  TokenMismatchError,
  VersionConflictError,
} from "../domain/index.js";
import type { Clock, EventStore, Observer, TokenIssuer } from "../ports/index.js";

export interface ContinuationServiceDependencies {
  clock: Clock;
  eventStore: EventStore;
  observer: Observer;
  tokenIssuer: TokenIssuer;
  generateId?: () => string;
  tokenTtlSeconds: number;
}

export interface CreateContinuationInput {
  continuationId?: ContinuationId;
  correlationId?: CorrelationId;
  expiresAt?: Date;
  metadata?: JsonObject;
  payload: JsonValue;
}

export interface CreatedContinuation {
  continuation: PendingContinuationEnvelopeV1;
  resumeToken: string;
}

export interface ResumeContinuationInput {
  continuationId: ContinuationId;
  idempotencyKey: IdempotencyKey;
  resumePayload: JsonValue;
  resumeToken: string;
}

export interface CancelContinuationInput {
  continuationId: ContinuationId;
  /** Compare-and-swap fence captured when the cancellation decision was issued. */
  expectedVersion?: number;
  reason?: string;
}

interface ResumeContext {
  continuation: ContinuationEnvelopeV1;
  resumeTokenHash: ResumeTokenHash;
}

function tokenHashesEqual(left: ResumeTokenHash, right: ResumeTokenHash): boolean {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) {
    return false;
  }

  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class ContinuationService {
  readonly #clock: Clock;
  readonly #eventStore: EventStore;
  readonly #generateId: () => string;
  readonly #observer: Observer;
  readonly #tokenIssuer: TokenIssuer;
  readonly #tokenTtlMilliseconds: number;

  constructor(dependencies: ContinuationServiceDependencies) {
    this.#clock = dependencies.clock;
    this.#eventStore = dependencies.eventStore;
    this.#generateId = dependencies.generateId ?? randomUUID;
    this.#observer = dependencies.observer;
    this.#tokenIssuer = dependencies.tokenIssuer;
    this.#tokenTtlMilliseconds = dependencies.tokenTtlSeconds * 1_000;

    if (!Number.isSafeInteger(this.#tokenTtlMilliseconds) || this.#tokenTtlMilliseconds <= 0) {
      throw new RangeError("tokenTtlSeconds must be a positive safe integer");
    }
  }

  async create(input: CreateContinuationInput): Promise<CreatedContinuation> {
    const now = this.#clock.now();
    const continuationId = input.continuationId ?? this.#generateId();
    const correlationId = input.correlationId ?? this.#generateId();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.#tokenTtlMilliseconds);
    if (expiresAt.getTime() <= now.getTime()) {
      throw new RangeError("expiresAt must be later than the creation time");
    }

    const issuedToken = await this.#tokenIssuer.issue();
    const event: ContinuationCreatedV1 = {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      type: "continuation.created",
      continuationId,
      correlationId,
      version: 1,
      occurredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      payload: input.payload,
      metadata: input.metadata ?? {},
      resumeTokenHash: issuedToken.tokenHash,
    };

    await this.#eventStore.append(continuationId, 0, [event]);
    const continuation = reduceContinuation(undefined, event);
    if (continuation.status !== "pending") {
      throw new Error("Creation did not produce a pending continuation");
    }

    await this.#observeSafely({
      name: "continuation.created",
      continuationId,
      correlationId,
      observedAt: now.toISOString(),
      status: "pending",
      version: continuation.version,
    });

    return { continuation, resumeToken: issuedToken.token };
  }

  async inspect(continuationId: ContinuationId): Promise<ContinuationEnvelopeV1> {
    const continuation = await this.#loadRequired(continuationId);
    return this.#expireIfDue(continuation);
  }

  async history(continuationId: ContinuationId): Promise<readonly ContinuationEventV1[]> {
    const events = await this.#eventStore.load(continuationId);
    if (events.length === 0) {
      throw new ContinuationNotFoundError(continuationId);
    }
    return events;
  }

  async resume(input: ResumeContinuationInput): Promise<ContinuationEnvelopeV1> {
    const context = await this.#loadResumeContext(input.continuationId);
    await this.#requireMatchingToken(
      input.continuationId,
      context.resumeTokenHash,
      input.resumeToken,
    );

    const replayed = this.#resolveCompletedResume(context.continuation, input);
    if (replayed !== undefined) {
      return replayed;
    }

    const pending = await this.#requireResumable(context.continuation);

    const now = this.#clock.now();
    const event: ContinuationResumedV1 = {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      type: "continuation.resumed",
      continuationId: input.continuationId,
      version: pending.version + 1,
      occurredAt: now.toISOString(),
      idempotencyKey: input.idempotencyKey,
      resumePayload: input.resumePayload,
    };

    try {
      await this.#eventStore.append(input.continuationId, pending.version, [event]);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) {
        throw error;
      }
      const current = await this.#loadResumeContext(input.continuationId);
      await this.#requireMatchingToken(
        input.continuationId,
        current.resumeTokenHash,
        input.resumeToken,
      );
      const resolved = this.#resolveCompletedResume(current.continuation, input);
      if (resolved !== undefined) {
        return resolved;
      }
      throw error;
    }

    const resumed = reduceContinuation(pending, event);
    await this.#observeSafely({
      name: "continuation.transitioned",
      continuationId: resumed.continuationId,
      observedAt: now.toISOString(),
      status: "resumed",
      version: resumed.version,
    });
    return resumed;
  }

  async cancel(input: CancelContinuationInput): Promise<ContinuationEnvelopeV1> {
    const loaded = await this.#loadRequired(input.continuationId);
    if (loaded.status === "cancelled") {
      return this.#resolveCompletedCancellation(loaded, input);
    }

    const now = this.#clock.now();
    const continuation = await this.#expireIfDue(loaded, now);
    if (continuation.status === "cancelled") {
      return this.#resolveCompletedCancellation(continuation, input);
    }
    if (continuation.status === "expired") {
      throw new ContinuationExpiredError(input.continuationId);
    }
    if (continuation.status !== "pending") {
      throw new InvalidTransitionError(
        input.continuationId,
        continuation.status,
        "continuation.cancelled",
      );
    }
    if (input.expectedVersion !== undefined && continuation.version !== input.expectedVersion) {
      throw new VersionConflictError(
        input.continuationId,
        input.expectedVersion,
        continuation.version,
      );
    }

    const event: ContinuationCancelledV1 = {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      type: "continuation.cancelled",
      continuationId: input.continuationId,
      version: continuation.version + 1,
      occurredAt: now.toISOString(),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    try {
      await this.#eventStore.append(input.continuationId, continuation.version, [event]);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) {
        throw error;
      }
      const current = await this.#loadRequired(input.continuationId);
      if (current.status === "cancelled") {
        return this.#resolveCompletedCancellation(current, input);
      }
      if (current.status === "expired") {
        throw new ContinuationExpiredError(input.continuationId);
      }
      throw error;
    }
    const cancelled = reduceContinuation(continuation, event);
    await this.#observeSafely({
      name: "continuation.transitioned",
      continuationId: cancelled.continuationId,
      observedAt: now.toISOString(),
      status: "cancelled",
      version: cancelled.version,
    });
    return cancelled;
  }

  #resolveCompletedCancellation(
    continuation: Extract<ContinuationEnvelopeV1, { readonly status: "cancelled" }>,
    input: CancelContinuationInput,
  ): ContinuationEnvelopeV1 {
    if (continuation.reason !== input.reason) {
      throw new InvalidTransitionError(
        input.continuationId,
        continuation.status,
        "continuation.cancelled",
      );
    }
    if (input.expectedVersion !== undefined && continuation.version !== input.expectedVersion + 1) {
      throw new VersionConflictError(
        input.continuationId,
        input.expectedVersion,
        continuation.version,
      );
    }
    return continuation;
  }

  async #expireIfDue(
    continuation: ContinuationEnvelopeV1,
    now = this.#clock.now(),
  ): Promise<ContinuationEnvelopeV1> {
    if (continuation.status !== "pending" || now.getTime() < Date.parse(continuation.expiresAt)) {
      return continuation;
    }

    const event: ContinuationExpiredV1 = {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      type: "continuation.expired",
      continuationId: continuation.continuationId,
      version: continuation.version + 1,
      occurredAt: now.toISOString(),
    };

    try {
      await this.#eventStore.append(continuation.continuationId, continuation.version, [event]);
      const expired = reduceContinuation(continuation, event);
      await this.#observeSafely({
        name: "continuation.transitioned",
        continuationId: expired.continuationId,
        observedAt: now.toISOString(),
        status: "expired",
        version: expired.version,
      });
      return expired;
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return this.#loadRequired(continuation.continuationId);
      }
      throw error;
    }
  }

  async #loadRequired(continuationId: ContinuationId): Promise<ContinuationEnvelopeV1> {
    const state = replayContinuation(await this.#eventStore.load(continuationId));
    if (state === undefined) {
      throw new ContinuationNotFoundError(continuationId);
    }
    return state;
  }

  async #loadResumeContext(continuationId: ContinuationId): Promise<ResumeContext> {
    const events = await this.#eventStore.load(continuationId);
    const continuation = replayContinuation(events);
    if (continuation === undefined) {
      throw new ContinuationNotFoundError(continuationId);
    }

    const created = events[0];
    if (created?.type !== "continuation.created") {
      throw new Error("Continuation history does not begin with a creation event");
    }
    return { continuation, resumeTokenHash: created.resumeTokenHash };
  }

  async #requireMatchingToken(
    continuationId: ContinuationId,
    expectedTokenHash: ResumeTokenHash,
    token: string,
  ): Promise<void> {
    const actualTokenHash = await this.#tokenIssuer.hash(token);
    if (tokenHashesEqual(expectedTokenHash, actualTokenHash)) {
      return;
    }

    await this.#reject(continuationId, "TOKEN_MISMATCH");
    throw new TokenMismatchError(continuationId);
  }

  #resolveCompletedResume(
    continuation: ContinuationEnvelopeV1,
    input: ResumeContinuationInput,
  ): ContinuationEnvelopeV1 | undefined {
    if (continuation.status !== "resumed") {
      return undefined;
    }
    if (continuation.idempotencyKey !== input.idempotencyKey) {
      throw new TokenAlreadyUsedError(input.continuationId);
    }
    if (canonicalJson(continuation.resumePayload) !== canonicalJson(input.resumePayload)) {
      throw new IdempotencyConflictError(input.continuationId);
    }
    return continuation;
  }

  async #requireResumable(
    continuation: ContinuationEnvelopeV1,
  ): Promise<PendingContinuationEnvelopeV1> {
    const current = await this.#expireIfDue(continuation);
    switch (current.status) {
      case "pending":
        return current;
      case "expired":
        throw new ContinuationExpiredError(current.continuationId);
      case "cancelled":
        throw new ContinuationCancelledError(current.continuationId);
      case "resumed":
        throw new TokenAlreadyUsedError(current.continuationId);
    }
  }

  async #reject(continuationId: ContinuationId, code: "TOKEN_MISMATCH"): Promise<void> {
    await this.#observeSafely({
      name: "continuation.rejected",
      continuationId,
      observedAt: this.#clock.now().toISOString(),
      code,
    });
  }

  async #observeSafely(event: Parameters<Observer["observe"]>[0]): Promise<void> {
    try {
      await this.#observer.observe(event);
    } catch {
      // Observability must never change an already committed continuation outcome.
    }
  }
}
