# Issue and Pull Request Governance

Treat Issues and pull requests created by people or multiple LLMs as machine-verifiable contracts, not suggestions in templates.

## Issue contract

Blank Issues are disabled. Select an Issue Form from `.github/ISSUE_TEMPLATE/`:

- Feature
- Bug
- Architecture
- Maintenance
- Research

Every Issue requires Summary, Problem, Goal, Non-goals, Acceptance criteria as a checklist, Affected areas, Risks / compatibility, Dependencies, and Implementation notes.

`issue-governance.yml` validates an Issue after creation or editing. Invalid Issues receive `status:invalid` and `needs:specification`; successful revalidation removes them.

## Pull request contract

Title format:

```text
type(scope): summary
```

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

Allowed scopes: `cli`, `proxy`, `config`, `compression`, `routing`, `upstream`, `security`, `release`, `docs`, `ci`.

Branch format:

```text
type/123-short-description
```

Preserve every heading in `.github/PULL_REQUEST_TEMPLATE.md`. Use exactly one `Closes #123` reference. Split changes that close multiple Issues. Do not link PRs directly to Epics; split Epics into child Issues.

Check only validation that ran. Leave unrun checks unchecked and state why. Non-draft PRs cannot contain `TBD`, `TODO`, `FIXME`, or `WIP`.

## Changed-file rules

| Change | Required contract |
|---|---|
| `src/config.ts`, `mottainai.config*` | `Migration / compatibility` statement |
| `src/compress/**` | Test change in the same directory plus transformation and preservation validation |
| `package.json` | Completed Package check |
| `src/index.ts`, `scripts/mcp.ts` | README or CLI test change |
| security, auth, sandbox, or local-tools files | `Security impact` statement |

## Local validation

```bash
pnpm run governance:test
pnpm run governance:branch -- --branch chore/123-governance
pnpm run governance:issue -- --event /path/to/issues-event.json
pnpm run governance:pr -- --event /path/to/pull-request-event.json --files /path/to/changed-files.txt
```

`scripts/governance-rules.json` is the rule source of truth. `scripts/governance-lib.mjs` implements validation. Do not duplicate validation rules in workflows.

## GitHub Ruleset

Repository files cannot enable a Ruleset. Configure a Ruleset for `main` manually:

- Require pull requests
- Require one approval
- Dismiss stale approvals
- Require resolved review conversations
- Require branches to be up to date
- Block force pushes and branch deletion
- Block bypasses, including administrators
- Require `Governance / validate-pr`
- Require CI jobs for Node 22 and Node 24

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
