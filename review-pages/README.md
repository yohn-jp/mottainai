# Review Pages

Generates a deterministic, machine-readable review package for every
eligible non-draft pull request revision and publishes it as static
content, consumable over plain HTTP. See
[Issue #704](https://github.com/yohn-jp/mottainai/issues/704) for the
originating contract.

This directory is a self-contained boundary: it has no dependency on
`src/`, the MCP runtime, or any other Mottainai code, and no
implementation logic lives in `.github/workflows/review-pages.yml`
beyond orchestration (checkout, run the scripts below, push). It is
designed to be extractable into an independent package later without
redesigning its public data contract.

## Ownership boundary

| Concern                                             | Owner                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Deterministic review-oriented preparation semantics  | Open Code Review (upstream), once it exposes a structured export — see below       |
| PR identity, diff metadata, Issue intent, checks     | `review-pages/src/*` (this directory)                                              |
| Governance/policy evaluation                         | `scripts/governance-lib.mjs` and related governance tooling — surfaced, not redone |
| Publication to GitHub Pages                          | `review-pages/src/publish-to-pages.mjs`, invoked by the workflow                   |
| Triggering, checkout, credentials                    | `.github/workflows/review-pages.yml`                                               |

## Open Code Review integration

`OpenCodeReview` (see `scripts/review-preflight.mjs`) is a manual,
comment-triggered external review action. Its pinned action does not
expose a repository-enforceable request-token bound, so it is listed in
`UNBOUNDED_REVIEWERS` and stays disabled; Review Pages never invokes it,
and there is currently no stable structured export surface published by
OCR itself to consume. `review-pages/src/build-ocr.mjs` therefore
reproduces the narrow, deterministic slice of OCR's review-preparation
contract that downstream consumers need — changed-file selection and
hunk positioning — directly from Git, under its own versioned schema
(`mottainai.review-pages.ocr-export/v1`) with `provider.ocrIntegration:
"none-live"`. This is the minimum explicit export contract the
Constraints in Issue #704 call for; it is not a reimplementation of
OCR's bundling, rule resolution, or review-unit construction, and it is
expected to be replaced by OCR's own structured export once one exists.

## Generated layout

```text
reviews/
  pr/
    <pr-number>/
      index.json              # mutable: resolves to the latest eligible revision
      <full-head-sha>/
        manifest.json          # canonical, versioned entry point for this revision
        issue.json
        diff.json
        ocr.json
        checks.json
        index.html
```

- **Revision identity** is `(repository, PR number, base SHA, full head
  SHA)`. `manifest.json` under a given `<full-head-sha>` directory is
  immutable once generated — the generator never overwrites an existing
  revision directory in place; a new head SHA always gets a new
  directory.
- **`reviews/pr/<number>/index.json`** is the only mutable pointer: it
  resolves to the newest eligible revision. `manifest.json` remains the
  canonical, versioned machine-readable entry point for one specific
  revision.
- **Draft PRs** produce no output at all (see `isEligibleForGeneration`
  in `src/generate-review-package.mjs`); `ready_for_review` produces the
  first revision, and every later eligible head change produces the
  next.

## Volatile vs. deterministic fields

Generation from fixed inputs (a fixed repository state, PR metadata, and
injected GitHub API responses) is byte-for-byte deterministic — see
`test/generate-review-package.test.mjs`. The only fields that legitimately
vary between otherwise-identical runs are listed explicitly in
`manifest.json`'s `volatile.fields` array (currently
`volatile.generatedAt` and `checks.checkRuns`, since live CI/check state
changes independently of the PR's Git content). JSON output is
canonicalized (sorted object keys, fixed indentation — see
`src/lib/canonical-json.mjs`) so incidental serialization order never
looks like a content change.

## Publication and concurrency safety

Publication targets a dedicated `gh-pages` branch (classic
"deploy from a branch" GitHub Pages, not the newer single-artifact
Actions deployment, which replaces the entire site on every deploy and
would violate the no-overwrite requirement below). One-time repository
setup: **Settings → Pages → Source: Deploy from a branch → `gh-pages` /
`(root)`**.

`src/publish-to-pages.mjs` merges only `reviews/pr/<number>/...` into the
branch's working tree (`mergeRevisionIntoSite`) and pushes with
optimistic-concurrency retry: on a non-fast-forward rejection (another
PR's publish landed first), it re-fetches the branch tip, re-applies this
PR's own merge on top, and retries. Because the merge only ever touches
this PR's own subtree, replaying it after a rebase can never erase
another PR's directory — see
`test/publish-to-pages.test.mjs` for a reproduction of a genuine push
race and the recovery, plus multi-PR and multi-revision coexistence
checks.

## Scripts

| Script                          | Purpose                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| `src/generate-review-package.mjs` | Orchestrates `build-*` modules into a manifest + resource set for one revision |
| `src/validate-manifest.mjs`       | Validates `manifest.json`/`pr-index.json` against `schema/*.schema.json` |
| `src/publish-to-pages.mjs`        | Merges a generated revision into the `gh-pages` branch with retry        |

Run the test suite with:

```bash
node --test review-pages/test/*.test.mjs
```

## Non-goals (see Issue #704)

Semantic LLM code review, replacing OCR's deterministic pipeline, making
GitHub Actions an MCP server, a persistent interactive review service,
raw CI log/binary/build-artifact publication, and migrating storage away
from GitHub Pages are all explicitly out of scope for this
implementation.
