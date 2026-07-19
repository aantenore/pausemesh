# ADR 0003: Optional PostgreSQL store for multi-replica continuity

- Status: accepted
- Date: 2026-07-19
- Target: `0.3.0-alpha.1`

## Context

SQLite/WAL provides durable local recovery, but a callback may reach a different application
replica. The `EventStore` contract already requires an atomic compare-and-swap append, so the
multi-replica capability belongs in a storage adapter rather than in the continuation domain or a
new coordinator.

PostgreSQL integration must not make the root package import a database driver, hide DDL in an
application constructor, expose connection credentials, or let a pool-backed transaction move
between physical connections.

## Decision

PauseMesh provides `PostgresEventStore` and `migratePostgresEventStore` from the optional
`pausemesh/postgres` entry point.

- The host injects a minimal `PostgresPoolLike` object and retains ownership of connection limits,
  timeouts, idle-client error handling, and shutdown.
- Migration is an explicit deployment operation. Version 1 is recorded with a stable SHA-256
  checksum and serialized with a transaction-scoped advisory lock. Constructors perform no DDL.
- A dedicated stream-head row holds `current_version`. Append creates the head only for a new
  non-empty stream, advances it with `UPDATE ... WHERE current_version = expected`, and inserts the
  full event batch on the same checked-out client and `READ COMMITTED` transaction.
- A lost fence becomes `VersionConflictError`; unexpected uniqueness, data, or database failures
  are not mislabeled as concurrency.
- Event JSON remains text so replay observes the exact persisted snapshot. Load validates the head,
  contiguous physical versions, embedded identity/version, schema, and a configurable event bound.
- Physical event rows and migration metadata are protected by database triggers. Stream-head rows
  cannot be deleted or truncated; their version remains updateable by the runtime adapter.
- Readiness requires the exact migration version/checksum, ordinary tables, expected active
  trigger/table/function tuples, and runtime read access. Liveness remains independent.
- The bundled CLI stays SQLite-only. A PostgreSQL deployment is a library composition root because
  it must own provider-specific credentials, TLS, pool policy, roles, and lifecycle.

## Consequences

- Multiple stateless application replicas can share continuation state without changing protocol
  adapters, lifecycle events, token handling, or application-service reconciliation.
- `pg` is used only for development and the real integration test; consumers may inject node-postgres
  or another compatible pool without leaking its types through public declarations.
- Migration and runtime roles must be distinct. Runtime roles need no DDL, delete, or truncate
  privilege.
- PostgreSQL availability, regional failover, backup/restore, tenant authorization, payload
  encryption, and secret distribution remain deployment responsibilities.
- Readiness verifies migration metadata and the required object identities, not the entire function
  body or every physical constraint. Removing DDL from the runtime role is therefore a required
  defense, not an optional hardening step.
