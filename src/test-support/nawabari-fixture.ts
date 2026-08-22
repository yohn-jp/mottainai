import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { RunResult } from "../subprocess.js";
import { startNawabariTask } from "../workflow/domain/nawabari-task.js";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import type { WorkflowPolicyDocument } from "../workflow/policy/schema.js";
import type { TaskRecord, WorkflowStateStore } from "../workflow/state/store.js";
import { runGit } from "./tmp-git-repo.js";

/**
 * Real Nawabari session/claim ids are RFC 9562 UUIDs (session ids are
 * UUIDv7; see `nawabari`'s `session-id.ts`). The fixture must produce the
 * same shape so tests exercise the real id-validation boundary instead of a
 * fixture-only convenience format.
 */
export function fakeSessionId(sequence: number): string {
  const suffix = sequence.toString(16).padStart(12, "0");
  return `00000000-0000-7000-8000-${suffix}`;
}
function fakeClaimId(): string {
  return randomUUID();
}

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

export const FAKE_NAWABARI_COMMANDS = [
  "session create",
  "session id",
  "session show",
  "session inspect",
  "session list",
  "session claim",
  "session update",
  "session claims",
  "session close",
  "authorize",
  "checkpoint",
  "commit",
  "push",
  "gc",
];

export const FAKE_NAWABARI_CAPABILITIES = [
  {
    id: "resource-claims",
    commands: FAKE_NAWABARI_COMMANDS,
    claim_set_replacement: {
      commands: ["session update", "resource update"],
      atomic: true,
      pairing: "adjacent-resource-mode",
      idempotent_retry: true,
      unchanged_on_rejection: true,
    },
  },
];

/**
 * `nawabari` CLIを模したfake runner。#203以降Nawabariが管理worktreeの唯一の物理権限に
 * なったため、check/write系integrationテストが共通で必要とするsession create/show/claim等
 * を1箇所に集約する（各テストファイルへの複製を避ける）。
 */
export function fakeNawabari(
  repositoryRoot: string,
  options: {
    repository?: string;
    calls?: string[][];
    sessions?: Map<string, Record<string, unknown>>;
    claims?: Map<string, Record<string, unknown>[]>;
    currentSessionId?: string;
    failSessionList?: boolean;
    failSessionClaim?: boolean;
    beforeSessionClose?: () => void;
  } = {},
): NawabariExecutionClient {
  const calls = options.calls ?? [];
  const sessions = options.sessions ?? new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const claims = options.claims ?? new Map<string, Record<string, unknown>[]>();
  return new NawabariExecutionClient({
    runner: {
      async run(_command, args): Promise<RunResult> {
        calls.push([...args]);
        if (args[0] === "capabilities")
          return runResult(
            JSON.stringify({
              ok: true,
              command: "capabilities",
              schema_version: 1,
              contract_id: "nawabari.standalone-execution.v1",
              package_version: "0.6.1",
              capabilities: FAKE_NAWABARI_CAPABILITIES,
            }),
          );
        if (args[0] === "session" && args[1] === "id")
          return options.currentSessionId === undefined
            ? runResult(JSON.stringify({ ok: false, command: "session id", code: "NO_SESSION", message: "none" }), "", {
                exitCode: 3,
              })
            : runResult(JSON.stringify({ ok: true, command: "session id", session_id: options.currentSessionId }));
        if (args[0] === "session" && args[1] === "create") {
          const sessionId = fakeSessionId(++sequence);
          const branch = args[args.indexOf("--branch") + 1]!;
          const labelIndex = args.indexOf("--label");
          const label = labelIndex < 0 ? undefined : args[labelIndex + 1];
          const session = {
            ok: true,
            command: "session create",
            session_id: sessionId,
            repository: options.repository ?? path.join(repositoryRoot, ".git"),
            worktree: path.join(repositoryRoot, `.fake-worktree-${sessionId}`),
            branch,
            state: "active",
            ...(label === undefined ? {} : { label }),
          };
          sessions.set(sessionId, session);
          claims.set(sessionId, []);
          return runResult(JSON.stringify(session));
        }
        if (args[0] === "session" && args[1] === "list") {
          if (options.failSessionList)
            return runResult(
              JSON.stringify({ ok: false, command: "session list", code: "TEMPORARY_FAILURE", message: "unavailable" }),
              "",
              { exitCode: 3 },
            );
          return runResult(JSON.stringify({ ok: true, command: "session list", sessions: [...sessions.values()] }));
        }
        if (args[0] === "session" && args[1] === "show") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const session = sessions.get(sessionId);
          if (session === undefined)
            return runResult(
              JSON.stringify({ ok: false, command: "session show", code: "NOT_FOUND", message: "missing" }),
              "",
              {
                exitCode: 3,
              },
            );
          return runResult(JSON.stringify(session));
        }
        if (args[0] === "session" && args[1] === "inspect") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const session = sessions.get(sessionId);
          if (session === undefined)
            return runResult(
              JSON.stringify({ ok: false, command: "session inspect", code: "NOT_FOUND", message: "missing" }),
              "",
              {
                exitCode: 3,
              },
            );
          // Matches Nawabari 0.5.0's real session-diagnostic.v1 shape: identity
          // fields remain top-level while the authoritative state is nested under
          // `session` (the value is the live fixture record, so later state
          // changes are reflected here too).
          return runResult(
            JSON.stringify({
              ok: true,
              command: "session inspect",
              session_id: session.session_id,
              repository: session.repository,
              worktree: session.worktree,
              branch: session.branch,
              session,
              claims: [],
              physical_state: "healthy",
              close_readiness: "ready",
              cleanup_readiness: "not_due",
              result_state: "complete",
              idempotent: false,
              blockers: [],
              safe_actions: ["close-session"],
              integration_evidence: { supplied: false },
            }),
          );
        }
        if (args[0] === "session" && args[1] === "claims") {
          const sessionOption = args.indexOf("--session");
          const sessionId = sessionOption < 0 ? undefined : args[sessionOption + 1];
          const listed = sessionId === undefined ? [...claims.values()].flat() : (claims.get(sessionId) ?? []);
          return runResult(JSON.stringify({ ok: true, command: "session claims", claims: listed }));
        }
        if (args[0] === "session" && args[1] === "claim") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const resource = args[args.indexOf("--resource") + 1]!;
          const mode = args[args.indexOf("--mode") + 1]!;
          if (options.failSessionClaim)
            return runResult(
              JSON.stringify({ ok: false, command: "session claim", code: "CLAIM_FAILED", message: "injected" }),
              "",
              {
                exitCode: 3,
              },
            );
          const session = sessions.get(sessionId);
          if (session === undefined) throw new Error(`missing fake session: ${sessionId}`);
          const sessionClaims = claims.get(sessionId) ?? [];
          claims.set(sessionId, sessionClaims);
          const timestamp = new Date(sessionClaims.length).toISOString();
          const claim = {
            schema_version: 2,
            claim_id: fakeClaimId(),
            session_id: sessionId,
            repository: session.repository,
            worktree: session.worktree,
            resource,
            mode,
            created_at: timestamp,
            updated_at: timestamp,
          };
          sessionClaims.push(claim);
          return runResult(JSON.stringify({ ok: true, command: "session claim", ...claim }));
        }
        if (args[0] === "session" && args[1] === "close") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          options.beforeSessionClose?.();
          const session = sessions.get(sessionId);
          if (session === undefined)
            return runResult(
              JSON.stringify({ ok: false, command: "session close", code: "NOT_FOUND", message: "missing" }),
              "",
              { exitCode: 3 },
            );
          session.state = "closed";
          claims.set(sessionId, []);
          // Nawabari 0.5.0 session-close.v1 returns the authoritative SessionRecord
          // nested under `session`; keep the fixture contract-identical so a flat
          // parser cannot silently pass tests again.
          return runResult(
            JSON.stringify({
              ok: true,
              command: "session close",
              session,
              worktree_removed: true,
              branch_removed: true,
              idempotent: false,
            }),
          );
        }
        throw new Error(`unexpected fake Nawabari command: ${args.join(" ")}`);
      },
    },
  });
}

export interface NawabariManagedTaskFixture {
  store: WorkflowStateStore;
  nawabari: NawabariExecutionClient;
  task: TaskRecord;
  worktree: { canonicalPath: string; branchName: string };
}

/**
 * Nawabariが物理worktreeを所有する管理タスクを起動するfixture。legacy `startTask()` +
 * `store.attachNawabariSession()`を後付けする代わりに、本番と同じ`startNawabariTask()`
 * 経路でセッションを張り、実体を伴うgit worktreeへ`session.worktree`を差し替える
 * （fakeの`session create`はディスク上に何も作らないため）。
 */
export async function startNawabariManagedTask(
  t: TestContext,
  input: {
    root: string;
    store: WorkflowStateStore;
    policy: WorkflowPolicyDocument;
    taskSlug: string;
    branchType: string;
    issueRef: string;
  },
): Promise<NawabariManagedTaskFixture> {
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-nawabari-managed-"));
  const worktree = path.join(worktreeParent, "worktree");
  const branchName = `${input.branchType}/${input.issueRef}-${input.taskSlug}`;
  runGit(["worktree", "add", "--quiet", "-b", branchName, worktree, "HEAD"], input.root);
  t.after(() => {
    if (fs.existsSync(input.root)) runGit(["worktree", "remove", "--force", worktree], input.root);
    fs.rmSync(worktreeParent, { recursive: true, force: true });
  });

  const sessions = new Map<string, Record<string, unknown>>();
  const nawabari = fakeNawabari(input.root, { sessions });
  const started = await startNawabariTask({
    workspaceRoot: input.root,
    store: input.store,
    policy: input.policy,
    taskSlug: input.taskSlug,
    branchType: input.branchType,
    issueRef: input.issueRef,
    nawabari,
  });
  if (!started.ok) throw new Error(`Nawabari managed task fixture setup failed: ${JSON.stringify(started)}`);
  const session = sessions.get(started.execution.sessionId);
  if (session === undefined) throw new Error("fake Nawabari session missing after task start");
  session.worktree = worktree;

  return { store: input.store, nawabari, task: started.task, worktree: { canonicalPath: worktree, branchName } };
}
