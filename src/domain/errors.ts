import type { ContinuationId, ContinuationStatus, ContinuationVersion } from "./types.js";

export type PauseMeshErrorCode =
  | "CONTINUATION_CANCELLED"
  | "CONTINUATION_EXPIRED"
  | "CONTINUATION_ID_MISMATCH"
  | "CONTINUATION_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "TOKEN_ALREADY_USED"
  | "TOKEN_MISMATCH"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "VERSION_CONFLICT";

export abstract class PauseMeshError extends Error {
  readonly code: PauseMeshErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  protected constructor(
    code: PauseMeshErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ContinuationNotFoundError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super("CONTINUATION_NOT_FOUND", `Continuation ${continuationId} was not found`, {
      continuationId,
    });
  }
}

export class VersionConflictError extends PauseMeshError {
  constructor(
    readonly continuationId: ContinuationId,
    readonly expectedVersion: ContinuationVersion,
    readonly actualVersion: ContinuationVersion,
  ) {
    super(
      "VERSION_CONFLICT",
      `Continuation ${continuationId} expected version ${expectedVersion}, received ${actualVersion}`,
      { actualVersion, continuationId, expectedVersion },
    );
  }
}

export class InvalidTransitionError extends PauseMeshError {
  constructor(
    readonly continuationId: ContinuationId,
    readonly fromStatus: ContinuationStatus | "missing",
    readonly eventType: string,
  ) {
    super(
      "INVALID_TRANSITION",
      `Cannot apply ${eventType} to continuation ${continuationId} in state ${fromStatus}`,
      { continuationId, eventType, fromStatus },
    );
  }
}

export class ContinuationIdMismatchError extends PauseMeshError {
  constructor(
    readonly expectedContinuationId: ContinuationId,
    readonly actualContinuationId: ContinuationId,
  ) {
    super(
      "CONTINUATION_ID_MISMATCH",
      `Expected continuation ${expectedContinuationId}, received event for ${actualContinuationId}`,
      { actualContinuationId, expectedContinuationId },
    );
  }
}

export class UnsupportedSchemaVersionError extends PauseMeshError {
  constructor(readonly schemaVersion: number) {
    super(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported continuation schema version ${schemaVersion}`,
      {
        schemaVersion,
      },
    );
  }
}

export class TokenMismatchError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super("TOKEN_MISMATCH", `Resume token did not match continuation ${continuationId}`, {
      continuationId,
    });
  }
}

export class TokenAlreadyUsedError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super(
      "TOKEN_ALREADY_USED",
      `Resume token for continuation ${continuationId} was already consumed`,
      {
        continuationId,
      },
    );
  }
}

export class ContinuationExpiredError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super("CONTINUATION_EXPIRED", `Continuation ${continuationId} has expired`, {
      continuationId,
    });
  }
}

export class ContinuationCancelledError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super("CONTINUATION_CANCELLED", `Continuation ${continuationId} was cancelled`, {
      continuationId,
    });
  }
}

export class IdempotencyConflictError extends PauseMeshError {
  constructor(readonly continuationId: ContinuationId) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key conflicts with the completed request for continuation ${continuationId}`,
      { continuationId },
    );
  }
}
