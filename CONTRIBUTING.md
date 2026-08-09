# Contributing to Mottainai

Thanks for your interest in contributing. Mottainai is pre-1.0 and evolving
quickly — expect breaking changes between minor versions until 1.0.

## Before you start

- Blank Issues are disabled. Create and discuss one concrete Issue before
  implementation; the Issue must include the Maintenance contract sections
  when the Maintenance form applies.
- Include the Issue number in the branch name, following the repository branch
  contract.
- Keep a pull request scoped to one closing Issue. Split work that would close
  multiple Issues.
- Read [Issue and Pull Request Governance](docs/governance.md) before opening a
  pull request.

## Development setup

Requires Node.js >= 22.13, [pnpm](https://pnpm.io/) 11.18.0, and
[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on `PATH`.

```bash
pnpm install
# tree-sitter packages need a native build; if pnpm warns about ignored
# build scripts (ERR_PNPM_IGNORED_BUILDS), run:
pnpm approve-builds

pnpm run build
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run architecture:test
pnpm run architecture:check
pnpm run verify:standards
pnpm run test:standards
pnpm run test:coverage
pnpm run verify
```

The executable standard is defined by `eslint.config.mjs`,
`prettier.config.mjs`, and `scripts/architecture-check.mjs`. The formatter
currently checks the new standard-tooling files only; broad reformatting of
legacy production code stays out of this Issue. Use `pnpm run verify:standards`
before submitting a change. Test-layer ownership and coverage policy are
defined in [`docs/testing.md`](docs/testing.md); `scripts/test-suites.mjs` is
the mechanical classification source.

## Making changes

1. Create a branch off `main` using the Issue number (don't commit directly to
   `main`).
2. Keep changes focused — a bug fix shouldn't carry along unrelated
   refactors.
3. Preserve every section in `.github/PULL_REQUEST_TEMPLATE.md`. Link exactly
   one closing Issue and describe Included and Excluded scope.
4. Add or update tests alongside your change. Tests live next to the file
   they cover, as `<name>.test.ts`, using `node:test` + `node:assert/strict`.
5. If you change the compression pipeline (`src/compress/*`), you must add
   **both** a "this gets shortened" test case and a "this must NOT be
   transformed" test case — see
   [AGENTS.md](AGENTS.md#projection-integrity) for the full list of
   protected content (code fences, inline code, URLs, quoted strings,
   Japanese text, non-`description` JSON Schema fields, `image`/`resource`
   content, `git diff` output).
6. Run the layer matching the change. Pure logic and contract changes need
   `pnpm test`; filesystem, git, SQLite, CLI, subprocess, and fault changes
   need `pnpm run test:integration`; stdio changes need `pnpm run test:e2e`;
   package/bin/init changes need `pnpm run test:package`. Run
   `pnpm run test:coverage` when production behavior or a critical module
   changes.

   Before a non-Draft pull request is ready, run `pnpm run verify` and report
   `pnpm run test:coverage` separately. If a configured package-impacting path
   changes, also complete Package check. The Governance check is a required
   status check for the repository Ruleset.

7. Run the full check before opening a PR:

   ```bash
   pnpm run verify
   pnpm run test:coverage
   ```

8. Update relevant docs in the same commit/PR as the behavior change
   (`README.md`, `docs/*.md`) — stale docs are worse than no docs.

9. Keep executable rules in the formatter/lint/architecture configuration.
   Do not duplicate those rules as a second normative list in documentation.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Look at `git log`
for examples from this repository.

## Code conventions

- TypeScript, strict mode, ESM (`module: NodeNext`). Relative imports use
  explicit `.js` extensions (e.g. `./config.js`), even though the source
  file is `.ts` — this is required by NodeNext module resolution.
- Use full words in identifiers, not abbreviations (`config`, not `cfg`;
  avoid introducing new short forms like `impl`/`req`/`res`).
- Comments explain **why**, not what — a non-obvious constraint, invariant,
  or workaround. Skip comments that just restate the code.
- Argument-validation errors use `throw new Error("<lowercase message>")`,
  matching the existing pattern.
- Local tools (`src/local-tools.ts`) return the shared structured output
  shape (`operation` / `status` / `summary` / `facts` / `diagnostics` /
  `metrics` / `result_id` / `truncated`) — don't drop fields when adding a
  new tool.
- MCP tool `annotations` (`readOnlyHint`, `destructiveHint`, etc.) must match
  real behavior. Don't add side effects to a tool annotated read-only.

Executable checks enforce import/runtime safety, protocol stdout purity,
process/global boundaries, dependency direction, unsafe type escapes, and the
shared local-tool output envelope. Human review remains responsible for naming,
why-comments, compression semantics, behavioral invariants, and subjective
architecture judgment.

## Pull requests

- Describe what changed and why, not just what.
- Link exactly one Issue using a closing reference such as `Closes #123`.
- Keep all pull request template sections, including `Breaking changes`,
  `Migration / compatibility`, `Security impact`, and `Review focus`.
- CI (install, typecheck, test, build) must pass — see
  [.github/workflows/ci.yml](.github/workflows/ci.yml).
- CI identifies standards/static, fast, integration/process, coverage, and
  package/E2E/smoke jobs separately. Use the same layer names in the PR
  Validation section; do not claim a full verification from only `pnpm test`.
- `Governance / validate-pr` must pass. Non-Draft PRs must complete Typecheck,
  Tests, and Build; Package check is conditional on distribution-impacting
  paths listed in `scripts/governance-rules.json`.
- Do not mark a check complete unless it ran. Draft PRs may leave validation
  incomplete until they are ready for review.
- Complete `Test contract`, `Regression proof`, `Validation evidence`, and
  `Release impact` in addition to the existing template sections. Record one
  concrete evidence item for each configured class; a Not applicable item needs
  a reason and is allowed only when the changed paths do not trigger that
  class.
- For bug-fix PRs, identify the changed regression test, pre-fix observed
  failure, and post-fix result. Use the fixed runner or an explicit
  reviewer-attested unsupported-proof path described in
  [`docs/governance.md`](docs/governance.md).
- New quality-gate diagnostics are report-only until maintainers explicitly
  promote the trusted rollout mode after post-merge observation. Existing
  mandatory governance rules remain enforced.
- Maintainers may ask for changes or close PRs that don't fit the project
  direction; an up-front issue discussion minimizes that risk.

For the exact title, branch, changed-file, Issue, and Ruleset contracts, see
[`docs/governance.md`](docs/governance.md).

## Reporting bugs / requesting features

Use GitHub Issues. For security issues, see [SECURITY.md](SECURITY.md)
instead of filing a public issue.
