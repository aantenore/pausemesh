import { describe, expect, it } from "vitest";
import { toA2AInterruptedTask, toA2AResumeMessage } from "../src/adapters/a2a/task.js";
import { toAguiInterruptEvent, toAguiResumeEntry } from "../src/adapters/agui/interrupt.js";
import { Sha256TokenIssuer } from "../src/adapters/crypto/sha256-token-issuer.js";
import { fromMcpElicitResult, toMcpElicitRequest } from "../src/adapters/mcp/elicitation.js";
import { InMemoryEventStore } from "../src/adapters/storage/index.js";
import { ContinuationService } from "../src/application/index.js";
import { NoopObserver } from "../src/observability/pino-observer.js";

async function pendingContinuation(kind: "input" | "authorization" = "input") {
  const service = new ContinuationService({
    clock: { now: () => new Date("2026-07-15T08:00:00.000Z") },
    eventStore: new InMemoryEventStore(),
    generateId: () => "generated",
    observer: new NoopObserver(),
    tokenIssuer: new Sha256TokenIssuer(),
    tokenTtlSeconds: 300,
  });
  return (
    await service.create({
      continuationId: "continuation-1",
      correlationId: "thread-1",
      metadata: { a2aTaskId: "task-1", aguiRunId: "run-1" },
      payload: {
        kind,
        message: "Which region?",
        responseSchema: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
      },
    })
  ).continuation;
}

describe("protocol projections", () => {
  it("projects an MCP 2025-11-25 form elicitation and result", async () => {
    const continuation = await pendingContinuation();
    expect(toMcpElicitRequest(continuation)).toMatchObject({
      jsonrpc: "2.0",
      id: "continuation-1",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Which region?",
        requestedSchema: { required: ["region"], type: "object" },
      },
    });
    expect(fromMcpElicitResult({ action: "accept", content: { region: "eu-west" } })).toEqual({
      action: "accept",
      content: { region: "eu-west" },
    });
  });

  it("projects A2A interrupted task state and correlated follow-up", async () => {
    const continuation = await pendingContinuation("authorization");
    expect(toA2AInterruptedTask(continuation)).toMatchObject({
      task: {
        id: "task-1",
        contextId: "thread-1",
        status: { state: "TASK_STATE_AUTH_REQUIRED" },
      },
    });
    expect(toA2AResumeMessage(continuation, { approved: true }, "message-2")).toMatchObject({
      message: {
        taskId: "task-1",
        contextId: "thread-1",
        messageId: "message-2",
        parts: [{ data: { approved: true } }],
      },
    });
  });

  it("projects the AG-UI interrupt outcome and resume entry", async () => {
    const continuation = await pendingContinuation();
    expect(toAguiInterruptEvent(continuation)).toMatchObject({
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "continuation-1", reason: "input_required" }],
      },
    });
    expect(toAguiResumeEntry("continuation-1", { region: "eu-west" })).toEqual({
      interruptId: "continuation-1",
      status: "resolved",
      payload: { region: "eu-west" },
    });
  });
});
