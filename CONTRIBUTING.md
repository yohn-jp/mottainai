# Contributing to Mottainai

Thanks for your interest in contributing. Mottainai is pre-1.0 and evolves quickly; minor releases may change interfaces while the operational model is hardened.

## Before you start

- Create and agree on one concrete Issue before implementation.
- Include the Issue number in the governed branch name.
- Do not commit directly to `main`.
- Read [Issue and Pull Request Governance](docs/governance/issues-and-pull-requests.md) before opening a pull request.

## Development setup

Requires Node.js >= 24.0.0, pnpm 11.25.0, and `rg` (ripgrep) on `PATH`.

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
pnpm run verify:standards
pnpm run test:integration
pnpm run test:e2e
pnpm run test:package
pnpm run test:coverage
pnpm run verify
```

The executable standards are owned by `eslint.config.mjs`, `prettier.config.mjs`, `scripts/architecture-check.mjs`, the test-suite classifier, and the repository governance code. Documentation explains the flow but does not create a second normative rule set.

## Making changes

1. Start from an Issue and a governed branch. On the supported managed path, let Mottainai/Nawabari establish the physical worktree/session rather than reconstructing it manually.
2. Keep changes focused on the owning Issue. Add newly discovered follow-up work as a separate Issue unless it directly blocks the current Golden Path.
3. Add or update tests with the behavior change. Pure logic and contracts belong in the fast layer; filesystem/Git/SQLite/CLI/subprocess behavior belongs in integration; stdio belongs in E2E; package/bin behavior belongs in package smoke.
4. For compression changes, cover both transformation and preservation cases.
5. New persistent/process failure boundaries need a deterministic fault case when that boundary is changed.
6. Run the smallest relevant layer while iterating and `pnpm run verify` before declaring the change fully validated. Record `pnpm run test:coverage` separately when production behavior or a critical module changes.
7. Update relevant documentation with the behavior change. Do not leave stale operational instructions behind.

## Pull requests

The default PR body is owned by the compiled Inari contract at `.github/inari/pull-requests/default.json`. The current default fields render as:

- Summary
- Linked issue
- Changes
- Validation
- Review focus

Do not manually invent additional mandatory headings to satisfy a second repository-local body schema. `mottainai task open-pr`/gh-inari should be able to create a valid PR from these fields alone.

Additional repository checks remain independent of body shape:

- Use a conventional governed title such as `fix(workflow): repair push retry`.
- Link exactly one closing Issue.
- Non-Draft PRs must mark Typecheck, Tests, and Build complete only after they ran.
- Package check is conditional on configured distribution-impacting paths.
- Compression and CLI changed-file evidence rules remain active.
- Required CI/Governance checks must pass before merge.

Detailed test, package, fault, architecture, security, and release evidence lives in the owning CI jobs/artifacts. Do not duplicate those outputs into a second mandatory PR-body evidence schema, and never claim an unrun layer passed.

## Commit messages

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). During the Golden Path bring-up exception, multiple directly blocking Issues may share one integration branch/PR, but each owning Issue must retain at least one attributable commit. That temporary bring-up exception does not authorize direct `main` commits.

## Code conventions

- TypeScript strict mode, ESM/NodeNext; relative source imports use explicit `.js` extensions.
- Prefer full words in identifiers.
- Comments explain non-obvious constraints/invariants, not syntax.
- Argument-validation errors follow the repository's existing lowercase-message convention.
- Local MCP tools preserve the shared structured output envelope.
- MCP annotations must reflect actual side effects.

Executable checks enforce import/runtime safety, stdout purity, process/global boundaries, dependency direction, unsafe type escapes, and the shared local-tool contract. Human review remains responsible for naming, invariants, product boundaries, and architecture judgment.

## Reporting bugs / requesting features

Use GitHub Issues. For security issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
