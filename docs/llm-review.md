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

OpenCodeReview has no repository variable that enables provider execution. The
workflow is intentionally fail-closed because the pinned action does not
expose an enforceable per-request token bound.

When a custom model is selected, all three budget variables for that reviewer
must be set explicitly. Unknown models and invalid budgets fail closed before
the provider is called.

## Secret and budget behavior

Only PR-Agent uses the `OPENAI_API_KEY` repository secret for the Featherless
OpenAI-compatible endpoint. The repository-owned preflight counts the review
diff, pull-request metadata, and applicable `AGENTS.md` instructions using a
conservative sizing upper bound. It derives:

```text
maximum input = total context - reserved output - safety margin
```

That estimate is sufficient for PR-Agent because its pinned action accepts an
input-token bound. It is not proof of the final OpenCodeReview request: the
pinned action constructs additional context internally. Its pinned
[`action.yml`](https://github.com/alibaba/open-code-review/blob/4bcc95acecd629e64ea984c962cfd08dd892a38e/action.yml)
contains no per-request token/context limit, and its composite `ocr review`
invocation has no such argument.

The PR-Agent path is different: its pinned source resolves
`custom_model_max_tokens` and clips the assembled review prompt before the
completion call ([token-limit implementation](https://github.com/qodo-ai/pr-agent/blob/f6af7d77554ff8d26adffded077e6461329e92fa/pr_agent/algo/utils.py#L993-L1028)). The workflow passes the preflight maximum to that setting and still refuses oversized or invalid inputs before the action starts.

Consequently, the OpenCodeReview workflow has no credential mask or provider
action step. Its request-bound output is fixed to `false`, and the preflight
also ignores any legacy bound flag for that reviewer. `/open-code-review`
therefore produces a non-secret `review_not_generated` summary without
invoking a provider. Re-enabling it requires an upstream bound or a
repository-owned bounded wrapper, plus focused regression coverage proving the
same bound reaches the downstream request.

The repository has no controlled safe multi-pass support. PR-Agent rejects an
oversized, uncollectable, invalid, or unproven request before its provider
step; OpenCodeReview is always disabled until its downstream bound is proven.
The Actions summary exposes `chunking=false`, `passes=0`, and `chunks=0`,
alongside the provider-bound and invocation decisions. A successful PR-Agent
provider step is reported as `review_generated`; disabled or failed execution
remains `review_not_generated`.

Manual routing is exact (`/qodo-review` and `/open-code-review`), limited to
trusted commenter associations, and same-repository pull requests. Fork PRs
and untrusted/bot commenters receive no review credentials. Summaries contain
only bounded numeric/status metadata; raw prompts, responses, and credentials
are not published.
