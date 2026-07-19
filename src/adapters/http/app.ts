import { Buffer } from "node:buffer";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, z } from "zod";
import type { ContinuationService } from "../../application/index.js";
import {
  ContinuationCancelledError,
  ContinuationExpiredError,
  ContinuationNotFoundError,
  IdempotencyConflictError,
  InvalidTransitionError,
  PauseMeshError,
  TokenAlreadyUsedError,
  TokenMismatchError,
  VersionConflictError,
} from "../../domain/index.js";
import type { ReadinessProbe } from "../../ports/readiness.js";
import { toA2AInterruptedTask } from "../a2a/task.js";
import { issueAguiInterrupts } from "../agui/interrupt.js";
import { issueMcpElicitation, type McpProjectionPolicy } from "../mcp/elicitation.js";
import { ProtocolAdapterError } from "../protocol-error.js";

const OpaqueIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && value === value.trim(), {
    message: "IDs must be non-empty and must not contain edge whitespace",
  });

const CreateContinuationSchema = z
  .object({
    continuationId: OpaqueIdSchema.optional(),
    correlationId: OpaqueIdSchema.optional(),
    expiresAt: z.iso.datetime().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
    payload: z.json(),
  })
  .strict();

const ResumeContinuationSchema = z.object({ payload: z.json() }).strict();
const CancelContinuationSchema = z
  .object({
    expectedVersion: z.number().int().positive().safe().optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
const A2AProjectionSchema = z
  .object({ contextId: OpaqueIdSchema, taskId: OpaqueIdSchema })
  .strict();
const AguiProjectionSchema = z.object({ runId: OpaqueIdSchema, threadId: OpaqueIdSchema }).strict();
const McpProjectionSchema = z
  .object({
    clientCapabilities: z
      .object({
        elicitation: z
          .object({
            form: z.record(z.string(), z.unknown()).optional(),
            url: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    relatedTask: z.object({ taskId: OpaqueIdSchema }).strict().optional(),
    requestId: z.union([OpaqueIdSchema, z.number().int().safe()]),
    urlBinding: z
      .object({ elicitationId: OpaqueIdSchema, url: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export interface CreateHttpAppOptions {
  maxPayloadBytes: number;
  /** Trusted host policy; never populated from an HTTP request body. */
  mcpProjectionPolicy?: McpProjectionPolicy;
  /** Host-owned dependency probe. Omission makes readiness fail closed. */
  readinessProbe?: ReadinessProbe;
  service: ContinuationService;
}

function errorStatus(error: PauseMeshError): ContentfulStatusCode {
  if (error instanceof ContinuationNotFoundError) return 404;
  if (error instanceof TokenMismatchError) return 401;
  if (error instanceof ContinuationExpiredError) return 410;
  if (
    error instanceof ContinuationCancelledError ||
    error instanceof TokenAlreadyUsedError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InvalidTransitionError ||
    error instanceof VersionConflictError
  ) {
    return 409;
  }
  return 400;
}

async function readBoundedJson(c: Context, maxPayloadBytes: number): Promise<unknown> {
  const declaredLength = c.req.header("content-length");
  if (declaredLength !== undefined && Number(declaredLength) > maxPayloadBytes) {
    throw new PayloadTooLargeError(maxPayloadBytes);
  }

  const value: unknown = await c.req.json();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxPayloadBytes) {
    throw new PayloadTooLargeError(maxPayloadBytes);
  }
  return value;
}

class PayloadTooLargeError extends Error {
  constructor(readonly maxPayloadBytes: number) {
    super(`JSON payload exceeds ${maxPayloadBytes} bytes`);
  }
}

function resumeToken(c: Context, continuationId: string): string {
  const authorization = c.req.header("authorization");
  const match = /^PauseMesh\s+(.+)$/i.exec(authorization ?? "");
  if (match?.[1] === undefined || match[1].trim().length === 0) {
    throw new TokenMismatchError(continuationId);
  }
  return match[1].trim();
}

function idempotencyKey(c: Context): string {
  const value = c.req.header("idempotency-key")?.trim();
  if (value === undefined || value.length === 0 || value.length > 200) {
    throw new ZodError([
      {
        code: "custom",
        input: value,
        message: "Idempotency-Key header is required and must be at most 200 characters",
        path: ["headers", "idempotency-key"],
      },
    ]);
  }
  return value;
}

export function createHttpApp(options: CreateHttpAppOptions): Hono {
  const app = new Hono();
  const boundedJsonBody = bodyLimit({
    maxSize: options.maxPayloadBytes,
    onError: () => {
      throw new PayloadTooLargeError(options.maxPayloadBytes);
    },
  });

  app.onError((error, c) => {
    if (error instanceof PayloadTooLargeError) {
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: error.message } }, 413);
    }
    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Request validation failed",
            issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
          },
        },
        400,
      );
    }
    if (error instanceof ProtocolAdapterError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.code === "INVALID_PROTOCOL_TRANSITION" ? 409 : 400,
      );
    }
    if (error instanceof PauseMeshError) {
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        errorStatus(error),
      );
    }

    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "The continuation operation failed" } },
      500,
    );
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/readyz", async (c) => {
    if (options.readinessProbe === undefined) {
      return c.json(
        {
          status: "not_ready",
          checks: [{ component: "event-store", status: "not_configured" }],
        },
        503,
      );
    }

    try {
      await options.readinessProbe.checkReadiness();
      return c.json({
        status: "ready",
        checks: [{ component: "event-store", status: "ready" }],
      });
    } catch {
      return c.json(
        {
          status: "not_ready",
          checks: [{ component: "event-store", status: "unavailable" }],
        },
        503,
      );
    }
  });

  app.post("/v1/continuations", boundedJsonBody, async (c) => {
    const body = CreateContinuationSchema.parse(await readBoundedJson(c, options.maxPayloadBytes));
    const result = await options.service.create({
      payload: body.payload,
      ...(body.continuationId === undefined ? {} : { continuationId: body.continuationId }),
      ...(body.correlationId === undefined ? {} : { correlationId: body.correlationId }),
      ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
    });
    return c.json(result, 201);
  });

  app.get("/v1/continuations/:continuationId", async (c) => {
    const continuation = await options.service.inspect(c.req.param("continuationId"));
    return c.json({ continuation });
  });

  app.get("/v1/continuations/:continuationId/events", async (c) => {
    const events = await options.service.history(c.req.param("continuationId"));
    return c.json({ events });
  });

  app.post(
    "/v1/continuations/:continuationId/projections/:protocol",
    boundedJsonBody,
    async (c) => {
      const continuation = await options.service.inspect(c.req.param("continuationId"));
      const protocol = c.req.param("protocol");
      switch (protocol) {
        case "mcp": {
          const context = McpProjectionSchema.parse(
            await readBoundedJson(c, options.maxPayloadBytes),
          );
          const issuance = issueMcpElicitation(continuation, context, options.mcpProjectionPolicy);
          return c.json({ projection: issuance.request, receipt: issuance.receipt });
        }
        case "a2a": {
          const binding = A2AProjectionSchema.parse(
            await readBoundedJson(c, options.maxPayloadBytes),
          );
          return c.json({ projection: toA2AInterruptedTask(continuation, binding) });
        }
        case "ag-ui": {
          const binding = AguiProjectionSchema.parse(
            await readBoundedJson(c, options.maxPayloadBytes),
          );
          const issuance = issueAguiInterrupts([continuation], binding);
          return c.json({ projection: issuance.event, receipt: issuance.receipt });
        }
        default:
          return c.json(
            {
              error: {
                code: "UNSUPPORTED_PROTOCOL",
                message: "Protocol must be one of: mcp, a2a, ag-ui",
              },
            },
            404,
          );
      }
    },
  );

  app.post("/v1/continuations/:continuationId/resume", boundedJsonBody, async (c) => {
    const body = ResumeContinuationSchema.parse(await readBoundedJson(c, options.maxPayloadBytes));
    const continuationId = c.req.param("continuationId");
    const continuation = await options.service.resume({
      continuationId,
      idempotencyKey: idempotencyKey(c),
      resumePayload: body.payload,
      resumeToken: resumeToken(c, continuationId),
    });
    return c.json({ continuation });
  });

  app.post("/v1/continuations/:continuationId/cancel", boundedJsonBody, async (c) => {
    const body = CancelContinuationSchema.parse(await readBoundedJson(c, options.maxPayloadBytes));
    const continuation = await options.service.cancel({
      continuationId: c.req.param("continuationId"),
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    return c.json({ continuation });
  });

  return app;
}
