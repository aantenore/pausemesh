import type { PauseMeshErrorCode } from "../domain/errors.js";
import type {
  ContinuationId,
  ContinuationStatus,
  ContinuationVersion,
  CorrelationId,
  IsoTimestamp,
} from "../domain/types.js";

interface ContinuationObservationBase {
  readonly continuationId: ContinuationId;
  readonly observedAt: IsoTimestamp;
}

export type ContinuationObservation =
  | (ContinuationObservationBase & {
      readonly name: "continuation.created";
      readonly correlationId: CorrelationId;
      readonly version: ContinuationVersion;
      readonly status: "pending";
    })
  | (ContinuationObservationBase & {
      readonly name: "continuation.transitioned";
      readonly version: ContinuationVersion;
      readonly status: Exclude<ContinuationStatus, "pending">;
    })
  | (ContinuationObservationBase & {
      readonly name: "continuation.rejected";
      readonly code: PauseMeshErrorCode;
    });

/** Receives deliberately redacted lifecycle facts; observations contain no token or payload. */
export interface Observer {
  observe(event: ContinuationObservation): void | Promise<void>;
}
