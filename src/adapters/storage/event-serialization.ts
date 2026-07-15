import { z } from "zod";
import { ContinuationIdMismatchError, VersionConflictError } from "../../domain/errors.js";
import type { ContinuationEventV1 } from "../../domain/events.js";
import {
  CONTINUATION_SCHEMA_VERSION,
  type ContinuationId,
  type ContinuationVersion,
} from "../../domain/types.js";

const eventBaseSchema = {
  schemaVersion: z.literal(CONTINUATION_SCHEMA_VERSION),
  continuationId: z.string().min(1),
  version: z.number().int().positive().safe(),
  occurredAt: z.iso.datetime(),
} as const;

const continuationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBaseSchema,
      type: z.literal("continuation.created"),
      correlationId: z.string().min(1),
      expiresAt: z.iso.datetime(),
      payload: z.json(),
      metadata: z.record(z.string(), z.json()),
      resumeTokenHash: z.string().regex(/^[a-f\d]{64}$/i),
    })
    .strict(),
  z
    .object({
      ...eventBaseSchema,
      type: z.literal("continuation.resumed"),
      idempotencyKey: z.string().min(1),
      resumePayload: z.json(),
    })
    .strict(),
  z
    .object({
      ...eventBaseSchema,
      type: z.literal("continuation.cancelled"),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...eventBaseSchema,
      type: z.literal("continuation.expired"),
    })
    .strict(),
]);

function parseEvent(event: unknown): ContinuationEventV1 {
  const result = continuationEventSchema.safeParse(event);
  if (!result.success) {
    throw new TypeError("Stored continuation event does not match schema version 1", {
      cause: result.error,
    });
  }
  // Zod may infer an omitted optional property as `undefined`; JSON persistence and the exact
  // optional domain interface represent the same validated field by omitting it.
  return result.data as ContinuationEventV1;
}

export function serializeAppendBatch(
  continuationId: ContinuationId,
  expectedVersion: ContinuationVersion,
  events: readonly ContinuationEventV1[],
): readonly string[] {
  return events.map((event, index) => {
    if (event.continuationId !== continuationId) {
      throw new ContinuationIdMismatchError(continuationId, event.continuationId);
    }

    const nextVersion = expectedVersion + index + 1;
    if (event.version !== nextVersion) {
      throw new VersionConflictError(continuationId, nextVersion, event.version);
    }

    return JSON.stringify(parseEvent(event));
  });
}

export function deserializeEvent(serializedEvent: string): ContinuationEventV1 {
  let event: unknown;
  try {
    event = JSON.parse(serializedEvent);
  } catch (cause) {
    throw new TypeError("Stored continuation event must be valid JSON", { cause });
  }
  return parseEvent(event);
}
