import { z } from "zod";
import type { ContinuationEnvelopeV1, JsonObject } from "../../domain/index.js";

const FormSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
    type: z.literal("object"),
  })
  .passthrough();

const ContinuationPayloadSchema = z
  .object({
    kind: z.enum(["input", "authorization"]).default("input"),
    message: z.string().min(1),
    responseSchema: FormSchema.optional(),
  })
  .passthrough();

export interface McpElicitRequest {
  jsonrpc: "2.0";
  id: string;
  method: "elicitation/create";
  params: {
    mode: "form";
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
    _meta: {
      "io.pausemesh/continuation": {
        correlationId: string;
        expiresAt: string;
        schemaVersion: 1;
      };
    };
  };
}

export interface McpElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

function requirePending(continuation: ContinuationEnvelopeV1): void {
  if (continuation.status !== "pending") {
    throw new Error(`Cannot project a ${continuation.status} continuation as MCP elicitation`);
  }
}

export function toMcpElicitRequest(continuation: ContinuationEnvelopeV1): McpElicitRequest {
  requirePending(continuation);
  const payload = ContinuationPayloadSchema.parse(continuation.payload);
  const responseSchema = payload.responseSchema ?? { type: "object" as const, properties: {} };

  return {
    jsonrpc: "2.0",
    id: continuation.continuationId,
    method: "elicitation/create",
    params: {
      mode: "form",
      message: payload.message,
      requestedSchema: {
        type: "object",
        properties: responseSchema.properties,
        ...(responseSchema.required === undefined ? {} : { required: responseSchema.required }),
      },
      _meta: {
        "io.pausemesh/continuation": {
          correlationId: continuation.correlationId,
          expiresAt: continuation.expiresAt,
          schemaVersion: 1,
        },
      },
    },
  };
}

export function fromMcpElicitResult(result: McpElicitResult): JsonObject {
  return {
    action: result.action,
    ...(result.content === undefined ? {} : { content: result.content }),
  };
}
