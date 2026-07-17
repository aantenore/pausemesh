# ADR 0002: Explicit protocol bindings and fail-closed resume validation

- Status: accepted
- Date: 2026-07-17
- Target: `0.2.0-alpha.1`

## Context

The continuation core is intentionally protocol-neutral, but the first adapter surface inferred
protocol identifiers and accepted schemas that the upstream protocols do not permit. In
particular, a continuation ID is not an A2A server-generated task ID, sensitive authorization
data must not use MCP form elicitation, and an AG-UI resume is valid only when it addresses every
open interrupt on the same thread.

Treating these protocol details as optional conveniences creates convincing-looking wire objects
that a conforming peer can reject. The core lifecycle and persistence model do not need to change;
the correction belongs at the adapter boundary.

## Decision

### Shared boundary

- Protocol-owned MCP request, A2A task/context, and AG-UI run/thread IDs are supplied through
  explicit, validated binding objects and are never trimmed or otherwise transformed.
- Outbound MCP/A2A/AG-UI projections reject terminal continuations and malformed protocol
  payloads. AG-UI inbound handling separately permits exact replay of a previously completed
  resume tuple, as required by its idempotency contract.
- Protocol metadata keeps the PauseMesh continuation ID for correlation. PauseMesh also uses it as
  the A2A message ID and AG-UI interrupt ID that its own projection creates, but never substitutes
  it for receiver-owned request, task, context, or run IDs.
- The canonical continuation envelope, state machine, token handling, and event store remain
  unchanged.

### MCP 2025-11-25

- Projection requires the client's negotiated elicitation capabilities.
- Issuance returns the wire request and a host-only SHA-256 receipt over the complete request.
  Result parsing and URL completion require that receipt, so changed messages, schemas, URLs,
  elicitation IDs, metadata, or request IDs fail binding before interpretation.
- `kind: "input"` becomes form elicitation and accepts only MCP's flat primitive schema subset.
- Validation follows the tagged 2025-11-25 wire schema. The prose page shows a `pattern` example,
  but that keyword is absent from the tagged `schema.ts`/`schema.json`, so it is rejected rather
  than passed through ambiguously.
- `kind: "authorization"` requires `url` and `elicitationId` and becomes URL elicitation. Secrets
  never pass through form content. URL elicitation is not used to authenticate the MCP client to
  its MCP server; the host binds callback state to the requesting client and user identity.
- Authorization URLs require HTTPS and a trusted host callback that attests the URL is not
  pre-authenticated and is bound to the initiating client/user workflow. Userinfo, fragments, and
  credential-like query keys fail static validation. A trusted library-only policy can allow
  plaintext HTTP for an exact loopback host during development; request bodies cannot enable it
  and remote HTTP is never accepted. The generic CLI server therefore supports form mode only;
  URL mode needs host policy injection through the library/HTTP app factory.
- An optional existing MCP task binding adds
  `_meta["io.modelcontextprotocol/related-task"]`. PauseMesh does not create, poll, or own MCP
  Tasks and does not add task augmentation to the elicitation request.

### A2A 1.0

- Both interruption and follow-up projection require an explicit `A2AServerTaskBinding`.
- The binding acknowledges that the task ID came from the A2A server; there is no continuation-ID
  fallback.
- Follow-up projection is permitted only while the continuation remains pending.
- Authorization status messages contain explanation and correlation only. Credentials remain
  out-of-band unless a separate A2A extension has been negotiated.
- A narrow `reject`/`retry` control helper keeps the A2A message channel usable without accepting
  arbitrary credential-bearing content. Richer negotiation belongs to a host-owned extension.

### AG-UI interrupts

- Outbound interrupts require the run that actually emitted them; the continuation ID is never
  substituted for a run ID.
- Authorization uses the namespaced custom reason `pausemesh:authorization_required`.
- Issuance returns the wire event and a content-addressed receipt for the exact cohort, including
  continuation ID, issued version, expiry, and payload hash. The host persists this immutable
  receipt beside its workflow checkpoint; it detects altered state but is not an auth token or a
  confidentiality control and is never projected to the AG-UI client.
- Inbound validation consumes the whole `RunAgentInput` resume batch, the receipt, and the complete
  current cohort, including already-completed members needed to prove exact replay.
- A bounded iterative preflight rejects cyclic, over-deep, or oversized input before protocol or
  response-schema parsing; hosts can tighten the public defaults of 64 levels and 50,000 nodes.
- Validation rejects thread mismatches, omitted/partial/extra/duplicate entries, stale pending
  continuations, changed terminal replay tuples, invalid status/payload combinations, missing or
  throwing host-schema validation, and in-band authorization payloads by returning a
  protocol-shaped `RUN_ERROR` event.
- Successful resolutions include a deterministic idempotency key derived from the AG-UI replay
  tuple. The host still supplies the one-time PauseMesh resume token when invoking the service.
- JSON Schema evaluation remains an injected adapter policy. When `responseSchema` exists the
  policy is required and fails closed; PauseMesh does not embed a generic schema engine in the
  core.
- Cancellation commands carry the version captured at issuance. Exact replays keep the original
  reason, while stale or conflicting cancellations fail their compare-and-swap fence.

## Compatibility

This is a deliberate prerelease adapter break. Callers must provide MCP capability context and
retain the issuance receipt, provide an A2A server task binding, and retain the receipt from an
AG-UI run issuance. The continuation and storage interfaces remain source and wire compatible
with `0.1.0`; the SQLite implementation moves to Node's built-in driver.

## Verification matrix

| Surface | Positive evidence | Negative evidence |
|---|---|---|
| MCP form | Flat primitives, enums, related-task metadata, issuance receipt | Nested objects, altered request/receipt, unsupported mode, missing capability |
| MCP URL | Trusted URL policy, consent and completion notification | Pre-auth/credential-like URL, mutated URL/elicitation ID, missing capability/policy |
| A2A | Server task ID, input/auth states, safe auth control | Missing binding, context mismatch, credential-bearing auth follow-up |
| AG-UI | Receipt-bound multi-interrupt batch, scalar/structured payload, stable replay key | Wrong thread, omitted/partial/extra/duplicate, altered receipt, expired, invalid payload/status |

## Consequences

- Hosts do slightly more wiring, but protocol ownership is explicit and testable.
- Projection helpers stop manufacturing identifiers that only an upstream receiver can issue.
- A later protocol revision can be isolated in a new adapter contract without migrating durable
  continuation data.
- PauseMesh remains a narrow durability primitive rather than a generic MCP, A2A, or AG-UI
  runtime.

## Sources

- [MCP elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- [MCP tasks 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [AG-UI interrupts](https://docs.ag-ui.com/concepts/interrupts)
