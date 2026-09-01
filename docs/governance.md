# Issue and Pull Request Governance

Mottainai treats Issues and pull requests as machine-verifiable contracts. The
important rule is that each concern has one authority: Inari owns the PR body
shape and fixed Validation checklist, Mottainai governance owns shared PR
metadata and conditional product-specific gates, and CI owns executable
verification results.

## Issue contract

Blank Issues are disabled. A normal implementation task starts from one Issue
whose body contains meaningful content for:

- Summary
- Problem
- Goal
- Non-goals
- Acceptance criteria, including at least one checklist item
- Affected areas
- Risks / compatibility
- Dependencies
- Implementation notes

The linked Issue is validated at the PR merge boundary. An Issue carrying
`status:invalid` or `needs:specification` cannot satisfy that gate.

## Pull request body authority

The compiled Inari contract under `.github/inari/pull-requests/default.json`
is the single source of truth for the normal PR body shape. The current default
contract renders exactly these sections:

- Summary
- Linked issue
- Changes
- Validation
- Review focus

Do not add a second mandatory section vocabulary in `governance-rules.json`,
workflow code, or documentation. The local validator does not copy or enforce
these headings, fields, or fixed checklist items. Inari synchronization and
drift checks validate the canonical snapshot separately.

A normal managed PR therefore needs no manual `Scope`, `Implementation`,
`Behavioral changes`, `Test contract`, `Regression proof`, `Validation
evidence`, `Release impact`, `Risks`, `Breaking changes`,
`Migration / compatibility`, or `Security impact` section. Those headings may
appear in a specialized template when that template declares them, but the
repository must not require undeclared fields from the default contract.

## Independent repository checks

The PR body shape is not the whole governance policy. Mottainai continues to
enforce independent checks that do not redefine the Inari body contract:

- shared metadata: title format, branch format, minimum PR body length, and
  exactly one closing Issue reference;
- Mottainai-specific conditional gates: `Package check` for
  distribution-impacting paths, compression test/preservation evidence, and
  CLI README or CLI-test evidence.

Inari owns the required `Summary`, `Linked issue`, `Changes`, and `Validation`
fields plus completion of its fixed `Typecheck`, `Tests`, and `Build` checklist.
The conditional `Package check` is a separate Mottainai gate, not an Inari
checklist item or a new PR-template section.

Branch-name policy remains in `scripts/governance-rules.json`. Mottainai's
workflow code derives governed branch types from that same `branchPattern`, so
reducing the PR body contract does not weaken physical branch governance.

## Validation and evidence

Executable checks are the evidence authority. A PR must not duplicate CI output
into another mandatory body schema.

The normal validation chain is:

```text
Issue contract
  -> Inari-compiled PR body
  -> repository branch/title/completion checks
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
- Node compatibility smoke;
- path-sensitive Runtime/QEMU checks when applicable.

The exact commands and classification live in `package.json`,
`scripts/test-suites.mjs`, and `docs/testing.md`.

## Workflow trust boundary

For normal PRs, `.github/workflows/governance.yml` checks out the PR head only
for candidate changed-file information while executing the trusted validator
from the PR base revision. The linked-Issue fetch receives only the numeric
Issue number extracted by the validator. Governance changes therefore apply to
subsequent PRs after merge; a PR cannot self-authorize a new body contract.

Release branches use the dedicated organization release-PR contract and remain
separate from the normal default Inari PR body.

## Local validation

Useful local checks are:

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch fix/123-example
pnpm run governance:pr:local -- \
  --title 'fix(workflow): example correction' \
  --body-file /path/to/pr-body.md \
  --files /path/to/changed-files.txt \
  --branch fix/123-example
pnpm run verify:standards
pnpm run typecheck
pnpm test
pnpm run build
```

The local PR validator deliberately leaves default body headings, fields, and
fixed checklist semantics to Inari. It validates shared metadata and the
conditional Mottainai gates; gh-inari remains the renderer/semantic validator
for repository PR mutation.

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
