import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EXECUTION_PROFILE_SCHEMA_VERSION } from "tsukai";
import type { ExecutionProfile, ExecutionProfileTool, PiRunRequest, RunOperations, RunSnapshot } from "tsukai";
import type { ExecutionManifest } from "../workflow/domain/execution-manifest.js";
import type { ManagerSessionId, ManagerSessionRecord, WorkflowStateStore } from "../workflow/state/store.js";

/**
 * Manager-owned seam onto the released Tsukai AgentRun API.
 *
 * Mottainai decides orchestration policy (what to run, with which admitted
 * intent, under which idempotent start key) and records only the opaque
 * Tsukai `agentRunId`. Tsukai owns AgentRun identity and lifecycle; Jinushi
 * (behind Tsukai's execution port) owns the physical process; Nawabari owns
 * the workspace this seam forwards unchanged.
 */

/** Stable id of the managed Pi guard inside the Tsukai execution profile. */
export const TSUKAI_GUARD_EXTENSION_ID = "mottainai-pi-guard" as const;
/** Run metadata keys that let a restarted Manager find a run it created. */
export const TSUKAI_START_KEY_METADATA = "mottainaiStartKey" as const;
export const TSUKAI_MANAGER_SESSION_METADATA = "mottainaiManagerSessionId" as const;

const LIST_PAGE_LIMIT = 100;

export type TsukaiRunOperations = Pick<RunOperations<PiRunRequest, "pi">, "create" | "get" | "list">;

/** Admitted tool policy. Nothing is defaulted: an empty builtin list admits no built-in tools. */
export interface TsukaiToolIntent {
  readonly builtin: readonly string[];
  /** Extra admitted extensions beyond the managed guard. */
  readonly extensions?: readonly { readonly id: string; readonly path: string }[];
  /** Custom tools, each registered by a declared extension (including the guard). */
  readonly customTools?: readonly { readonly extension: string; readonly name: string }[];
}

export interface TsukaiExecutionIntent {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  /** Validated managed Pi guard asset; always composed, never optional. */
  readonly guardPath: string;
  readonly tools: TsukaiToolIntent;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Translate admitted Mottainai intent into the Tsukai M5.5 execution profile. */
export function tsukaiExecutionProfile(intent: TsukaiExecutionIntent): ExecutionProfile {
  const extensions = [
    { id: TSUKAI_GUARD_EXTENSION_ID, path: intent.guardPath },
    ...(intent.tools.extensions ?? []),
  ].map((extension) => {
    if (!path.isAbsolute(extension.path)) throw new Error(`extension ${extension.id} path must be absolute`);
    const resolved = path.resolve(extension.path);
    return { id: extension.id, path: resolved, sha256: sha256File(resolved) };
  });
  const tools: ExecutionProfileTool[] = [
    ...intent.tools.builtin.map((name) => ({ source: "builtin" as const, name })),
    ...(intent.tools.customTools ?? []).map((tool) => ({
      source: "extension" as const,
      extension: tool.extension,
      name: tool.name,
    })),
  ];
  return {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    ...(intent.provider === undefined ? {} : { provider: intent.provider }),
    ...(intent.model === undefined ? {} : { model: intent.model }),
    tools,
    extensions,
  };
}

/**
 * The Nawabari-admitted workspace, forwarded exactly. Only an attached,
 * Nawabari-authoritative manifest for this Manager session is accepted; no
 * path is derived, widened, or taken from the caller.
 */
export function admittedTsukaiWorkspace(
  manifest: ExecutionManifest,
  managerSessionId: ManagerSessionId,
): { cwd: string; workspaceSessionId: string } {
  const { attachment } = manifest;
  if (attachment.authority !== "nawabari" || attachment.status !== "attached" || attachment.physical === undefined)
    throw new Error("execution manifest has no admitted Nawabari workspace");
  if (manifest.intent.manager?.managerSessionId !== managerSessionId)
    throw new Error("execution manifest belongs to another Manager session");
  return { cwd: attachment.physical.worktree, workspaceSessionId: attachment.physical.sessionId };
}

export interface TsukaiAgentRunStartInput {
  /** Caller-owned idempotency key; a retry decision uses a new key. */
  readonly startKey: string;
  readonly session: ManagerSessionRecord;
  /** Manifest already admitted by `admitExecution` for this session. */
  readonly manifest: ExecutionManifest;
  readonly prompt: string;
  readonly guardPath: string;
  readonly tools: TsukaiToolIntent;
}

export interface TsukaiAgentRunStartResult {
  readonly agentRunId: string;
  readonly snapshot: RunSnapshot;
  /** False when an existing AgentRun was recovered instead of created. */
  readonly created: boolean;
}

export interface TsukaiAgentRunStarterOptions {
  readonly store: Pick<
    WorkflowStateStore,
    "reserveTsukaiRunCorrelation" | "bindTsukaiRunCorrelation" | "getTsukaiRunCorrelation"
  >;
  readonly runs: TsukaiRunOperations;
}

export class TsukaiAgentRunStarter {
  private readonly inFlight = new Map<string, Promise<TsukaiAgentRunStartResult>>();

  constructor(private readonly options: TsukaiAgentRunStarterOptions) {}

  /**
   * Create, or recover, the single AgentRun for `startKey`. The start is
   * reserved durably before Tsukai is called and the run carries the key in
   * its metadata, so a restart between create and bind finds the run through
   * Tsukai `list` instead of creating a second one. A bound run is returned as
   * Tsukai reports it, terminal included; it is never re-created.
   */
  start(input: TsukaiAgentRunStartInput): Promise<TsukaiAgentRunStartResult> {
    const pending = this.inFlight.get(input.startKey);
    if (pending !== undefined) return pending;
    const started = this.startOnce(input).finally(() => this.inFlight.delete(input.startKey));
    this.inFlight.set(input.startKey, started);
    return started;
  }

  private async startOnce(input: TsukaiAgentRunStartInput): Promise<TsukaiAgentRunStartResult> {
    const { session, startKey } = input;
    if (session.agentKind !== "pi")
      throw new Error(`Tsukai start supports the pi agent only, not ${session.agentKind}`);
    const managerSessionId = session.sessionId;
    const workspace = admittedTsukaiWorkspace(input.manifest, managerSessionId);
    const executionProfile = tsukaiExecutionProfile({
      provider: session.provider,
      model: session.model,
      guardPath: input.guardPath,
      tools: input.tools,
    });

    const reserved = this.options.store.reserveTsukaiRunCorrelation({ startKey, managerSessionId });
    if (reserved.agentRunId !== undefined) return this.recovered(startKey, managerSessionId, reserved.agentRunId);

    const orphan = this.findCreatedRun(startKey);
    if (orphan !== undefined) {
      this.verifyOwnership(orphan, startKey, managerSessionId);
      this.options.store.bindTsukaiRunCorrelation({ startKey, agentRunId: orphan.agentRunId });
      return { agentRunId: orphan.agentRunId, snapshot: orphan, created: false };
    }

    const snapshot = await this.options.runs.create({
      harness: "pi",
      request: { prompt: input.prompt },
      metadata: { [TSUKAI_START_KEY_METADATA]: startKey, [TSUKAI_MANAGER_SESSION_METADATA]: managerSessionId },
      workspace,
      executionProfile,
    });
    this.options.store.bindTsukaiRunCorrelation({ startKey, agentRunId: snapshot.agentRunId });
    return { agentRunId: snapshot.agentRunId, snapshot, created: true };
  }

  private recovered(
    startKey: string,
    managerSessionId: ManagerSessionId,
    agentRunId: string,
  ): TsukaiAgentRunStartResult {
    const snapshot = this.options.runs.get(agentRunId);
    this.verifyOwnership(snapshot, startKey, managerSessionId);
    return { agentRunId, snapshot, created: false };
  }

  private findCreatedRun(startKey: string): RunSnapshot | undefined {
    let cursor: string | undefined;
    do {
      const page = this.options.runs.list({ limit: LIST_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
      const match = page.items.find((run) => run.metadata[TSUKAI_START_KEY_METADATA] === startKey);
      if (match !== undefined) return match;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }

  private verifyOwnership(snapshot: RunSnapshot, startKey: string, managerSessionId: ManagerSessionId): void {
    if (
      snapshot.metadata[TSUKAI_START_KEY_METADATA] !== startKey ||
      snapshot.metadata[TSUKAI_MANAGER_SESSION_METADATA] !== managerSessionId
    )
      throw new Error(`Tsukai AgentRun ${snapshot.agentRunId} is not correlated with start ${startKey}`);
  }
}
