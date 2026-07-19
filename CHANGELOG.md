# Changelog

All notable changes to PauseMesh are documented here. The project follows semantic versioning;
protocol adapter contracts remain experimental until a stable `1.0.0` release.

## 0.3.0-alpha.1 - 2026-07-19

### Added

- Optional `pausemesh/postgres` entry point with an externally owned, structurally typed pool and
  no PostgreSQL client dependency in the root runtime path.
- Explicit, checksum-validated PostgreSQL schema migration with a serialized migration lock,
  append-only database guards, and no constructor-time DDL.
- Multi-replica compare-and-swap persistence using a stream-head fence and one checked-out client
  per transaction.
- Bounded, fully validated PostgreSQL replay that detects missing events, version gaps, identity
  mismatches, malformed snapshots, and unsafe `BIGINT` values.
- Host-owned readiness port and `/readyz`; SQLite, in-memory, and PostgreSQL stores implement the
  same probe while `/healthz` remains an independent liveness endpoint.
- Scripted fake-pool coverage plus an opt-in real PostgreSQL test and mandatory Linux PostgreSQL CI
  job covering concurrent replicas, exact retry, append-only enforcement, and restart replay.

### Security

- PostgreSQL schema identifiers are restricted and quoted; values remain parameterized.
- Migration metadata, physical tables, expected trigger/table/function tuples, trigger activation,
  and runtime read access fail readiness closed without leaking database errors over HTTP.
- The adapter never owns or logs a connection string and never closes the injected pool. Deployment
  code must separate migration and runtime roles and own timeout, idle-error, and shutdown policy.

## 0.2.0-alpha.1 - 2026-07-17

### Breaking

- MCP projection now requires an explicit JSON-RPC request ID and negotiated client elicitation
  capabilities.
- MCP result parsing and URL completion now require the host-only receipt returned by
  `issueMcpElicitation`; the receipt binds the complete original request.
- A2A projection now requires an existing server-issued task/context binding and no longer derives
  a task ID from continuation data.
- AG-UI projection now requires the emitting run binding and accepts an explicit interrupt cohort.
- AG-UI issuance now returns an immutable cohort receipt; inbound validation requires that receipt
  and the complete current continuation set.
- Replaced the generic MCP/A2A response helpers with mode-aware MCP result parsing and a
  non-sensitive A2A input-message helper.
- Renamed public response types to `McpElicitationOutcome`, `A2ASendMessageResponse`, and
  `A2ASendMessageRequest`; `AguiResumeEntry` now requires an explicit decision shape.
- Protocol projection previews moved from `GET` to `POST` and require an explicit binding body.
- Exact cancellation retries now reject a changed reason; callers may add an `expectedVersion`
  compare-and-swap fence.

### Added

- Strict MCP 2025-11-25 flat form-schema validation, URL-mode authorization, related-task
  correlation, and completion notification projection.
- Whole-input AG-UI resume validation with content-addressed cohort receipts, deterministic replay
  keys, expiry/version enforcement, mandatory schema policy when declared, and protocol-shaped run
  errors.
- Bounded AG-UI input preflight with configurable depth and node budgets.
- Narrow A2A authorization `reject`/`retry` control projection without credential payloads.
- Official AG-UI schema validation pinned to `@ag-ui/core` `0.0.57`.
- Explicit protocol adapter errors and POST-based HTTP projection previews.
- Positive and negative conformance fixtures across MCP, A2A, AG-UI, and HTTP surfaces.
- Clean-checkout package smoke coverage for compiled exports, declarations, documentation, config,
  real pnpm consumer install, ESM import, and the installed CLI binary.
- Built-in `node:sqlite` storage with the same `SqliteEventStore` port, eliminating native package
  build scripts.
- Global V8 coverage regression thresholds and clean `dist` builds with embedded JS source maps.

### Security

- Sensitive MCP and A2A authorization material is kept out of form/message payloads.
- AG-UI authorization material is rejected in-band and must arrive through a trusted callback.
- Protocol-owned task and run IDs are never synthesized from continuation IDs.
- Opaque protocol IDs are preserved exactly; edge whitespace is rejected instead of normalized.
- MCP authorization URLs require trusted host validation, default to HTTPS, reject userinfo,
  fragments and credential-like query keys, and allow an HTTP loopback exception only through
  trusted library policy.
- MCP and AG-UI receipts bind inbound decisions to the exact host-issued request/cohort and remain
  host-only.
- Cancellation materializes expiry before its compare-and-swap operation, including the
  validation-to-execution race.
- AG-UI parsing fails closed before schema evaluation for cyclic, over-deep, or oversized inputs.
- HTTP JSON bodies are capped while streaming, before parsing, including unknown-length requests.

## 0.1.0 - 2026-07-15

- Initial continuation lifecycle, one-shot token, idempotency, SQLite/WAL store, reference HTTP
  server, CLI, and protocol projection MVP.
