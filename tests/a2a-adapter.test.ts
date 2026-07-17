import { describe, expect, it } from "vitest";
import {
  type A2AServerTaskBinding,
  toA2AAuthorizationControlMessage,
  toA2AInputMessage,
  toA2AInterruptedTask,
} from "../src/adapters/a2a/task.js";
import { ProtocolAdapterError } from "../src/adapters/protocol-error.js";
import type { ContinuationEnvelopeV1, JsonValue } from "../src/domain/index.js";

const BINDING: A2AServerTaskBinding = { taskId: "server-task-7", contextId: "context-1" };

function baseContinuation(payload: JsonValue) {
  return {
    schemaVersion: 1 as const,
    continuationId: "continuation-1",
    correlationId: "context-1",
    version: 0,
    createdAt: "2026-07-17T08:00:00.000Z",
    expiresAt: "2026-07-17T08:05:00.000Z",
    payload,
    metadata: { a2aTaskId: "untrusted-metadata-task" },
  };
}

function pendingContinuation(
  kind: "input" | "authorization" | undefined = "input",
): ContinuationEnvelopeV1 {
  return {
    ...baseContinuation({
      ...(kind === undefined ? {} : { kind }),
      message: kind === "authorization" ? "Authorize out of band" : "Choose a region",
      credential: "must-not-cross-the-adapter",
    }),
    status: "pending",
    resumeTokenHash: "sha256:opaque",
  };
}

function terminalContinuation(status: "resumed" | "cancelled" | "expired"): ContinuationEnvelopeV1 {
  const base = baseContinuation({ kind: "input", message: "Choose a region" });
  switch (status) {
    case "resumed":
      return {
        ...base,
        status,
        version: 1,
        resumedAt: "2026-07-17T08:01:00.000Z",
        idempotencyKey: "idem-1",
        resumePayload: "eu",
      };
    case "cancelled":
      return {
        ...base,
        status,
        version: 1,
        cancelledAt: "2026-07-17T08:01:00.000Z",
        reason: "operator",
      };
    case "expired":
      return {
        ...base,
        status,
        version: 1,
        expiredAt: "2026-07-17T08:05:00.000Z",
      };
  }
}

function expectProtocolError(
  operation: () => unknown,
  code: "INVALID_PROTOCOL_BINDING" | "INVALID_PROTOCOL_MESSAGE" | "INVALID_PROTOCOL_TRANSITION",
): void {
  try {
    operation();
    throw new Error("Expected a ProtocolAdapterError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolAdapterError);
    expect(error).toMatchObject({ code });
  }
}

describe("A2A adapter", () => {
  it("projects input-required state with explicit server binding and exact correlation", () => {
    expect(toA2AInterruptedTask(pendingContinuation("input"), BINDING)).toEqual({
      task: {
        id: "server-task-7",
        contextId: "context-1",
        status: {
          state: "TASK_STATE_INPUT_REQUIRED",
          message: {
            role: "ROLE_AGENT",
            messageId: "continuation-1",
            contextId: "context-1",
            taskId: "server-task-7",
            parts: [{ text: "Choose a region" }],
          },
          timestamp: "2026-07-17T08:00:00.000Z",
        },
        metadata: {
          pausemesh: {
            continuationId: "continuation-1",
            expiresAt: "2026-07-17T08:05:00.000Z",
            schemaVersion: 1,
          },
        },
      },
    });
  });

  it("treats a payload with no kind as input for wire compatibility", () => {
    expect(toA2AInterruptedTask(pendingContinuation(undefined), BINDING).task.status.state).toBe(
      "TASK_STATE_INPUT_REQUIRED",
    );
  });

  it("uses the explicit server task ID instead of task-like continuation metadata", () => {
    const projection = toA2AInterruptedTask(pendingContinuation(), BINDING);
    expect(projection.task.id).toBe("server-task-7");
    expect(JSON.stringify(projection)).not.toContain("untrusted-metadata-task");
  });

  it("projects authorization-required state without credentials", () => {
    const projection = toA2AInterruptedTask(pendingContinuation("authorization"), BINDING);
    expect(projection).toEqual({
      task: {
        id: "server-task-7",
        contextId: "context-1",
        status: {
          state: "TASK_STATE_AUTH_REQUIRED",
          message: {
            role: "ROLE_AGENT",
            messageId: "continuation-1",
            contextId: "context-1",
            taskId: "server-task-7",
            parts: [{ text: "Authorize out of band" }],
          },
          timestamp: "2026-07-17T08:00:00.000Z",
        },
        metadata: {
          pausemesh: {
            continuationId: "continuation-1",
            expiresAt: "2026-07-17T08:05:00.000Z",
            schemaVersion: 1,
          },
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-cross-the-adapter");
  });

  it.each([
    ["null", null],
    ["boolean", true],
    ["number", 42],
    ["string", "eu"],
    ["array", ["eu", "us"]],
    ["object", { region: "eu", retries: 2 }],
  ] as const)("projects %s JSON as an input message", (_label, response) => {
    expect(toA2AInputMessage(pendingContinuation(), BINDING, response, "message-9")).toEqual({
      message: {
        taskId: "server-task-7",
        contextId: "context-1",
        role: "ROLE_USER",
        messageId: "message-9",
        parts: [{ data: response }],
        metadata: {
          pausemesh: { continuationId: "continuation-1", schemaVersion: 1 },
        },
      },
    });
  });

  it("keeps authorization responses out of band", () => {
    expectProtocolError(
      () =>
        toA2AInputMessage(
          pendingContinuation("authorization"),
          BINDING,
          { accessToken: "secret" },
          "message-9",
        ),
      "INVALID_PROTOCOL_TRANSITION",
    );
  });

  it("permits only narrow non-sensitive controls on authorization tasks", () => {
    expect(
      toA2AAuthorizationControlMessage(
        pendingContinuation("authorization"),
        BINDING,
        "retry",
        "message-auth-control",
      ),
    ).toEqual({
      message: {
        taskId: "server-task-7",
        contextId: "context-1",
        role: "ROLE_USER",
        messageId: "message-auth-control",
        parts: [{ data: { action: "retry" } }],
        metadata: {
          pausemesh: { continuationId: "continuation-1", schemaVersion: 1 },
        },
      },
    });
    expect(() =>
      toA2AAuthorizationControlMessage(
        pendingContinuation("authorization"),
        BINDING,
        { accessToken: "secret" } as never,
        "message-auth-control",
      ),
    ).toThrow(ProtocolAdapterError);
    expect(() =>
      toA2AAuthorizationControlMessage(
        pendingContinuation("input"),
        BINDING,
        "reject",
        "message-auth-control",
      ),
    ).toThrow(ProtocolAdapterError);
  });

  it("requires an explicit server binding for both projections", () => {
    expect(() => toA2AInterruptedTask(pendingContinuation(), undefined as never)).toThrow();
    expect(() =>
      toA2AInputMessage(pendingContinuation(), undefined as never, "eu", "message-9"),
    ).toThrow();
  });

  it.each([
    ["empty task ID", { taskId: "", contextId: "context-1" }],
    ["empty context ID", { taskId: "server-task-7", contextId: "" }],
    ["unknown binding field", { taskId: "server-task-7", contextId: "context-1", owned: true }],
  ])("rejects a malformed explicit binding: %s", (_label, binding) => {
    expect(() =>
      toA2AInterruptedTask(pendingContinuation(), binding as A2AServerTaskBinding),
    ).toThrow();
  });

  it.each([
    [
      "interruption",
      (continuation: ContinuationEnvelopeV1) =>
        toA2AInterruptedTask(continuation, { taskId: "server-task-7", contextId: "other-context" }),
    ],
    [
      "input message",
      (continuation: ContinuationEnvelopeV1) =>
        toA2AInputMessage(
          continuation,
          { taskId: "server-task-7", contextId: "other-context" },
          "eu",
          "message-9",
        ),
    ],
  ])("rejects a context mismatch for %s", (_label, project) => {
    expectProtocolError(() => project(pendingContinuation()), "INVALID_PROTOCOL_BINDING");
  });

  it.each(["resumed", "cancelled", "expired"] as const)(
    "rejects %s continuations for both A2A projections",
    (status) => {
      const continuation = terminalContinuation(status);
      expectProtocolError(
        () => toA2AInterruptedTask(continuation, BINDING),
        "INVALID_PROTOCOL_TRANSITION",
      );
      expectProtocolError(
        () => toA2AInputMessage(continuation, BINDING, "eu", "message-9"),
        "INVALID_PROTOCOL_TRANSITION",
      );
    },
  );

  it("rejects an empty input message ID", () => {
    expect(() => toA2AInputMessage(pendingContinuation(), BINDING, "eu", "   ")).toThrow();
  });

  it("preserves opaque IDs and rejects edge whitespace", () => {
    const binding = { taskId: "server task", contextId: "context-1" };
    const message = toA2AInputMessage(pendingContinuation(), binding, "eu", "message internal");
    expect(message.message.taskId).toBe("server task");
    expect(message.message.messageId).toBe("message internal");
    expect(() => toA2AInputMessage(pendingContinuation(), BINDING, "eu", " message ")).toThrow(
      ProtocolAdapterError,
    );
    expect(() =>
      toA2AInterruptedTask(pendingContinuation(), {
        taskId: " server-task-7 ",
        contextId: "context-1",
      }),
    ).toThrow(ProtocolAdapterError);
    expectProtocolError(
      () =>
        toA2AInterruptedTask(
          { ...pendingContinuation(), continuationId: " continuation-1 " },
          BINDING,
        ),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });

  it("rejects a malformed continuation payload", () => {
    expectProtocolError(
      () => toA2AInterruptedTask(pendingContinuationWithPayload({ kind: "input" }), BINDING),
      "INVALID_PROTOCOL_MESSAGE",
    );
  });
});

function pendingContinuationWithPayload(payload: JsonValue): ContinuationEnvelopeV1 {
  return {
    ...baseContinuation(payload),
    status: "pending",
    resumeTokenHash: "sha256:opaque",
  };
}
