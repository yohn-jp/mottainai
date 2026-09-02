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

The workflow splits generation from publication into two jobs so the
step that processes PR-controlled content (diff, issue body, PR
metadata) never holds a write token: `generate` runs with
`permissions.contents: read` and hands its output to `publish` (which
holds `permissions.contents: write` and does no PR-content processing)
as a build artifact.

## Ownership boundary

| Concern                                             | Owner                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Deterministic review-oriented preparation semantics | Open Code Review (upstream), once it exposes a structured export — see below       |
| PR identity, diff metadata, Issue intent, checks    | `review-pages/src/*` (this directory)                                              |
| Governance/policy evaluation                        | `scripts/governance-lib.mjs` and related governance tooling — surfaced, not redone |
| Publication to GitHub Pages                         | `review-pages/src/publish-to-pages.mjs`, invoked by the workflow                   |
| Triggering, checkout, credentials                   | `.github/workflows/review-pages.yml`                                               |

## Open Code Review integration

Investigated surface: `scripts/review-preflight.mjs` and
`.github/workflows/*.yml`. Findings —

- `OpenCodeReview` is a manual, comment-triggered third-party GitHub
  Action (`MANUAL_REVIEW_COMMANDS.OpenCodeReview = "/open-code-review"`).
  Its pinned action exposes no repository-enforceable request-token
  bound, so it is listed in `UNBOUNDED_REVIEWERS` and stays disabled.
- No workflow in this repository currently invokes OpenCodeReview or
  `review-preflight.mjs`.
- None of OCR's own deterministic review-preparation logic
  (changed-file selection, bundling, rule resolution, positioning) is
  repository-owned code — it lives inside OCR's own third-party action —
  so there is nothing in this repository to re-export.

There is therefore no structured OCR output for Review Pages to consume,
and this subsystem does not reimplement any of OCR's review-preparation
semantics. `review-pages/src/build-ocr.mjs` records that integration
state as an honest, versioned `ocr.json`
(`mottainai.review-pages.ocr-status/v1`, currently always
`status: "unavailable"`) rather than fabricating OCR-shaped content, so a
future PR that gives OCR an enforceable request bound and a real
structured export can populate `status: "available"` without a breaking
schema change. Diff positioning (changed files, line/column hunk
anchors) that Review Pages _does_ generate lives in `diff.json` — it is
Review Pages' own "cheap deterministic diff metadata" per Issue #704's
Change Information category, computed with plain `git diff`, not an OCR
stand-in.

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
SHA)`. A `<full-head-sha>` directory is immutable once published:
  `publish-to-pages.mjs` fail-closes if it would publish different
  deterministic content under an existing revision directory — see
  "Publication and concurrency safety" below.
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
`test/generate-review-package.test.mjs`. Exactly two things legitimately
vary between otherwise-identical regenerations of the same head SHA, and
both are named in `manifest.json`'s `volatile.fields` array:

- `volatile.generatedAt` — stripped before the immutability comparison
  described below; the published `manifest.json` keeps the timestamp
  from the revision's _first_ publish and is never touched again.
- `checks.checkRuns` — the entire `checks.json` resource is treated as
  volatile evidence (live CI/check state legitimately changes over time
  for the same SHA) and is the one file `publish-to-pages.mjs` will
  refresh in place for an existing revision.

Every other resource (`issue.json`, `diff.json`, `ocr.json`,
`index.html`, and `manifest.json` minus `volatile.generatedAt`) is part
of a revision's immutable, compared identity. JSON output is
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
another PR's directory.

**Immutability enforcement**: if `reviews/pr/<n>/<sha>/` already exists,
`mergeRevisionIntoSite` compares its deterministic content (everything
listed above except `checks.json`) against the incoming revision. An
exact match is a no-op for those files (only `checks.json` is
refreshed); any difference throws `ImmutableRevisionConflictError`
_before_ any git operation for that attempt, which — because it happens
outside the push-retry `try`/`catch` — propagates straight out of
`publishGeneratedRevision` and aborts the publish rather than being
retried or partially applied. `reviews/pr/<n>/index.json` is the only
mutable pointer and is always safe to update.

See `test/publish-to-pages.test.mjs` for: first publish, a no-op
identical-content republish with a `checks.json` refresh, a
rejected differing-content republish, a reproduction of a genuine push
race and its retry recovery, and multi-PR / multi-revision coexistence
checks.

## Scripts

| Script                            | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `src/generate-review-package.mjs` | Orchestrates `build-*` modules into a manifest + resource set for one revision |
| `src/validate-manifest.mjs`       | Validates `manifest.json`/`pr-index.json` against `schema/*.schema.json`       |
| `src/publish-to-pages.mjs`        | Merges a generated revision into the `gh-pages` branch with retry              |

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
