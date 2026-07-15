import { z } from "zod";
import type { ContinuationEnvelopeV1, JsonObject } from "../../domain/index.js";

const ContinuationPayloadSchema = z
  .object({
    kind: z.enum(["input", "authorization"]).default("input"),
    message: z.string().min(1),
  })
  .passthrough();

export interface A2AInterruptedTask {
  task: {
    id: string;
    contextId: string;
    status: {
      state: "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_AUTH_REQUIRED";
      message: {
        role: "ROLE_AGENT";
        messageId: string;
        parts: [{ text: string }];
      };
      timestamp: string;
    };
    metadata: {
      pausemesh: {
        continuationId: string;
        expiresAt: string;
        schemaVersion: 1;
      };
    };
  };
}

export interface A2AResumeMessage {
  message: {
    taskId: string;
    contextId: string;
    role: "ROLE_USER";
    messageId: string;
    parts: [{ data: JsonObject }];
    metadata: {
      pausemesh: {
        continuationId: string;
        schemaVersion: 1;
      };
    };
  };
}

function requirePending(continuation: ContinuationEnvelopeV1): void {
  if (continuation.status !== "pending") {
    throw new Error(`Cannot project a ${continuation.status} continuation as A2A interruption`);
  }
}

export function toA2AInterruptedTask(continuation: ContinuationEnvelopeV1): A2AInterruptedTask {
  requirePending(continuation);
  const payload = ContinuationPayloadSchema.parse(continuation.payload);
  const taskId =
    typeof continuation.metadata.a2aTaskId === "string"
      ? continuation.metadata.a2aTaskId
      : continuation.continuationId;

  return {
    task: {
      id: taskId,
      contextId: continuation.correlationId,
      status: {
        state:
          payload.kind === "authorization"
            ? "TASK_STATE_AUTH_REQUIRED"
            : "TASK_STATE_INPUT_REQUIRED",
        message: {
          role: "ROLE_AGENT",
          messageId: continuation.continuationId,
          parts: [{ text: payload.message }],
        },
        timestamp: continuation.createdAt,
      },
      metadata: {
        pausemesh: {
          continuationId: continuation.continuationId,
          expiresAt: continuation.expiresAt,
          schemaVersion: 1,
        },
      },
    },
  };
}

export function toA2AResumeMessage(
  continuation: ContinuationEnvelopeV1,
  response: JsonObject,
  messageId: string,
): A2AResumeMessage {
  const taskId =
    typeof continuation.metadata.a2aTaskId === "string"
      ? continuation.metadata.a2aTaskId
      : continuation.continuationId;

  return {
    message: {
      taskId,
      contextId: continuation.correlationId,
      role: "ROLE_USER",
      messageId,
      parts: [{ data: response }],
      metadata: {
        pausemesh: {
          continuationId: continuation.continuationId,
          schemaVersion: 1,
        },
      },
    },
  };
}
