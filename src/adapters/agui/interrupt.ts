import { z } from "zod";
import type { ContinuationEnvelopeV1, JsonObject } from "../../domain/index.js";

const ContinuationPayloadSchema = z
  .object({
    kind: z.enum(["input", "authorization"]).default("input"),
    message: z.string().min(1),
    responseSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface AguiInterruptEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  outcome: {
    type: "interrupt";
    interrupts: [
      {
        id: string;
        reason: "input_required" | "authorization_required";
        message: string;
        expiresAt: string;
        responseSchema?: Record<string, unknown>;
        metadata: {
          pausemesh: {
            continuationId: string;
            schemaVersion: 1;
          };
        };
      },
    ];
  };
}

export interface AguiResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: JsonObject;
}

function requirePending(continuation: ContinuationEnvelopeV1): void {
  if (continuation.status !== "pending") {
    throw new Error(`Cannot project a ${continuation.status} continuation as AG-UI interrupt`);
  }
}

export function toAguiInterruptEvent(continuation: ContinuationEnvelopeV1): AguiInterruptEvent {
  requirePending(continuation);
  const payload = ContinuationPayloadSchema.parse(continuation.payload);
  const runId =
    typeof continuation.metadata.aguiRunId === "string"
      ? continuation.metadata.aguiRunId
      : continuation.continuationId;

  return {
    type: "RUN_FINISHED",
    threadId: continuation.correlationId,
    runId,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: continuation.continuationId,
          reason: payload.kind === "authorization" ? "authorization_required" : "input_required",
          message: payload.message,
          expiresAt: continuation.expiresAt,
          ...(payload.responseSchema === undefined
            ? {}
            : { responseSchema: payload.responseSchema }),
          metadata: {
            pausemesh: {
              continuationId: continuation.continuationId,
              schemaVersion: 1,
            },
          },
        },
      ],
    },
  };
}

export function toAguiResumeEntry(continuationId: string, response?: JsonObject): AguiResumeEntry {
  return {
    interruptId: continuationId,
    status: response === undefined ? "cancelled" : "resolved",
    ...(response === undefined ? {} : { payload: response }),
  };
}
