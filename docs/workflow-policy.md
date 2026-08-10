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

- `rootCommitDigest` — a hash of the root commit SHA(s) reachable from
  any ref (`git rev-list --max-parents=0 --all`, not just `HEAD`, so
  switching branches or adding an orphan branch doesn't change the
  digest of an already-known repository). This is a hint value, not a
  globally unique identifier: two independently initialized
  repositories with identical content can produce the same root commit
  SHA if created at the same instant.
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

### Canonical task worktrees (Issue #102)

`mottainai_workflow_task_start` resolves the repository control-plane root
from the canonical Git common-dir, not from `workspaceRoot`, caller cwd, or
the current linked worktree. Managed task worktrees are always created below
`<canonical repository root>/.mottainai/worktrees/`; the same resolved
absolute path is used by collision detection, SQLite reservation, and
`git worktree add`. Ambiguous common-dir layouts fail closed. The legacy
`.worktrees` path is not a task-workflow fallback.

The task-start input supplies `branchType` explicitly. The candidate is
projected as `<type>/<issue>-<slug>` and validated through the existing
`scripts/governance-lib.mjs` API backed by `scripts/governance-rules.json`.
Branch validation runs before worktree-path collision checks, SQLite task or
worktree reservation, and Git mutation; a rejected candidate leaves no task
or worktree reservation.

## Protected-branch and control-plane decisions

`src/workflow/policy/protected-branch.ts` decides whether a given
`(policy, branch, operation, repository role)` combination is allowed.
It does not execute or intercept any Git operation itself — see
"What's not here yet" below.

- `matchesProtectedBranch()` matches a branch name against
  `protectedBranches` glob patterns (`*` is the only wildcard; every
  other character, including regex metacharacters, is literal).
- `decideProtectedBranchOperation()` combines two independent gates:
  1. **control-plane role** — when `controlPlaneRole` is
     `"primary-checkout"` and the caller is on the primary checkout
     (not a linked worktree), `sourceWrite`/`stage`/`commit` are denied
     regardless of branch (the primary checkout is repo-sync/worktree
     management only). Repo-sync/worktree-management operations remain
     allowed.
  2. **protected-branch rule** — if the branch matches
     `protectedBranches`, the operation's `protectedBranchRule` mode
     decides: `off`/`advisory` allow, `enforce`/`confirm` deny.
  Detached HEAD (no branch name) is treated as unprotected for this
  gate, not silently permissive by accident — the decision result
  records why (`reason: "detached-head-treated-as-unprotected"`).

`src/workflow/domain/repo-state.ts` resolves ambiguous repository
states explicitly instead of letting them fall through as ordinary
branch checkouts: `bare-repository`, `submodule`, `detached-head`,
`unborn-branch`, and `linked-worktree` each get a structured
`{ kind, supported, reason }`, plus `isPrimaryCheckout` (derived from
whether `--git-dir` and `--git-common-dir` agree) for the
control-plane gate above.

`src/workflow/git/hooks.ts` generates `pre-commit`/`pre-push` shell
scripts that re-implement the same glob-match-plus-rule-mode logic
independently in POSIX `sh` as defense-in-depth (the TypeScript
implementation isn't invoked directly from a hook). The scripts parse
`.mottainai/workflow.json` via `node -e`, since `git` alone can't parse
JSON safely; if `node` isn't on `PATH` (common in GUI Git clients or
minimal launchd/systemd environments), the hook fails closed — it
blocks the operation with a diagnostic rather than silently letting it
through. Branch-name glob matching mirrors
`protected-branch.ts`'s `patternToRegExp` exactly: patterns are split
on `*`, each literal segment is escaped with the same character set
(``. + ? ^ $ { } ( ) | [ ] \``), and segments are rejoined with `.*`.
The `pre-push` hook classifies each updated ref independently: a
ref deletion (all-zero local SHA, matched without hardcoding a SHA-1
vs. SHA-256 length) is gated by `destructiveBranchOp`; a non-fast-forward
update is gated by `forcePush`; anything else is gated by `directPush`.

It also exposes `detectHookBypass(cwd, branch, checkpointCommit)`,
which resolves the requested `branch`'s own tip (`refs/heads/<branch>`,
not `HEAD` — a caller may be checking one branch's checkpoint from a
different checkout) and compares a recorded checkpoint commit (from
the new `hook_checkpoints` table, `src/state/migrations.ts` version 3)
against that tip via `git merge-base --is-ancestor`. If the checkpoint
isn't an ancestor of the tip, something changed the branch without
going through a hook-mediated commit (`--no-verify`, history rewrite,
or a client that doesn't run hooks at all). Failure to resolve the
requested branch's tip throws rather than reporting a false
divergence.

## What's not here yet

This Issue (#32) provides the decision API, hook generation, and
repository-state detection only — **not enforced write-path
interception**. Generated hooks only intercept `git commit`/`git
push`; they cannot stop a plain editor write to a file on `main`, and
they can be bypassed with `--no-verify` or from hook-unaware clients.
Actual enforcement over Mottainai's own write/edit tools — wiring every
managed write path through `decideProtectedBranchOperation()` before
it runs — lands in the MCP/CLI exposure child Issue (9a-2). Full
reconciliation reporting of detected hook-bypass events is Child Issue
8.

Task/worktree lifecycle, commit/push execution, provider integration,
cleanup, and reconciliation remain separate child Issues under the
Issue #28 Epic and land incrementally. See Issue #28 for the full
child-Issue sequence.

Issue #34 added a thin, early-dogfooding MCP/CLI exposure of three
gated workflow operations — `policy explain` (read-only), `task
start` (creates a dedicated worktree/branch), `task status`
(read-only) (`src/workflow/commands/mcp-tools.ts`, gated by
`gateway.workflowTasks`) — ahead of the full exposure in Child Issue
9a-1/9a-2. `policy explain` resolves only the genuine `RuleMode`
fields (`protectedBranchRule.*` / `worktree.{required,issueRequired,
multipleActiveTasksPerIssue,multipleWorktreesPerTask,staleBaseBranch}`
/ `cleanup.*`) through `resolveRule()`; `protectedBranches`,
`controlPlaneRole`, `stagingMode`, and `worktree.bootstrapMode` are
returned as plain descriptive values since the schema has no
associated mode for them yet. `task start`/`task status` still consult
the effective policy document directly (`resolveEffectiveWorkflowPolicy`),
not the authority-resolved view `policy explain` shows — the
resolution/weakening-guard engine is not yet wired into task-start
enforcement itself. Full write-path enforcement remains Child Issue
9a-2.

## Rollout status

Issue #41 starts repository dogfooding with the tracked
`.mottainai/workflow.json`. It declares the `strict-worktree` preset, but
sets every schema `RuleMode` in the repository document and its
`effectivePolicy` projection to `advisory`; no repository rule is set to
`enforce`.
`controlPlaneRole` is `any` during this observation period because
`primary-checkout` unconditionally denies source changes outside the
RuleMode matrix and would therefore violate the advisory-only rollout.
The strict preset's protected-branch patterns, explicit staging, and
conditional bootstrap remain declared for observation.

`policy explain` also exposes the authority-resolved `rules` and
`resolvedPolicy` projections. Those projections intentionally retain a
preset's stronger mode when the repository has no human-approval record for
weakening it; this is provenance, not an enforcement enablement. Workflow
operations consume the repository `effectivePolicy` document for this
rollout.

The advisory baseline is recorded at the start of this rollout:

- Observation start: 2026-08-10, base revision `b2c7038`.
- Configuration digest: SHA-256
  `97ab684cdeea2bae225a04b75bce35e0f5de549dba119387036cf974daa960ce`.
- `policy explain` baseline: `preset=strict-worktree`,
  `policySourceAuthority=repository`, and every `effectivePolicy` RuleMode
  is `advisory`.
- Initial event counts: zero recorded violations, false positives, or
  blocked operations; this is an observation-start baseline, not evidence
  that the window is clean.
- A clean window means at least 14 consecutive days and 10 pull requests
  with zero unexpected denials or destructive false positives, with every
  advisory event either explained or tracked to a follow-up Issue.

Enforcement remains disabled. The baseline and subsequent audit/metrics
observations must be reviewed before any rule is strengthened. #42 remains
evidence-gated and is the only follow-up for an eventual `enforce` rollout.
