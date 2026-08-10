# Issue and Pull Request Governance

Treat Issues and pull requests created by people or multiple LLMs as
machine-verifiable contracts, not suggestions in templates.

The exact title, branch, section, evidence, path-class, and rollout rules live
in [`scripts/governance-rules.json`](../scripts/governance-rules.json).
[`scripts/governance-lib.mjs`](../scripts/governance-lib.mjs) is the shared
implementation used by local commands and GitHub Actions. Workflows provide
trusted inputs and permissions; they do not duplicate rule conditionals.

## Issue contract

Blank Issues are disabled. Create and agree on exactly one Issue before
starting work, then select an Issue Form from `.github/ISSUE_TEMPLATE/`:

- Feature
- Bug
- Architecture
- Maintenance
- Research

The existing validator contract remains required: Summary, Problem, Goal,
Non-goals, Acceptance criteria as a checklist, Affected areas, Risks /
compatibility, Dependencies, and Implementation notes. The forms additionally
capture the expected contract, failing scenario, test layer, release impact,
and security impact before implementation. A feature or research Issue may
state why no failure scenario applies; it must not leave the field blank.

`issue-governance.yml` checks the validator from the repository default branch
after creation, editing, or reopening. Invalid Issues receive
`status:invalid` and `needs:specification`; successful revalidation removes
those labels. Issue text is written to a report file and is never interpolated
into a shell command.

## Pull request contract

Title format:

```text
type(scope): summary
```

Branch format:

```text
type/123-short-description
```

The existing PR headings remain required, including `Migration / compatibility`
and `Security impact`. The template now adds four distinct headings:

- `Test contract` declares the change type, required layers, and each
  Not-applicable decision.
- `Regression proof` is mandatory for bug-fix PRs and records the test path,
  identifier, pre-fix observed failure, and post-fix result.
- `Validation evidence` records concrete evidence by class.
- `Release impact` records package/publish impact and is separate from
  compatibility migration and security impact.

The existing `Validation` checklist is preserved. Its Typecheck, Tests, Build,
and conditional Package check items are completion gates; it does not replace
the structured evidence records below it. Do not mark an item complete unless
the check ran.

## Structured validation evidence

`Validation evidence` contains exactly one record for each configured evidence
class. The canonical record is a bounded key/value line; it does not grant the
validator permission to execute the declared command.

```text
- class: unit/contract; status: pass; command: pnpm test; target: src/example.test.ts; result: 12 tests passed; artifact: test output reference
```

The minimum classes are `unit/contract`, `process/integration`, `package
smoke`, `fault injection`, `lint/architecture`, and `release`. The security
path also uses `security/negative`. A `pass` record must contain the fields
configured for its class. A `not-applicable` record must contain a concrete
reason and is allowed only when no changed path triggers that class.

Generic claims such as `Tests checked`, `pass`, `TODO`, `TBD`, `placeholder`,
template-comment-only content, or empty meaningful fields are not evidence.
The placeholder check is scoped to structured evidence and standalone
placeholder lines so ordinary explanatory prose is not rejected merely for
mentioning a word such as TODO.

## Path-aware minimum evidence

The following is the meaning of the data-driven path classes. Exact patterns
and required fields are canonical in `governance-rules.json`.

| Changed boundary                                                          | Minimum evidence                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CLI or MCP entry                                                          | `process/integration`                                                                |
| Package, packed artifact, or publish path                                 | `package smoke` with artifact evidence; `release` with artifact and `warnings: none` |
| Persistence or process boundary                                           | `fault injection` with a concrete failure scenario                                   |
| Security-sensitive path                                                   | existing `Security impact` section and `security/negative` evidence                  |
| Config, CLI registration, persisted state, exports, or public tool schema | existing `Migration / compatibility` section with an explicit decision               |
| Governance, workflow, or standards path                                   | `lint/architecture`                                                                  |

The existing package checkbox, compression rule, CLI evidence rule, security
section rule, and configuration compatibility rule remain active. The new
path classes add structured evidence; they do not replace those existing
changed-file rules.

## Current v1 enforcement and evidence state

The current `main` chain is:

```text
canonical rule/config
  -> named test layer and command
  -> PR validation evidence
  -> packed artifact / release proof when the package path is affected
  -> runtime/build identity tied to that verified artifact
```

The source of truth for each arrow remains the executable owner linked above;
this document describes how to navigate the result. Source-level build or test
success does not prove that an npm consumer can install or execute the packed
artifact. Conversely, runtime identity is provenance for an already verified
artifact, not a replacement for its package test.

| Check or policy | Current status on `main` | Evidence boundary |
| --- | --- | --- |
| Issue/PR contract, title/branch rules, existing `Validation` checkboxes, linked Issue validation, and existing changed-file rules | Enforced. `Governance / validate-pr` is a required Ruleset check; the linked Issue and branch are validated by the governance workflow. | `scripts/governance-rules.json` + `scripts/governance-lib.mjs`; command failures are errors. |
| `CI / typecheck (Node 22)` and `CI / fast unit / contract (Node 22)` | Enforced required checks. | `package.json` scripts and [`scripts/test-suites.mjs`](../scripts/test-suites.mjs); fast correctness is deterministic test result, not wall-clock timing. |
| Standards, integration/process, built-dist E2E, package/consumer, Node 24 compatibility, and coverage jobs | Executed on normal PRs and each job evaluates its command/policy, but not required status checks in the current Ruleset; their results are evidence and a failed non-required job does not itself block merge. | `.github/workflows/ci.yml` and the named commands in [`docs/testing.md`](testing.md). |
| Structured fields/records in path-aware `Test contract`, `Validation evidence`, `Release impact`, and regression-proof diagnostics | **Report-only**. The section headings remain part of the enforced PR contract, while `qualityGates.rollout.mode` is `report-only`; missing/invalid quality records become warnings with changed paths, matched rules, missing evidence, and remediation. | [`scripts/governance-rules.json`](../scripts/governance-rules.json) and [`scripts/governance-lib.mjs`](../scripts/governance-lib.mjs). Do not describe a warning as an enforcement failure or an unrun layer as passed. |
| Property/mutation effectiveness | Scheduled or manual, advisory to normal PR merge. The runner enforces its own catalog/baseline/timeout result and uploads JSON reports, but the workflow is not a PR required check and is excluded from `verify`. | `.github/workflows/test-effectiveness.yml`, [`scripts/mutation-catalog.mjs`](../scripts/mutation-catalog.mjs), [`mutation-baseline.json`](mutation-baseline.json). |
| Packed artifact and runtime/build identity | Required as package/release evidence when the configured package path applies; not a source-test shortcut. | [`docs/mcp-stdio-blackbox.md`](mcp-stdio-blackbox.md), `scripts/run-package-suite.mjs`, `scripts/generate-build-metadata.mjs`, `src/runtime-diagnostic.ts`. |

This status table describes current `main`, not the observation state of PR
#116 or an intended future promotion. The detailed #21–#27 map and test-layer
ownership are in [`docs/testing.md`](testing.md).

## Regression-first proof and trust boundary

For a bug-fix PR (`fix(...)` or `change type: bug-fix`), `Regression proof` must
identify:

- the changed regression test path and fixed test identifier;
- the observed pre-fix failure and post-fix result; and
- either automated proof, reviewer-attested proof, or an explicit
  `unsupported automated proof` reason with reviewer attestation.

Automated proof is intentionally narrow. The PR supplies only a bounded test
path, identifier, and command id. The command argv comes from the trusted base
revision's `regressionProof.runners` mapping. The validator never executes a
shell command copied from the PR body, and the identifier is metadata rather
than a shell fragment.

When a proof is eligible, the governance workflow's dedicated
`regression-proof` job (see below) creates temporary CI worktrees separate
from the Mottainai development task worktree. It applies only the declared
regular test-file diff to a base worktree, runs the fixed runner expecting the
pre-fix failure, then runs the same fixed runner in a head worktree expecting
success. Both worktrees use a timeout, bounded output, a temporary
HOME/config directory, no credentials, `shell: false`, and cleanup. No
workflow task state is created or persisted by this proof.

If the test diff cannot be safely narrowed to the configured class, use
`unsupported automated proof` plus reviewer attestation. The validator reports
that evidence as an explicit path; it does not turn an unverified case green.

## Report-only quality-gate rollout (current)

The trusted current configuration sets `pullRequest.qualityGates.rollout.mode`
to `report-only` in [`scripts/governance-rules.json`](../scripts/governance-rules.json).
The validator emits diagnostics with the changed path, matched path class/rule,
missing evidence, and the exact way to satisfy it, but does not fail the PR for
those quality diagnostics. Existing mandatory rules still fail normally. Draft
PRs may leave quality evidence incomplete; non-Draft PRs must still complete
the existing enforced validation checkboxes.

Promotion is a three-stage operational gate:

```text
report-only -> observed -> explicit mode=enforced change
```

This is the current v1 enforcement state after the quality-gate implementation
has landed on `main`; it is not a historical claim that rollout is complete.
Observation data and false-positive review are prerequisites for promotion. A
maintainer would have to explicitly change the trusted rollout mode after that
review; no such promotion is documented or implied here.

## Workflow trust boundary

`governance.yml` checks out the pull request head into `pr` only to calculate
changed files and to provide a candidate test diff. It checks out
`pull_request.base.sha` into `governance` and runs the validator from that
revision. Checkout credentials remain disabled. The linked Issue step receives
only the numeric Issue number written by the validator.

Regression-proof execution runs PR-authored test code — a Git worktree
isolates repository state, not OS-user or filesystem access, so that code must
never share a job with trusted follow-up steps (such as the linked Issue
validation) or with a checkout those steps still trust afterward. The
`validate-pr` job only builds the regression-proof plan and uploads it as an
artifact; it never executes the plan and never checks out a workspace that
proof code could reach. Execution happens in a separate `regression-proof`
job with `permissions: {}`, its own PR-head and governance-base checkouts, and
no further trusted step afterward — its only output is a report appended to
its own job summary. It is not `pull_request_target`, does not run PR-provided
shell text (only fixed argv from the trusted base revision's
`regressionProof.runners` mapping), and cannot influence the `validate-pr`
result. Governance changes therefore govern subsequent PRs after merge; they
cannot self-authorize their own enforcement.

## Local validation

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch chore/123-governance
pnpm run governance:issue -- --event /path/to/issues-event.json
pnpm run governance:pr -- --event /path/to/pull-request-event.json --files /path/to/changed-files.txt
```

For this quality-gate change, use the repository development loop:

```bash
pnpm run governance:test
pnpm run test:standards
pnpm run verify:standards
pnpm run typecheck
pnpm test
pnpm run build
```

Do not report report-only observations as enforcement failures or as proof that
post-merge operational observation has completed. Do not report an unrun,
pending, hung, or environment-unavailable layer as passed.

## Failed-result navigation

Use the diagnostic's changed paths and matched rule to select the next owner;
do not infer a new rule from the prose of a PR.

| Failed result or warning | Canonical owner | Next proof / evidence |
| --- | --- | --- |
| Test file is unclassified, overlaps suites, or leaks into fast | [`scripts/test-suites.mjs`](../scripts/test-suites.mjs) | `pnpm run test:classification` / `pnpm run test:standards`; record the affected test layer. |
| Format, lint, architecture, or governance self-test | [`eslint.config.mjs`](../eslint.config.mjs), [`prettier.config.mjs`](../prettier.config.mjs), [`scripts/architecture-check.mjs`](../scripts/architecture-check.mjs) | `pnpm run verify:standards`; `lint/architecture` evidence for governance paths. |
| `quality.evidence.*`, path class, or `quality.regression.*` warning | [`scripts/governance-rules.json`](../scripts/governance-rules.json) + [`scripts/governance-lib.mjs`](../scripts/governance-lib.mjs) | Run the mapped test, add the exact class fields, and record the concrete result. Current quality warning remains report-only. |
| Package/artifact or release result | [`scripts/run-package-suite.mjs`](../scripts/run-package-suite.mjs), [`scripts/smoke-test.mjs`](../scripts/smoke-test.mjs), release workflow | Verify the same packed tarball in an isolated consumer; include artifact and `warnings: none` release evidence. |
| Runtime identity or startup diagnostic mismatch | [`scripts/generate-build-metadata.mjs`](../scripts/generate-build-metadata.mjs), [`src/runtime-diagnostic.ts`](../src/runtime-diagnostic.ts) | Rebuild the candidate, run package identity assertions, then inspect `doctor --json` or `mottainai_runtime_status` for the verified artifact's `build_id` and distribution kind. |

## GitHub Ruleset

Repository files cannot enable a Ruleset. Configure a Ruleset for `main`
manually:

- Require pull requests
- Require one approval
- Require Code Owner review
- Dismiss stale approvals
- Require resolved conversations
- Require branches to be up to date
- Block force pushes
- Block branch deletion
- Disable bypasses, including administrators
- Require the status check `Governance / validate-pr`
- Require `CI / typecheck (Node 22)`
- Require `CI / fast unit / contract (Node 22)`

The active repository ruleset does not require a native-Windows check or the
Linux Node 24 compatibility smoke. No branch-protection setting is changed by
this repository change.

`.github/CODEOWNERS` currently assigns governance paths to `@yohnark`. Do not
configure a nonexistent team name.

## LLM rules

- Do not add functionality absent from the Issue.
- Do not change acceptance criteria during implementation.
- Propose out-of-scope problems as separate Issues.
- Reconstruct the PR body from the final diff and validation results.
- Never mark unrun validation as completed.
- Close exactly one Issue by default.
- Make Review focus specific.
- Create Issues for TODOs and follow-ups; do not leave them only in a PR body.
