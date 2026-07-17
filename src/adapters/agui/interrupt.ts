import { createHash } from "node:crypto";
import { RunAgentInputSchema } from "@ag-ui/core";
import { z } from "zod";
import { type ContinuationEnvelopeV1, canonicalJson, type JsonValue } from "../../domain/index.js";
import { ProtocolAdapterError } from "../protocol-error.js";

const ContinuationPayloadSchema = z
  .object({
    kind: z.enum(["input", "authorization"]).default("input"),
    message: z.string().min(1),
    responseSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const OpaqueProtocolIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && value === value.trim(), {
    message: "Protocol IDs must be non-empty and must not contain edge whitespace",
  });

const AguiRunBindingSchema = z
  .object({
    runId: OpaqueProtocolIdSchema,
    threadId: OpaqueProtocolIdSchema,
  })
  .strict();

const AguiReceiptInterruptSchema = z
  .object({
    continuationId: OpaqueProtocolIdSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    issuedVersion: z.number().int().positive().safe(),
    payloadHash: z.string().regex(/^[a-f\d]{64}$/),
  })
  .strict();

const AguiInterruptReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    cohortId: z.string().regex(/^agui-cohort:[a-f\d]{64}$/),
    threadId: OpaqueProtocolIdSchema,
    runId: OpaqueProtocolIdSchema,
    interrupts: z.array(AguiReceiptInterruptSchema).min(1),
  })
  .strict();

const JsonValueSchema = z.json();

const DEFAULT_MAX_INPUT_DEPTH = 64;
const DEFAULT_MAX_INPUT_NODES = 50_000;

interface AguiInputLimits {
  readonly maxInputDepth: number;
  readonly maxInputNodes: number;
}

type AguiInputFrame =
  | { readonly phase: "visit"; readonly value: unknown; readonly depth: number }
  | { readonly phase: "leave"; readonly value: object };

export interface AguiRunBinding {
  readonly runId: string;
  readonly threadId: string;
}

export interface AguiInterrupt {
  readonly id: string;
  readonly reason: "input_required" | "pausemesh:authorization_required";
  readonly message: string;
  readonly expiresAt: string;
  readonly responseSchema?: Record<string, unknown>;
  readonly metadata: {
    readonly pausemesh: {
      readonly continuationId: string;
      readonly schemaVersion: 1;
    };
  };
}

export interface AguiInterruptEvent {
  readonly type: "RUN_FINISHED";
  readonly threadId: string;
  readonly runId: string;
  readonly outcome: {
    readonly type: "interrupt";
    readonly interrupts: readonly AguiInterrupt[];
  };
}

export interface AguiReceiptInterrupt {
  readonly continuationId: string;
  readonly expiresAt: string;
  readonly issuedVersion: number;
  readonly payloadHash: string;
}

/**
 * Immutable host-side evidence of the complete interrupt cohort that was emitted. It detects
 * dropped, reordered, stale, or accidentally altered members; it is not an authentication token.
 */
export interface AguiInterruptReceipt {
  readonly schemaVersion: 1;
  readonly cohortId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly interrupts: readonly AguiReceiptInterrupt[];
}

export interface AguiInterruptIssuance {
  readonly event: AguiInterruptEvent;
  readonly receipt: AguiInterruptReceipt;
}

export type AguiResumeEntry =
  | {
      readonly interruptId: string;
      readonly status: "resolved";
      readonly payload: JsonValue;
    }
  | {
      readonly interruptId: string;
      readonly status: "cancelled";
    };

export type AguiResumeErrorCode =
  | "PAUSEMESH_AGUI_INVALID_INPUT"
  | "PAUSEMESH_AGUI_RESUME_REQUIRED"
  | "PAUSEMESH_AGUI_THREAD_MISMATCH"
  | "PAUSEMESH_AGUI_DUPLICATE_INTERRUPT"
  | "PAUSEMESH_AGUI_RESUME_SET_MISMATCH"
  | "PAUSEMESH_AGUI_RESUME_EXPIRED"
  | "PAUSEMESH_AGUI_INVALID_ENTRY"
  | "PAUSEMESH_AGUI_INVALID_PAYLOAD"
  | "PAUSEMESH_AGUI_REPLAY_CONFLICT";

export interface AguiRunErrorEvent {
  readonly type: "RUN_ERROR";
  readonly message: string;
  readonly code?: AguiResumeErrorCode;
  readonly timestamp?: number;
  readonly rawEvent?: unknown;
}

export type AguiResumeCommand =
  | {
      readonly action: "resume";
      readonly continuationId: string;
      readonly idempotencyKey: string;
      readonly resumePayload: JsonValue;
    }
  | {
      readonly action: "cancel";
      readonly continuationId: string;
      readonly expectedVersion: number;
      readonly reason: "agui:cancelled";
    };

export type AguiPayloadValidator = (input: {
  readonly continuation: ContinuationEnvelopeV1;
  readonly payload: JsonValue;
  readonly responseSchema: Record<string, unknown>;
}) => { readonly valid: true } | { readonly valid: false; readonly message?: string };

export interface AguiResumeValidationOptions {
  readonly now?: Date;
  readonly validatePayload?: AguiPayloadValidator;
  /** Maximum object/array nesting accepted before protocol parsers run. Defaults to 64. */
  readonly maxInputDepth?: number;
  /** Maximum total values inspected before protocol parsers run. Defaults to 50,000. */
  readonly maxInputNodes?: number;
}

export type AguiResumeValidationResult =
  | { readonly ok: true; readonly commands: readonly AguiResumeCommand[] }
  | { readonly ok: false; readonly error: AguiRunErrorEvent };

function runError(code: AguiResumeErrorCode, message: string): AguiResumeValidationResult {
  return { ok: false, error: { type: "RUN_ERROR", code, message } };
}

function unsafeInputError(): AguiResumeValidationResult {
  return runError(
    "PAUSEMESH_AGUI_INVALID_INPUT",
    "AG-UI resume input could not be safely processed",
  );
}

function parseInputLimits(options: AguiResumeValidationOptions): AguiInputLimits | undefined {
  const maxInputDepth = options.maxInputDepth ?? DEFAULT_MAX_INPUT_DEPTH;
  const maxInputNodes = options.maxInputNodes ?? DEFAULT_MAX_INPUT_NODES;
  if (
    !Number.isSafeInteger(maxInputDepth) ||
    maxInputDepth < 1 ||
    !Number.isSafeInteger(maxInputNodes) ||
    maxInputNodes < 1
  ) {
    return undefined;
  }
  return { maxInputDepth, maxInputNodes };
}

/**
 * Bounded iterative traversal that rejects cycles before recursive protocol schemas, JSON
 * canonicalization, or cloning can observe untrusted structures.
 */
function passesInputPreflight(values: readonly unknown[], limits: AguiInputLimits): boolean {
  const stack: AguiInputFrame[] = values.map((value) => ({ phase: "visit", value, depth: 0 }));
  const activePath = new WeakSet<object>();
  let visitedNodes = 0;
  let pendingNodes = values.length;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) return false;
    if (frame.phase === "leave") {
      activePath.delete(frame.value);
      continue;
    }

    pendingNodes -= 1;
    visitedNodes += 1;
    if (visitedNodes > limits.maxInputNodes || frame.depth > limits.maxInputDepth) return false;

    const valueType = typeof frame.value;
    if (frame.value === null || (valueType !== "object" && valueType !== "function")) {
      continue;
    }

    const objectValue = frame.value as object;
    if (activePath.has(objectValue)) return false;
    const keys = Object.keys(objectValue);
    if (visitedNodes + pendingNodes + keys.length > limits.maxInputNodes) return false;

    activePath.add(objectValue);
    stack.push({ phase: "leave", value: objectValue });
    pendingNodes += keys.length;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) return false;
      stack.push({
        phase: "visit",
        value: Reflect.get(objectValue, key),
        depth: frame.depth + 1,
      });
    }
  }

  return true;
}

function withOutboundAdapterBoundary<T>(message: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProtocolAdapterError) throw error;
    throw new ProtocolAdapterError("INVALID_PROTOCOL_MESSAGE", message);
  }
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function receiptDescriptor(receipt: Omit<AguiInterruptReceipt, "cohortId">): JsonValue {
  return {
    schemaVersion: receipt.schemaVersion,
    threadId: receipt.threadId,
    runId: receipt.runId,
    interrupts: receipt.interrupts.map((interrupt) => ({
      continuationId: interrupt.continuationId,
      expiresAt: interrupt.expiresAt,
      issuedVersion: interrupt.issuedVersion,
      payloadHash: interrupt.payloadHash,
    })),
  };
}

function cohortId(receipt: Omit<AguiInterruptReceipt, "cohortId">): string {
  return `agui-cohort:${hashJson(["agui-cohort-v1", receiptDescriptor(receipt)])}`;
}

function resumeIdempotencyKey(
  threadId: string,
  interruptId: string,
  status: "resolved",
  payload: JsonValue,
): string {
  const tuple: JsonValue = ["agui-v1", threadId, interruptId, status, true, payload];
  return `agui:${hashJson(tuple)}`;
}

function requirePending(continuation: ContinuationEnvelopeV1): void {
  if (continuation.status !== "pending") {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_TRANSITION",
      `Cannot project a ${continuation.status} continuation as an AG-UI interrupt`,
    );
  }
}

function parseBinding(rawBinding: AguiRunBinding): AguiRunBinding {
  const parsed = AguiRunBindingSchema.safeParse(rawBinding);
  if (!parsed.success) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "AG-UI run binding is not protocol-valid",
    );
  }
  return parsed.data;
}

function parseContinuationPayload(
  continuation: ContinuationEnvelopeV1,
): z.infer<typeof ContinuationPayloadSchema> {
  const parsed = ContinuationPayloadSchema.safeParse(continuation.payload);
  if (!parsed.success || !JsonValueSchema.safeParse(continuation.payload).success) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_MESSAGE",
      "Continuation payload cannot be projected as an AG-UI interrupt",
    );
  }
  return parsed.data;
}

export function issueAguiInterrupts(
  continuations: readonly ContinuationEnvelopeV1[],
  rawBinding: AguiRunBinding,
): AguiInterruptIssuance {
  return withOutboundAdapterBoundary("AG-UI interrupt projection failed", () => {
    const binding = parseBinding(rawBinding);
    if (continuations.length === 0) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_BINDING",
        "AG-UI interrupt projection requires at least one continuation",
      );
    }

    const ids = new Set<string>();
    const projected = continuations.map((continuation) => {
      requirePending(continuation);
      if (continuation.correlationId !== binding.threadId) {
        throw new ProtocolAdapterError(
          "INVALID_PROTOCOL_BINDING",
          "AG-UI run binding thread does not match the continuation correlation ID",
        );
      }
      const parsedId = OpaqueProtocolIdSchema.safeParse(continuation.continuationId);
      if (!parsedId.success || ids.has(continuation.continuationId)) {
        throw new ProtocolAdapterError(
          "INVALID_PROTOCOL_BINDING",
          "AG-UI interrupt cohort contains an invalid or duplicate continuation ID",
        );
      }
      ids.add(continuation.continuationId);
      return { continuation, payload: parseContinuationPayload(continuation) };
    });

    const descriptor: Omit<AguiInterruptReceipt, "cohortId"> = {
      schemaVersion: 1,
      threadId: binding.threadId,
      runId: binding.runId,
      interrupts: projected.map(({ continuation }) => ({
        continuationId: continuation.continuationId,
        expiresAt: continuation.expiresAt,
        issuedVersion: continuation.version,
        payloadHash: hashJson(continuation.payload),
      })),
    };
    const receipt: AguiInterruptReceipt = {
      ...descriptor,
      cohortId: cohortId(descriptor),
    };
    const parsedReceipt = AguiInterruptReceiptSchema.safeParse(receipt);
    if (!parsedReceipt.success) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        "Continuation cohort cannot be represented by an AG-UI issuance receipt",
      );
    }

    const interrupts = projected.map(
      ({ continuation, payload }): AguiInterrupt => ({
        id: continuation.continuationId,
        reason:
          payload.kind === "authorization" ? "pausemesh:authorization_required" : "input_required",
        message: payload.message,
        expiresAt: continuation.expiresAt,
        ...(payload.responseSchema === undefined ? {} : { responseSchema: payload.responseSchema }),
        metadata: {
          pausemesh: {
            continuationId: continuation.continuationId,
            schemaVersion: 1,
          },
        },
      }),
    );

    return {
      event: {
        type: "RUN_FINISHED",
        threadId: binding.threadId,
        runId: binding.runId,
        outcome: { type: "interrupt", interrupts },
      },
      receipt,
    };
  });
}

export function toAguiResumeEntry(
  interruptId: string,
  decision:
    | { readonly status: "resolved"; readonly payload: JsonValue }
    | { readonly status: "cancelled" },
): AguiResumeEntry {
  return withOutboundAdapterBoundary("AG-UI resume entry projection failed", () => {
    const parsedId = OpaqueProtocolIdSchema.safeParse(interruptId);
    if (!parsedId.success) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        "AG-UI interrupt ID is not protocol-valid",
      );
    }
    if (decision.status === "cancelled") {
      return { interruptId: parsedId.data, status: "cancelled" };
    }
    const payload = JsonValueSchema.safeParse(decision.payload);
    if (!payload.success) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        "AG-UI resume payload must be valid JSON",
      );
    }
    return { interruptId: parsedId.data, status: "resolved", payload: payload.data };
  });
}

function validateReceipt(
  rawReceipt: unknown,
): { readonly ok: true; readonly receipt: AguiInterruptReceipt } | AguiResumeValidationResult {
  const parsed = AguiInterruptReceiptSchema.safeParse(rawReceipt);
  if (!parsed.success) {
    return runError("PAUSEMESH_AGUI_INVALID_INPUT", "AG-UI issuance receipt is invalid");
  }
  const receipt = parsed.data as AguiInterruptReceipt;
  const { cohortId: suppliedCohortId, ...descriptor } = receipt;
  if (suppliedCohortId !== cohortId(descriptor)) {
    return runError("PAUSEMESH_AGUI_INVALID_INPUT", "AG-UI issuance receipt was altered");
  }
  const ids = new Set(receipt.interrupts.map((interrupt) => interrupt.continuationId));
  if (ids.size !== receipt.interrupts.length) {
    return runError(
      "PAUSEMESH_AGUI_INVALID_INPUT",
      "AG-UI issuance receipt contains a duplicate interrupt",
    );
  }
  return { ok: true, receipt };
}

function validateCurrentCohort(
  receipt: AguiInterruptReceipt,
  currentContinuations: readonly ContinuationEnvelopeV1[],
):
  | { readonly ok: true; readonly continuationsById: Map<string, ContinuationEnvelopeV1> }
  | AguiResumeValidationResult {
  const continuationsById = new Map(
    currentContinuations.map((continuation) => [continuation.continuationId, continuation]),
  );
  if (
    continuationsById.size !== currentContinuations.length ||
    continuationsById.size !== receipt.interrupts.length
  ) {
    return runError(
      "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
      "Current continuations do not match the complete issued interrupt cohort",
    );
  }

  for (const issued of receipt.interrupts) {
    const continuation = continuationsById.get(issued.continuationId);
    if (continuation === undefined) {
      return runError(
        "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
        "Current continuations omit an issued interrupt",
      );
    }
    const expectedVersion =
      continuation.status === "pending" ? issued.issuedVersion : issued.issuedVersion + 1;
    const parsedPayload = JsonValueSchema.safeParse(continuation.payload);
    if (
      !parsedPayload.success ||
      continuation.correlationId !== receipt.threadId ||
      continuation.expiresAt !== issued.expiresAt ||
      continuation.version !== expectedVersion ||
      (parsedPayload.success && hashJson(parsedPayload.data) !== issued.payloadHash)
    ) {
      return runError(
        "PAUSEMESH_AGUI_REPLAY_CONFLICT",
        "Current continuation state does not match the issued interrupt receipt",
      );
    }
  }
  return { ok: true, continuationsById };
}

function validatePayloadWithPolicy(
  continuation: ContinuationEnvelopeV1,
  payload: JsonValue,
  responseSchema: Record<string, unknown>,
  validator: AguiPayloadValidator | undefined,
): AguiResumeValidationResult | undefined {
  if (validator === undefined) {
    return runError(
      "PAUSEMESH_AGUI_INVALID_PAYLOAD",
      "AG-UI response-schema validation policy is required",
    );
  }
  try {
    const expectedPayload = canonicalJson(payload);
    const validationPayload = structuredClone(payload);
    const validationContinuation = structuredClone(continuation);
    const validationSchema = structuredClone(responseSchema);
    if (
      validator({
        continuation: validationContinuation,
        payload: validationPayload,
        responseSchema: validationSchema,
      }).valid !== true
    ) {
      return runError(
        "PAUSEMESH_AGUI_INVALID_PAYLOAD",
        "AG-UI resume payload does not match its response schema",
      );
    }
    const reparsedPayload = JsonValueSchema.safeParse(validationPayload);
    if (!reparsedPayload.success || canonicalJson(reparsedPayload.data) !== expectedPayload) {
      return runError(
        "PAUSEMESH_AGUI_INVALID_PAYLOAD",
        "AG-UI resume payload validation must not mutate the payload",
      );
    }
  } catch {
    return runError("PAUSEMESH_AGUI_INVALID_PAYLOAD", "AG-UI resume payload validation failed");
  }
  return undefined;
}

export function fromAguiRunAgentInput(
  rawInput: unknown,
  rawReceipt: unknown,
  currentContinuations: readonly ContinuationEnvelopeV1[],
  options: AguiResumeValidationOptions = {},
): AguiResumeValidationResult {
  try {
    const limits = parseInputLimits(options);
    if (
      limits === undefined ||
      !passesInputPreflight([rawInput, rawReceipt, currentContinuations], limits)
    ) {
      return unsafeInputError();
    }

    const parsedInput = RunAgentInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return runError("PAUSEMESH_AGUI_INVALID_INPUT", "AG-UI run input is not protocol-valid");
    }
    const validatedReceipt = validateReceipt(rawReceipt);
    if (!("receipt" in validatedReceipt)) return validatedReceipt;
    const receipt = validatedReceipt.receipt;
    const current = validateCurrentCohort(receipt, currentContinuations);
    if (!("continuationsById" in current)) return current;

    if (parsedInput.data.threadId !== receipt.threadId) {
      return runError(
        "PAUSEMESH_AGUI_THREAD_MISMATCH",
        "AG-UI resume must use the interrupted thread",
      );
    }
    const resumeEntries = parsedInput.data.resume;
    if (resumeEntries === undefined) {
      return runError(
        "PAUSEMESH_AGUI_RESUME_REQUIRED",
        "Pending AG-UI interrupts require a resume batch",
      );
    }

    const entriesById = new Map<string, (typeof resumeEntries)[number]>();
    for (const entry of resumeEntries) {
      if (entriesById.has(entry.interruptId)) {
        return runError(
          "PAUSEMESH_AGUI_DUPLICATE_INTERRUPT",
          "AG-UI resume contains a duplicate interrupt",
        );
      }
      entriesById.set(entry.interruptId, entry);
    }
    const issuedIds = new Set(receipt.interrupts.map((interrupt) => interrupt.continuationId));
    if (
      entriesById.size !== issuedIds.size ||
      [...entriesById.keys()].some((interruptId) => !issuedIds.has(interruptId))
    ) {
      return runError(
        "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
        "AG-UI resume must address the complete issued interrupt cohort exactly once",
      );
    }

    const now = options.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      return runError("PAUSEMESH_AGUI_INVALID_INPUT", "AG-UI validation clock is invalid");
    }
    const commands: AguiResumeCommand[] = [];
    for (const issued of receipt.interrupts) {
      const continuation = current.continuationsById.get(issued.continuationId);
      const entry = entriesById.get(issued.continuationId);
      if (continuation === undefined || entry === undefined) {
        return runError(
          "PAUSEMESH_AGUI_RESUME_SET_MISMATCH",
          "AG-UI resume is missing an issued interrupt",
        );
      }
      const payloadContract = ContinuationPayloadSchema.safeParse(continuation.payload);
      if (!payloadContract.success) {
        return runError(
          "PAUSEMESH_AGUI_INVALID_INPUT",
          "An issued AG-UI interrupt has an invalid continuation payload",
        );
      }
      const hasPayload = Object.hasOwn(entry, "payload") && entry.payload !== undefined;
      if (entry.status === "cancelled") {
        if (hasPayload) {
          return runError(
            "PAUSEMESH_AGUI_INVALID_ENTRY",
            "A cancelled AG-UI resume entry must omit payload",
          );
        }
        if (
          continuation.status === "resumed" ||
          (continuation.status === "cancelled" && continuation.reason !== "agui:cancelled")
        ) {
          return runError(
            "PAUSEMESH_AGUI_REPLAY_CONFLICT",
            "AG-UI resume conflicts with the completed interrupt outcome",
          );
        }
        if (continuation.status === "expired") {
          return runError(
            "PAUSEMESH_AGUI_RESUME_EXPIRED",
            "AG-UI resume references an expired interrupt",
          );
        }
        if (
          continuation.status === "pending" &&
          now.getTime() >= Date.parse(continuation.expiresAt)
        ) {
          return runError(
            "PAUSEMESH_AGUI_RESUME_EXPIRED",
            "AG-UI resume arrived after an interrupt expired",
          );
        }
        commands.push({
          action: "cancel",
          continuationId: continuation.continuationId,
          expectedVersion: issued.issuedVersion,
          reason: "agui:cancelled",
        });
        continue;
      }

      if (!hasPayload) {
        return runError(
          "PAUSEMESH_AGUI_INVALID_PAYLOAD",
          "A resolved AG-UI resume entry must include payload",
        );
      }
      const resumePayload = JsonValueSchema.safeParse(entry.payload);
      if (!resumePayload.success) {
        return runError(
          "PAUSEMESH_AGUI_INVALID_PAYLOAD",
          "A resolved AG-UI resume entry must contain valid JSON",
        );
      }
      if (payloadContract.data.kind === "authorization") {
        return runError(
          "PAUSEMESH_AGUI_INVALID_ENTRY",
          "Authorization credentials must be delivered through a trusted out-of-band callback",
        );
      }
      const stableResumePayload = structuredClone(resumePayload.data);
      if (continuation.status === "resumed") {
        const idempotencyKey = resumeIdempotencyKey(
          receipt.threadId,
          continuation.continuationId,
          "resolved",
          stableResumePayload,
        );
        if (
          continuation.idempotencyKey !== idempotencyKey ||
          canonicalJson(continuation.resumePayload) !== canonicalJson(stableResumePayload)
        ) {
          return runError(
            "PAUSEMESH_AGUI_REPLAY_CONFLICT",
            "AG-UI resume conflicts with the completed interrupt outcome",
          );
        }
        commands.push({
          action: "resume",
          continuationId: continuation.continuationId,
          idempotencyKey,
          resumePayload: stableResumePayload,
        });
        continue;
      }
      if (continuation.status === "cancelled") {
        return runError(
          "PAUSEMESH_AGUI_REPLAY_CONFLICT",
          "AG-UI resume conflicts with the completed interrupt outcome",
        );
      }
      if (
        continuation.status === "expired" ||
        now.getTime() >= Date.parse(continuation.expiresAt)
      ) {
        return runError(
          "PAUSEMESH_AGUI_RESUME_EXPIRED",
          "AG-UI resume references an expired interrupt",
        );
      }
      if (payloadContract.data.responseSchema !== undefined) {
        const schemaError = validatePayloadWithPolicy(
          continuation,
          stableResumePayload,
          payloadContract.data.responseSchema,
          options.validatePayload,
        );
        if (schemaError !== undefined) return schemaError;
      }
      const idempotencyKey = resumeIdempotencyKey(
        receipt.threadId,
        continuation.continuationId,
        "resolved",
        stableResumePayload,
      );
      commands.push({
        action: "resume",
        continuationId: continuation.continuationId,
        idempotencyKey,
        resumePayload: stableResumePayload,
      });
    }

    return { ok: true, commands };
  } catch {
    return unsafeInputError();
  }
}
