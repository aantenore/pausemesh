# Delivery Contract: PauseMesh

Date: 2026-07-15
Last updated: 2026-07-17
Mode: new-project
Status: delivered through `0.2.0-alpha.1`

## Objective

Provide a protocol-neutral primitive that lets an agent workflow pause, survive process failure,
hand control to another protocol surface, and resume exactly once without repeating a side effect.

## Scope

Must:

- Persist a versioned continuation envelope and append-only lifecycle events.
- Enforce `pending -> resumed | cancelled | expired` with compare-and-swap fencing.
- Issue opaque, one-shot resume tokens while persisting only their SHA-256 hashes.
- Make retries idempotent and reject stale, wrong, expired, cancelled, or reused tokens.
- Supply replaceable in-memory and SQLite/WAL event-store adapters.
- Map a minimal continuation contract across MCP, A2A, and AG-UI adapters.
- Expose a small HTTP/CLI demo and machine-readable errors.

Should:

- Reconstruct state by replay after reopening SQLite.
- Emit structured, redacted operational logs.
- Keep protocol mappings versioned and report semantic loss explicitly.

Could:

- Publish the package to npm after the repository MVP proves stable.
- Add OpenTelemetry instrumentation without coupling the core to a vendor.

Out of scope:

- Agent orchestration, model routing, tool execution, memory, planning, workflow DAGs, or approval UI.
- A production identity provider, multi-tenancy, hosted control plane, or generic protocol gateway.
- Lossless translation of every MCP, A2A, or AG-UI field.

## Assumptions

- Node.js 24+ is available.
- SQLite is a reference store; consumers may implement the event-store port elsewhere.
- The MVP HTTP server is for local evaluation and must not be internet-exposed without authentication.
- Protocol drafts can change, so adapter contracts are versioned independently from the core envelope.

## Requirements

| ID | Requirement | Priority | Acceptance criteria | Verification |
|---|---|---|---|---|
| R1 | Durable lifecycle | Must | A pending continuation replays after closing and reopening the SQLite store | Restart integration test |
| R2 | Exactly-once resume | Must | One valid token wins; subsequent or concurrent attempts cannot transition again | Unit and concurrency tests |
| R3 | Retry idempotency | Must | Repeating the same idempotency key returns the first result without another event | Unit test |
| R4 | Expiry/cancel | Must | Expired and cancelled continuations cannot resume | Fake-clock tests |
| R5 | Protocol projection | Must | Canonical requests project to MCP, A2A, and AG-UI with correlation preserved | Adapter contract tests |
| R6 | Configuration | Must | Invalid limits, ports, or paths fail at startup | Config tests |
| R7 | Safe diagnostics | Must | Tokens and response payloads never appear in structured logs | Log assertion test |
| R8 | Public delivery | Must | CI, documentation, license, commit, and GitHub push succeed | Repository evidence |
| R9 | MCP conformance | Must | Capabilities, flat schemas, trusted URL policy, related-task metadata, and the exact issuance receipt fail closed | Exact adapter fixtures |
| R10 | A2A ownership | Must | Only an explicit server task/context binding is projected; credentials remain out-of-band | Exact adapter fixtures |
| R11 | AG-UI resume contract | Must | A whole resume batch is bound to an immutable issued receipt/current cohort and invalid input becomes `RUN_ERROR` | Official schema, receipt, and replay fixtures |
| R12 | Adapter migration | Must | HTTP/demo/docs use the explicit 0.2 bindings with no legacy ID fallback | Build, demo, and HTTP tests |
| R13 | Consumable package | Must | A clean source copy builds a tarball that installs in a real pnpm consumer with working ESM exports, declarations, docs, config, and CLI | Package smoke test |

## Acceptance Threshold

Accepted only when all Must criteria pass, `pnpm check` is green, no known P0/P1 defect remains,
the local API demo completes, and security/operational limitations are explicit.

## Architecture Approach

A modular TypeScript library: pure domain state machine, application service, storage/clock/token
ports, protocol adapters at the edge, SQLite/WAL reference adapter, and a thin Hono HTTP adapter.
Dependencies point inward; protocol and storage packages never leak into the domain.

## Test Plan

Critical:

- State transition, stale version, token mismatch/reuse, idempotency, cancel, and expiry tests.
- SQLite close/reopen replay and concurrent-resume tests.
- MCP/A2A/AG-UI projection contract tests.
- Strict MCP primitive/enum schemas, original-request receipt binding, trusted URL policy, URL
  consent vs completion, and invalid result fixtures.
- A2A server-binding, JSON value, authorization boundary, and terminal-state fixtures.
- AG-UI receipt/current-cohort equality, multi-interrupt coverage, replay, CAS cancellation, expiry,
  mandatory schema-policy, authorization isolation, and official wire-schema tests.

Recommended:

- HTTP error-shape and payload-limit integration tests.
- Log redaction and configuration validation tests.

Not tested in the MVP:

- Multi-node consensus, hostile internet traffic, or full upstream conformance suites; risk is high
  outside local evaluation, so the server is explicitly non-production until those gates exist.

## Delivery Policy

Selected mode: create public GitHub repository and push `main`, as explicitly requested by Antonio.

- Commit convention: Conventional Commits.
- CI: lint, typecheck, unit/integration tests, and build on Node 24.
- Rollback: revert the initial commit or archive the new repository; no external runtime is deployed.

## Change Log

| Time | Change request | Impact | Decision |
|---|---|---|---|
| 2026-07-15 | Exclude profile README, pins, descriptions, and topics | Avoid collision with another task | Kept out of scope |
| 2026-07-15 | Include LinkedIn context, GitHub follows, and stars | Parallel discovery/network work | Non-blocking; LinkedIn awaits login |
| 2026-07-15 | Avoid overlap with existing portfolio control planes | Narrowed product boundary | Protocol primitive only |
| 2026-07-17 | Correct upstream protocol drift before a first package release | Breaking prerelease adapter surface | Explicit host bindings and fail-closed conformance in 0.2 alpha |
| 2026-07-17 | Make AG-UI cohort reconstruction independently verifiable | Added host-side issuance state | Content-addressed immutable receipt plus exact current-cohort validation |
| 2026-07-17 | Prove the npm artifact from clean source | Release gate expanded | Prepack build and import/bin/content smoke included in `pnpm check` |
| 2026-07-17 | Bind MCP results/completion to the exact emitted request | Added host-side issuance state | Request SHA-256 receipt is mandatory on inbound helpers |
| 2026-07-17 | Remove consumer native-build approval | Storage implementation swap | `SqliteEventStore` now uses built-in `node:sqlite` behind the unchanged port |

## Incident Register

| Incident | Severity | Status | Regression prevention |
|---|---|---|---|
| Windows checkout converted LF to CRLF, causing Biome's formatter gate to fail | P2 | Resolved | Repository `.gitattributes`, explicit Biome `lineEnding: lf`, and Windows CI |

## Final Evidence

- Repository: <https://github.com/aantenore/pausemesh>
- Delivered rewritten-history commits: `82b8964` (MVP), `a515227` (cross-platform hardening),
  `4cad014` (delivery evidence), `f3efe51` (authenticated retry hardening), `6b16790` (history
  evidence), and `2583003` (final CI link).
- Local quality gate: `pnpm check` passed; 6 test files and 35 tests passed, then TypeScript
  package build completed.
- Runtime smoke: create returned 201, AG-UI projection returned `RUN_FINISHED`, resume reached
  version 2, and an exact idempotent retry returned 200.
- Packaging: `pnpm pack --dry-run` included only the compiled package, README, license, and package
  manifest. Production dependency audit reported no known vulnerabilities.
- Remote CI: [run 29403027193](https://github.com/aantenore/pausemesh/actions/runs/29403027193)
  passed from a clean checkout on Ubuntu, macOS, and Windows with Node.js 24.
- Repository security: Dependabot alerts and security updates, private vulnerability reporting,
  secret scanning, push protection, and CodeQL default setup are enabled.
- Acceptance result: every Must requirement is implemented and verified; no known P0/P1 defect
  remains inside the documented MVP boundary.

### Adapter conformance release evidence

- Target release: <https://github.com/aantenore/pausemesh/releases/tag/v0.2.0-alpha.1>.
- Architecture decision: [ADR 0002](adr/0002-protocol-adapter-conformance.md).
- Local quality gate: `pnpm check` passed with 10 test files and 164 tests, 84.24% statement and
  80.80% branch coverage, followed by the TypeScript build and clean-source package smoke.
- Upstream validation: AG-UI interrupt events are accepted by the exact-pinned official
  `RunFinishedEventSchema`; MCP and A2A fixtures follow their tagged/current normative schemas.
- Runtime smoke: the cross-protocol demo generated explicit MCP/A2A bindings, issued an AG-UI
  event plus receipt, validated a complete inbound batch, and completed a one-shot resume.
- Packaging: the clean-copy smoke built `pausemesh-0.2.0-alpha.1.tgz`, installed it into a separate
  pnpm consumer, and verified compiled exports, declarations, embedded JS sources, docs/config, ESM
  import, and the installed CLI. The production dependency audit reported no known vulnerabilities.
- Boundary result: the continuation core and persisted envelope did not change. Protocol drift is
  isolated to adapters, and legacy task/run ID fallbacks are absent.
