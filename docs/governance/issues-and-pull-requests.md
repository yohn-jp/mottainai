# Issue and Pull Request Governance

Mottainai treats Issues and pull requests as machine-verifiable contracts. Each
concern has exactly one authority: Inari owns the PR body shape and fixed
Validation checklist, the canonical `yohn-jp/.github` reusable governance
workflow owns organization-level branch-name and PR-title/body contract
enforcement, Mottainai owns only its own conditional product-specific gates,
and CI owns executable verification results. Mottainai does not locally
reimplement, fork, or wrap the organization-level branch-name or PR-title/
contract semantics (Issue #905).

## Issue contract

Blank Issues are disabled. A normal implementation task starts from one Issue
whose body contains meaningful content for the sections its Inari issue
template (`.github/inari/issues/*.json`) declares required — for example
Summary, Problem/Goal, Non-goals, Acceptance criteria (including at least one
checklist item), and Context/Risks. Issue-body content governance is the
canonical `yohn-jp/.github` `issue-governance.yml` reusable workflow's
concern (`.github/workflows/issue-governance.yml`), not a local
reimplementation here: it validates a new/edited Issue against the
synchronized `.github/inari/issues/*.json` snapshot and applies a
`status:invalid` label on violation.

The linked Issue is validated at the PR merge boundary by the
`linked-issue-check` job in `.github/workflows/governance.yml`: an Issue
carrying `status:invalid` or `needs:specification` cannot satisfy that gate.
This job only reads the label state `issue-governance.yml` applies — it does
not re-validate Issue body content.

## Pull request body authority

The compiled Inari contract under `.github/inari/pull-requests/default.json`
is the single source of truth for the normal PR body shape. The current default
contract renders exactly these sections:

- Summary
- Linked issue
- Changes
- Validation
- Review focus

Do not add a second mandatory section vocabulary in workflow code or
documentation. Inari synchronization and drift checks validate the canonical
`.github/inari/**` snapshot separately.

A normal managed PR therefore needs no manual `Scope`, `Implementation`,
`Behavioral changes`, `Test contract`, `Regression proof`, `Validation
evidence`, `Release impact`, `Risks`, `Breaking changes`,
`Migration / compatibility`, or `Security impact` section. Those headings may
appear in a specialized template when that template declares them, but the
repository must not require undeclared fields from the default contract.

## Canonical organization PR governance

Branch-name format, PR-title format, PR-body contract compliance (including
exactly one linked closing Issue), and branch classification for the
`release/<semver>` and `epic/<issue-number>-<slug>` classes are all enforced
by the canonical `yohn-jp/.github/.github/workflows/pr-governance.yml`
reusable workflow, called directly from the `governance` job in
`.github/workflows/governance.yml`. Ordinary, Epic, and release PRs all go
through this single canonical path — Mottainai does not maintain a separate
local validator, a separate release-only path, or a partial reimplementation
of any of this for any branch class.

## Independent repository checks

The PR body shape and the canonical contract above are not the whole
governance policy. Mottainai continues to enforce independent,
Mottainai-specific conditional gates that do not redefine or duplicate either
authority, run as the separate `product-checks` job:

- `Package check` for distribution-impacting paths (`package.json`,
  `pnpm-lock.yaml`, `tsconfig.build.json`, `src/index.ts`, `src/server.ts`,
  `src/cli.ts`, `.github/workflows/publish.yml`);
- compression test/preservation evidence for `src/compress/**` changes;
- CLI README or CLI-test evidence for CLI entry-point changes.

The merge-boundary linked-Issue label check (`linked-issue-check` job) is a
distinct, separately-run gate: it reads the canonical `issue-governance.yml`
workflow's `status:invalid` / `needs:specification` labels on the closing
Issue rather than reimplementing Issue-body validation.

Inari owns the required `Summary`, `Linked issue`, `Changes`, and `Validation`
fields plus completion of its fixed `Typecheck`, `Tests`, and `Build`
checklist. The conditional `Package check` is a separate Mottainai gate, not
an Inari checklist item or a new PR-template section.

Branch-name format is additionally read at runtime by
`src/workflow/governance/branch.ts`, Mottainai's own product feature for
governing execution against repositories it manages: `scripts/governance-lib.mjs`
and `scripts/governance-rules.json` remain in this repository as that
feature's bundled fallback authority, independent of the CI PR-governance path
above, which delegates branch-name enforcement for Mottainai's own PRs to the
canonical workflow instead.

## Validation and evidence

Executable checks are the evidence authority. A PR must not duplicate CI output
into another mandatory body schema.

The normal validation chain is:

```text
Issue contract (canonical issue-governance.yml)
  -> Inari-compiled PR body
  -> canonical organization branch/title/body governance
  -> merge-boundary linked-Issue label check
  -> Mottainai product-specific conditional gates
  -> CI static integrity and product contract
  -> merge
```

`Validation` is the compact user/reviewer-facing declaration owned by Inari.
Typecheck, Tests, and Build may be marked complete only after they actually
ran. Package check is a separate conditional Mottainai gate for configured
distribution-impacting paths.

Detailed process, package, fault, architecture, security, coverage, or release
results remain available from their owning CI jobs/artifacts. They are not
separate mandatory PR-body records. Historical quality-evidence experiments do
not define the current PR schema.

## CI topology

The repository keeps distinct execution roles so a fast source check is not
mistaken for a packed-product proof:

- static integrity: typecheck, lint, architecture and build;
- fast unit/contract tests;
- integration/process and managed workflow lifecycle tests;
- built-dist E2E and packed consumer/product-contract tests;
- path-sensitive Runtime/QEMU checks when applicable.

The exact commands and classification live in `package.json`,
`scripts/test-suites.mjs`, and `docs/testing/README.md`.

## Workflow trust boundary

`.github/workflows/governance.yml` composes four jobs with independent trust
models:

- `standards-self-check` runs entirely from the PR head; it self-verifies this
  branch's own governance/actions/semantics machinery and gates nothing else.
- `governance` calls the canonical `yohn-jp/.github` reusable workflow, which
  trusts only that repository's own reusable-workflow revision and the PR
  base's synchronized `.github/inari/**` snapshot — never PR-head code.
- `linked-issue-check` checks out and trusts only the base SHA's
  `scripts/governance-lib.mjs` to resolve which Issue the PR body closes, so
  a PR cannot forge which Issue it appears to close; it then reads that
  Issue's label state via the GitHub API.
- `product-checks` runs entirely from the PR head, like
  `standards-self-check`: it is a Mottainai-internal conditional quality
  gate, not an organization-level authority a PR could self-authorize
  around, so it does not need a base-trusted checkout.

Release branches use the canonical organization release-PR contract
(auto-selected by the `governance` job from the `release/<semver>` head
branch) and remain separate from the normal default Inari PR body.

## Local validation

Useful local checks are:

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch fix/123-example
pnpm run governance:product-checks:test
pnpm run verify:standards
pnpm run typecheck
pnpm test
pnpm run build
```

Branch-name and PR-title/body contract validation for Mottainai's own PRs runs
only in CI, via the canonical `governance` job; there is no local equivalent,
because that authority belongs to `yohn-jp/.github`, not this repository.

## GitHub Ruleset

Repository files cannot configure the GitHub Ruleset themselves. The intended
main-branch policy requires pull requests and the repository's required
Governance/CI status checks. Exact currently configured Ruleset state must be
verified in GitHub rather than inferred from this document.

## LLM / agent rules

- Do not add functionality absent from the owning Issue.
- Do not change acceptance criteria during implementation.
- Use gh-inari for governed PR mutation and Nawabari for physical Git/session
  authority on the supported Golden Path.
- Reconstruct the Inari fields from the final change and actual validation
  results; do not invent undeclared mandatory sections.
- Never mark an unrun validation check complete.
- Close exactly one Issue by default.
- Make Review focus concrete.
- Treat CI/job output as executable evidence rather than copying it into a
  second PR-body authority.
- Do not reimplement, fork, or locally wrap the canonical
  `yohn-jp/.github` branch-name or PR-title/body governance semantics.
