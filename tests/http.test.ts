import { describe, expect, it } from "vitest";
import { Sha256TokenIssuer } from "../src/adapters/crypto/sha256-token-issuer.js";
import { createHttpApp } from "../src/adapters/http/index.js";
import { InMemoryEventStore } from "../src/adapters/storage/index.js";
import { ContinuationService } from "../src/application/index.js";
import { NoopObserver } from "../src/observability/pino-observer.js";

function app() {
  const service = new ContinuationService({
    clock: { now: () => new Date("2026-07-15T08:00:00.000Z") },
    eventStore: new InMemoryEventStore(),
    generateId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
    observer: new NoopObserver(),
    tokenIssuer: new Sha256TokenIssuer(),
    tokenTtlSeconds: 300,
  });
  return createHttpApp({ maxPayloadBytes: 4_096, service });
}

describe("HTTP adapter", () => {
  it("creates, projects, resumes, and inspects a continuation", async () => {
    const api = app();
    const createdResponse = await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        continuationId: "http-1",
        correlationId: "thread-http",
        payload: { kind: "input", message: "Choose" },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { resumeToken: string };

    const projection = await api.request("/v1/continuations/http-1/projections/ag-ui");
    expect(projection.status).toBe(200);
    expect(await projection.json()).toMatchObject({
      projection: { type: "RUN_FINISHED", threadId: "thread-http" },
    });

    const resumed = await api.request("/v1/continuations/http-1/resume", {
      method: "POST",
      headers: {
        authorization: `PauseMesh ${created.resumeToken}`,
        "content-type": "application/json",
        "idempotency-key": "http-request-1",
      },
      body: JSON.stringify({ payload: { choice: "one" } }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ continuation: { status: "resumed", version: 2 } });
  });

  it("returns typed safe errors and never echoes a bad token", async () => {
    const api = app();
    await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuationId: "http-2", payload: {} }),
    });
    const response = await api.request("/v1/continuations/http-2/resume", {
      method: "POST",
      headers: {
        authorization: "PauseMesh secret-bad-token",
        "content-type": "application/json",
        "idempotency-key": "http-request-2",
      },
      body: JSON.stringify({ payload: {} }),
    });
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(401);
    expect(body).toContain("TOKEN_MISMATCH");
    expect(body).not.toContain("secret-bad-token");
  });

  it("rejects oversized JSON", async () => {
    const api = app();
    const response = await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { value: "x".repeat(5_000) } }),
    });
    expect(response.status).toBe(413);
  });
});
