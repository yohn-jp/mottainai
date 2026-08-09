# LLM review workflows

This repository runs two independent pull-request reviewers. Both workflows
run only for same-repository pull requests, and manual commands are accepted
only from `OWNER`, `MEMBER`, or `COLLABORATOR` commenters. Fork-originated pull
requests never receive review credentials.

## Reviewers and triggers

| Reviewer        | Automatic pull-request events                           | Manual command      |
| --------------- | ------------------------------------------------------- | ------------------- |
| PR-Agent / Qodo | `opened`, `reopened`                                    | `/qodo-review`      |
| OpenCodeReview  | `opened`, `reopened`, `synchronize`, `ready_for_review` | `/open-code-review` |

`/review` is not a manual trigger. The PR-Agent workflow translates the exact
`/qodo-review` command to the upstream action's `/review` command after the
trusted-comment and budget checks pass.

## Repository variables

Both reviewers use the current 32,768-token Kimi-class profile by default:

- total context: `32768`
- reserved output: `8192`
- safety margin: `2048`
- effective maximum input: `22528`

PR-Agent variables:

- `PR_AGENT_MODEL` (default: `openai/moonshotai/Kimi-K3`)
- `PR_AGENT_CONTEXT_TOKENS`
- `PR_AGENT_OUTPUT_RESERVE_TOKENS`
- `PR_AGENT_SAFETY_MARGIN_TOKENS`

OpenCodeReview variables:

- `OPEN_CODE_REVIEW_MODEL` (default: `moonshotai/Kimi-K3`)
- `OPEN_CODE_REVIEW_CONTEXT_TOKENS`
- `OPEN_CODE_REVIEW_OUTPUT_RESERVE_TOKENS`
- `OPEN_CODE_REVIEW_SAFETY_MARGIN_TOKENS`

When a custom model is selected, all three budget variables for that reviewer
must be set explicitly. Unknown models and invalid budgets fail closed before
the provider is called.

## Secret and budget behavior

Both workflows use the `OPENAI_API_KEY` repository secret for the Featherless
OpenAI-compatible endpoint. The repository-owned preflight counts the review
diff, pull-request metadata, and applicable `AGENTS.md` instructions using a
conservative upper bound. It derives:

```text
maximum input = total context - reserved output - safety margin
```

The pinned OpenCodeReview action does not expose a per-request token-budget
input, and neither action has repository-controlled safe multi-pass support.
Therefore an oversized or uncollectable request is rejected before the model
step, with `review_not_generated` and the reason recorded in the Actions
summary. Raw prompts, responses, and credentials are not published.
