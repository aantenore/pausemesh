# Contributing

PauseMesh intentionally stays smaller than an agent framework. Changes should preserve the narrow
`pause -> durable handoff -> authenticated resume` boundary and keep protocol or storage details
behind adapters.

## Development

Requirements: Node.js 24+ and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

Add tests for every lifecycle transition, concurrency invariant, or protocol mapping you change.
Use Conventional Commits and explain any wire-format compatibility impact in the pull request.

Before proposing a new subsystem, document why it belongs in PauseMesh instead of an application,
workflow engine, identity layer, or protocol SDK.
