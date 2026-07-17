import { describe, expect, it, vi } from "vitest";
import { Sha256TokenIssuer } from "../src/adapters/crypto/sha256-token-issuer.js";
import { createHttpApp } from "../src/adapters/http/index.js";
import type { McpProjectionPolicy } from "../src/adapters/mcp/elicitation.js";
import { InMemoryEventStore } from "../src/adapters/storage/index.js";
import { ContinuationService } from "../src/application/index.js";
import { NoopObserver } from "../src/observability/pino-observer.js";

function app(mcpProjectionPolicy?: McpProjectionPolicy) {
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
  return createHttpApp({
    maxPayloadBytes: 4_096,
    service,
    ...(mcpProjectionPolicy === undefined ? {} : { mcpProjectionPolicy }),
  });
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

    const mcpProjection = await api.request("/v1/continuations/http-1/projections/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientCapabilities: { elicitation: { form: {} } },
        relatedTask: { taskId: "mcp-parent-1" },
        requestId: "mcp-request-1",
      }),
    });
    expect(mcpProjection.status).toBe(200);
    expect(await mcpProjection.json()).toMatchObject({
      projection: {
        jsonrpc: "2.0",
        id: "mcp-request-1",
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Choose",
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            "io.pausemesh/continuation": {
              continuationId: "http-1",
              correlationId: "thread-http",
              expiresAt: "2026-07-15T08:05:00.000Z",
              requestId: "mcp-request-1",
              schemaVersion: 1,
            },
            "io.modelcontextprotocol/related-task": { taskId: "mcp-parent-1" },
          },
        },
      },
      receipt: {
        schemaVersion: 1,
        continuationId: "http-1",
        correlationId: "thread-http",
        mode: "form",
        requestId: "mcp-request-1",
        requestHash: expect.stringMatching(/^[a-f\d]{64}$/),
      },
    });

    const a2aProjection = await api.request("/v1/continuations/http-1/projections/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextId: "thread-http", taskId: "a2a-task-1" }),
    });
    expect(a2aProjection.status).toBe(200);
    expect(await a2aProjection.json()).toEqual({
      projection: {
        task: {
          id: "a2a-task-1",
          contextId: "thread-http",
          status: {
            state: "TASK_STATE_INPUT_REQUIRED",
            message: {
              role: "ROLE_AGENT",
              messageId: "http-1",
              contextId: "thread-http",
              taskId: "a2a-task-1",
              parts: [{ text: "Choose" }],
            },
            timestamp: "2026-07-15T08:00:00.000Z",
          },
          metadata: {
            pausemesh: {
              continuationId: "http-1",
              expiresAt: "2026-07-15T08:05:00.000Z",
              schemaVersion: 1,
            },
          },
        },
      },
    });

    const aguiProjection = await api.request("/v1/continuations/http-1/projections/ag-ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "agui-run-1", threadId: "thread-http" }),
    });
    expect(aguiProjection.status).toBe(200);
    const aguiBody = await aguiProjection.json();
    expect(aguiBody).toMatchObject({
      projection: {
        type: "RUN_FINISHED",
        threadId: "thread-http",
        runId: "agui-run-1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "http-1",
              reason: "input_required",
              message: "Choose",
              expiresAt: "2026-07-15T08:05:00.000Z",
              metadata: {
                pausemesh: {
                  continuationId: "http-1",
                  schemaVersion: 1,
                },
              },
            },
          ],
        },
      },
      receipt: {
        schemaVersion: 1,
        cohortId: expect.stringMatching(/^agui-cohort:[a-f\d]{64}$/),
        threadId: "thread-http",
        runId: "agui-run-1",
        interrupts: [
          {
            continuationId: "http-1",
            expiresAt: "2026-07-15T08:05:00.000Z",
            issuedVersion: 1,
            payloadHash: expect.stringMatching(/^[a-f\d]{64}$/),
          },
        ],
      },
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

    const unauthenticatedRetry = await api.request("/v1/continuations/http-1/resume", {
      method: "POST",
      headers: {
        authorization: "PauseMesh wrong-token",
        "content-type": "application/json",
        "idempotency-key": "http-request-1",
      },
      body: JSON.stringify({ payload: { choice: "one" } }),
    });
    expect(unauthenticatedRetry.status).toBe(401);
  });

  it("rejects invalid projection capabilities and bindings", async () => {
    const api = app();
    await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        continuationId: "http-projection-errors",
        correlationId: "thread-http",
        payload: { kind: "input", message: "Choose" },
      }),
    });

    const unsupportedMcpCapability = await api.request(
      "/v1/continuations/http-projection-errors/projections/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientCapabilities: {}, requestId: "mcp-request-invalid" }),
      },
    );
    expect(unsupportedMcpCapability.status).toBe(400);
    expect(await unsupportedMcpCapability.json()).toEqual({
      error: {
        code: "UNSUPPORTED_PROTOCOL_CAPABILITY",
        message: "MCP client did not declare the elicitation capability",
      },
    });

    const requestControlledHttpPolicy = await api.request(
      "/v1/continuations/http-projection-errors/projections/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowInsecureHttp: true,
          clientCapabilities: { elicitation: { form: {} } },
          requestId: "mcp-request-invalid-policy",
        }),
      },
    );
    expect(requestControlledHttpPolicy.status).toBe(400);
    expect(await requestControlledHttpPolicy.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "Request validation failed" },
    });

    const transformedOpaqueId = await api.request(
      "/v1/continuations/http-projection-errors/projections/a2a",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextId: "thread-http", taskId: " a2a-task-1 " }),
      },
    );
    expect(transformedOpaqueId.status).toBe(400);
    expect(await transformedOpaqueId.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "Request validation failed" },
    });

    const invalidA2ABinding = await api.request(
      "/v1/continuations/http-projection-errors/projections/a2a",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextId: "wrong-thread", taskId: "a2a-task-1" }),
      },
    );
    expect(invalidA2ABinding.status).toBe(400);
    expect(await invalidA2ABinding.json()).toEqual({
      error: {
        code: "INVALID_PROTOCOL_BINDING",
        message: "A2A task binding context does not match the continuation correlation ID",
      },
    });

    const invalidAguiBinding = await api.request(
      "/v1/continuations/http-projection-errors/projections/ag-ui",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "agui-run-1", threadId: "wrong-thread" }),
      },
    );
    expect(invalidAguiBinding.status).toBe(400);
    expect(await invalidAguiBinding.json()).toEqual({
      error: {
        code: "INVALID_PROTOCOL_BINDING",
        message: "AG-UI run binding thread does not match the continuation correlation ID",
      },
    });

    await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        continuationId: "http-url-policy",
        correlationId: "thread-http",
        payload: { kind: "authorization", message: "Authorize out of band" },
      }),
    });
    const missingTrustedUrlPolicy = await api.request(
      "/v1/continuations/http-url-policy/projections/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientCapabilities: { elicitation: { url: {} } },
          requestId: "mcp-url-no-policy",
          urlBinding: {
            elicitationId: "elicitation-http-1",
            url: "https://auth.example/authorize",
          },
        }),
      },
    );
    expect(missingTrustedUrlPolicy.status).toBe(400);
    expect(await missingTrustedUrlPolicy.json()).toEqual({
      error: {
        code: "INVALID_PROTOCOL_BINDING",
        message: "MCP URL elicitation requires a trusted authorization-URL validation policy",
      },
    });
  });

  it("rejects terminal projections and the removed GET projection route", async () => {
    const api = app();
    const createdResponse = await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        continuationId: "http-terminal",
        correlationId: "thread-http",
        payload: { kind: "input", message: "Choose" },
      }),
    });
    const created = (await createdResponse.json()) as { resumeToken: string };

    const oldGetProjection = await api.request("/v1/continuations/http-terminal/projections/ag-ui");
    expect(oldGetProjection.status).toBe(404);

    const resumed = await api.request("/v1/continuations/http-terminal/resume", {
      method: "POST",
      headers: {
        authorization: `PauseMesh ${created.resumeToken}`,
        "content-type": "application/json",
        "idempotency-key": "http-terminal-resume",
      },
      body: JSON.stringify({ payload: { choice: "one" } }),
    });
    expect(resumed.status).toBe(200);

    const terminalProjection = await api.request(
      "/v1/continuations/http-terminal/projections/ag-ui",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "agui-run-terminal", threadId: "thread-http" }),
      },
    );
    expect(terminalProjection.status).toBe(409);
    expect(await terminalProjection.json()).toEqual({
      error: {
        code: "INVALID_PROTOCOL_TRANSITION",
        message: "Cannot project a resumed continuation as an AG-UI interrupt",
      },
    });
  });

  it("injects trusted MCP URL policy at the host boundary and returns its receipt", async () => {
    const validateAuthorizationUrl = vi.fn((url: URL) => url.origin === "https://auth.example");
    const api = app({ validateAuthorizationUrl });
    await api.request("/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        continuationId: "http-url-policy-success",
        correlationId: "thread-http-url",
        payload: { kind: "authorization", message: "Authorize out of band" },
      }),
    });

    const response = await api.request(
      "/v1/continuations/http-url-policy-success/projections/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientCapabilities: { elicitation: { url: {} } },
          requestId: "mcp-url-policy-success",
          urlBinding: {
            elicitationId: "elicitation-http-success",
            url: "https://auth.example/authorize?client_id=pausemesh",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projection: {
        id: "mcp-url-policy-success",
        params: {
          mode: "url",
          elicitationId: "elicitation-http-success",
          url: "https://auth.example/authorize?client_id=pausemesh",
        },
      },
      receipt: {
        continuationId: "http-url-policy-success",
        correlationId: "thread-http-url",
        mode: "url",
        requestId: "mcp-url-policy-success",
        requestHash: expect.stringMatching(/^[a-f\d]{64}$/),
        schemaVersion: 1,
      },
    });
    expect(validateAuthorizationUrl).toHaveBeenCalledOnce();
    expect(validateAuthorizationUrl.mock.calls[0]?.[0]).toBeInstanceOf(URL);
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

  it("stops reading an oversized streaming body before JSON parsing", async () => {
    const api = app();
    let emittedChunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(new Uint8Array(1_024).fill(0x78));
        if (emittedChunks === 100) controller.close();
      },
    });
    const request = new Request("http://localhost/v1/continuations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.has("content-length")).toBe(false);

    const response = await api.request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "JSON payload exceeds 4096 bytes",
      },
    });
    expect(emittedChunks).toBeLessThan(100);
  });
});
