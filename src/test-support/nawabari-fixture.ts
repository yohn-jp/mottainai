import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { RunResult } from "../subprocess.js";
import { startNawabariTask } from "../workflow/domain/nawabari-task.js";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import type { WorkflowPolicyDocument } from "../workflow/policy/schema.js";
import type { TaskRecord, WorkflowStateStore } from "../workflow/state/store.js";
import { runGit } from "./tmp-git-repo.js";

function runResult(stdout: string, stderr = "", overrides: Partial<RunResult> = {}): RunResult {
  return { stdout, stderr, exitCode: 0, signal: null, timedOut: false, outputLimit: false, ...overrides };
}

export const FAKE_NAWABARI_COMMANDS = [
  "session create",
  "session id",
  "session show",
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
    currentSessionId?: string;
    failSessionList?: boolean;
    failSessionClaim?: boolean;
    beforeSessionClose?: () => void;
  } = {},
): NawabariExecutionClient {
  const calls = options.calls ?? [];
  const sessions = options.sessions ?? new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const claims = new Map<string, Record<string, unknown>[]>();
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
              package_version: "0.4.1",
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
          const sessionId = `fake-session-${++sequence}`;
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
            return runResult(JSON.stringify({ ok: false, command: "session show", code: "NOT_FOUND", message: "missing" }), "", {
              exitCode: 3,
            });
          return runResult(JSON.stringify(session));
        }
        if (args[0] === "session" && args[1] === "claims") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          return runResult(JSON.stringify({ ok: true, command: "session claims", claims: claims.get(sessionId) ?? [] }));
        }
        if (args[0] === "session" && args[1] === "claim") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          const resource = args[args.indexOf("--resource") + 1]!;
          const mode = args[args.indexOf("--mode") + 1]!;
          if (options.failSessionClaim)
            return runResult(JSON.stringify({ ok: false, command: "session claim", code: "CLAIM_FAILED", message: "injected" }), "", {
              exitCode: 3,
            });
          const claim = { resource, mode };
          claims.get(sessionId)?.push(claim);
          return runResult(JSON.stringify({ ok: true, command: "session claim", session_id: sessionId, ...claim }));
        }
        if (args[0] === "session" && args[1] === "close") {
          const sessionId = args[args.indexOf("--session") + 1]!;
          options.beforeSessionClose?.();
          const session = sessions.get(sessionId);
          if (session !== undefined) session.state = "closed";
          return runResult(JSON.stringify({ ok: true, command: "session close", session_id: sessionId, state: "closed" }));
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
