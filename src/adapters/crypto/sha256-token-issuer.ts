import { createHash, randomBytes } from "node:crypto";
import type { ResumeTokenHash } from "../../domain/index.js";
import type { IssuedResumeToken, TokenIssuer } from "../../ports/index.js";

export interface Sha256TokenIssuerOptions {
  tokenBytes?: number;
}

export class Sha256TokenIssuer implements TokenIssuer {
  readonly #tokenBytes: number;

  constructor(options: Sha256TokenIssuerOptions = {}) {
    this.#tokenBytes = options.tokenBytes ?? 32;
    if (!Number.isInteger(this.#tokenBytes) || this.#tokenBytes < 16) {
      throw new RangeError("tokenBytes must be an integer greater than or equal to 16");
    }
  }

  async issue(): Promise<IssuedResumeToken> {
    const token = randomBytes(this.#tokenBytes).toString("base64url");
    return { token, tokenHash: await this.hash(token) };
  }

  async hash(token: string): Promise<ResumeTokenHash> {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}
