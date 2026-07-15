import { Buffer } from "node:buffer";
import { type Context, Hono } from "hono";
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
import { toA2AInterruptedTask } from "../a2a/task.js";
import { toAguiInterruptEvent } from "../agui/interrupt.js";
import { toMcpElicitRequest } from "../mcp/elicitation.js";

const CreateContinuationSchema = z
  .object({
    continuationId: z.string().trim().min(1).optional(),
    correlationId: z.string().trim().min(1).optional(),
    expiresAt: z.iso.datetime().optional(),
    metadata: z.record(z.string(), z.json()).optional(),
    payload: z.json(),
  })
  .strict();

const ResumeContinuationSchema = z.object({ payload: z.json() }).strict();
const CancelContinuationSchema = z.object({ reason: z.string().max(500).optional() }).strict();

export interface CreateHttpAppOptions {
  maxPayloadBytes: number;
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

  app.post("/v1/continuations", async (c) => {
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

  app.get("/v1/continuations/:continuationId/projections/:protocol", async (c) => {
    const continuation = await options.service.inspect(c.req.param("continuationId"));
    const protocol = c.req.param("protocol");
    switch (protocol) {
      case "mcp":
        return c.json({ projection: toMcpElicitRequest(continuation) });
      case "a2a":
        return c.json({ projection: toA2AInterruptedTask(continuation) });
      case "ag-ui":
        return c.json({ projection: toAguiInterruptEvent(continuation) });
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
  });

  app.post("/v1/continuations/:continuationId/resume", async (c) => {
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

  app.post("/v1/continuations/:continuationId/cancel", async (c) => {
    const body = CancelContinuationSchema.parse(await readBoundedJson(c, options.maxPayloadBytes));
    const continuation = await options.service.cancel({
      continuationId: c.req.param("continuationId"),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    return c.json({ continuation });
  });

  return app;
}
