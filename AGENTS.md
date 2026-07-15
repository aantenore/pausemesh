# PauseMesh contributor instructions

PauseMesh is a narrow protocol primitive, not an agent framework or workflow engine.

## Architectural boundary

- The core owns only durable continuation creation, inspection, cancellation, expiry, and one-shot resume.
- Protocol-specific MCP, A2A, and AG-UI semantics belong in adapters.
- Persistence is a port. SQLite is the reference adapter, not a domain dependency.
- Do not add model routing, agent loops, tool execution, memory, planning, approval UI, or DAG scheduling.
- Keep environment values, limits, protocol mappings, and policy metadata typed and configurable.
- Never persist raw resume tokens; store only a cryptographic hash.

## Quality gate

Run `pnpm check`. New lifecycle behavior requires tests for replay, idempotency, concurrency, expiry, and restart recovery where relevant.
