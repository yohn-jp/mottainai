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
| Deterministic review-oriented preparation semantics | Open Code Review (`@alibaba-group/open-code-review`, `ocr delegate`) — see below   |
| PR identity, diff metadata, Issue intent, checks    | `review-pages/src/*` (this directory)                                              |
| Governance/policy evaluation                        | `scripts/governance-lib.mjs` and related governance tooling — surfaced, not redone |
| Publication to GitHub Pages                         | `review-pages/src/publish-to-pages.mjs`, invoked by the workflow                   |
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
`(root)`**. The workflow then verifies the immutable URL
`<Pages site>/reviews/pr/<number>/<full-head-sha>/manifest.json` over
public HTTP. For the default project Pages site, the expected base URL is
derived from `GITHUB_REPOSITORY`; set the repository variable
`REVIEW_PAGES_BASE_URL` when the repository uses a custom Pages domain.
The value must be an absolute HTTP(S) URL without credentials, query, or
fragment.

After the push, the bounded serving check reports one of these outcomes:

- `success`: the expected manifest is reachable and its repository, PR
  number, and head/revision SHA match the generated revision.
- `published-but-not-serving`: the push completed, but the manifest stayed
  unreachable (for example, a persistent 404). The diagnostic points to
  **Settings → Pages** and the required `gh-pages` / `(root)` configuration.
- `serving-wrong-identity`: an HTTP 2xx response contained a manifest for a
  different repository, PR, or revision; the workflow fails closed without
  retrying that immutable identity mismatch.
- `push-failure`: the trusted `gh-pages` push did not complete, so serving
  verification is not attempted.

Only the manifest URL is requested, with an `Accept` header and no
authorization header. A fixed attempt count, request timeout, and retry
delay bound the check even when Pages is unavailable.

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
| `src/verify-pages-serving.mjs`    | Bounded public-HTTP reachability and revision-identity verification            |

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
