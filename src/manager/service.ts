import crypto from "node:crypto";
import fs from "node:fs";
import { startTask } from "../workflow/domain/task.js";
import type {
  WorkflowStateStore,
  ManagerSessionId,
  ManagerSessionRecord,
  TaskId,
  WorktreeId,
} from "../workflow/state/store.js";
import { validateIssueRef, validateTaskSlug } from "../workflow/commands/validate.js";
import { resolveEffectiveWorkflowPolicy } from "../workflow/policy/load.js";
import { deriveZellijSessionName, ZellijRuntimeError, type ZellijRuntime } from "./zellij.js";

const MAX_INSTRUCTION_LENGTH = 64 * 1024;
const MAX_MODEL_LENGTH = 128;

export interface NewManagerSessionInput {
  instruction: string;
  agentKind?: string;
  model?: string;
  taskSlug?: string;
  issueRef?: string;
  branchType?: string;
}

export interface ManagerHealth {
  manager: "ready";
  workspaceRoot: string;
  zellij: { available: true; version: string };
}

export class ManagerError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "zellij_unavailable"
      | "runtime_name_collision"
      | "task_start_failed"
      | "session_not_found"
      | "session_not_running"
      | "runtime_error"
      | "worktree_missing",
    message: string,
    readonly statusCode = code === "session_not_found"
      ? 404
      : code === "runtime_name_collision" || code === "worktree_missing"
        ? 409
        : code === "zellij_unavailable"
          ? 503
          : 400,
  ) {
    super(message);
    this.name = "ManagerError";
  }
}

function invalid(message: string): ManagerError {
  return new ManagerError("invalid_request", message, 400);
}

function validateInstruction(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid("instruction is required");
  if (value.length > MAX_INSTRUCTION_LENGTH)
    throw invalid(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
  if (value.includes("\u0000")) throw invalid("instruction contains an unsupported NUL character");
  return value;
}

function validateOptionalArg(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000\u0001-\u001f\u007f]/u.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function managerError(error: unknown): ManagerError {
  if (error instanceof ManagerError) return error;
  if (error instanceof ZellijRuntimeError) {
    const status = error.code === "zellij_unavailable" ? 503 : error.code === "zellij_launch_failed" ? 502 : 500;
    return new ManagerError(
      error.code === "zellij_unavailable" ? "zellij_unavailable" : "runtime_error",
      error.message,
      status,
    );
  }
  return new ManagerError("runtime_error", error instanceof Error ? error.message : String(error), 500);
}

export class ManagerSessionService {
  private zellijVersion: string | undefined;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      store: WorkflowStateStore;
      runtime: ZellijRuntime;
      /** Hermetic process-test seam; production defaults to the Codex CLI. */
      agentCommand?: { command: string; baseArgs?: readonly string[] };
    },
  ) {}

  async initialize(): Promise<ManagerHealth> {
    try {
      const available = await this.options.runtime.checkAvailability();
      this.zellijVersion = available.version;
      await this.reconcile();
      return {
        manager: "ready",
        workspaceRoot: this.options.workspaceRoot,
        zellij: { available: true, version: available.version },
      };
    } catch (error) {
      throw managerError(error);
    }
  }

  health(): ManagerHealth {
    if (this.zellijVersion === undefined)
      throw new ManagerError("zellij_unavailable", "Zellij availability has not been established", 503);
    return {
      manager: "ready",
      workspaceRoot: this.options.workspaceRoot,
      zellij: { available: true, version: this.zellijVersion },
    };
  }

  async list(): Promise<ManagerSessionRecord[]> {
    await this.reconcile();
    return this.options.store.listManagerSessions(this.options.workspaceRoot);
  }

  async start(input: NewManagerSessionInput): Promise<ManagerSessionRecord> {
    if (input.agentKind !== undefined && input.agentKind !== "codex")
      throw invalid("only the codex agent is supported in Manager v0");
    const instruction = validateInstruction(input.instruction);
    const model = validateOptionalArg(input.model, "model", MAX_MODEL_LENGTH);
    const taskSlug = validateOptionalArg(input.taskSlug, "taskSlug", 96);
    const issueRef = validateOptionalArg(input.issueRef, "issueRef", 96);
    const branchType = validateOptionalArg(input.branchType, "branchType", 32) ?? "feat";
    try {
      if (taskSlug !== undefined) validateTaskSlug(taskSlug);
      validateIssueRef(issueRef);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    if (issueRef !== undefined && taskSlug === undefined)
      throw invalid("taskSlug is required when issueRef is provided");

    if (this.zellijVersion === undefined) {
      await this.initialize();
    }

    const sessionId = crypto.randomUUID() as ManagerSessionId;
    const runtimeName = deriveZellijSessionName(sessionId);
    let existingRuntime: Awaited<ReturnType<ZellijRuntime["inspect"]>>;
    try {
      existingRuntime = await this.options.runtime.inspect(runtimeName);
    } catch (error) {
      throw managerError(error);
    }
    if (existingRuntime !== "absent")
      throw new ManagerError("runtime_name_collision", `Zellij session name is already in use: ${runtimeName}`, 409);
    if (this.options.store.listManagerSessions(this.options.workspaceRoot).some((candidate) => candidate.runtimeName === runtimeName))
      throw new ManagerError("runtime_name_collision", `Mottainai runtime name is already recorded: ${runtimeName}`, 409);

    let taskId: TaskId | undefined;
    let worktreeId: WorktreeId | undefined;
    let worktreePath = this.options.workspaceRoot;
    let branchName: string | undefined;
    if (taskSlug !== undefined) {
      const policyResult = resolveEffectiveWorkflowPolicy(this.options.workspaceRoot);
      if (!policyResult.ok)
        throw new ManagerError("task_start_failed", `workflow policy is invalid: ${policyResult.reason}`, 409);
      const taskResult = await startTask({
        workspaceRoot: this.options.workspaceRoot,
        store: this.options.store,
        policy: policyResult.document,
        taskSlug,
        branchType,
        issueRef,
        idempotencyKey: sessionId,
      });
      if (!taskResult.ok) throw new ManagerError("task_start_failed", taskResult.detail, 409);
      taskId = taskResult.task.taskId;
      if (taskResult.worktree !== undefined) {
        worktreeId = taskResult.worktree.worktreeId;
        worktreePath = taskResult.worktree.canonicalPath;
        branchName = taskResult.worktree.branchName;
      }
    }

    const agentCommand = this.options.agentCommand ?? { command: "codex", baseArgs: [] };
    const launchArgs = [
      ...(agentCommand.baseArgs ?? []),
      ...(model === undefined ? [] : ["--model", model]),
      instruction,
    ];
    const session = this.options.store.createManagerSession({
      sessionId,
      workspaceRoot: this.options.workspaceRoot,
      taskId,
      worktreeId,
      worktreePath,
      branchName,
      agentKind: "codex",
      launchCommand: agentCommand.command,
      launchArgs,
      runtimeName,
    });
    if (!this.worktreeExists(worktreePath)) {
      const message = `managed worktree is missing or not a directory: ${worktreePath}`;
      this.options.store.updateManagerSession(sessionId, {
        lifecycleState: "failed",
        terminationState: "failed",
        errorMessage: message,
      });
      throw new ManagerError("worktree_missing", message, 409);
    }
    try {
      await this.options.runtime.start({
        sessionName: runtimeName,
        cwd: worktreePath,
        command: session.launchCommand,
        args: launchArgs,
      });
      return this.options.store.updateManagerSession(sessionId, {
        lifecycleState: "running",
        terminationState: "running",
      });
    } catch (error) {
      const failure = managerError(error);
      this.options.store.updateManagerSession(sessionId, {
        lifecycleState: "failed",
        terminationState: "failed",
        errorMessage: failure.message,
      });
      throw failure;
    }
  }

  async openTerminal(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    const session = await this.reconcileOne(this.requireSession(sessionId));
    if (session.lifecycleState !== "running")
      throw new ManagerError("session_not_running", `session is not running: ${sessionId}`, 409);
    if (!this.worktreeExists(session.worktreePath))
      throw new ManagerError(
        "worktree_missing",
        `managed worktree is missing or not a directory: ${session.worktreePath}`,
        409,
      );
    try {
      await this.options.runtime.attach(session.runtimeName, session.worktreePath);
      return session;
    } catch (error) {
      throw managerError(error);
    }
  }

  async stop(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    const session = await this.reconcileOne(this.requireSession(sessionId));
    if (session.lifecycleState !== "running" && session.lifecycleState !== "starting") return session;
    try {
      await this.options.runtime.terminate(
        session.runtimeName,
        this.worktreeExists(session.worktreePath) ? session.worktreePath : this.options.workspaceRoot,
      );
      return this.options.store.updateManagerSession(session.sessionId, {
        lifecycleState: "stopped",
        terminationState: "stopped",
      });
    } catch (error) {
      throw managerError(error);
    }
  }

  private requireSession(sessionId: ManagerSessionId): ManagerSessionRecord {
    const session = this.options.store.getManagerSession(sessionId);
    if (session === undefined || session.workspaceRoot !== this.options.workspaceRoot)
      throw new ManagerError("session_not_found", `manager session not found: ${sessionId}`);
    return session;
  }

  private async reconcileOne(session: ManagerSessionRecord): Promise<ManagerSessionRecord> {
    if (session.lifecycleState !== "starting" && session.lifecycleState !== "running") return session;
    if (!this.worktreeExists(session.worktreePath)) {
      await this.options.runtime.terminate(session.runtimeName, this.options.workspaceRoot).catch(() => undefined);
      return this.options.store.updateManagerSession(session.sessionId, {
        lifecycleState: "failed",
        terminationState: "failed",
        errorMessage: session.errorMessage ?? `managed worktree is missing or not a directory: ${session.worktreePath}`,
      });
    }
    const observed = await this.options.runtime.inspect(session.runtimeName, session.worktreePath);
    if (observed === "running") {
      if (session.lifecycleState === "starting")
        return this.options.store.updateManagerSession(session.sessionId, {
          lifecycleState: "running",
          terminationState: "running",
        });
      return session;
    }
    return this.options.store.updateManagerSession(session.sessionId, {
      lifecycleState: "exited",
      terminationState: "exited",
      errorMessage: session.errorMessage ?? "Zellij session is no longer running",
    });
  }

  private async reconcile(): Promise<void> {
    const sessions = this.options.store.listManagerSessions(this.options.workspaceRoot);
    for (const session of sessions) {
      await this.reconcileOne(session);
    }
  }

  private worktreeExists(worktreePath: string): boolean {
    try {
      return fs.statSync(worktreePath).isDirectory();
    } catch {
      return false;
    }
  }
}
