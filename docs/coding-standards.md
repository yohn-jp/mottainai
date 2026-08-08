# Executable coding standard

Issue #25 turns the high-value repository boundaries into local and CI checks.
The check configuration and AST validator are the normative sources; this
document explains scope and intent without duplicating their rule tables.

## Commands

```bash
pnpm run format:check
pnpm run lint
pnpm run architecture:test
pnpm run architecture:check
pnpm run test:standards
pnpm run verify:standards
```

`test:standards` runs architecture/governance/test-classification/coverage-policy
self-tests. `verify:standards` adds format, lint, and project validation. CI
keeps standards/static validation identifiable while preserving distinct
failure causes.

## Tool selection

- Prettier `3.6.2` provides deterministic formatting for the ESM/TypeScript
  tool files and has no runtime dependency on the gateway.
- ESLint `9.29.0` with `typescript-eslint` `8.66.0` provides the pinned flat
  configuration and a small safety rule set for Node 22/24.
- `scripts/architecture-check.mjs` uses the repository's pinned TypeScript
  compiler API. It parses ASTs, resolves relative modules with NodeNext
  resolution, and builds a production import graph; it does not implement
  semantic rules with grep.

The formatter scope is intentionally limited to the new standard-tooling files
and `package.json`. Reformatting the existing production tree would create a
large mechanical diff and belongs in a separate change.

## Boundary model

The validator enforces runtime dependency edges in this direction:

```text
entry -> upstream / adaptive / compression -> persistence / shared / utility
```

`src/config.ts`, `src/envelope.ts`, `src/logging.ts`, and `src/telemetry.ts`
are shared boundaries. The existing `config.ts -> adaptive/metadata.ts` edge is
the documented metadata exception. Type-only imports are checked for extension
and resolution but are excluded from runtime cycle detection.

The executable boundaries are `src/index.ts` and `src/cli.ts`; `src/server.ts`
owns MCP signal lifecycle registration. `src/workflow/domain/identity-resolve-worker.mjs`
and `src/workflow/domain/task-start-worker.mjs` are separate executable workers.
The task worker may read argv and write its JSON result to stdout. Environment
reads remain limited to the allowlisted configuration, telemetry, policy,
upstream, CLI, persistence, and workflow bootstrap boundaries in the validator.

`src/test-support/` と `src/e2e/` は独立した `testInfrastructure` レイヤ:
fixture を組み立てるためにどの production レイヤからでも import してよい（一時
git repo fixture が persistence に依存するのは正当な例）が、production 側から
このレイヤへの import は許されない — 依存の向きは一方向のみ。詳細は
[`testing.md`](testing.md) を参照。

## Suppressions

Production exceptions require a local marker with a reason, for example:

```ts
// architecture-check allow: double-assertion -- validated native interop boundary
```

Broad disable comments are not an accepted way to pass CI. New exceptions must
be narrow, explain the boundary, and update the validator allowlist or marker
contract when needed.

Human-only conventions remain outside CI: full-word identifiers, why-comments,
compression meaning preservation, behavioral invariants, and subjective
architecture judgment.
