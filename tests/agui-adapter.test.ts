import { RunFinishedEventSchema } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AguiInterruptIssuance,
  type AguiResumeValidationOptions,
  fromAguiRunAgentInput,
  issueAguiInterrupts,
  toAguiResumeEntry,
} from "../src/adapters/agui/interrupt.js";
import { ProtocolAdapterError } from "../src/adapters/protocol-error.js";
import type {
  CancelledContinuationEnvelopeV1,
  JsonValue,
  PendingContinuationEnvelopeV1,
  ResumedContinuationEnvelopeV1,
} from "../src/domain/types.js";

const THREAD_ID = "thread-agui-1";
const NOW = new Date("2026-07-17T10:00:00.000Z");
const EXPIRES_AT = "2099-07-17T10:05:00.000Z";

function pending(
  overrides: Partial<PendingContinuationEnvelopeV1> = {},
): PendingContinuationEnvelopeV1 {
  return {
    schemaVersion: 1,
    continuationId: "interrupt-1",
    correlationId: THREAD_ID,
    version: 1,
    createdAt: "2026-07-17T09:55:00.000Z",
    expiresAt: EXPIRES_AT,
    payload: { kind: "input", message: "Approve the deployment?" },
    metadata: { source: "agui-test" },
    status: "pending",
    resumeTokenHash: "a".repeat(64),
    ...overrides,
  };
}

function resumed(
  source: PendingContinuationEnvelopeV1,
  idempotencyKey: string,
  resumePayload: JsonValue,
): ResumedContinuationEnvelopeV1 {
  return {
    schemaVersion: source.schemaVersion,
    continuationId: source.continuationId,
    correlationId: source.correlationId,
    version: source.version + 1,
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    payload: source.payload,
    metadata: source.metadata,
    status: "resumed",
    resumedAt: "2026-07-17T10:00:01.000Z",
    idempotencyKey,
    resumePayload,
  };
}

function cancelled(
  source: PendingContinuationEnvelopeV1,
  reason = "agui:cancelled",
): CancelledContinuationEnvelopeV1 {
  return {
    schemaVersion: source.schemaVersion,
    continuationId: source.continuationId,
    correlationId: source.correlationId,
    version: source.version + 1,
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    payload: source.payload,
    metadata: source.metadata,
    status: "cancelled",
    cancelledAt: "2026-07-17T10:00:01.000Z",
    reason,
  };
}

function runInput(
  resume?: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId: THREAD_ID,
    runId: "run-resume-1",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    ...(resume === undefined ? {} : { resume }),
    ...overrides,
  };
}

function issue(
  cohort: readonly PendingContinuationEnvelopeV1[],
  runId = "run-interrupted-1",
): AguiInterruptIssuance {
  return issueAguiInterrupts(cohort, { threadId: THREAD_ID, runId });
}

function nestedValue(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}

function validate(
  rawInput: unknown,
  issuance: AguiInterruptIssuance,
  current: Parameters<typeof fromAguiRunAgentInput>[2],
  options: AguiResumeValidationOptions = { now: NOW },
) {
  return fromAguiRunAgentInput(rawInput, issuance.receipt, current, options);
}

function expectError(
  result: ReturnType<typeof fromAguiRunAgentInput>,
  code:
    | "PAUSEMESH_AGUI_INVALID_INPUT"
    | "PAUSEMESH_AGUI_RESUME_REQUIRED"
    | "PAUSEMESH_AGUI_THREAD_MISMATCH"
    | "PAUSEMESH_AGUI_DUPLICATE_INTERRUPT"
    | "PAUSEMESH_AGUI_RESUME_SET_MISMATCH"
    | "PAUSEMESH_AGUI_RESUME_EXPIRED"
    | "PAUSEMESH_AGUI_INVALID_ENTRY"
    | "PAUSEMESH_AGUI_INVALID_PAYLOAD"
    | "PAUSEMESH_AGUI_REPLAY_CONFLICT",
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an AG-UI run error");
  expect(result.error).toEqual({
    type: "RUN_ERROR",
    code,
    message: expect.any(String),
  });
  expect("commands" in result).toBe(false);
}

describe("AG-UI interrupt issuance", () => {
  it("emits an official RUN_FINISHED event and a content-addressed complete receipt", () => {
    const input = pending({
      payload: {
        kind: "input",
        message: "Choose a region",
        responseSchema: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
      },
    });
    const authorization = pending({
      continuationId: "interrupt-2",
      payload: { kind: "authorization", message: "Authorize the deployment" },
    });

    const issuance = issue([input, authorization]);

    expect(RunFinishedEventSchema.safeParse(issuance.event).success).toBe(true);
    expect(issuance.receipt).toMatchObject({
      schemaVersion: 1,
      cohortId: expect.stringMatching(/^agui-cohort:[a-f\d]{64}$/),
      threadId: THREAD_ID,
      runId: "run-interrupted-1",
      interrupts: [
        {
          continuationId: "interrupt-1",
          expiresAt: EXPIRES_AT,
          issuedVersion: 1,
          payloadHash: expect.stringMatching(/^[a-f\d]{64}$/),
        },
        {
          continuationId: "interrupt-2",
          expiresAt: EXPIRES_AT,
          issuedVersion: 1,
          payloadHash: expect.stringMatching(/^[a-f\d]{64}$/),
        },
      ],
    });
    expect(issuance.event.outcome.interrupts).toEqual([
      expect.objectContaining({
        id: "interrupt-1",
        reason: "input_required",
        metadata: {
          pausemesh: {
            continuationId: "interrupt-1",
            schemaVersion: 1,
          },
        },
      }),
      expect.objectContaining({
        id: "interrupt-2",
        reason: "pausemesh:authorization_required",
      }),
    ]);
  });

  it("keeps opaque IDs exact and rejects edge whitespace instead of transforming it", () => {
    const continuation = pending({ continuationId: "interrupt internal" });
    expect(issue([continuation]).event.outcome.interrupts[0]?.id).toBe("interrupt internal");
    expect(toAguiResumeEntry("interrupt internal", { status: "resolved", payload: true })).toEqual({
      interruptId: "interrupt internal",
      status: "resolved",
      payload: true,
    });
    expect(() =>
      issueAguiInterrupts([continuation], { threadId: THREAD_ID, runId: " run " }),
    ).toThrow(ProtocolAdapterError);
    expect(() =>
      toAguiResumeEntry(" interrupt internal ", { status: "resolved", payload: true }),
    ).toThrow(ProtocolAdapterError);
  });

  it("rejects empty, duplicate, cross-thread, terminal, and malformed cohorts", () => {
    const first = pending();
    const malformed = pending({ payload: {} });
    for (const operation of [
      () => issue([]),
      () => issue([first, first]),
      () => issue([first, pending({ continuationId: "two", correlationId: "other" })]),
      () => issueAguiInterrupts([cancelled(first)], { threadId: THREAD_ID, runId: "run" }),
      () => issue([malformed]),
    ]) {
      expect(operation).toThrow(ProtocolAdapterError);
    }
  });

  it("normalizes deep or cyclic outbound payload failures to ProtocolAdapterError", () => {
    const deeplyNested = nestedValue(3_000) as JsonValue;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      toAguiResumeEntry("interrupt-1", { status: "resolved", payload: deeplyNested }),
    ).toThrow(ProtocolAdapterError);
    expect(() =>
      toAguiResumeEntry("interrupt-1", {
        status: "resolved",
        payload: cyclic as JsonValue,
      }),
    ).toThrow(ProtocolAdapterError);
    expect(() =>
      issue([
        pending({
          payload: {
            kind: "input",
            message: "Deep outbound payload",
            nested: deeplyNested,
          },
        }),
      ]),
    ).toThrow(ProtocolAdapterError);
  });
});

describe("AG-UI resume validation", () => {
  it("rejects deeply nested and cyclic payloads without leaking parser exceptions", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const deeplyNested = nestedValue(3_000);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const deepResult = validate(
      runInput([
        {
          interruptId: continuation.continuationId,
          status: "resolved",
          payload: deeplyNested,
        },
      ]),
      issuance,
      [continuation],
    );
    const cyclicResult = validate(
      runInput([
        {
          interruptId: continuation.continuationId,
          status: "resolved",
          payload: cyclic,
        },
      ]),
      issuance,
      [continuation],
    );

    expectError(deepResult, "PAUSEMESH_AGUI_INVALID_INPUT");
    expectError(cyclicResult, "PAUSEMESH_AGUI_INVALID_INPUT");
  });

  it.each([
    ["zero depth", { maxInputDepth: 0 }],
    ["fractional depth", { maxInputDepth: 1.5 }],
    ["infinite depth", { maxInputDepth: Number.POSITIVE_INFINITY }],
    ["zero nodes", { maxInputNodes: 0 }],
    ["fractional nodes", { maxInputNodes: 1.5 }],
    ["unsafe node integer", { maxInputNodes: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects invalid %s limits without throwing", (_label, limits) => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const result = validate(
      runInput([
        toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload: true }),
      ]),
      issuance,
      [continuation],
      { now: NOW, ...limits },
    );

    expectError(result, "PAUSEMESH_AGUI_INVALID_INPUT");
  });

  it("enforces configured traversal limits and accepts a normal bounded input", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const input = runInput([
      toAguiResumeEntry(continuation.continuationId, {
        status: "resolved",
        payload: { approved: true },
      }),
    ]);

    expectError(
      validate(input, issuance, [continuation], {
        now: NOW,
        maxInputDepth: 64,
        maxInputNodes: 10,
      }),
      "PAUSEMESH_AGUI_INVALID_INPUT",
    );
    expect(
      validate(input, issuance, [continuation], {
        now: NOW,
        maxInputDepth: 32,
        maxInputNodes: 1_000,
      }).ok,
    ).toBe(true);
  });

  it("accepts one exact batch and returns commands in issued order", () => {
    const first = pending();
    const second = pending({ continuationId: "interrupt-2" });
    const issuance = issue([first, second]);
    const result = validate(
      runInput([
        toAguiResumeEntry(second.continuationId, { status: "cancelled" }),
        toAguiResumeEntry(first.continuationId, {
          status: "resolved",
          payload: { approved: true },
        }),
      ]),
      issuance,
      [first, second],
    );

    expect(result).toEqual({
      ok: true,
      commands: [
        {
          action: "resume",
          continuationId: "interrupt-1",
          idempotencyKey: expect.stringMatching(/^agui:[a-f\d]{64}$/),
          resumePayload: { approved: true },
        },
        {
          action: "cancel",
          continuationId: "interrupt-2",
          expectedVersion: 1,
          reason: "agui:cancelled",
        },
      ],
    });
  });

  it.each([
    ["string", "approved"],
    ["number", 0],
    ["boolean", false],
    ["array", ["eu-west", 2, true, null]],
    ["null", null],
  ] as const)("preserves a resolved %s JSON payload", (_label, payload) => {
    const continuation = pending();
    const result = validate(
      runInput([toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload })]),
      issue([continuation]),
      [continuation],
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.commands[0]?.action !== "resume") {
      throw new Error("expected a valid AG-UI resume");
    }
    expect(result.commands[0].resumePayload).toEqual(payload);
  });

  it("derives the same idempotency key for recursively reordered object keys", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const firstPayload = { b: 2, a: { z: true, y: [3, { d: 4, c: 5 }] } };
    const reorderedPayload = { a: { y: [3, { c: 5, d: 4 }], z: true }, b: 2 };
    const first = validate(
      runInput([
        toAguiResumeEntry(continuation.continuationId, {
          status: "resolved",
          payload: firstPayload,
        }),
      ]),
      issuance,
      [continuation],
    );
    const reordered = validate(
      runInput([
        toAguiResumeEntry(continuation.continuationId, {
          status: "resolved",
          payload: reorderedPayload,
        }),
      ]),
      issuance,
      [continuation],
    );
    if (!first.ok || !reordered.ok) throw new Error("expected valid AG-UI resumes");
    expect(reordered.commands[0]).toMatchObject({
      idempotencyKey: (first.commands[0] as { idempotencyKey: string }).idempotencyKey,
    });
  });

  it("rejects a wrong thread and a missing resume batch", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const entry = toAguiResumeEntry(continuation.continuationId, {
      status: "resolved",
      payload: true,
    });
    expectError(
      validate(runInput([entry], { threadId: "thread-other" }), issuance, [continuation]),
      "PAUSEMESH_AGUI_THREAD_MISMATCH",
    );
    expectError(validate(runInput(), issuance, [continuation]), "PAUSEMESH_AGUI_RESUME_REQUIRED");
  });

  it.each([
    [
      "wrong",
      [{ interruptId: "interrupt-wrong", status: "resolved", payload: true }],
      "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
    ],
    [
      "partial",
      [{ interruptId: "interrupt-1", status: "resolved", payload: true }],
      "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
    ],
    [
      "extra",
      [
        { interruptId: "interrupt-1", status: "resolved", payload: true },
        { interruptId: "interrupt-2", status: "resolved", payload: true },
        { interruptId: "interrupt-extra", status: "resolved", payload: true },
      ],
      "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
    ],
    [
      "duplicate",
      [
        { interruptId: "interrupt-1", status: "resolved", payload: true },
        { interruptId: "interrupt-1", status: "resolved", payload: true },
        { interruptId: "interrupt-2", status: "resolved", payload: true },
      ],
      "PAUSEMESH_AGUI_DUPLICATE_INTERRUPT",
    ],
  ] as const)("rejects a %s resume set", (_label, entries, code) => {
    const cohort = [pending(), pending({ continuationId: "interrupt-2" })];
    expectError(validate(runInput(entries), issue(cohort), cohort), code);
  });

  it("binds validation to the immutable receipt and the complete current cohort", () => {
    const cohort = [pending(), pending({ continuationId: "interrupt-2" })];
    const issuance = issue(cohort);
    const entries = cohort.map((continuation) =>
      toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload: true }),
    );
    expectError(
      validate(runInput(entries), issuance, [cohort[0] as PendingContinuationEnvelopeV1]),
      "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
    );
    const altered = {
      ...issuance.receipt,
      runId: "run-altered",
    };
    expectError(
      fromAguiRunAgentInput(runInput(entries), altered, cohort, { now: NOW }),
      "PAUSEMESH_AGUI_INVALID_INPUT",
    );
    expectError(
      validate(runInput(entries), issuance, [
        {
          ...(cohort[0] as PendingContinuationEnvelopeV1),
          payload: { kind: "input", message: "Changed" },
        },
        cohort[1] as PendingContinuationEnvelopeV1,
      ]),
      "PAUSEMESH_AGUI_REPLAY_CONFLICT",
    );
  });

  it("accepts cancellation only when payload is absent and includes a CAS fence", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    expect(
      validate(
        runInput([toAguiResumeEntry(continuation.continuationId, { status: "cancelled" })]),
        issuance,
        [continuation],
      ),
    ).toEqual({
      ok: true,
      commands: [
        {
          action: "cancel",
          continuationId: continuation.continuationId,
          expectedVersion: 1,
          reason: "agui:cancelled",
        },
      ],
    });
    expectError(
      validate(
        runInput([
          { interruptId: continuation.continuationId, status: "cancelled", payload: null },
        ]),
        issuance,
        [continuation],
      ),
      "PAUSEMESH_AGUI_INVALID_ENTRY",
    );
  });

  it("rejects missing resolved payload but preserves an explicit null", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    expectError(
      validate(
        runInput([{ interruptId: continuation.continuationId, status: "resolved" }]),
        issuance,
        [continuation],
      ),
      "PAUSEMESH_AGUI_INVALID_PAYLOAD",
    );
    expect(
      validate(
        runInput([{ interruptId: continuation.continuationId, status: "resolved", payload: null }]),
        issuance,
        [continuation],
      ).ok,
    ).toBe(true);
  });

  it("fails closed when schema validation is missing, rejects, or throws", () => {
    const responseSchema = { type: "boolean" };
    const continuation = pending({
      payload: { kind: "input", message: "Approve?", responseSchema },
    });
    const issuance = issue([continuation]);
    const input = runInput([
      toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload: true }),
    ]);
    expectError(validate(input, issuance, [continuation]), "PAUSEMESH_AGUI_INVALID_PAYLOAD");
    const rejecting = vi.fn(() => ({ valid: false as const, message: "sensitive detail" }));
    const rejected = validate(input, issuance, [continuation], {
      now: NOW,
      validatePayload: rejecting,
    });
    expectError(rejected, "PAUSEMESH_AGUI_INVALID_PAYLOAD");
    if (!rejected.ok) expect(rejected.error.message).not.toContain("sensitive detail");
    expectError(
      validate(input, issuance, [continuation], {
        now: NOW,
        validatePayload: () => {
          throw new Error("validator internals");
        },
      }),
      "PAUSEMESH_AGUI_INVALID_PAYLOAD",
    );
  });

  it("fails closed if schema validation mutates its isolated payload", () => {
    const continuation = pending({
      payload: {
        kind: "input",
        message: "Approve?",
        responseSchema: { type: "object" },
      },
    });
    const issuance = issue([continuation]);
    const decisionPayload = { approved: true };
    const result = validate(
      runInput([
        toAguiResumeEntry(continuation.continuationId, {
          status: "resolved",
          payload: decisionPayload,
        }),
      ]),
      issuance,
      [continuation],
      {
        now: NOW,
        validatePayload: ({ payload, continuation: validationContinuation }) => {
          (payload as { approved: boolean }).approved = false;
          (validationContinuation as { continuationId: string }).continuationId = "mutated";
          return { valid: true };
        },
      },
    );

    expectError(result, "PAUSEMESH_AGUI_INVALID_PAYLOAD");
    expect(decisionPayload).toEqual({ approved: true });
    expect(continuation.continuationId).toBe("interrupt-1");
  });

  it("never accepts authorization credentials in-band but allows cancellation", () => {
    const authorization = pending({
      payload: { kind: "authorization", message: "Authorize out of band" },
    });
    const issuance = issue([authorization]);
    expectError(
      validate(
        runInput([
          toAguiResumeEntry(authorization.continuationId, {
            status: "resolved",
            payload: { accessToken: "secret" },
          }),
        ]),
        issuance,
        [authorization],
      ),
      "PAUSEMESH_AGUI_INVALID_ENTRY",
    );
    expect(
      validate(
        runInput([toAguiResumeEntry(authorization.continuationId, { status: "cancelled" })]),
        issuance,
        [authorization],
      ).ok,
    ).toBe(true);
  });

  it("treats the exact expiry instant as expired", () => {
    const continuation = pending({ expiresAt: "2026-07-17T10:00:00.000Z" });
    const issuance = issue([continuation]);
    const input = runInput([
      toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload: true }),
    ]);
    expect(
      validate(input, issuance, [continuation], {
        now: new Date("2026-07-17T09:59:59.999Z"),
      }).ok,
    ).toBe(true);
    expectError(
      validate(input, issuance, [continuation], { now: new Date(continuation.expiresAt) }),
      "PAUSEMESH_AGUI_RESUME_EXPIRED",
    );
    expectError(
      validate(input, issuance, [continuation], { now: new Date("invalid") }),
      "PAUSEMESH_AGUI_INVALID_INPUT",
    );
  });

  it("accepts exact terminal replays after expiry without rerunning schema policy", () => {
    const continuation = pending({
      payload: {
        kind: "input",
        message: "Approve?",
        responseSchema: { type: "boolean" },
      },
    });
    const issuance = issue([continuation]);
    const entry = toAguiResumeEntry(continuation.continuationId, {
      status: "resolved",
      payload: true,
    });
    const first = validate(runInput([entry]), issuance, [continuation], {
      now: NOW,
      validatePayload: () => ({ valid: true }),
    });
    if (!first.ok || first.commands[0]?.action !== "resume") {
      throw new Error("expected initial resume");
    }
    const replay = validate(
      runInput([entry], { runId: "run-retry" }),
      issuance,
      [resumed(continuation, first.commands[0].idempotencyKey, true)],
      { now: new Date("2100-01-01T00:00:00.000Z") },
    );
    expect(replay).toEqual(first);
  });

  it("rejects terminal replay conflicts and different cancellation reasons", () => {
    const continuation = pending();
    const issuance = issue([continuation]);
    const acceptedEntry = toAguiResumeEntry(continuation.continuationId, {
      status: "resolved",
      payload: true,
    });
    const first = validate(runInput([acceptedEntry]), issuance, [continuation]);
    if (!first.ok || first.commands[0]?.action !== "resume") throw new Error("expected resume");
    const terminal = resumed(continuation, first.commands[0].idempotencyKey, true);
    expectError(
      validate(
        runInput([
          toAguiResumeEntry(continuation.continuationId, { status: "resolved", payload: false }),
        ]),
        issuance,
        [terminal],
      ),
      "PAUSEMESH_AGUI_REPLAY_CONFLICT",
    );
    expectError(
      validate(
        runInput([toAguiResumeEntry(continuation.continuationId, { status: "cancelled" })]),
        issuance,
        [terminal],
      ),
      "PAUSEMESH_AGUI_REPLAY_CONFLICT",
    );
    expectError(
      validate(runInput([acceptedEntry]), issuance, [cancelled(continuation)]),
      "PAUSEMESH_AGUI_REPLAY_CONFLICT",
    );
    const cancelEntry = toAguiResumeEntry(continuation.continuationId, { status: "cancelled" });
    expect(validate(runInput([cancelEntry]), issuance, [cancelled(continuation)]).ok).toBe(true);
    expectError(
      validate(runInput([cancelEntry]), issuance, [cancelled(continuation, "operator")]),
      "PAUSEMESH_AGUI_REPLAY_CONFLICT",
    );
  });

  it("returns no partial command batch when any member is invalid", () => {
    const first = pending();
    const second = pending({ continuationId: "interrupt-2" });
    const cohort = [first, second];
    expectError(
      validate(
        runInput([
          toAguiResumeEntry(first.continuationId, { status: "resolved", payload: true }),
          { interruptId: second.continuationId, status: "resolved", payload: 1n },
        ]),
        issue(cohort),
        cohort,
      ),
      "PAUSEMESH_AGUI_INVALID_PAYLOAD",
    );
  });

  it("rejects malformed protocol status before interpreting the batch", () => {
    const continuation = pending();
    expectError(
      validate(
        runInput([{ interruptId: continuation.continuationId, status: "wrong", payload: true }]),
        issue([continuation]),
        [continuation],
      ),
      "PAUSEMESH_AGUI_INVALID_INPUT",
    );
  });
});
