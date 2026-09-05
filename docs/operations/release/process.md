# Release process

This documents how to prepare and ship a patch/minor release of the
`mottainai` npm package. It was written after preparing 0.9.1, the first time
this sequence was done deliberately rather than rederived from the prior
release-prep commit.

## How publishing actually triggers

`.github/workflows/publish.yml` does not use `workflow_dispatch` with a
version input. It detects a `package.json` version change on a trusted push to
`main` (comparing the new commit's version against `HEAD^`'s). If the version
changed and is a bare `MAJOR.MINOR.PATCH`, it drafts a GitHub Release, tags
`v<version>`, and runs the publish/build/attach jobs against that tag. If the
version is unchanged, the workflow no-ops.

This means **the release is triggered by merging the version bump to `main`**,
not by a separate manual dispatch step.

## Steps

1. Branch off `main` (never commit release-prep changes directly to `main` —
   see [AGENTS.md](../../../AGENTS.md) §2). Branch name is not load-bearing for the
   publish workflow itself, but `inari pr create --template release` expects
   a PR, not a specific branch prefix — using `chore/release-<version>` is
   fine.
2. Bump the version in `package.json`.
3. Update every `mottainai@<old-version>` reference in `README.md` (npx
   examples, MCP registration commands, the example client configuration
   block) to the new version. Also add a "release notes" link line for the
   new version near the existing `docs/history/releases/*.md` links, keeping older
   links intact.
4. Add `docs/history/releases/<version>.md`: a short writeup of what changed since the
   last release (group by Fixed / CI / Added / etc. as applicable), a
   Distribution line naming the npm package, an Upgrade line, and a Tracking
   line listing the PR numbers included.
5. Add a `## [<version>] - <date>` entry to `CHANGELOG.md` under `[Unreleased]`
   (which stays empty), linking to the new `docs/history/releases/<version>.md`
   writeup and summarizing the same changes in Keep a Changelog style.
6. Commit, push, and open the PR through the governed release template:

   ```bash
   inari pr create --template release \
     --title "chore(release): prepare <version>" \
     --head <branch> --base main \
     --from <path-to-json>
   ```

   The `release` template (`.github/inari/pull-requests/release.json`) has
   these fields: `release_pr` (do **not** supply this — see gotcha below),
   `version`, `release_notes`, `breaking_migration`, `publish_plan`,
   `post_release_verification`, `tracking`.

7. Merge the PR once it's approved and checks pass. Merging is what triggers
   the publish workflow, per "How publishing actually triggers" above.
8. Verify post-merge:
   - `npm view mottainai@<version> version` resolves to the new version.
   - The GitHub Release for `v<version>` is finalized (not left as a draft —
     the workflow finalizes it only after all publish jobs succeed).
   - The Runtime Appliance OCI artifact tag matches `v<version>`.

## Known gotcha: `inari pr create` round-trip conflict

Supplying a value for the `release_pr` field (the PR's H1 section, which the
template already fills with its own explanatory placeholder text) or writing
`release_notes` as multi-paragraph markdown with embedded links and blank
lines can trigger:

```
ARTIFACT_ROUND_TRIP_INVALID ... FIELD_VALUE_CONFLICT
```

This happens because the rendered markdown doesn't parse back to the same
semantic value that was validated. Workaround:

- Omit `release_pr` entirely from the `--from` JSON (or `--field` list) —
  let the template's own placeholder stand.
- Keep `release_notes` (and other free-text fields) to a single paragraph:
  plain sentences, no markdown links, no blank lines within the field value.
  Reference files by bare path (e.g. `docs/history/releases/0.9.1.md`) instead of a
  `[text](path)` link.

## Files this process touches

- `package.json` (`version` field)
- `README.md` (all `mottainai@<version>` references, release notes link list)
- `CHANGELOG.md` (`[Unreleased]` section, new version entry)
- `docs/history/releases/<version>.md` (new file)

It does not require changes to `.github/workflows/publish.yml` or
`.github/inari/pull-requests/release.json` under normal circumstances — those
are release *tooling*, not release *content*, and changing them is a separate,
explicitly-scoped task.
