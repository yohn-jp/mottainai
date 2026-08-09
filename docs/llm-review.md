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
- `OPENCODEREVIEW_32K_CONFIRMED` (default: unset/false; explicit upstream-bound escape hatch)

When a custom model is selected, all three budget variables for that reviewer
must be set explicitly. Unknown models and invalid budgets fail closed before
the provider is called.

## Secret and budget behavior

Both workflows use the `OPENAI_API_KEY` repository secret for the Featherless
OpenAI-compatible endpoint. The repository-owned preflight counts the review
diff, pull-request metadata, and applicable `AGENTS.md` instructions using a
conservative sizing upper bound. It derives:

```text
maximum input = total context - reserved output - safety margin
```

That estimate is not proof of the final provider request: the pinned
OpenCodeReview action constructs additional context internally. The exact
upstream evidence is its pinned [`action.yml`](https://github.com/alibaba/open-code-review/blob/4bcc95acecd629e64ea984c962cfd08dd892a38e/action.yml), whose inputs contain no per-request token/context limit, and whose composite `ocr review` invocation has no such argument. The repository regression test keeps this limitation visible in the workflow contract.

The PR-Agent path is different: its pinned source resolves
`custom_model_max_tokens` and clips the assembled review prompt before the
completion call ([token-limit implementation](https://github.com/qodo-ai/pr-agent/blob/f6af7d77554ff8d26adffded077e6461329e92fa/pr_agent/algo/utils.py#L993-L1028)). The workflow passes the preflight maximum to that setting and still refuses oversized or invalid inputs before the action starts.

Consequently, `OPENCODEREVIEW_32K_CONFIRMED` defaults to false. The preflight
estimator never enables it: OpenCodeReview's credential mask and provider step
both require the explicit bound gate and a fitting preflight result. Until an
upstream bound or repository-owned bounded wrapper is evidenced, the
credentialed OpenCodeReview path is fail-closed.

Neither pinned action has repository-controlled safe multi-pass support. An
oversized, uncollectable, invalid, or unproven request therefore produces
`review_not_generated`; no provider request is attempted. The Actions summary
always exposes `chunking=false`, `passes=0`, and `chunks=0`, alongside the
provider-bound and invocation decisions. A successful provider step alone is
reported as `review_generated`; skipped or failed provider execution remains
`review_not_generated`.

Manual routing is exact (`/qodo-review` and `/open-code-review`), limited to
trusted commenter associations, and same-repository pull requests. Fork PRs
and untrusted/bot commenters receive no review credentials. Summaries contain
only bounded numeric/status metadata; raw prompts, responses, and credentials
are not published.
