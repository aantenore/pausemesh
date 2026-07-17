import { describe, expect, it } from "vitest";
import {
  issueMcpElicitation,
  type McpElicitationIssuance,
  type McpElicitRequest,
  type McpUrlElicitRequest,
  parseMcpElicitResult,
  toMcpElicitationCompleteNotification,
  toMcpElicitRequest,
} from "../src/adapters/mcp/elicitation.js";
import { ProtocolAdapterError } from "../src/adapters/protocol-error.js";
import type { ContinuationEnvelopeV1, JsonValue } from "../src/domain/index.js";

const FORM_CAPABILITY = { elicitation: { form: {} } } as const;
const URL_CAPABILITY = { elicitation: { url: {} } } as const;
const TRUSTED_URL_POLICY = { validateAuthorizationUrl: () => true } as const;

function pendingContinuation(payload: JsonValue): ContinuationEnvelopeV1 {
  return {
    schemaVersion: 1,
    continuationId: "continuation-1",
    correlationId: "thread-1",
    version: 0,
    createdAt: "2026-07-17T08:00:00.000Z",
    expiresAt: "2026-07-17T08:05:00.000Z",
    status: "pending",
    payload,
    metadata: {},
    resumeTokenHash: "sha256:opaque",
  };
}

function inputContinuation(responseSchema?: Record<string, JsonValue>): ContinuationEnvelopeV1 {
  return pendingContinuation({
    kind: "input",
    message: "Choose execution policy",
    ...(responseSchema === undefined ? {} : { responseSchema }),
  });
}

function authorizationContinuation(
  responseSchema?: Record<string, JsonValue>,
): ContinuationEnvelopeV1 {
  return pendingContinuation({
    kind: "authorization",
    message: "Authorize access in your browser",
    ...(responseSchema === undefined ? {} : { responseSchema }),
    secret: "must-not-cross-the-adapter",
  });
}

function expectProtocolError(
  operation: () => unknown,
  code:
    | "INVALID_PROTOCOL_BINDING"
    | "INVALID_PROTOCOL_MESSAGE"
    | "INVALID_PROTOCOL_TRANSITION"
    | "UNSUPPORTED_PROTOCOL_CAPABILITY",
): void {
  try {
    operation();
    throw new Error("Expected a ProtocolAdapterError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolAdapterError);
    expect(error).toMatchObject({ code });
  }
}

function formRequest(continuation: ContinuationEnvelopeV1): McpElicitRequest {
  return toMcpElicitRequest(continuation, {
    clientCapabilities: FORM_CAPABILITY,
    requestId: "request-1",
  });
}

function formIssuance(continuation: ContinuationEnvelopeV1): McpElicitationIssuance {
  return issueMcpElicitation(continuation, {
    clientCapabilities: FORM_CAPABILITY,
    requestId: "request-1",
  });
}

function urlRequest(request: McpElicitRequest): McpUrlElicitRequest {
  if (request.params.mode !== "url") {
    throw new Error("Expected URL elicitation request");
  }
  return request as McpUrlElicitRequest;
}

describe("MCP adapter", () => {
  it("projects the complete flat primitive and enum schema subset exactly", () => {
    const responseSchema = {
      type: "object",
      properties: {
        email: {
          type: "string",
          title: "Contact",
          description: "Notification address",
          format: "email",
          minLength: 3,
          maxLength: 120,
          default: "agent@example.com",
        },
        replicas: { type: "integer", minimum: 1, maximum: 16, default: 3 },
        threshold: { type: "number", minimum: 0, maximum: 1, default: 0.75 },
        approved: { type: "boolean", default: true },
        region: { type: "string", enum: ["eu", "us"], default: "eu" },
        legacyRegion: {
          type: "string",
          enum: ["eu", "us"],
          enumNames: ["Europe", "United States"],
          default: "eu",
        },
        tier: {
          type: "string",
          oneOf: [
            { const: "fast", title: "Fast" },
            { const: "safe", title: "Safe" },
          ],
          default: "safe",
        },
        channels: {
          type: "array",
          items: { type: "string", enum: ["web", "cli", "api"] },
          minItems: 1,
          maxItems: 2,
          default: ["web"],
        },
        targets: {
          type: "array",
          items: {
            anyOf: [
              { const: "cpu", title: "CPU" },
              { const: "gpu", title: "GPU" },
            ],
          },
        },
      },
      required: ["email", "replicas", "approved", "region", "legacyRegion", "tier", "channels"],
    } as const;
    const continuation = inputContinuation(responseSchema);

    const issuance = issueMcpElicitation(continuation, {
      clientCapabilities: FORM_CAPABILITY,
      requestId: 41,
      relatedTask: { taskId: "mcp-task-7" },
    });
    const request = issuance.request;

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: 41,
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Choose execution policy",
        requestedSchema: responseSchema,
        _meta: {
          "io.pausemesh/continuation": {
            continuationId: "continuation-1",
            correlationId: "thread-1",
            expiresAt: "2026-07-17T08:05:00.000Z",
            requestId: 41,
            schemaVersion: 1,
          },
          "io.modelcontextprotocol/related-task": { taskId: "mcp-task-7" },
        },
      },
    });
    expect(request.params).not.toHaveProperty("task");

    expect(
      parseMcpElicitResult(continuation, request, issuance.receipt, {
        action: "accept",
        content: {
          email: "operator@example.com",
          replicas: 4,
          approved: false,
          region: "us",
          legacyRegion: "us",
          tier: "fast",
          channels: ["cli", "api"],
          targets: ["gpu"],
        },
      }),
    ).toEqual({
      kind: "form_response",
      action: "accept",
      content: {
        email: "operator@example.com",
        replicas: 4,
        approved: false,
        region: "us",
        legacyRegion: "us",
        tier: "fast",
        channels: ["cli", "api"],
        targets: ["gpu"],
      },
    });
  });

  it("keeps the legacy empty elicitation capability compatible with form mode", () => {
    expect(
      toMcpElicitRequest(inputContinuation(), {
        clientCapabilities: { elicitation: {} },
        requestId: "request-1",
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Choose execution policy",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          "io.pausemesh/continuation": {
            continuationId: "continuation-1",
            correlationId: "thread-1",
            expiresAt: "2026-07-17T08:05:00.000Z",
            requestId: "request-1",
            schemaVersion: 1,
          },
        },
      },
    });
  });

  it.each([
    ["no elicitation capability", {}],
    ["URL-only capability", URL_CAPABILITY],
  ])("rejects form mode with %s", (_label, clientCapabilities) => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(inputContinuation(), {
          clientCapabilities,
          requestId: "request-1",
        }),
      "UNSUPPORTED_PROTOCOL_CAPABILITY",
    );
  });

  it("projects authorization as URL elicitation without in-band secrets", () => {
    const request = toMcpElicitRequest(
      authorizationContinuation(),
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-1",
        relatedTask: { taskId: "mcp-task-7" },
        urlBinding: {
          elicitationId: "elicitation-9",
          url: "https://auth.example.com/authorize?flow=9",
        },
      },
      TRUSTED_URL_POLICY,
    );

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: "request-auth-1",
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Authorize access in your browser",
        elicitationId: "elicitation-9",
        url: "https://auth.example.com/authorize?flow=9",
        _meta: {
          "io.pausemesh/continuation": {
            continuationId: "continuation-1",
            correlationId: "thread-1",
            expiresAt: "2026-07-17T08:05:00.000Z",
            requestId: "request-auth-1",
            schemaVersion: 1,
          },
          "io.modelcontextprotocol/related-task": { taskId: "mcp-task-7" },
        },
      },
    });
    expect(JSON.stringify(request)).not.toContain("must-not-cross-the-adapter");
    expect(request.params).not.toHaveProperty("task");
  });

  it("permits HTTP URL elicitation only for loopback through trusted adapter policy", () => {
    const request = toMcpElicitRequest(
      authorizationContinuation(),
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-local",
        urlBinding: { elicitationId: "local-1", url: "http://127.0.0.1:4400/authorize" },
      },
      { ...TRUSTED_URL_POLICY, allowInsecureLoopbackHttp: true },
    );

    expect(request.params).toMatchObject({
      mode: "url",
      elicitationId: "local-1",
      url: "http://127.0.0.1:4400/authorize",
    });
  });

  it.each([
    "http://auth.example.com/authorize",
    "http://192.168.1.20/authorize",
    "http://10.0.0.12/authorize",
  ])("rejects remote HTTP even when loopback HTTP policy is enabled: %s", (url) => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(
          authorizationContinuation(),
          {
            clientCapabilities: URL_CAPABILITY,
            requestId: "request-auth-local",
            urlBinding: { elicitationId: "local-1", url },
          },
          { ...TRUSTED_URL_POLICY, allowInsecureLoopbackHttp: true },
        ),
      "INVALID_PROTOCOL_BINDING",
    );
  });

  it.each([
    "http://localhost:4400/authorize",
    "http://agent.localhost:4400/authorize",
    "http://127.99.0.1:4400/authorize",
    "http://[::1]:4400/authorize",
  ])("accepts a trusted loopback HTTP URL without rewriting it: %s", (url) => {
    const request = toMcpElicitRequest(
      authorizationContinuation(),
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-local",
        urlBinding: { elicitationId: "local-1", url },
      },
      { ...TRUSTED_URL_POLICY, allowInsecureLoopbackHttp: true },
    );
    expect(request.params).toMatchObject({ url });
  });

  it("does not accept insecure transport policy from request-derived context", () => {
    const untrustedContext = {
      allowInsecureHttp: true,
      clientCapabilities: URL_CAPABILITY,
      requestId: "request-auth-local",
      urlBinding: { elicitationId: "local-1", url: "http://127.0.0.1:4400/authorize" },
    } as unknown as Parameters<typeof toMcpElicitRequest>[1];

    expectProtocolError(
      () => toMcpElicitRequest(authorizationContinuation(), untrustedContext),
      "INVALID_PROTOCOL_BINDING",
    );
  });

  it("preserves opaque protocol identifiers containing internal whitespace", () => {
    const request = urlRequest(
      toMcpElicitRequest(
        authorizationContinuation(),
        {
          clientCapabilities: URL_CAPABILITY,
          requestId: "request /opaque",
          relatedTask: { taskId: "task /opaque" },
          urlBinding: {
            elicitationId: "elicitation /opaque",
            url: "https://example.com/authorize",
          },
        },
        TRUSTED_URL_POLICY,
      ),
    );

    expect(request.id).toBe("request /opaque");
    expect(request.params.elicitationId).toBe("elicitation /opaque");
    expect(request.params._meta["io.pausemesh/continuation"].requestId).toBe("request /opaque");
    expect(request.params._meta["io.modelcontextprotocol/related-task"]?.taskId).toBe(
      "task /opaque",
    );
  });

  it("rejects identifier boundary whitespace instead of transforming it", () => {
    const contexts: Parameters<typeof toMcpElicitRequest>[1][] = [
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: " request-1",
        relatedTask: { taskId: "task-1" },
        urlBinding: { elicitationId: "e-1", url: "https://example.com/authorize" },
      },
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-1",
        relatedTask: { taskId: "task-1 " },
        urlBinding: { elicitationId: "e-1", url: "https://example.com/authorize" },
      },
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-1",
        relatedTask: { taskId: "task-1" },
        urlBinding: { elicitationId: " e-1", url: "https://example.com/authorize" },
      },
    ];

    for (const context of contexts) {
      expectProtocolError(
        () => toMcpElicitRequest(authorizationContinuation(), context),
        "INVALID_PROTOCOL_BINDING",
      );
    }

    for (const continuation of [
      { ...authorizationContinuation(), continuationId: " continuation-1" },
      { ...authorizationContinuation(), correlationId: "thread-1 " },
    ] satisfies ContinuationEnvelopeV1[]) {
      expectProtocolError(
        () =>
          toMcpElicitRequest(
            continuation,
            {
              clientCapabilities: URL_CAPABILITY,
              requestId: "request-1",
              urlBinding: {
                elicitationId: "e-1",
                url: "https://example.com/authorize",
              },
            },
            TRUSTED_URL_POLICY,
          ),
        "INVALID_PROTOCOL_MESSAGE",
      );
    }
  });

  it.each([
    [
      "missing URL capability",
      FORM_CAPABILITY,
      { elicitationId: "e-1", url: "https://example.com" },
    ],
    ["missing URL binding", URL_CAPABILITY, undefined],
  ])("rejects authorization with %s", (_label, clientCapabilities, urlBinding) => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(authorizationContinuation(), {
          clientCapabilities,
          requestId: "request-auth-1",
          ...(urlBinding === undefined ? {} : { urlBinding }),
        }),
      urlBinding === undefined ? "INVALID_PROTOCOL_BINDING" : "UNSUPPORTED_PROTOCOL_CAPABILITY",
    );
  });

  it.each([
    ["relative", "/authorize"],
    ["insecure", "http://auth.example.com/authorize"],
    ["embedded credentials", "https://user:secret@auth.example.com/authorize"],
    ["fragment", "https://auth.example.com/authorize#access_token=secret"],
    ["credential query", "https://auth.example.com/authorize?access_token=secret"],
    ["API-key query", "https://auth.example.com/authorize?api-key=secret"],
    ["signed query", "https://auth.example.com/authorize?sig=secret"],
    ["unsupported scheme", "ftp://auth.example.com/authorize"],
  ])("rejects a %s authorization URL", (_label, url) => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(authorizationContinuation(), {
          clientCapabilities: URL_CAPABILITY,
          requestId: "request-auth-1",
          urlBinding: { elicitationId: "e-1", url },
        }),
      "INVALID_PROTOCOL_BINDING",
    );
  });

  it("requires trusted URL attestation and fails closed on rejection or exceptions", () => {
    const continuation = authorizationContinuation();
    const context = {
      clientCapabilities: URL_CAPABILITY,
      requestId: "request-auth-1",
      urlBinding: { elicitationId: "e-1", url: "https://auth.example.com/authorize?state=opaque" },
    } as const;

    for (const policy of [
      {},
      { validateAuthorizationUrl: () => false },
      {
        validateAuthorizationUrl: () => {
          throw new Error("policy internals");
        },
      },
    ]) {
      expectProtocolError(
        () => toMcpElicitRequest(continuation, context, policy),
        "INVALID_PROTOCOL_BINDING",
      );
    }
  });

  it("rejects a URL binding on form elicitation", () => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(inputContinuation(), {
          clientCapabilities: FORM_CAPABILITY,
          requestId: "request-1",
          urlBinding: { elicitationId: "e-1", url: "https://example.com" },
        }),
      "INVALID_PROTOCOL_BINDING",
    );
  });

  it.each([
    ["decline", { kind: "form_response", action: "decline" }],
    ["cancel", { kind: "form_response", action: "cancel" }],
  ] as const)("parses a form %s without content", (action, expected) => {
    const continuation = inputContinuation();
    const issuance = formIssuance(continuation);
    expect(
      parseMcpElicitResult(continuation, issuance.request, issuance.receipt, { action }),
    ).toEqual(expected);
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "parses URL %s as consent rather than a form response",
    (action) => {
      const continuation = authorizationContinuation();
      const issuance = issueMcpElicitation(
        continuation,
        {
          clientCapabilities: URL_CAPABILITY,
          requestId: "request-auth-1",
          urlBinding: { elicitationId: "elicitation-9", url: "https://example.com/authorize" },
        },
        TRUSTED_URL_POLICY,
      );

      expect(
        parseMcpElicitResult(continuation, issuance.request, issuance.receipt, { action }),
      ).toEqual({
        kind: "url_consent",
        action,
        elicitationId: "elicitation-9",
      });
    },
  );

  it("rejects URL completion until the out-of-band continuation has resumed", () => {
    const continuation = authorizationContinuation();
    const issuance = issueMcpElicitation(
      continuation,
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-1",
        relatedTask: { taskId: "mcp-task-7" },
        urlBinding: {
          elicitationId: "elicitation-9",
          url: "https://example.com/authorize",
        },
      },
      TRUSTED_URL_POLICY,
    );
    const request = urlRequest(issuance.request);

    expectProtocolError(
      () => toMcpElicitationCompleteNotification(continuation, request, issuance.receipt),
      "INVALID_PROTOCOL_TRANSITION",
    );
  });

  it("builds URL completion from the original request after the continuation resumes", () => {
    const pending = authorizationContinuation();
    const issuance = issueMcpElicitation(
      pending,
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-1",
        relatedTask: { taskId: "mcp-task-7" },
        urlBinding: {
          elicitationId: "elicitation-9",
          url: "https://example.com/authorize",
        },
      },
      TRUSTED_URL_POLICY,
    );
    const request = urlRequest(issuance.request);
    const resumed: ContinuationEnvelopeV1 = {
      schemaVersion: pending.schemaVersion,
      continuationId: pending.continuationId,
      correlationId: pending.correlationId,
      version: 1,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      status: "resumed",
      resumedAt: "2026-07-17T08:01:00.000Z",
      idempotencyKey: "idem-auth-1",
      payload: pending.payload,
      metadata: pending.metadata,
      resumePayload: { authorized: true },
    };

    expect(toMcpElicitationCompleteNotification(resumed, request, issuance.receipt)).toMatchObject({
      method: "notifications/elicitation/complete",
      params: {
        elicitationId: "elicitation-9",
        _meta: {
          "io.pausemesh/continuation": {
            continuationId: "continuation-1",
            requestId: "request-auth-1",
          },
          "io.modelcontextprotocol/related-task": { taskId: "mcp-task-7" },
        },
      },
    });
  });

  it("issues a host-only content-addressed receipt and requires it for result parsing", () => {
    const continuation = inputContinuation();
    const issuance = formIssuance(continuation);

    expect(issuance.receipt).toEqual({
      schemaVersion: 1,
      continuationId: continuation.continuationId,
      correlationId: continuation.correlationId,
      mode: "form",
      requestId: "request-1",
      requestHash: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(JSON.stringify(issuance.request)).not.toContain(issuance.receipt.requestHash);
    for (const receipt of [
      undefined,
      { ...issuance.receipt, requestHash: "0".repeat(64) },
      { ...issuance.receipt, mode: "url" },
    ]) {
      expectProtocolError(
        () => parseMcpElicitResult(continuation, issuance.request, receipt, { action: "decline" }),
        "INVALID_PROTOCOL_BINDING",
      );
    }
  });

  it("rejects URL request mutations against the original issuance receipt", () => {
    const pending = authorizationContinuation();
    const issuance = issueMcpElicitation(
      pending,
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-bound",
        urlBinding: {
          elicitationId: "elicitation-original",
          url: "https://auth.example.com/authorize?state=opaque",
        },
      },
      TRUSTED_URL_POLICY,
    );
    const request = urlRequest(issuance.request);
    const resumed: ContinuationEnvelopeV1 = {
      schemaVersion: pending.schemaVersion,
      continuationId: pending.continuationId,
      correlationId: pending.correlationId,
      version: pending.version + 1,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      status: "resumed",
      resumedAt: "2026-07-17T08:01:00.000Z",
      idempotencyKey: "idem-auth-bound",
      payload: pending.payload,
      metadata: pending.metadata,
      resumePayload: { authorized: true },
    };
    const changedRequests: McpUrlElicitRequest[] = [
      {
        ...request,
        params: { ...request.params, elicitationId: "elicitation-substituted" },
      },
      {
        ...request,
        params: { ...request.params, url: "https://evil.example.com/authorize" },
      },
      {
        ...request,
        params: { ...request.params, message: "A substituted authorization request" },
      },
    ];

    for (const changedRequest of changedRequests) {
      expectProtocolError(
        () =>
          parseMcpElicitResult(pending, changedRequest, issuance.receipt, { action: "decline" }),
        "INVALID_PROTOCOL_BINDING",
      );
      expectProtocolError(
        () => toMcpElicitationCompleteNotification(resumed, changedRequest, issuance.receipt),
        "INVALID_PROTOCOL_BINDING",
      );
    }
  });

  it.each([
    [
      "nested object",
      { type: "object", properties: { nested: { type: "object", properties: {} } } },
    ],
    [
      "undefined required property",
      { type: "object", properties: { known: { type: "string" } }, required: ["missing"] },
    ],
    [
      "prototype toString required property",
      { type: "object", properties: {}, required: ["toString"] },
    ],
    [
      "prototype constructor required property",
      { type: "object", properties: {}, required: ["constructor"] },
    ],
    [
      "duplicate enum",
      { type: "object", properties: { region: { type: "string", enum: ["eu", "eu"] } } },
    ],
    [
      "legacy enum title length mismatch",
      {
        type: "object",
        properties: {
          region: { type: "string", enum: ["eu", "us"], enumNames: ["Europe"] },
        },
      },
    ],
    [
      "invalid numeric range",
      { type: "object", properties: { replicas: { type: "integer", minimum: 5, maximum: 2 } } },
    ],
    [
      "unsupported schema keyword",
      { type: "object", properties: { value: { type: "string", pattern: "^[a-z]+$" } } },
    ],
  ])("rejects a malformed form schema: %s", (_label, schema) => {
    expectProtocolError(
      () => formRequest(inputContinuation(schema as Record<string, JsonValue>)),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it("supports explicitly declared prototype-named form fields", () => {
    const continuation = inputContinuation({
      type: "object",
      properties: {
        toString: { type: "string" },
        constructor: { type: "string" },
      },
      required: ["toString", "constructor"],
    });
    const issuance = formIssuance(continuation);
    const request = issuance.request;

    expect(
      parseMcpElicitResult(continuation, request, issuance.receipt, {
        action: "accept",
        content: { toString: "explicit", constructor: "explicit" },
      }),
    ).toMatchObject({
      kind: "form_response",
      action: "accept",
      content: { toString: "explicit", constructor: "explicit" },
    });
  });

  it("rejects an authorization payload that attempts to carry a response schema", () => {
    expectProtocolError(
      () =>
        toMcpElicitRequest(authorizationContinuation({ type: "object", properties: {} }), {
          clientCapabilities: URL_CAPABILITY,
          requestId: "request-auth-1",
          urlBinding: { elicitationId: "e-1", url: "https://example.com/authorize" },
        }),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it.each([
    ["unknown action", { action: "approve", content: {} }],
    ["accepted without content", { action: "accept" }],
    ["declined with content", { action: "decline", content: {} }],
    ["cancelled with content", { action: "cancel", content: {} }],
  ])("rejects a malformed form result: %s", (_label, result) => {
    const continuation = inputContinuation();
    const issuance = formIssuance(continuation);
    expectProtocolError(
      () => parseMcpElicitResult(continuation, issuance.request, issuance.receipt, result),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it.each([
    ["unexpected property", { region: "eu", extra: true }],
    ["missing required property", {}],
    ["wrong primitive type", { region: 7 }],
    ["unknown enum member", { region: "apac" }],
  ])("rejects form content with %s", (_label, content) => {
    const continuation = inputContinuation({
      type: "object",
      properties: { region: { type: "string", enum: ["eu", "us"] } },
      required: ["region"],
    });
    const issuance = formIssuance(continuation);
    expectProtocolError(
      () =>
        parseMcpElicitResult(continuation, issuance.request, issuance.receipt, {
          action: "accept",
          content,
        }),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it("rejects in-band content from a URL consent result", () => {
    const continuation = authorizationContinuation();
    const issuance = issueMcpElicitation(
      continuation,
      {
        clientCapabilities: URL_CAPABILITY,
        requestId: "request-auth-1",
        urlBinding: { elicitationId: "e-1", url: "https://example.com/authorize" },
      },
      TRUSTED_URL_POLICY,
    );
    expectProtocolError(
      () =>
        parseMcpElicitResult(continuation, issuance.request, issuance.receipt, {
          action: "accept",
          content: {},
        }),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it("rejects requests whose continuation, request, mode, or expiry binding was changed", () => {
    const continuation = inputContinuation();
    const issuance = formIssuance(continuation);
    const request = issuance.request;
    if (request.params.mode !== "form") {
      throw new Error("Expected form elicitation request");
    }
    const changedRequestId = { ...request, id: "request-2" };
    const changedMetadata = {
      ...request,
      params: {
        ...request.params,
        _meta: {
          ...request.params._meta,
          "io.pausemesh/continuation": {
            ...request.params._meta["io.pausemesh/continuation"],
            continuationId: "continuation-2",
          },
        },
      },
    };
    const changedExpiry = {
      ...continuation,
      expiresAt: "2026-07-17T08:06:00.000Z",
    } as ContinuationEnvelopeV1;
    const changedContinuationId = {
      ...continuation,
      continuationId: "continuation-2",
    } as ContinuationEnvelopeV1;
    const changedMessage = {
      ...request,
      params: { ...request.params, message: "A different question" },
    };
    const changedSchema = {
      ...request,
      params: {
        ...request.params,
        requestedSchema: {
          type: "object" as const,
          properties: { approved: { type: "boolean" as const } },
          required: ["approved"],
        },
      },
    };

    for (const operation of [
      () =>
        parseMcpElicitResult(continuation, changedRequestId, issuance.receipt, {
          action: "decline",
        }),
      () =>
        parseMcpElicitResult(continuation, changedMetadata, issuance.receipt, {
          action: "decline",
        }),
      () => parseMcpElicitResult(changedExpiry, request, issuance.receipt, { action: "decline" }),
      () =>
        parseMcpElicitResult(changedContinuationId, request, issuance.receipt, {
          action: "decline",
        }),
      () =>
        parseMcpElicitResult(continuation, changedMessage, issuance.receipt, {
          action: "decline",
        }),
      () =>
        parseMcpElicitResult(continuation, changedSchema, issuance.receipt, {
          action: "decline",
        }),
      () =>
        parseMcpElicitResult(authorizationContinuation(), request, issuance.receipt, {
          action: "decline",
        }),
    ]) {
      expectProtocolError(operation, "INVALID_PROTOCOL_BINDING");
    }
  });

  it("normalizes structurally malformed request input to a protocol binding error", () => {
    const continuation = inputContinuation();
    const issuance = formIssuance(continuation);
    const request = issuance.request;
    const malformed = {
      ...request,
      params: { ...request.params, _meta: {} },
    } as unknown as McpElicitRequest;

    expectProtocolError(
      () => parseMcpElicitResult(continuation, malformed, issuance.receipt, { action: "decline" }),
      "INVALID_PROTOCOL_BINDING",
    );
  });

  it("rejects projection for a terminal continuation", () => {
    const terminal: ContinuationEnvelopeV1 = {
      schemaVersion: 1,
      continuationId: "continuation-1",
      correlationId: "thread-1",
      version: 1,
      createdAt: "2026-07-17T08:00:00.000Z",
      expiresAt: "2026-07-17T08:05:00.000Z",
      status: "resumed",
      resumedAt: "2026-07-17T08:01:00.000Z",
      idempotencyKey: "idem-1",
      payload: { kind: "input", message: "Done" },
      metadata: {},
      resumePayload: { approved: true },
    };

    expectProtocolError(
      () =>
        toMcpElicitRequest(terminal, {
          clientCapabilities: FORM_CAPABILITY,
          requestId: "request-1",
        }),
      "INVALID_PROTOCOL_TRANSITION",
    );
  });

  it.each(["cancelled", "expired"] as const)(
    "rejects URL completion for a %s continuation",
    (status) => {
      const pending = authorizationContinuation();
      const issuance = issueMcpElicitation(
        pending,
        {
          clientCapabilities: URL_CAPABILITY,
          requestId: "request-auth-1",
          urlBinding: { elicitationId: "e-1", url: "https://example.com/authorize" },
        },
        TRUSTED_URL_POLICY,
      );
      const request = urlRequest(issuance.request);
      const terminal: ContinuationEnvelopeV1 =
        status === "cancelled"
          ? {
              schemaVersion: pending.schemaVersion,
              continuationId: pending.continuationId,
              correlationId: pending.correlationId,
              version: 1,
              createdAt: pending.createdAt,
              expiresAt: pending.expiresAt,
              status,
              cancelledAt: "2026-07-17T08:01:00.000Z",
              payload: pending.payload,
              metadata: pending.metadata,
            }
          : {
              schemaVersion: pending.schemaVersion,
              continuationId: pending.continuationId,
              correlationId: pending.correlationId,
              version: 1,
              createdAt: pending.createdAt,
              expiresAt: pending.expiresAt,
              status,
              expiredAt: "2026-07-17T08:05:00.000Z",
              payload: pending.payload,
              metadata: pending.metadata,
            };

      expectProtocolError(
        () => toMcpElicitationCompleteNotification(terminal, request, issuance.receipt),
        "INVALID_PROTOCOL_TRANSITION",
      );
    },
  );
});
