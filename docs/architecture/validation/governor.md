# Validation Governor (Issue #184, Phase 1)

The Validation Governor is a state-aware validation execution layer. It
reduces execution cost and model-visible output tokens by reusing a successful
validation only when it deterministically matches the same repository and
worktree state. Uncertainty always forces execution; speculative cache reuse is
not allowed.

The implementation is under `src/workflow/validation/`, the task-selector
entrypoint is `src/workflow/commands/check.ts`, and the MCP entrypoints are
`mottainai_workflow_check_run` and `mottainai_workflow_validation_receipt` in
`src/workflow/commands/mcp-tools.ts`.

## Design invariants

1. Mottainai optimizes validation execution but never weakens a required
   validation.
2. A reused PASS is attributed to a specific matching historical execution;
   the receipt retains its `runId` and `fingerprint`, together with the
   matching `provenance.reasonCode` and `provenance.explanation`.
3. If state or configuration cannot be established or does not match, the
   validation always runs. Uncertainty forces execution.
4. Raw stdout and stderr are not returned to the model on success. They are
   stored in bounded form in `ArtifactStore`; only bounded diagnostic lines are
   returned on failure.
5. Results never cross repository or worktree boundaries; `instance_id` and
   `worktree_id` isolate them.
6. FAILED records are never reused. A failure must never be silently converted
   into success, and an unchanged failure is rerun for confirmation.

## Components

| File | Responsibility |
| --- | --- |
| `src/workflow/validation/registry.ts` | Managed-check identity and configuration. Callers cannot supply arbitrary commands; `DEFAULT_MANAGED_CHECKS` (`lint`, `typecheck`, `test`, `build`, and `verify`) is the sole definition. |
| `src/workflow/validation/fingerprint.ts` | Conservative deterministic state fingerprint from HEAD, changed paths from `git status` filtered by declared `scope` globs, and blob hashes for `configPaths`. A Git failure returns `ok: false`, so callers always execute. |
| `src/workflow/validation/identity.ts` | `commandDigest` for command/args/cwd and `configDigest` incorporating Node, OS, declared environment, and declared configuration-file contents. |
| `src/workflow/validation/scope.ts` | Minimal glob matcher for `scope` (`*`, `**`, `?`). It performs only mechanical matching of declared literal patterns and never infers dependencies. |
| `src/workflow/validation/governor.ts` | `runManagedCheck` (execute or reuse) and read-only `assessManagedCheck`/`assessManagedChecks` (never starts a process). |
| `src/workflow/state/store.ts` / `sqlite-store.ts` | `check_runs` table (migration v13), isolated by `instance_id`, `worktree_id`, `check_id`, `state_fingerprint`, and `config_digest`; only `status='passed'` rows are reusable. |

## State fingerprint

Without a declared `scope` (the default), the entire worktree's changes are
included, which is the most conservative default. A scoped check includes only
changed paths matching its glob. The content digest of every changed path is
included, not only its name, so changing content always changes the fingerprint.
Declared `configPaths` such as `tsconfig.json` are always included regardless
of scope.

This is not the speculative dependency graph explicitly excluded by Issue
#184. It mechanically matches declared literal path patterns against `git
status` output and performs no semantic analysis or dependency inference.

## Receipt

`runManagedCheck` returns one of five `state` values:

- `executed-pass`: executed and succeeded;
- `executed-fail`: executed and failed, with bounded failure lines in
  `diagnostics` and a reference to the complete raw log in `artifactRef`;
- `reused-pass`: reused a matching successful execution without starting a
  process;
- `stale`: no matching evidence exists and execution is required; returned by
  read-only `assessManagedCheck`; or
- `not-required`: optional under repository policy and without current
  evidence; read-only result.

A successful receipt is a compact shape equivalent to
`{ check, status, execution, duration_ms, fingerprint }` and omits stdout and
stderr by default. An explicit `mottainai_result_get`-equivalent operation can
retrieve `artifactRef`.

`getWorkflowValidationReceipt`
(`mottainai_workflow_validation_receipt`) assesses multiple checks read-only
and returns `satisfied` and `requiredPending`. It never starts a process, so it
can determine whether a push is currently allowed without running validation.

## Integration with existing `validation_evidence`

The governor does not replace the `validation_evidence` table (migration v6)
trusted by the push gate in `src/workflow/git/push.ts`. When a managed check
declares `evidenceName` and the entire worktree is clean (`git status` is
empty), the governor bridges PASS/FAIL through `recordValidationEvidence`.
It does not write on a dirty worktree because `headCommit` might not represent
the tested content; the existing push-gate trust boundary remains unchanged.

## Benchmark and fixture

`pnpm run benchmark:validation-governor`
(`scripts/benchmark-validation-governor.mjs`) replays the Issue #184 session:
validation, an unrelated edit, another validation, a second unrelated edit,
another validation, a real code change, validation, full verify, and full
verify again before the PR. It compares a naive path that executes every time
and returns raw stdout to the governed path.

Representative observations from a temporary Git repository with deterministic
synthetic commands follow. The values depend on the execution environment,
but the execution and byte-reduction ratios are stable by construction.

```json
{
  "sessionSteps": 6,
  "totalNaiveExecutions": 6,
  "totalGovernedExecutions": 3,
  "executionReductionRatio": 0.5,
  "totalNaiveBytes": 107740,
  "totalGovernedBytes": 3940,
  "modelVisibleByteReductionRatio": 0.963
}
```

Three of six calls reuse a result without starting a process: two after
unrelated changes and one without a change. Model-visible bytes are reduced by
about 96%.
