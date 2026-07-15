import type { ResumeTokenHash } from "../domain/types.js";

/** Ephemeral issuance result. `token` must be returned to the caller and never persisted. */
export interface IssuedResumeToken {
  readonly token: string;
  readonly tokenHash: ResumeTokenHash;
}

export interface TokenIssuer {
  issue(): Promise<IssuedResumeToken>;
  hash(token: string): Promise<ResumeTokenHash>;
}
