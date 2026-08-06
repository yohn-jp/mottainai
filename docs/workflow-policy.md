# Git workflow policy

Issue #28 adds a policy-driven Git workflow guardrail engine, built out
across several child Issues. This document covers what exists so far:
the policy schema, presets, and resolution/provenance model
(`src/workflow/policy/`).

This is a separate system from `src/adaptive/policy.ts`, which is an
unrelated capability-routing policy for MCP tool provider selection. Do
not confuse the two.

## Schema

`src/workflow/policy/schema.ts` defines a versioned zod schema
(`workflowPolicySchema`, current `POLICY_SCHEMA_VERSION`). A policy
document configures:

- `protectedBranches` — glob-style patterns (e.g. `main`, `release/*`).
- `protectedBranchRule` — independent rule modes for source writes,
  staging, commit, direct push, force push, and destructive branch
  operations.
- `controlPlaneRole` — whether the primary checkout is restricted to
  `primary-checkout` duties (sync/worktree management, no task
  implementation) or unrestricted (`any`).
- `worktree` — whether a worktree is required, the bootstrap mode
  (`off`/`suggest`/`automatic`/`conditional`), and whether multiple
  active tasks per Issue or multiple worktrees per task are allowed.
- `stagingMode` — `explicit`, `already-staged-only`, `tracked`, or `all`.
- `cleanup` — independent rule modes for worktree removal, local/remote
  branch deletion, `git worktree prune`, and force cleanup.

Every rule uses one of four modes: `off`, `advisory`, `enforce`,
`confirm`.

The schema is `.strict()` — unknown top-level keys are rejected rather
than silently ignored.

## Presets

`src/workflow/policy/presets.ts` ships three built-in presets
(`BUILTIN_PRESETS`), each validated against the canonical schema in
tests so a preset can never drift from what the loader accepts:

- **`minimal`** — everything `off`. No protected branches, no worktree
  requirement, staging mode `all`.
- **`standard`** — protected branches `main`/`master`, direct/force push
  and destructive branch ops `enforce`, everything else `advisory`,
  staging mode `tracked`.
- **`strict-worktree`** — protected branches `main`/`master`/`release/*`,
  full `enforce` on all protected-branch operations, worktree required,
  staging mode `explicit`, and automatic worktree removal after a
  verified merge (remote branch deletion stays `off` by default). This
  is the preset this repository intends to dogfood (advisory first,
  then enforcement — see the rollout section below).

## Resolution order and the weakening guard

`src/workflow/policy/resolve.ts`'s `resolveRule()` combines values from
multiple authorities into one resolved rule. Authorities, in ascending
priority: `built-in` → `preset` → `user-profile` → `repository` →
`invocation`.

This is **not** a naive last-source-wins merge. Each resolved rule
carries `{ value, mode, authority, weakening, confirmation? }`:

- **Strengthening** a rule (e.g. `advisory` → `enforce`) is always
  allowed, from any authority.
- **Weakening** a rule (e.g. `enforce` → `advisory`/`off`) is never
  permitted from `invocation` — an MCP tool call's ordinary arguments
  can never silently turn off a repository's `enforce` rule.
- Weakening an `enforce` rule from any other authority requires an
  explicit `humanApproval` record (`ConfirmationRecord`: who, when,
  optional evidence) attached to that source. Without it, the weakening
  attempt is dropped and the stronger rule stays in effect.
- `confirm` mode is represented the same way — a structured
  confirmation record, not a boolean an agent can self-assert.

This mirrors the human-approval-only posture already used by
`src/adaptive/policy.ts`'s routing-policy candidates (`pnpm run policy
approve` is the only path to activation) — no MCP tool should be able to
silently escalate its own permissions.

## `.mottainai/workflow.json`

`src/workflow/policy/load.ts` loads and validates a repository's tracked
policy file at `.mottainai/workflow.json`. Loading fails closed:

- A missing file returns a structured `{ ok: false, reason: "not-found" }`
  result (not an exception) — callers fall back to a built-in preset.
- Invalid JSON, an unsupported `schemaVersion`, or an unknown top-level
  key all return `{ ok: false, reason: "<diagnostic>" }` rather than
  being silently ignored or partially applied.

`.mottainai/` is gitignored as a whole *except* for `workflow.json`
(`.gitignore`: `.mottainai/*` plus `!.mottainai/workflow.json`), so the
tracked policy file can live alongside untracked scratch data (logs,
routing-policy candidates) without exposing it.

## Repository identity and state foundation

`src/workflow/domain/identity.ts` resolves a stable identity for the
Git repository at a given `cwd`, without relying on remote URL,
filesystem path, or branch name alone (all three change under moves,
mirrors, and case-insensitive filesystems):

- `rootCommitDigest` — a hash of the repository's root commit SHA(s).
  This is a hint value, not a globally unique identifier: two
  independently initialized repositories with identical content can
  produce the same root commit SHA if created at the same instant.
- `instanceId` — a UUID persisted in a marker file
  (`<git-common-dir>/mottainai-instance-id`), created on first
  resolution. Because the marker lives inside the Git common directory,
  it moves with the repository on disk, so `instanceId` stays stable
  across renames/moves. A corrupted marker file fails closed rather
  than silently re-minting an id.

`src/workflow/state/store.ts` defines `WorkflowStateStore`, a
repository-identity-scoped persistence interface separate from
`src/state/store.ts`'s session/read-evidence `StateStore`.
`src/workflow/state/sqlite-store.ts` implements it on the same SQLite
database and migration mechanism (`src/state/migrations.ts`,
`src/state/paths.ts`). `observeRepositoryInstance()` is the single
write path: it mints a globally unique `RepositorySourceId` the first
time a given `rootCommitDigest` is seen (reusing it on subsequent
observations, so root-commit-digest collisions never produce a
duplicate source), tracks canonicalized worktree paths per instance,
and reports whether an observation represents a detected move.

## What's not here yet

Protected-branch enforcement, task/worktree lifecycle, commit/push
operations, provider integration, cleanup, reconciliation, and MCP/CLI
exposure are separate child Issues under the Issue #28 Epic and land
incrementally. See Issue #28 for the full child-Issue sequence.

## Rollout status

Not yet dogfooded in this repository. Per Issue #28's own risk
guidance, `strict-worktree` will be adopted here only after an
`advisory`-mode observation period shows no destructive false
positives, then flipped to `enforce` rule by rule. Tracked as separate
child Issues once the full enforcement path (MCP/CLI exposure) exists.
