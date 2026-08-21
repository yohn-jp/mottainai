# Nawabari execution boundary

Mottainai is the semantic and task-orchestration authority. It owns
Repository Semantics, semantic impact, verification intent, task lifecycle,
provider/Issue/PR state, and agent-facing orchestration.

Nawabari is the sole local repository execution authority for managed tasks. A
compatible installation of `nawabari@0.5.0` or newer must advertise the
machine contract `nawabari.standalone-execution.v1` with schema version `1`,
including the `session-diagnostics` capability (`session inspect`) that
close reconciliation depends on.

```text
Mottainai task intent + Repository Semantics
        |
        | SemanticExecutionPlan -> concrete declaration
        v
Nawabari session / claims / Git execution / cleanup
        |
        | bounded JSON execution evidence
        v
Mottainai task and semantic reconciliation
```

The Mottainai plan may contain semantic targets, claim-generation provenance,
and verification intent. Only concrete branch/base/resource declarations cross
the Nawabari boundary. Nawabari never receives or interprets Symbols,
Components, Issues, task meaning, provider state, or verification policy.

Mottainai persists only an opaque `task -> nawabari_session_id` reference for
local execution. Session, worktree, branch, lock, and resource-claim records
remain in Nawabari's repository-local registry. Manager may retain a bounded
worktree path projection as a runtime launch directory, but does not reserve,
verify, mutate, or clean that resource itself. Legacy `worktrees` and
`cleanup_leases` rows, when present, are evidence only and are not a second
physical authority.

Manager launches use an explicit repository-wide `read` claim so multiple
control-plane sessions can start without silently claiming unknown write scope.
Semantic/task operations must declare concrete write claims before committing or
pushing; a read claim is never upgraded implicitly.

When semantic scope is incomplete, Mottainai records explicit provenance and
uses a repository-wide conservative claim (`**`), or blocks in strict mode. It
never guesses a narrower claim. Commit, push, checkpoint, and cleanup calls are
made through the installed JSON contract; the retired Mottainai mutation path
is not a fallback for managed tasks. Existing pre-cutover tasks without a
Nawabari reference are never silently adopted. Use the explicit `task
migrate-legacy` CLI command or `mottainai_workflow_task_migrate_legacy` MCP
tool. `complete` requires terminal task state and independently observed
absence of every legacy physical row and path. `adopt` requires an explicitly
named Nawabari session whose repository, worktree, branch, and active state
match the legacy record; ambiguous or unprovable identity fails closed. Neither
mode mutates a legacy worktree, branch, lease, or cleanup row. `workflow doctor`
labels any observed legacy physical rows as non-authoritative. Its default run
stays strictly read-only; only an explicit `--reconcile-closures` opt-in (CLI)
or `reconcileClosures: true` (MCP) also requests Nawabari's normal safe-close
for the caller's own prior merged executions.

The companion is discovered with `nawabari capabilities --json`. Mottainai does
not auto-install it. Missing, incompatible, malformed, timed-out, or rejected
capability results are surfaced as bounded diagnostics. Context, semantic
analysis, verification planning, and provider operations continue to work
without Nawabari; managed local repository mutation does not.

The source repository pins Nawabari 0.5.0 only as a development dependency for
hermetic contract and package tests. Published Mottainai packages do not install
the companion; operators install the compatible standalone executable explicitly.

Nawabari evidence is limited to Git-observable state at a checkpoint. Neither
product is an OS filesystem sandbox or an observer of direct writes that are
reverted or otherwise absent from Git's observable state.

Mottainai Issue #28 remains historical implementation evidence. Its local
physical execution modules are retained only for migration/reference reads and
tests; they are marked legacy and are not imported by the managed production
mutation entrypoints. Reconciliation never repairs those rows. They are not a
managed mutation fallback after this cutover.
