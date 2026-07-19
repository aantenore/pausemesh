# PostgreSQL adapter runbook

This runbook covers the optional `pausemesh/postgres` adapter in `0.3.0-alpha.1`. The built-in CLI
remains a SQLite reference server; PostgreSQL is composed by the production host.

## 1. Own the pool at the host boundary

Install the PostgreSQL client chosen by the host and pass a compatible pool to PauseMesh. Configure
TLS, connection and statement timeouts, a bounded pool size, and provider-specific options outside
the adapter. Register an idle-client error listener and close the pool during graceful shutdown.
Never log the connection string.

```ts
import { Pool } from "pg";
import { PostgresEventStore } from "pausemesh/postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  query_timeout: 5_000,
  statement_timeout: 5_000,
});

pool.on("error", () => {
  // Mark the host unhealthy through its protected telemetry path; do not log pool config.
});

const eventStore = new PostgresEventStore(pool, {
  schema: "pausemesh",
  maxEventsPerStream: 32,
});
```

`PostgresEventStore` deliberately has no `end()` method. The host must await `pool.end()` after it
has stopped accepting requests and drained in-flight work.

## 2. Separate migration and runtime roles

Run `migratePostgresEventStore` from a deployment process with a DDL-capable role before starting
or updating replicas. Do not call it in an application constructor or on every startup.

```ts
import { migratePostgresEventStore } from "pausemesh/postgres";

await migratePostgresEventStore(migrationPool, { schema: "pausemesh" });
```

For the default schema, the runtime role needs only:

- `USAGE` on schema `pausemesh`;
- `SELECT` on `pausemesh_schema_migrations`;
- `SELECT`, `INSERT`, and `UPDATE` on `continuation_streams`;
- `SELECT` and `INSERT` on `continuation_events`.

Do not grant the runtime role DDL, `DELETE`, or `TRUNCATE`. The adapter's readiness check validates
the migration version/checksum, physical tables, expected active trigger bindings, and read access,
but intentionally does not attest the complete trigger function body or every table constraint.
Only the controlled migration role may modify schema objects.

## 3. Wire liveness and readiness separately

Pass the store as the host-owned readiness probe:

```ts
const app = createHttpApp({
  maxPayloadBytes: 1_048_576,
  readinessProbe: eventStore,
  service: continuations,
});
```

- `GET /healthz` answers `200 {"status":"ok"}` while the process can serve HTTP. It never probes
  PostgreSQL.
- `GET /readyz` answers 200 only when the migration and required PostgreSQL objects are valid and
  accessible. Missing configuration or any probe error returns a bounded 503 response without the
  database host, SQL text, credentials, or underlying error.

The orchestrator should remove a replica from service on `/readyz` failure but restart it only from
an independent liveness policy. Configure pool/query timeouts so readiness has a deployment-specific
upper bound.

## 4. Deploy and verify

1. Back up according to the provider policy and stop schema-changing jobs.
2. Run the explicit migration with the migration role. Concurrent runners are serialized, but the
   deployment pipeline should still have one migration stage.
3. Start one canary replica with the runtime role.
4. Verify `/healthz`, `/readyz`, create, inspect through another replica, exact resume retry, and
   event history.
5. Roll out remaining replicas and monitor connection saturation, readiness failures, CAS conflicts,
   and database latency without recording payloads or tokens.

The v1 migration only creates a dedicated schema. There is no automatic downgrade. If a first-time
deployment must be abandoned before data is accepted, stop all replicas and remove that dedicated
schema with the migration role. Once continuations exist, restore from backup or deploy a forward
migration; never delete event rows to roll back application code.

## 5. Test locally

Set `PAUSEMESH_TEST_POSTGRES_URL` to an isolated database and run:

```bash
pnpm test:postgres
```

The test creates and removes a random dedicated schema. CI also sets
`PAUSEMESH_REQUIRE_POSTGRES_TEST=1`, which makes a missing URL a hard failure rather than a skipped
test.
