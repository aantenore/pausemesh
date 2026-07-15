# ADR 0001: Canonical continuation envelope over an append-only event log

- Status: accepted
- Date: 2026-07-15

## Context

MCP, A2A, and AG-UI describe different layers and lifecycle vocabularies. Coupling durable state
directly to any one protocol would make recovery semantics move whenever that protocol changes.

## Decision

PauseMesh owns a small, versioned `ContinuationEnvelope` and lifecycle state machine. Protocol
adapters translate at the boundary and report unsupported semantics. The event store exposes an
optimistic append operation keyed by aggregate version; current state is derived through replay.

Resume credentials are opaque random values. Only a SHA-256 hash is stored, and the successful
resume transition consumes the credential. An idempotency key records retry identity separately
from the token so a lost HTTP response can be retried safely.

## Consequences

- Recovery, audit, and tests do not depend on a protocol SDK.
- SQLite can be replaced without changing the domain.
- Adapter mappings are intentionally not assumed to be lossless.
- Multi-node ordering requires a store implementation with equivalent compare-and-swap semantics.
- Payload encryption and tenant authentication remain deployment responsibilities beyond the MVP.
