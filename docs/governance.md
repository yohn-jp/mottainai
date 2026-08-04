# Issue and Pull Request Governance

Treat Issues and pull requests created by people or multiple LLMs as machine-verifiable contracts, not suggestions in templates.

## Issue contract

Blank Issues are disabled. Create and agree on exactly one Issue before
starting work, then select an Issue Form from `.github/ISSUE_TEMPLATE/`:

- Feature
- Bug
- Architecture
- Maintenance
- Research

Every Issue requires Summary, Problem, Goal, Non-goals, Acceptance criteria as a checklist, Affected areas, Risks / compatibility, Dependencies, and Implementation notes.

`issue-governance.yml` checks the validator from the repository default branch
after creation, editing, or reopening. Invalid Issues receive `status:invalid`
and `needs:specification`; successful revalidation removes them. The Issue
number is passed to GitHub CLI as a numeric context value, and Issue text is
written to a report file rather than interpolated into a shell command.

## Pull request contract

Title format:

```text
type(scope): summary
```

The allowed types, scopes, title pattern, branch pattern, required sections,
minimum lengths, validation items, package-impact paths, and changed-file
rules are defined in `scripts/governance-rules.json`. The validator is the
only implementation of those rules; workflows only provide inputs and
permissions.

Branch format:

```text
type/123-short-description
```

Preserve every heading in `.github/PULL_REQUEST_TEMPLATE.md`. Use exactly one `Closes #123` reference. Split changes that close multiple Issues. Do not link PRs directly to Epics; split Epics into child Issues.

Non-draft PRs must mark Typecheck, Tests, and Build as completed. Package check
is required when a path in `packageCheckPaths` changes and may remain
unchecked otherwise. Draft PRs may leave validation checks incomplete, but
the same checks are required when the PR becomes ready for review. Check only
validation that ran. Non-draft PRs cannot contain `TBD`, `TODO`, `FIXME`, or
`WIP`.

## Changed-file rules

| Change | Required contract |
|---|---|
| Paths in `pullRequest.packageCheckPaths` | Completed Package check |
| Paths in `pullRequest.changedFileRules.configurationPaths` | `Migration / compatibility` statement |
| Paths in `pullRequest.changedFileRules.compressionPaths` | Test path in `pullRequest.changedFileRules.compressionTestPaths` plus transformation and preservation evidence |
| Paths in `pullRequest.changedFileRules.cliPaths` | README or CLI test change |
| Paths in `pullRequest.changedFileRules.securityPaths` | `Security impact` statement |

## Local validation

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch chore/123-governance
pnpm run governance:issue -- --event /path/to/issues-event.json
pnpm run governance:pr -- --event /path/to/pull-request-event.json --files /path/to/changed-files.txt
```

`scripts/governance-rules.json` is the rule source of truth. `scripts/governance-lib.mjs` implements validation. Do not duplicate validation rules in workflows.

The Package check checkbox is always present in the template as `- [ ]
Package check`; its completion is conditional on the configured changed-file
paths. Keep the path lists and regexes in the JSON file, not in workflow YAML,
JavaScript, or a second Markdown rule list.

## Validator trust boundary

`governance.yml` checks out the pull request head into `pr` only to calculate
the changed-file list between the base and head SHAs. It checks out
`pull_request.base.sha` into `governance` and runs
`governance/scripts/validate-branch-name.mjs` and
`governance/scripts/validate-pr.mjs` from that checkout. The PR head is never
executed as the governance validator, and the workflow does not use
`pull_request_target`.

Governance changes are validated by the validator from the base revision. New
governance rules apply to subsequent pull requests after merge. A governance
change must therefore be reviewed as a change to the rules that will govern
later pull requests, not as a self-authorizing change to its own check.

## GitHub Ruleset

Repository files cannot enable a Ruleset. Configure a Ruleset for `main` manually:

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
- Require `CI / install / typecheck / test / build (Node 22)`
- Require `CI / install / typecheck / test / build (Node 24)`

`.github/CODEOWNERS` currently assigns the governance paths to the valid
individual user `@yohnark`. A future migration to an existing Organization
Team can change the owner after that Team is created; do not configure a
nonexistent Team name.

After enabling the Ruleset, update existing Issues to the current Issue contract before referencing them from a PR.

## LLM rules

- Do not add functionality absent from the Issue
- Do not change acceptance criteria during implementation
- Propose out-of-scope problems as separate Issues
- Reconstruct the PR body from the final diff and validation results
- Never mark unrun validation as completed
- Close exactly one Issue by default
- Make Review focus specific
- Create Issues for TODOs and follow-ups; do not leave them only in a PR body
