# Review Pages

Generates a deterministic, machine-readable review package for every
eligible non-draft pull request revision and publishes it as static
content, consumable over plain HTTP. See
[Issue #704](https://github.com/yohn-jp/mottainai/issues/704) for the
originating contract.

This directory is a self-contained boundary: it has no dependency on
`src/`, the MCP runtime, or any other Mottainai code, and no
review-package implementation logic lives in `.github/workflows/review-pages.yml`
beyond orchestration (checkout, run the scripts below, push) and the minimal
pre-checkout timestamp bootstrap needed before repository files are available.
The directory is designed to be extractable into an independent package later
without redesigning its public data contract.

The workflow splits generation from publication into two jobs so the
step that processes PR-controlled content (diff, issue body, PR
metadata) never holds a write token: `generate` runs with
`permissions.contents: read` and hands its output to `publish` (which
holds `permissions.contents: write` and does no PR-content processing)
as a build artifact.

## Ownership boundary

| Concern                                             | Owner                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Deterministic review-oriented preparation semantics | Open Code Review (`@alibaba-group/open-code-review`, `ocr delegate`) — see below   |
| PR identity, diff metadata, Issue intent, checks    | `review-pages/src/*` (this directory)                                              |
| Governance/policy evaluation                        | `scripts/governance-lib.mjs` and related governance tooling — surfaced, not redone |
| Publication to GitHub Pages                         | `review-pages/src/publish-to-pages.mjs`, invoked by the workflow                   |
| Latency measurement                                 | `review-pages/src/lib/latency.mjs` and `src/measure-pages-visibility.mjs`          |
| Triggering, checkout, credentials                   | `.github/workflows/review-pages.yml`                                               |

## Open Code Review integration

`OpenCodeReview` (see `scripts/review-preflight.mjs`) as invoked via a
manual PR-comment slash-command stays disabled — its pinned action
exposes no repository-enforceable request-token bound (unrelated to
this section: that's LLM-backed semantic review, not what Review Pages
uses). Review Pages instead installs the OCR CLI package,
`@alibaba-group/open-code-review` (pinned in `package.json`,
`node_modules/.bin/ocr`), and consumes its documented **delegate mode**
— a deterministic, LLM-free structured-output surface built for
exactly this kind of host-agent consumption:

```text
PR base/head
    ↓
ocr delegate preview --format json --from <base> --to <head>
    ↓
reviewable_files / excluded_files
    ↓
ocr delegate rule --format json <reviewable files>
    ↓
review-pages envelope (schema, provider, base/head SHA)
    ↓
ocr.json
```

`build-ocr.mjs` (via `lib/ocr-cli.mjs`) runs both delegate subcommands
and stores their JSON output close to verbatim under `ocr.json`'s
`preview`/`rule` fields, alongside `provider` (OCR's npm package name
and installed version), `baseSha`, `headSha`, and a schema version. It
does not reimplement OCR's changed-file selection, exclusion, or rule
resolution — that JSON _is_ OCR's own output. The one normalization
applied is stripping `preview.repository`, an absolute local filesystem
path that duplicates `manifest.repository` and isn't portable evidence.
Delegate mode never calls an LLM and needs no credentials.

Diff positioning (all changed files — not curated by OCR's
reviewable/excluded split — plus line/column hunk anchors) that Review
Pages generates independently lives in `diff.json`: plain `git diff`
plumbing under Issue #704's Change Information category, not an OCR
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

## Latency evidence

Each eligible Review Pages run records bounded evidence in the
`review-pages-latency-generate` and `review-pages-latency-publish` Actions
artifacts and appends a compact table to the job summary. The evidence has
only run/revision identifiers, UTC timestamps, monotonic timestamps, stage
durations, and HTTP visibility status; it never contains PR bodies,
credentials, or raw logs.

The generate job measures runner marker, checkout, setup, dependency install,
generation, validation, and artifact upload. The publish job measures its
runner marker, checkout, setup, artifact download, and publication. The
`generation-complete`, `gh-pages-push-complete`, and `http-visible` milestones
remain separate. Stage durations are calculated from Node's monotonic clock
within each runner. Since the two jobs use different runners, deltas between
jobs use UTC wall-clock timestamps and are labelled informational. If
`github.run_started_at` is available, the summary also reports the delay from
workflow start to each runner marker; this is a queue/startup baseline, not an
SLO.

The HTTP observation polls the expected immutable manifest path with bounded
attempts and a bounded response size. A missing or stale Pages response is
recorded as measurement evidence and does not turn a successful publication
into a failed workflow. Set the optional repository variable
`REVIEW_PAGES_BASE_URL` when the project uses a custom Pages URL; otherwise
the standard `https://<owner>.github.io/<repository>` project URL is used.

### Current baseline

The first baseline was captured from the real, non-draft [PR #735 run
33630221776](https://github.com/yohn-jp/mottainai/actions/runs/33630221776)
on 2026-09-02. Recorded monotonic stage durations were:

| Job      | Stage            | Duration |
| -------- | ---------------- | -------: |
| generate | checkout         |  2353 ms |
| generate | setup            |  4767 ms |
| generate | install          | 11714 ms |
| generate | generation       |  1064 ms |
| generate | validation       |   191 ms |
| generate | artifact handoff |  1352 ms |
| publish  | checkout         |  2213 ms |
| publish  | setup            |   863 ms |
| publish  | artifact handoff |  2540 ms |
| publish  | publish          |  2319 ms |
| publish  | Pages serving    | 30474 ms |

The expected manifest became HTTP-visible on attempt 7, about 30.5 seconds
after the gh-pages push marker. Pages serving was the dominant boundary in
this run; dependency installation was the next largest measured stage at
11.7 seconds. The workflow-start-to-runner-marker field was unavailable in
this run, so queue/startup delay remains unmeasured until that metadata is
exposed. This is baseline evidence only; no hard pass/fail latency target is
defined from it.

## Scripts

| Script                             | Purpose                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `src/generate-review-package.mjs`  | Orchestrates `build-*` modules into a manifest + resource set for one revision |
| `src/validate-manifest.mjs`        | Validates `manifest.json`/`pr-index.json` against `schema/*.schema.json`       |
| `src/publish-to-pages.mjs`         | Merges a generated revision into the `gh-pages` branch with retry              |
| `src/lib/latency.mjs`              | Records bounded monotonic stage timing and renders run-summary evidence        |
| `src/measure-pages-visibility.mjs` | Observes the expected manifest over HTTP without changing publication          |

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
