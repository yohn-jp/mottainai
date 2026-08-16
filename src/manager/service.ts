import crypto from "node:crypto";
import { NawabariExecutionClient } from "../workflow/nawabari.js";
import type {
  ManagerAgentKind,
  ManagerReconciliationState,
  ManagerRuntimeState,
  ManagerSessionId,
  ManagerSessionRecord,
  ManagerSessionReceipt,
  TaskId,
  WorkflowStateStore,
} from "../workflow/state/store.js";
import { validateIssueRef, validateTaskSlug } from "../workflow/commands/validate.js";
import {
  createNawabariManagerExecutionAuthority,
  type ManagerExecutionAuthority,
  type ManagerExecutionContext,
} from "../workflow/domain/manager-execution.js";
import { deriveZellijSessionName, ZellijRuntimeError, type ZellijObservedState, type ZellijRuntime } from "./zellij.js";

const MAX_INSTRUCTION_LENGTH = 64 * 1024;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 128;
const MAX_STATUS_LENGTH = 512;
const MAX_LIST_LIMIT = 500;
const ACTIVE_RUNTIME_STATES = ["starting", "running", "detached"] as const satisfies readonly ManagerRuntimeState[];
const RECENT_RUNTIME_STATES = [
  "exited",
  "failed",
  "stopped",
  "stale",
] as const satisfies readonly ManagerRuntimeState[];

function boundedStatus(value: string): string {
  return value.slice(0, MAX_STATUS_LENGTH);
}

export interface NewManagerSessionInput {
  instruction: string;
  agentKind?: string;
  /** Alias accepted by the API for clients that call the profile explicitly. */
  launchProfile?: string;
  provider?: string;
  model?: string;
  taskSlug?: string;
  issueRef?: string;
  branchType?: string;
  /** Stable operation identity used by the public task-run orchestration. */
  idempotencyKey?: string;
}

export interface ManagerLaunchInvocation {
  agentKind: ManagerAgentKind;
  command: string;
  args: string[];
}

export interface ManagerSessionFilter {
  runtimeState?: ManagerRuntimeState;
  agentKind?: ManagerAgentKind;
  semanticLifecycleState?: ManagerSessionRecord["semanticLifecycleState"];
  taskId?: TaskId;
  issueRef?: string;
  search?: string;
  limit?: number;
}

export interface ManagerHealth {
  manager: "ready";
  workspaceRoot: string;
  zellij: { available: true; version: string };
  sessions: { active: number; recent: number };
}

export class ManagerError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "zellij_unavailable"
      | "zellij_incompatible"
      | "runtime_name_collision"
      | "task_start_failed"
      | "session_not_found"
      | "session_not_running"
      | "session_not_attachable"
      | "session_restart_rejected"
      | "runtime_error"
      | "worktree_missing"
      | "execution_unresolved"
      | "idempotency_conflict",
    message: string,
    readonly statusCode = code === "session_not_found"
      ? 404
      : code === "runtime_name_collision" ||
          code === "worktree_missing" ||
          code === "session_restart_rejected" ||
          code === "idempotency_conflict"
        ? 409
        : code === "zellij_unavailable" || code === "zellij_incompatible"
          ? 503
          : 400,
  ) {
    super(boundedStatus(message));
    this.name = "ManagerError";
  }
}

function invalid(message: string): ManagerError {
  return new ManagerError("invalid_request", message, 400);
}

function idempotencyConflict(message: string): ManagerError {
  return new ManagerError("idempotency_conflict", message, 409);
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

function normalizeAgentKind(input: unknown): ManagerAgentKind {
  if (input === undefined || input === null || input === "" || input === "codex") return "codex";
  if (input === "claude" || input === "claude-code") return "claude";
  if (input === "pi") return "pi";
  throw invalid("agentKind must be codex, claude, or pi");
}

function managerError(error: unknown): ManagerError {
  if (error instanceof ManagerError) return error;
  if (error instanceof ZellijRuntimeError) {
    const status =
      error.code === "zellij_unavailable" || error.code === "zellij_incompatible"
        ? 503
        : error.code === "zellij_launch_failed"
          ? 502
          : 500;
    return new ManagerError(
      error.code === "zellij_unavailable"
        ? "zellij_unavailable"
        : error.code === "zellij_incompatible"
          ? "zellij_incompatible"
          : "runtime_error",
      error.message,
      status,
    );
  }
  return new ManagerError("runtime_error", boundedStatus(error instanceof Error ? error.message : String(error)), 500);
}

function receipt(code: string, message: string, source: ManagerSessionReceipt["source"]): ManagerSessionReceipt {
  return { code, message: message.slice(0, MAX_STATUS_LENGTH), source, recordedAt: Date.now() };
}

/**
 * Deterministic profile construction. Every user-controlled value remains an
 * argv element; no shell string is built or evaluated.
 */
export function buildManagerLaunchInvocation(input: {
  agentKind: ManagerAgentKind;
  provider?: string;
  model?: string;
  instruction: string;
  commands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
}): ManagerLaunchInvocation {
  const configured = input.commands?.[input.agentKind];
  const defaultProfile =
    input.agentKind === "claude"
      ? { command: "claude", baseArgs: [] }
      : input.agentKind === "pi"
        ? { command: "pi", baseArgs: [] }
        : { command: "codex", baseArgs: [] };
  const profileArgs =
    input.agentKind === "pi"
      ? [
          ...(input.provider === undefined ? [] : ["--provider", input.provider]),
          ...(input.model === undefined ? [] : ["--model", input.model]),
        ]
      : input.model === undefined
        ? []
        : ["--model", input.model];
  const profile = configured ?? defaultProfile;
  const args = [...(profile.baseArgs ?? []), ...profileArgs, "--", input.instruction];
  return { agentKind: input.agentKind, command: profile.command, args };
}

function runtimeStateForObservation(observed: ZellijObservedState): ManagerRuntimeState {
  if (observed === "absent" || observed === "unresolved") return "stale";
  return observed;
}

function lifecycleForRuntime(
  runtimeState: ManagerRuntimeState,
  current: ManagerSessionRecord["lifecycleState"],
): ManagerSessionRecord["lifecycleState"] {
  if (runtimeState === "running" || runtimeState === "detached") return "running";
  if (runtimeState === "starting") return "starting";
  if (runtimeState === "stopped") return "stopped";
  if (runtimeState === "failed") return "failed";
  // Keep the legacy lifecycle projection compatible while exposing stale as a
  // separate runtime state. A missing process is never semantic completion.
  if (runtimeState === "stale" || runtimeState === "exited") {
    if (current === "stopped" || current === "failed") return current;
    return "exited";
  }
  return current;
}

function isTerminalSemanticState(state: ManagerSessionRecord["semanticLifecycleState"]): boolean {
  return (
    state === "committed" ||
    state === "pushed" ||
    state === "pull-request-open" ||
    state === "merged" ||
    state === "abandoned" ||
    state === "cleaned"
  );
}

export class ManagerSessionService {
  private zellijVersion: string | undefined;
  private readonly execution: ManagerExecutionAuthority;
  private readonly sessionOperations = new Map<ManagerSessionId, Promise<void>>();

  private readonly options: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    runtime: ZellijRuntime;
    /** The sole local execution boundary used by task-bound Manager sessions. */
    nawabari: NawabariExecutionClient;
    /** Hermetic process-test seam; production defaults to the Codex/Claude CLIs. */
    agentCommand?: { command: string; baseArgs?: readonly string[] };
    agentCommands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
  };

  constructor(options: {
    workspaceRoot: string;
    store: WorkflowStateStore;
    runtime: ZellijRuntime;
    /** Optional injection seam; production and tests default to the installed contract client. */
    nawabari?: NawabariExecutionClient;
    /** Hermetic process-test seam; production defaults to the Codex/Claude CLIs. */
    agentCommand?: { command: string; baseArgs?: readonly string[] };
    agentCommands?: Partial<Record<ManagerAgentKind, { command: string; baseArgs?: readonly string[] }>>;
    /** Optional injection seam; production defaults to the Nawabari-backed adapter. */
    executionAuthority?: ManagerExecutionAuthority;
  }) {
    const nawabari = options.nawabari ?? new NawabariExecutionClient();
    this.options = { ...options, nawabari };
    this.execution =
      options.executionAuthority ??
      createNawabariManagerExecutionAuthority(options.store, options.workspaceRoot, nawabari);
  }

  async initialize(): Promise<ManagerHealth> {
    try {
      const available = await this.options.runtime.checkAvailability();
      this.zellijVersion = available.version;
      await this.reconcile();
      return this.health();
    } catch (error) {
      throw managerError(error);
    }
  }

  health(): ManagerHealth {
    if (this.zellijVersion === undefined)
      throw new ManagerError("zellij_unavailable", "Zellij availability has not been established", 503);
    const sessions = this.loadControlPlaneSessions();
    const active = sessions.filter(
      (session) =>
        session.runtimeState === "starting" ||
        session.runtimeState === "running" ||
        session.runtimeState === "detached",
    ).length;
    return {
      manager: "ready",
      workspaceRoot: this.options.workspaceRoot,
      zellij: { available: true, version: this.zellijVersion },
      sessions: { active, recent: sessions.length },
    };
  }

  async list(filter: ManagerSessionFilter = {}): Promise<ManagerSessionRecord[]> {
    await this.reconcile();
    return this.projectSessions(this.loadControlPlaneSessions(), filter);
  }

  private projectSessions(sessions: ManagerSessionRecord[], filter: ManagerSessionFilter): ManagerSessionRecord[] {
    const projected = sessions
      .filter((session) => filter.runtimeState === undefined || session.runtimeState === filter.runtimeState)
      .filter((session) => filter.agentKind === undefined || session.agentKind === filter.agentKind)
      .filter(
        (session) =>
          filter.semanticLifecycleState === undefined ||
          session.semanticLifecycleState === filter.semanticLifecycleState,
      )
      .filter((session) => filter.taskId === undefined || session.taskId === filter.taskId)
      .filter((session) => filter.issueRef === undefined || session.issueRef === filter.issueRef)
      .filter((session) => {
        if (filter.search === undefined || filter.search.trim().length === 0) return true;
        const needle = filter.search.trim().toLowerCase();
        return [
          session.sessionId,
          session.taskId,
          session.issueRef,
          session.branchName,
          session.runtimeName,
          session.latestStatus,
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle));
      });
    projected.sort((left, right) => {
      const leftActive =
        left.runtimeState === "starting" || left.runtimeState === "running" || left.runtimeState === "detached";
      const rightActive =
        right.runtimeState === "starting" || right.runtimeState === "running" || right.runtimeState === "detached";
      return (
        Number(rightActive) - Number(leftActive) ||
        right.startedAt - left.startedAt ||
        left.sessionId.localeCompare(right.sessionId)
      );
    });
    return projected.slice(0, Math.min(Math.max(Math.trunc(filter.limit ?? MAX_LIST_LIMIT), 1), MAX_LIST_LIMIT));
  }

  private loadControlPlaneSessions(): ManagerSessionRecord[] {
    const active = this.options.store.listManagerSessions(this.options.workspaceRoot, {
      limit: MAX_LIST_LIMIT,
      runtimeStates: ACTIVE_RUNTIME_STATES,
    });
    const recent = this.options.store.listManagerSessions(this.options.workspaceRoot, {
      limit: MAX_LIST_LIMIT,
      runtimeStates: RECENT_RUNTIME_STATES,
    });
    return [...active, ...recent];
  }

  async get(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, () => this.reconcileOneUnlocked(this.requireSession(sessionId)));
  }

  async start(input: NewManagerSessionInput): Promise<ManagerSessionRecord> {
    const agentKind = normalizeAgentKind(input.launchProfile ?? input.agentKind);
    const instruction = validateInstruction(input.instruction);
    const provider = validateOptionalArg(input.provider, "provider", MAX_PROVIDER_LENGTH);
    const model = validateOptionalArg(input.model, "model", MAX_MODEL_LENGTH);
    const taskSlug = validateOptionalArg(input.taskSlug, "taskSlug", 96);
    const issueRef = validateOptionalArg(input.issueRef, "issueRef", 96);
    const branchType = validateOptionalArg(input.branchType, "branchType", 32) ?? "feat";
    const idempotencyKey = validateOptionalArg(input.idempotencyKey, "idempotencyKey", 128);
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(idempotencyKey))
      throw invalid("idempotencyKey must be a bounded branch-safe token");
    try {
      if (taskSlug !== undefined) validateTaskSlug(taskSlug);
      validateIssueRef(issueRef);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    if (issueRef !== undefined && taskSlug === undefined)
      throw invalid("taskSlug is required when issueRef is provided");
    if (provider !== undefined && agentKind !== "pi") throw invalid("provider is only supported by the pi profile");

    if (this.zellijVersion === undefined) await this.initialize();
    if (idempotencyKey !== undefined) {
      const existing = this.options.store
        .listManagerSessions(this.options.workspaceRoot)
        .find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.agentKind !== agentKind ||
          existing.provider !== provider ||
          existing.model !== model ||
          existing.instruction !== instruction ||
          existing.taskSlug !== taskSlug ||
          existing.issueRef !== issueRef ||
          (existing.branchType ?? "feat") !== branchType
        ) {
          throw idempotencyConflict(`idempotency key is already bound to manager session ${existing.sessionId}`);
        }
        return this.resumeIdempotentSession(existing.sessionId);
      }
    }
    const sessionId = crypto.randomUUID() as ManagerSessionId;
    const runtimeName = deriveZellijSessionName(sessionId);
    return this.withSessionOperation(sessionId, async () => {
      let existingRuntime: ZellijObservedState;
      try {
        existingRuntime = await this.options.runtime.inspect(runtimeName);
      } catch (error) {
        throw managerError(error);
      }
      if (existingRuntime !== "absent")
        throw new ManagerError("runtime_name_collision", `Zellij session name is already in use: ${runtimeName}`, 409);
      if (
        this.options.store
          .listManagerSessions(this.options.workspaceRoot)
          .some((candidate) => candidate.runtimeName === runtimeName)
      )
        throw new ManagerError(
          "runtime_name_collision",
          `Mottainai runtime name is already recorded: ${runtimeName}`,
          409,
        );

      let executionContext: ManagerExecutionContext;
      let executionReceipt: ManagerSessionReceipt | undefined;
      try {
        const execution = await this.execution.start({
          workspaceRoot: this.options.workspaceRoot,
          store: this.options.store,
          taskSlug,
          issueRef,
          branchType,
          idempotencyKey: idempotencyKey ?? sessionId,
        });
        executionContext = execution.context;
        executionReceipt = execution.receipt;
      } catch (error) {
        throw new ManagerError("task_start_failed", error instanceof Error ? error.message : String(error), 409);
      }

      const invocation = buildManagerLaunchInvocation({
        agentKind,
        provider,
        model,
        instruction,
        commands: {
          ...(this.options.agentCommands ?? {}),
          ...(this.options.agentCommand === undefined ? {} : { codex: this.options.agentCommand }),
        },
      });
      try {
        this.options.store.createManagerSession({
          sessionId,
          workspaceRoot: this.options.workspaceRoot,
          idempotencyKey,
          taskId: executionContext.taskId,
          executionSessionId: executionContext.executionSessionId,
          executionMode: executionContext.taskId === undefined ? "workspace" : "task-bound",
          worktreeId: executionContext.worktreeId,
          worktreePath: executionContext.worktreePath,
          branchName: executionContext.branchName,
          taskSlug: executionContext.taskSlug,
          issueRef: executionContext.issueRef,
          branchType: executionContext.branchType,
          agentKind,
          launchProfile: agentKind,
          instruction,
          provider,
          model,
          launchCommand: invocation.command,
          launchArgs: invocation.args,
          runtimeName,
          semanticLifecycleState: executionContext.semanticLifecycleState,
          latestStatus: "execution context acquired; launching agent runtime",
          latestReceipt: executionReceipt,
        });
      } catch (error) {
        // A concurrent retry may have persisted the same Manager record while
        // this process was acquiring the execution context. Reconcile that
        // record instead of creating a second runtime or surfacing a duplicate
        // operation as an unrelated database failure.
        if (idempotencyKey !== undefined) {
          const existing = this.options.store
            .listManagerSessions(this.options.workspaceRoot)
            .find((candidate) => candidate.idempotencyKey === idempotencyKey);
          if (existing !== undefined) return this.resumeIdempotentSession(existing.sessionId);
        }
        throw error;
      }
      const validation = await this.execution.validate(executionContext);
      if (!validation.ok) {
        const detail = validation.detail.slice(0, MAX_STATUS_LENGTH);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          reconciliationState: "unresolved",
          reconciliationMessage: detail,
          latestStatus: detail,
          latestReceipt: receipt("execution_unavailable", detail, "workflow"),
          terminationState: "failed",
          errorMessage: detail,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw new ManagerError("worktree_missing", detail, 409);
      }
      try {
        await this.options.runtime.start({
          sessionName: runtimeName,
          cwd: executionContext.worktreePath,
          command: invocation.command,
          args: invocation.args,
        });
        return this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "running",
          runtimeState: "running",
          attachable: true,
          reconciliationState: "synced",
          latestStatus: `${agentKind} runtime started in managed execution context`,
          latestReceipt: receipt("runtime_started", `${agentKind} runtime started`, "runtime"),
          terminationState: "running",
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        const failure = managerError(error);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          attachable: false,
          reconciliationState: "drifted",
          reconciliationMessage: failure.message,
          latestStatus: failure.message,
          latestReceipt: receipt("runtime_start_failed", failure.message, "zellij"),
          terminationState: "failed",
          errorMessage: failure.message,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw failure;
      }
    });
  }

  async openTerminal(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const session = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (session.runtimeState !== "running" && session.runtimeState !== "detached")
        throw new ManagerError("session_not_running", `session is not running: ${sessionId}`, 409);
      if (!session.attachable)
        throw new ManagerError("session_not_attachable", `session is not attachable: ${sessionId}`, 409);
      try {
        await this.options.runtime.attach(session.runtimeName, session.worktreePath);
        return this.options.store.updateManagerSession(sessionId, {
          latestStatus: "selected Zellij session opened",
          latestReceipt: receipt("runtime_attached", "selected Zellij session opened", "zellij"),
          reconciliationState: "synced",
          reconciliationMessage: null,
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        throw managerError(error);
      }
    });
  }

  async stop(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const session = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (
        session.runtimeState !== "running" &&
        session.runtimeState !== "detached" &&
        session.runtimeState !== "starting"
      )
        return session;
      try {
        const observed = await this.options.runtime.inspect(session.runtimeName, session.worktreePath);
        if (observed !== "running" && observed !== "detached" && observed !== "exited") {
          return this.options.store.updateManagerSession(session.sessionId, {
            runtimeState: "stale",
            attachable: false,
            reconciliationState: "unresolved",
            reconciliationMessage: `refusing to stop selected runtime because its identity is ${observed}`,
            latestStatus: `refusing to stop selected runtime because its identity is ${observed}`,
            latestReceipt: receipt(
              "runtime_stop_rejected",
              `refusing to stop selected runtime because its identity is ${observed}`,
              "zellij",
            ),
            runtimeObservedAt: Date.now(),
          });
        }
        await this.options.runtime.terminate(session.runtimeName, session.worktreePath);
        const now = Date.now();
        return this.options.store.updateManagerSession(session.sessionId, {
          lifecycleState: "stopped",
          runtimeState: "stopped",
          attachable: false,
          terminationState: "stopped",
          finishedAt: now,
          runtimeObservedAt: now,
          latestStatus: "selected managed runtime stopped",
          latestReceipt: receipt("runtime_stopped", "selected managed runtime stopped", "zellij"),
          reconciliationState: "synced",
          reconciliationMessage: null,
        });
      } catch (error) {
        throw managerError(error);
      }
    });
  }

  async restart(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    return this.withSessionOperation(sessionId, async () => {
      const current = await this.reconcileOneUnlocked(this.requireSession(sessionId));
      if (isTerminalSemanticState(current.semanticLifecycleState)) {
        throw new ManagerError(
          "session_restart_rejected",
          `cannot restart a session whose semantic task lifecycle is ${current.semanticLifecycleState}`,
          409,
        );
      }
      if (
        current.runtimeState === "running" ||
        current.runtimeState === "detached" ||
        current.runtimeState === "starting"
      ) {
        throw new ManagerError(
          "session_restart_rejected",
          "restart is only valid for a non-running managed runtime",
          409,
        );
      }
      if (current.runtimeState === "stale") {
        const observed = await this.options.runtime.inspect(current.runtimeName, current.worktreePath);
        if (observed !== "absent") {
          throw new ManagerError(
            "session_restart_rejected",
            `cannot restart because the managed Zellij identity is ${observed}; no unrelated session will be adopted`,
            409,
          );
        }
      }
      const context = this.contextFromRecord(current);
      const validation = await this.execution.validate(context);
      if (!validation.ok) throw new ManagerError("execution_unresolved", validation.detail, 409);
      const restartCount = current.restartCount + 1;
      const started = this.options.store.updateManagerSession(current.sessionId, {
        lifecycleState: "starting",
        runtimeState: "starting",
        attachable: false,
        reconciliationState: "drifted",
        reconciliationMessage: "restart requested for the selected managed runtime",
        latestStatus: "relaunching selected agent runtime",
        latestReceipt: receipt("runtime_restart_requested", "relaunching selected agent runtime", "manager"),
        restartCount,
        terminationState: "running",
        errorMessage: null,
        finishedAt: null,
        exitCode: null,
        runtimeObservedAt: Date.now(),
      });
      try {
        if (current.runtimeState === "exited")
          await this.options.runtime.terminate(current.runtimeName, current.worktreePath).catch(() => undefined);
        await this.options.runtime.start({
          sessionName: started.runtimeName,
          cwd: started.worktreePath,
          command: started.launchCommand,
          args: started.launchArgs,
        });
        return this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "running",
          runtimeState: "running",
          attachable: true,
          reconciliationState: "synced",
          reconciliationMessage: null,
          latestStatus: "agent runtime relaunched in the existing execution context",
          latestReceipt: receipt("runtime_restarted", "agent runtime relaunched", "runtime"),
          terminationState: "running",
          runtimeObservedAt: Date.now(),
        });
      } catch (error) {
        const failure = managerError(error);
        this.options.store.updateManagerSession(sessionId, {
          lifecycleState: "failed",
          runtimeState: "failed",
          attachable: false,
          reconciliationState: "drifted",
          reconciliationMessage: failure.message,
          latestStatus: failure.message,
          latestReceipt: receipt("runtime_restart_failed", failure.message, "zellij"),
          terminationState: "failed",
          errorMessage: failure.message,
          finishedAt: Date.now(),
          runtimeObservedAt: Date.now(),
        });
        throw failure;
      }
    });
  }

  async reconcileNow(): Promise<ManagerSessionRecord[]> {
    await this.reconcile();
    return this.projectSessions(this.loadControlPlaneSessions(), {});
  }

  private requireSession(sessionId: ManagerSessionId): ManagerSessionRecord {
    const session = this.options.store.getManagerSession(sessionId);
    if (session === undefined || session.workspaceRoot !== this.options.workspaceRoot)
      throw new ManagerError("session_not_found", `manager session not found: ${sessionId}`);
    return session;
  }

  /** Reconcile and, when safe, resume one previously persisted task-run. */
  private async resumeIdempotentSession(sessionId: ManagerSessionId): Promise<ManagerSessionRecord> {
    const current = await this.get(sessionId);
    if (
      current.runtimeState === "starting" ||
      current.runtimeState === "running" ||
      current.runtimeState === "detached"
    ) {
      return current;
    }
    if (isTerminalSemanticState(current.semanticLifecycleState)) return current;
    return this.restart(sessionId);
  }

  private contextFromRecord(session: ManagerSessionRecord): ManagerExecutionContext {
    return {
      taskId: session.taskId,
      executionSessionId: session.executionSessionId,
      worktreeId: session.worktreeId,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      taskSlug: session.taskSlug,
      issueRef: session.issueRef,
      branchType: session.branchType,
      semanticLifecycleState: session.semanticLifecycleState,
    };
  }

  private async reconcileOneUnlocked(session: ManagerSessionRecord): Promise<ManagerSessionRecord> {
    let semantic = session.semanticLifecycleState;
    let status = session.latestStatus;
    let semanticReceipt = session.latestReceipt;
    try {
      const observed = await this.execution.observe(this.contextFromRecord(session));
      semantic = observed.semanticLifecycleState;
      status = observed.status === undefined ? status : boundedStatus(observed.status);
      semanticReceipt = observed.receipt ?? semanticReceipt;
    } catch (error) {
      status = `workflow observation failed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        MAX_STATUS_LENGTH,
      );
      semanticReceipt = receipt("workflow_observation_failed", status, "workflow");
    }

    // Runtime-terminal records still observe workflow semantics so restart
    // decisions cannot use a stale pre-completion task lifecycle.
    if (session.lifecycleState === "failed" || session.lifecycleState === "stopped") {
      return this.options.store.updateManagerSession(session.sessionId, {
        semanticLifecycleState: semantic,
        latestStatus: status,
        ...(semanticReceipt === undefined ? {} : { latestReceipt: semanticReceipt }),
        runtimeObservedAt: Date.now(),
      });
    }

    const validation = await this.execution.validate(
      this.contextFromRecord({ ...session, semanticLifecycleState: semantic }),
    );
    if (!validation.ok) {
      const now = Date.now();
      const detail = boundedStatus(validation.detail);
      const observed = await this.options.runtime
        .inspect(session.runtimeName, session.worktreePath)
        .catch(() => "unresolved" as const);
      if (observed === "running" || observed === "detached") {
        await this.options.runtime.terminate(session.runtimeName, session.worktreePath).catch(() => undefined);
      }
      return this.options.store.updateManagerSession(session.sessionId, {
        lifecycleState: "failed",
        runtimeState: "stale",
        semanticLifecycleState: semantic,
        attachable: false,
        reconciliationState: "unresolved",
        reconciliationMessage: detail,
        latestStatus: detail,
        latestReceipt: receipt("execution_unresolved", detail, "workflow"),
        finishedAt: session.finishedAt ?? now,
        runtimeObservedAt: now,
        terminationState: "failed",
        errorMessage: session.errorMessage ?? detail,
      });
    }

    let observed: ZellijObservedState;
    try {
      observed = await this.options.runtime.inspect(session.runtimeName, session.worktreePath);
    } catch (error) {
      const detail = boundedStatus(error instanceof Error ? error.message : String(error));
      return this.options.store.updateManagerSession(session.sessionId, {
        runtimeState: "stale",
        semanticLifecycleState: semantic,
        attachable: false,
        reconciliationState: "unresolved",
        reconciliationMessage: detail,
        latestStatus: detail,
        latestReceipt: receipt("runtime_inspection_failed", detail, "zellij"),
        runtimeObservedAt: Date.now(),
      });
    }
    const runtimeState =
      observed === "absent" && session.runtimeState === "exited" ? "exited" : runtimeStateForObservation(observed);
    const now = Date.now();
    const attachable = runtimeState === "running" || runtimeState === "detached";
    const stale = runtimeState === "stale";
    const nextLifecycle = lifecycleForRuntime(runtimeState, session.lifecycleState);
    const detail =
      stale && observed === "unresolved"
        ? "managed Zellij runtime identity is unresolved; no unrelated session was adopted"
        : stale
          ? "managed Zellij session is missing; no unrelated session was adopted"
          : runtimeState === "exited"
            ? "managed Zellij agent pane exited; semantic task completion was not inferred"
            : runtimeState === "detached"
              ? "managed Zellij session is detached and attachable"
              : `managed Zellij session is ${runtimeState}`;
    const nextReceipt =
      stale || runtimeState === "exited" || runtimeState === "detached"
        ? receipt(
            stale ? "runtime_stale" : runtimeState === "exited" ? "runtime_exited" : "runtime_detached",
            detail,
            "zellij",
          )
        : semanticReceipt;
    return this.options.store.updateManagerSession(session.sessionId, {
      lifecycleState: nextLifecycle,
      runtimeState,
      semanticLifecycleState: semantic,
      attachable,
      reconciliationState: stale ? "unresolved" : runtimeState === "exited" ? "drifted" : "synced",
      reconciliationMessage: stale ? detail : null,
      latestStatus: status ?? detail,
      latestReceipt: nextReceipt,
      finishedAt: runtimeState === "exited" || runtimeState === "stale" ? (session.finishedAt ?? now) : null,
      runtimeObservedAt: now,
      terminationState:
        runtimeState === "running" || runtimeState === "detached"
          ? "running"
          : runtimeState === "stopped"
            ? "stopped"
            : runtimeState === "failed"
              ? "failed"
              : "exited",
      errorMessage: stale ? (session.errorMessage ?? detail) : runtimeState === "exited" ? session.errorMessage : null,
    });
  }

  private async reconcile(): Promise<void> {
    const sessions = this.loadControlPlaneSessions();
    for (const session of sessions) {
      await this.withSessionOperation(session.sessionId, () =>
        this.reconcileOneUnlocked(this.requireSession(session.sessionId)),
      );
    }
  }

  private async withSessionOperation<T>(sessionId: ManagerSessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.sessionOperations.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(sessionId) === tail) this.sessionOperations.delete(sessionId);
    }
  }
}
