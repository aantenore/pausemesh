# Delivery Contract: PauseMesh

Date: 2026-07-15
Mode: new-project
Status: delivered

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

## Incident Register

| Incident | Severity | Status | Regression prevention |
|---|---|---|---|
| Windows checkout converted LF to CRLF, causing Biome's formatter gate to fail | P2 | Resolved | Repository `.gitattributes`, explicit Biome `lineEnding: lf`, and Windows CI |

## Final Evidence

- Repository: <https://github.com/aantenore/pausemesh>
- Delivered commits: `6ae5ff2` (MVP), `5a7fb55` (cross-platform hardening), `ad8e3d1`
  (delivery evidence), and `f9fbd90` (authenticated retry hardening).
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
