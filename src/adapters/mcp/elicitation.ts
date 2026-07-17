import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ContinuationEnvelopeV1,
  canonicalJson,
  type JsonObject,
  type JsonValue,
} from "../../domain/index.js";
import { ProtocolAdapterError, type ProtocolAdapterErrorCode } from "../protocol-error.js";

const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const OpaqueProtocolIdSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "protocol identifiers must not have leading or trailing whitespace",
  });
const PreservedNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "value must not have leading or trailing whitespace",
  });
const McpRequestIdSchema = z.union([OpaqueProtocolIdSchema, z.number().int().safe()]);
const OptionalTextFields = {
  description: z.string().optional(),
  title: z.string().optional(),
};

function parseBoundary<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  code: ProtocolAdapterErrorCode,
  message: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProtocolAdapterError(code, message);
  }
  return result.data;
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function addRangeIssue(
  value: { maximum?: number | undefined; minimum?: number | undefined },
  context: z.RefinementCtx,
): void {
  if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
    context.addIssue({
      code: "custom",
      message: "minimum must not exceed maximum",
      path: ["minimum"],
    });
  }
}

function addLengthIssue(
  value: { maxLength?: number | undefined; minLength?: number | undefined },
  context: z.RefinementCtx,
): void {
  if (
    value.minLength !== undefined &&
    value.maxLength !== undefined &&
    value.minLength > value.maxLength
  ) {
    context.addIssue({
      code: "custom",
      message: "minLength must not exceed maxLength",
      path: ["minLength"],
    });
  }
}

const McpStringSchemaDefinitionSchema = z
  .object({
    ...OptionalTextFields,
    default: z.string().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    maxLength: NonNegativeIntegerSchema.optional(),
    minLength: NonNegativeIntegerSchema.optional(),
    type: z.literal("string"),
  })
  .strict()
  .superRefine((value, context) => {
    addLengthIssue(value, context);
    if (value.default !== undefined && value.minLength !== undefined) {
      if (unicodeLength(value.default) < value.minLength) {
        context.addIssue({
          code: "custom",
          message: "default is shorter than minLength",
          path: ["default"],
        });
      }
    }
    if (value.default !== undefined && value.maxLength !== undefined) {
      if (unicodeLength(value.default) > value.maxLength) {
        context.addIssue({
          code: "custom",
          message: "default is longer than maxLength",
          path: ["default"],
        });
      }
    }
    if (
      value.default !== undefined &&
      value.format !== undefined &&
      !validateStringFormat(value.default, value.format)
    ) {
      context.addIssue({
        code: "custom",
        message: "default does not match format",
        path: ["default"],
      });
    }
  });

const McpNumberSchemaDefinitionSchema = z
  .object({
    ...OptionalTextFields,
    default: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
    type: z.enum(["number", "integer"]),
  })
  .strict()
  .superRefine((value, context) => {
    addRangeIssue(value, context);
    if (
      value.type === "integer" &&
      value.default !== undefined &&
      !Number.isInteger(value.default)
    ) {
      context.addIssue({
        code: "custom",
        message: "integer schema default must be an integer",
        path: ["default"],
      });
    }
    if (value.default !== undefined && value.minimum !== undefined) {
      if (value.default < value.minimum) {
        context.addIssue({
          code: "custom",
          message: "default is lower than minimum",
          path: ["default"],
        });
      }
    }
    if (value.default !== undefined && value.maximum !== undefined) {
      if (value.default > value.maximum) {
        context.addIssue({
          code: "custom",
          message: "default is greater than maximum",
          path: ["default"],
        });
      }
    }
  });

const McpBooleanSchemaDefinitionSchema = z
  .object({
    ...OptionalTextFields,
    default: z.boolean().optional(),
    type: z.literal("boolean"),
  })
  .strict();

const McpUntitledSingleEnumSchema = z
  .object({
    ...OptionalTextFields,
    default: z.string().optional(),
    enum: z.array(z.string()).min(1),
    type: z.literal("string"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.enum).size !== value.enum.length) {
      context.addIssue({ code: "custom", message: "enum values must be unique", path: ["enum"] });
    }
    if (value.default !== undefined && !value.enum.includes(value.default)) {
      context.addIssue({
        code: "custom",
        message: "default must be one of the enum values",
        path: ["default"],
      });
    }
  });

const McpLegacyTitledEnumSchema = z
  .object({
    ...OptionalTextFields,
    default: z.string().optional(),
    enum: z.array(z.string()).min(1),
    enumNames: z.array(z.string()).optional(),
    type: z.literal("string"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.enum).size !== value.enum.length) {
      context.addIssue({ code: "custom", message: "enum values must be unique", path: ["enum"] });
    }
    if (value.enumNames !== undefined && value.enumNames.length !== value.enum.length) {
      context.addIssue({
        code: "custom",
        message: "enumNames must contain one title for every enum value",
        path: ["enumNames"],
      });
    }
    if (value.default !== undefined && !value.enum.includes(value.default)) {
      context.addIssue({
        code: "custom",
        message: "default must be one of the enum values",
        path: ["default"],
      });
    }
  });

const TitledEnumOptionSchema = z.object({ const: z.string(), title: z.string() }).strict();

const McpTitledSingleEnumSchema = z
  .object({
    ...OptionalTextFields,
    default: z.string().optional(),
    oneOf: z.array(TitledEnumOptionSchema).min(1),
    type: z.literal("string"),
  })
  .strict()
  .superRefine((value, context) => {
    const values = value.oneOf.map((option) => option.const);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "enum values must be unique", path: ["oneOf"] });
    }
    if (value.default !== undefined && !values.includes(value.default)) {
      context.addIssue({
        code: "custom",
        message: "default must be one of the enum values",
        path: ["default"],
      });
    }
  });

const McpUntitledMultiEnumSchema = z
  .object({
    ...OptionalTextFields,
    default: z.array(z.string()).optional(),
    items: z.object({ enum: z.array(z.string()).min(1), type: z.literal("string") }).strict(),
    maxItems: NonNegativeIntegerSchema.optional(),
    minItems: NonNegativeIntegerSchema.optional(),
    type: z.literal("array"),
  })
  .strict()
  .superRefine((value, context) => {
    addRangeIssue({ maximum: value.maxItems, minimum: value.minItems }, context);
    if (new Set(value.items.enum).size !== value.items.enum.length) {
      context.addIssue({
        code: "custom",
        message: "enum values must be unique",
        path: ["items", "enum"],
      });
    }
    if (value.default !== undefined) {
      if (new Set(value.default).size !== value.default.length) {
        context.addIssue({
          code: "custom",
          message: "default selections must be unique",
          path: ["default"],
        });
      }
      if (value.default.some((entry) => !value.items.enum.includes(entry))) {
        context.addIssue({
          code: "custom",
          message: "default selections must be enum values",
          path: ["default"],
        });
      }
      if (value.minItems !== undefined && value.default.length < value.minItems) {
        context.addIssue({
          code: "custom",
          message: "default has fewer selections than minItems",
          path: ["default"],
        });
      }
      if (value.maxItems !== undefined && value.default.length > value.maxItems) {
        context.addIssue({
          code: "custom",
          message: "default has more selections than maxItems",
          path: ["default"],
        });
      }
    }
  });

const McpTitledMultiEnumSchema = z
  .object({
    ...OptionalTextFields,
    default: z.array(z.string()).optional(),
    items: z.object({ anyOf: z.array(TitledEnumOptionSchema).min(1) }).strict(),
    maxItems: NonNegativeIntegerSchema.optional(),
    minItems: NonNegativeIntegerSchema.optional(),
    type: z.literal("array"),
  })
  .strict()
  .superRefine((value, context) => {
    addRangeIssue({ maximum: value.maxItems, minimum: value.minItems }, context);
    const values = value.items.anyOf.map((option) => option.const);
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: "enum values must be unique",
        path: ["items", "anyOf"],
      });
    }
    if (value.default !== undefined) {
      if (new Set(value.default).size !== value.default.length) {
        context.addIssue({
          code: "custom",
          message: "default selections must be unique",
          path: ["default"],
        });
      }
      if (value.default.some((entry) => !values.includes(entry))) {
        context.addIssue({
          code: "custom",
          message: "default selections must be enum values",
          path: ["default"],
        });
      }
      if (value.minItems !== undefined && value.default.length < value.minItems) {
        context.addIssue({
          code: "custom",
          message: "default has fewer selections than minItems",
          path: ["default"],
        });
      }
      if (value.maxItems !== undefined && value.default.length > value.maxItems) {
        context.addIssue({
          code: "custom",
          message: "default has more selections than maxItems",
          path: ["default"],
        });
      }
    }
  });

const McpPrimitiveSchemaDefinitionSchema = z.union([
  McpLegacyTitledEnumSchema,
  McpUntitledSingleEnumSchema,
  McpTitledSingleEnumSchema,
  McpUntitledMultiEnumSchema,
  McpTitledMultiEnumSchema,
  McpStringSchemaDefinitionSchema,
  McpNumberSchemaDefinitionSchema,
  McpBooleanSchemaDefinitionSchema,
]);

const McpRequestedSchemaSchema = z
  .object({
    $schema: z.string().optional(),
    properties: z.record(z.string(), McpPrimitiveSchemaDefinitionSchema),
    required: z.array(z.string()).optional(),
    type: z.literal("object"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required !== undefined && new Set(value.required).size !== value.required.length) {
      context.addIssue({
        code: "custom",
        message: "required property names must be unique",
        path: ["required"],
      });
    }
    for (const required of value.required ?? []) {
      if (!Object.hasOwn(value.properties, required)) {
        context.addIssue({
          code: "custom",
          message: `required property ${required} is not defined`,
          path: ["required"],
        });
      }
    }
  });

const InputContinuationPayloadSchema = z
  .object({
    kind: z.literal("input").default("input"),
    message: z.string().min(1),
    responseSchema: McpRequestedSchemaSchema.optional(),
  })
  .passthrough();

const AuthorizationContinuationPayloadSchema = z
  .object({
    kind: z.literal("authorization"),
    message: z.string().min(1),
    responseSchema: z.never().optional(),
  })
  .passthrough();

const ContinuationPayloadSchema = z.union([
  AuthorizationContinuationPayloadSchema,
  InputContinuationPayloadSchema,
]);

const McpClientCapabilitiesSchema = z
  .object({
    elicitation: z
      .object({
        form: z.object({}).passthrough().optional(),
        url: z.object({}).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const McpProjectionContextSchema = z
  .object({
    clientCapabilities: McpClientCapabilitiesSchema,
    relatedTask: z.object({ taskId: OpaqueProtocolIdSchema }).strict().optional(),
    requestId: McpRequestIdSchema,
    urlBinding: z
      .object({ elicitationId: OpaqueProtocolIdSchema, url: PreservedNonEmptyStringSchema })
      .strict()
      .optional(),
  })
  .strict();

const McpProjectionPolicySchema = z
  .object({
    allowInsecureLoopbackHttp: z.boolean().optional(),
    validateAuthorizationUrl: z
      .custom<McpAuthorizationUrlValidator>((value) => typeof value === "function")
      .optional(),
  })
  .strict();

const McpElicitResultSchema = z
  .object({
    _meta: z.record(z.string(), z.unknown()).optional(),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .optional(),
  })
  .passthrough();

const McpPauseMeshMetadataSchema = z
  .object({
    "io.pausemesh/continuation": z
      .object({
        continuationId: OpaqueProtocolIdSchema,
        correlationId: OpaqueProtocolIdSchema,
        expiresAt: PreservedNonEmptyStringSchema,
        requestId: McpRequestIdSchema,
        schemaVersion: z.literal(1),
      })
      .strict(),
    "io.modelcontextprotocol/related-task": z
      .object({ taskId: OpaqueProtocolIdSchema })
      .strict()
      .optional(),
  })
  .strict();

const McpFormElicitRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: McpRequestIdSchema,
    method: z.literal("elicitation/create"),
    params: z
      .object({
        mode: z.literal("form"),
        message: z.string().min(1),
        requestedSchema: McpRequestedSchemaSchema,
        _meta: McpPauseMeshMetadataSchema,
      })
      .strict(),
  })
  .strict();

const McpUrlElicitRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: McpRequestIdSchema,
    method: z.literal("elicitation/create"),
    params: z
      .object({
        mode: z.literal("url"),
        message: z.string().min(1),
        elicitationId: OpaqueProtocolIdSchema,
        url: PreservedNonEmptyStringSchema,
        _meta: McpPauseMeshMetadataSchema,
      })
      .strict(),
  })
  .strict();

const McpElicitRequestSchema = z.union([McpFormElicitRequestSchema, McpUrlElicitRequestSchema]);

const McpElicitationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    continuationId: OpaqueProtocolIdSchema,
    correlationId: OpaqueProtocolIdSchema,
    mode: z.enum(["form", "url"]),
    requestId: McpRequestIdSchema,
    requestHash: z.string().regex(/^[a-f\d]{64}$/),
  })
  .strict();

export type McpRequestedSchema = z.infer<typeof McpRequestedSchemaSchema>;
export type McpPrimitiveSchemaDefinition = z.infer<typeof McpPrimitiveSchemaDefinitionSchema>;
export type McpClientCapabilities = z.input<typeof McpClientCapabilitiesSchema>;

export interface McpRelatedTaskBinding {
  readonly taskId: string;
}

export interface McpUrlBinding {
  readonly elicitationId: string;
  readonly url: string;
}

export interface McpProjectionContext {
  readonly clientCapabilities: McpClientCapabilities;
  readonly relatedTask?: McpRelatedTaskBinding | undefined;
  readonly requestId: string | number;
  readonly urlBinding?: McpUrlBinding | undefined;
}

export interface McpProjectionPolicy {
  /** Trusted adapter policy. It is deliberately separate from request-derived context. */
  readonly allowInsecureLoopbackHttp?: boolean | undefined;
  /**
   * Required for URL mode. The host must attest that the URL is not pre-authenticated, contains
   * no user-sensitive state, and is bound to the initiating user/client workflow.
   */
  readonly validateAuthorizationUrl?: McpAuthorizationUrlValidator | undefined;
}

export type McpAuthorizationUrlValidator = (url: URL) => boolean;

interface McpPauseMeshMetadata {
  readonly "io.pausemesh/continuation": {
    readonly continuationId: string;
    readonly correlationId: string;
    readonly expiresAt: string;
    readonly requestId: string | number;
    readonly schemaVersion: 1;
  };
  readonly "io.modelcontextprotocol/related-task"?:
    | {
        readonly taskId: string;
      }
    | undefined;
}

export interface McpFormElicitRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: "elicitation/create";
  readonly params: {
    readonly mode: "form";
    readonly message: string;
    readonly requestedSchema: McpRequestedSchema;
    readonly _meta: McpPauseMeshMetadata;
  };
}

export interface McpUrlElicitRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: "elicitation/create";
  readonly params: {
    readonly mode: "url";
    readonly message: string;
    readonly elicitationId: string;
    readonly url: string;
    readonly _meta: McpPauseMeshMetadata;
  };
}

export type McpElicitRequest = McpFormElicitRequest | McpUrlElicitRequest;

/**
 * Host-side evidence for the exact request emitted by an issuance. It must be persisted as
 * immutable workflow state and never treated as an authentication or confidentiality token.
 */
export interface McpElicitationReceipt {
  readonly schemaVersion: 1;
  readonly continuationId: string;
  readonly correlationId: string;
  readonly mode: "form" | "url";
  readonly requestId: string | number;
  readonly requestHash: string;
}

export interface McpElicitationIssuance {
  readonly request: McpElicitRequest;
  readonly receipt: McpElicitationReceipt;
}

export type McpElicitationOutcome =
  | {
      readonly kind: "form_response";
      readonly action: "accept";
      readonly content: JsonObject;
    }
  | {
      readonly kind: "form_response";
      readonly action: "decline" | "cancel";
    }
  | {
      readonly kind: "url_consent";
      readonly action: "accept" | "decline" | "cancel";
      readonly elicitationId: string;
    };

export interface McpElicitationCompleteNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/elicitation/complete";
  readonly params: {
    readonly elicitationId: string;
    readonly _meta: McpPauseMeshMetadata;
  };
}

function requirePending(continuation: ContinuationEnvelopeV1): void {
  if (continuation.status !== "pending") {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_TRANSITION",
      `Cannot use a ${continuation.status} continuation for MCP elicitation`,
    );
  }
}

function requireModeCapability(capabilities: McpClientCapabilities, mode: "form" | "url"): void {
  const parsed = parseBoundary(
    McpClientCapabilitiesSchema,
    capabilities,
    "INVALID_PROTOCOL_BINDING",
    "MCP client capabilities are malformed",
  );
  const elicitation = parsed.elicitation;
  if (elicitation === undefined) {
    throw new ProtocolAdapterError(
      "UNSUPPORTED_PROTOCOL_CAPABILITY",
      "MCP client did not declare the elicitation capability",
    );
  }

  const supportsMode =
    mode === "form"
      ? elicitation.form !== undefined || Object.keys(elicitation).length === 0
      : elicitation.url !== undefined;
  if (!supportsMode) {
    throw new ProtocolAdapterError(
      "UNSUPPORTED_PROTOCOL_CAPABILITY",
      `MCP client did not declare ${mode} elicitation support`,
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }

  const ipv4 = normalized.split(".");
  return (
    ipv4.length === 4 &&
    ipv4.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(ipv4[0]) === 127
  );
}

function isSensitiveQueryParameter(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z\d]/g, "");
  return (
    normalized === "token" ||
    normalized === "auth" ||
    normalized === "code" ||
    normalized === "jwt" ||
    normalized === "session" ||
    normalized === "sig" ||
    normalized === "ticket" ||
    normalized.includes("accesstoken") ||
    normalized.includes("authtoken") ||
    normalized.includes("assertion") ||
    normalized.includes("authorization") ||
    normalized.includes("bearer") ||
    normalized.includes("credential") ||
    normalized.includes("idtoken") ||
    normalized.includes("apikey") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("privatekey") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("secret") ||
    normalized.includes("sessionid") ||
    normalized.includes("signature")
  );
}

function validateUrlBinding(binding: McpUrlBinding, policy: McpProjectionPolicy): void {
  let parsed: URL;
  try {
    parsed = new URL(binding.url);
  } catch {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation requires an absolute URL",
    );
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation must not embed credentials in the URL authority",
    );
  }
  if (parsed.hash.length > 0) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation must not include a fragment",
    );
  }
  if ([...parsed.searchParams.keys()].some(isSensitiveQueryParameter)) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation must not include credential-like query parameters",
    );
  }
  const secureTransport = parsed.protocol === "https:";
  const trustedLoopbackException =
    parsed.protocol === "http:" &&
    policy.allowInsecureLoopbackHttp === true &&
    isLoopbackHostname(parsed.hostname);
  if (!secureTransport && !trustedLoopbackException) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation requires HTTPS; trusted policy may allow HTTP only on loopback",
    );
  }
  if (policy.validateAuthorizationUrl === undefined) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP URL elicitation requires a trusted authorization-URL validation policy",
    );
  }
  try {
    if (policy.validateAuthorizationUrl(new URL(parsed.href)) !== true) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_BINDING",
        "MCP authorization URL was rejected by trusted host policy",
      );
    }
  } catch (error) {
    if (error instanceof ProtocolAdapterError) throw error;
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP authorization URL validation policy failed",
    );
  }
}

function projectionMetadata(
  continuation: ContinuationEnvelopeV1,
  requestId: string | number,
  relatedTask?: McpRelatedTaskBinding,
): McpPauseMeshMetadata {
  return {
    "io.pausemesh/continuation": {
      continuationId: continuation.continuationId,
      correlationId: continuation.correlationId,
      expiresAt: continuation.expiresAt,
      requestId,
      schemaVersion: 1,
    },
    ...(relatedTask === undefined
      ? {}
      : { "io.modelcontextprotocol/related-task": { taskId: relatedTask.taskId } }),
  };
}

export function toMcpElicitRequest(
  continuation: ContinuationEnvelopeV1,
  rawContext: McpProjectionContext,
  rawPolicy: McpProjectionPolicy = {},
): McpElicitRequest {
  requirePending(continuation);
  const payload = parseBoundary(
    ContinuationPayloadSchema,
    continuation.payload,
    "INVALID_PROTOCOL_MESSAGE",
    "PauseMesh continuation payload cannot be projected to MCP elicitation",
  );
  const context = parseBoundary(
    McpProjectionContextSchema,
    rawContext,
    "INVALID_PROTOCOL_BINDING",
    "MCP projection context is malformed",
  );
  const policy = parseBoundary(
    McpProjectionPolicySchema,
    rawPolicy,
    "INVALID_PROTOCOL_BINDING",
    "MCP projection policy is malformed",
  );
  const metadata = projectionMetadata(continuation, context.requestId, context.relatedTask);

  if (payload.kind === "authorization") {
    requireModeCapability(context.clientCapabilities, "url");
    if (context.urlBinding === undefined) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_BINDING",
        "MCP authorization projection requires an explicit URL binding",
      );
    }
    validateUrlBinding(context.urlBinding, policy);
    const request: McpUrlElicitRequest = {
      jsonrpc: "2.0",
      id: context.requestId,
      method: "elicitation/create",
      params: {
        mode: "url",
        message: payload.message,
        elicitationId: context.urlBinding.elicitationId,
        url: context.urlBinding.url,
        _meta: metadata,
      },
    };
    return parseBoundary(
      McpUrlElicitRequestSchema,
      request,
      "INVALID_PROTOCOL_MESSAGE",
      "PauseMesh continuation identifiers cannot be projected to MCP elicitation",
    );
  }

  requireModeCapability(context.clientCapabilities, "form");
  if (context.urlBinding !== undefined) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP form projection must not include a URL binding",
    );
  }
  const request: McpFormElicitRequest = {
    jsonrpc: "2.0",
    id: context.requestId,
    method: "elicitation/create",
    params: {
      mode: "form",
      message: payload.message,
      requestedSchema: payload.responseSchema ?? { type: "object", properties: {} },
      _meta: metadata,
    },
  };
  return parseBoundary(
    McpFormElicitRequestSchema,
    request,
    "INVALID_PROTOCOL_MESSAGE",
    "PauseMesh continuation identifiers cannot be projected to MCP elicitation",
  );
}

function requestHash(request: McpElicitRequest): string {
  return createHash("sha256")
    .update(canonicalJson(["mcp-elicitation-v1", request as unknown as JsonValue]))
    .digest("hex");
}

function createMcpElicitationReceipt(
  continuation: ContinuationEnvelopeV1,
  request: McpElicitRequest,
): McpElicitationReceipt {
  return {
    schemaVersion: 1,
    continuationId: continuation.continuationId,
    correlationId: continuation.correlationId,
    mode: request.params.mode,
    requestId: request.id,
    requestHash: requestHash(request),
  };
}

/**
 * Issues the wire request together with host-only evidence for the exact request. The receipt must
 * be persisted by the host; it must not be sent to the MCP client or treated as an auth token.
 */
export function issueMcpElicitation(
  continuation: ContinuationEnvelopeV1,
  context: McpProjectionContext,
  policy: McpProjectionPolicy = {},
): McpElicitationIssuance {
  const request = toMcpElicitRequest(continuation, context, policy);
  const receipt = createMcpElicitationReceipt(continuation, request);
  return {
    request,
    receipt: parseBoundary(
      McpElicitationReceiptSchema,
      receipt,
      "INVALID_PROTOCOL_MESSAGE",
      "MCP elicitation issuance receipt could not be created",
    ),
  };
}

function validateStringFormat(value: string, format: string): boolean {
  switch (format) {
    case "email":
      return z.email().safeParse(value).success;
    case "uri":
      return URL.canParse(value);
    case "date":
      return z.iso.date().safeParse(value).success;
    case "date-time":
      return z.iso.datetime({ offset: true }).safeParse(value).success;
    default:
      return false;
  }
}

function fieldValueIsValid(value: unknown, schema: McpPrimitiveSchemaDefinition): boolean {
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (schema.type === "integer" && !Number.isInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    return schema.maximum === undefined || value <= schema.maximum;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return false;
    if (new Set(value).size !== value.length) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    const allowed =
      "enum" in schema.items ? schema.items.enum : schema.items.anyOf.map((entry) => entry.const);
    return value.every((entry) => allowed.includes(entry));
  }
  if (typeof value !== "string") return false;
  if ("enum" in schema && !schema.enum.includes(value)) return false;
  if ("oneOf" in schema && !schema.oneOf.some((entry) => entry.const === value)) return false;
  if (
    "minLength" in schema &&
    schema.minLength !== undefined &&
    unicodeLength(value) < schema.minLength
  ) {
    return false;
  }
  if (
    "maxLength" in schema &&
    schema.maxLength !== undefined &&
    unicodeLength(value) > schema.maxLength
  ) {
    return false;
  }
  return (
    !("format" in schema && schema.format !== undefined) ||
    validateStringFormat(value, schema.format)
  );
}

function validatedFormContent(
  content: Record<string, string | number | boolean | string[]>,
  schema: McpRequestedSchema,
): JsonObject {
  const allowedKeys = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(content)) {
    if (!allowedKeys.has(key)) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        `MCP elicitation result contains unexpected property ${key}`,
      );
    }
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(content, key)) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        `MCP elicitation result is missing required property ${key}`,
      );
    }
  }
  for (const [key, value] of Object.entries(content)) {
    const fieldSchema = schema.properties[key];
    if (fieldSchema === undefined || !fieldValueIsValid(value, fieldSchema)) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        `MCP elicitation result property ${key} does not match its schema`,
      );
    }
  }
  return content;
}

export function parseMcpElicitResult(
  continuation: ContinuationEnvelopeV1,
  request: McpElicitRequest,
  rawReceipt: unknown,
  rawResult: unknown,
): McpElicitationOutcome {
  requirePending(continuation);
  const parsedRequest = parseBoundary(
    McpElicitRequestSchema,
    request,
    "INVALID_PROTOCOL_BINDING",
    "MCP elicitation request is malformed",
  );
  requireRequestBinding(continuation, parsedRequest);
  requireIssuanceReceipt(continuation, parsedRequest, rawReceipt);
  const result = parseBoundary(
    McpElicitResultSchema,
    rawResult,
    "INVALID_PROTOCOL_MESSAGE",
    "MCP elicitation result is malformed",
  );

  if (parsedRequest.params.mode === "url") {
    if (result.content !== undefined) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        "MCP URL elicitation results must not contain in-band content",
      );
    }
    return {
      kind: "url_consent",
      action: result.action,
      elicitationId: parsedRequest.params.elicitationId,
    };
  }

  if (result.action !== "accept") {
    if (result.content !== undefined) {
      throw new ProtocolAdapterError(
        "INVALID_PROTOCOL_MESSAGE",
        "Declined or cancelled MCP elicitation results must not contain content",
      );
    }
    return { kind: "form_response", action: result.action };
  }
  if (result.content === undefined) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_MESSAGE",
      "Accepted MCP form elicitation requires content",
    );
  }
  return {
    kind: "form_response",
    action: "accept",
    content: validatedFormContent(result.content, parsedRequest.params.requestedSchema),
  };
}

function requireRequestBinding(
  continuation: ContinuationEnvelopeV1,
  request: McpElicitRequest,
): void {
  const requestContinuation = request.params._meta["io.pausemesh/continuation"];
  const continuationPayload = parseBoundary(
    ContinuationPayloadSchema,
    continuation.payload,
    "INVALID_PROTOCOL_BINDING",
    "MCP elicitation request does not match the continuation payload",
  );
  const expectedMode = continuationPayload.kind === "authorization" ? "url" : "form";
  const messageMatches = request.params.message === continuationPayload.message;
  const schemaMatches =
    request.params.mode !== "form" ||
    (continuationPayload.kind === "input" &&
      canonicalJson(request.params.requestedSchema as JsonValue) ===
        canonicalJson(
          (continuationPayload.responseSchema ?? {
            type: "object",
            properties: {},
          }) as JsonValue,
        ));
  if (
    requestContinuation.continuationId !== continuation.continuationId ||
    requestContinuation.correlationId !== continuation.correlationId ||
    requestContinuation.expiresAt !== continuation.expiresAt ||
    requestContinuation.requestId !== request.id ||
    requestContinuation.schemaVersion !== continuation.schemaVersion ||
    request.params.mode !== expectedMode ||
    !messageMatches ||
    !schemaMatches
  ) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP elicitation request is not bound to this continuation",
    );
  }
}

function requireIssuanceReceipt(
  continuation: ContinuationEnvelopeV1,
  request: McpElicitRequest,
  rawReceipt: unknown,
): void {
  const receipt = parseBoundary(
    McpElicitationReceiptSchema,
    rawReceipt,
    "INVALID_PROTOCOL_BINDING",
    "MCP elicitation issuance receipt is malformed",
  );
  if (
    receipt.continuationId !== continuation.continuationId ||
    receipt.correlationId !== continuation.correlationId ||
    receipt.mode !== request.params.mode ||
    receipt.requestId !== request.id ||
    receipt.requestHash !== requestHash(request)
  ) {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_BINDING",
      "MCP elicitation request does not match its immutable issuance receipt",
    );
  }
}

export function toMcpElicitationCompleteNotification(
  continuation: ContinuationEnvelopeV1,
  request: McpUrlElicitRequest,
  rawReceipt: unknown,
): McpElicitationCompleteNotification {
  if (continuation.status !== "resumed") {
    throw new ProtocolAdapterError(
      "INVALID_PROTOCOL_TRANSITION",
      `MCP URL elicitation completion requires a resumed continuation, received ${continuation.status}`,
    );
  }
  const parsedRequest = parseBoundary(
    McpUrlElicitRequestSchema,
    request,
    "INVALID_PROTOCOL_BINDING",
    "MCP URL elicitation request is malformed",
  );
  requireRequestBinding(continuation, parsedRequest);
  requireIssuanceReceipt(continuation, parsedRequest, rawReceipt);
  return {
    jsonrpc: "2.0",
    method: "notifications/elicitation/complete",
    params: {
      elicitationId: parsedRequest.params.elicitationId,
      _meta: parsedRequest.params._meta,
    },
  };
}
