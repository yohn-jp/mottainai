import crypto from "node:crypto";
import {
  GH_MAKAMI_MACHINE_CONTRACT,
  type GhMakamiAwaitRequest,
  type GhMakamiAwaitResult,
  type GhMakamiJsonObject,
  type GhMakamiJsonValue,
  type GhMakamiObservationRequest,
  type GhMakamiReconcileRequest,
  type GhMakamiReconcileResult,
  type GhMakamiResult,
  type GhMakamiStatusResult,
} from "../../gh-makami.js";
import type {
  ManagedPullRequestCoarseState,
  ManagedPullRequestGeneration,
  ManagedPullRequestState,
  PullRequestRecord,
  WorkflowStateStore,
} from "../state/store.js";

export const MANAGED_PR_OBSERVATION_SOURCE = "gh-makami" as const;
export const MANAGED_PR_LIFECYCLE_EVENTS = ["initial", "same-generation", "head-rollover"] as const;
export type ManagedPrLifecycleEvent = (typeof MANAGED_PR_LIFECYCLE_EVENTS)[number];

export interface ManagedPullRequestMakamiClient {
  status(request: GhMakamiObservationRequest): Promise<GhMakamiResult<GhMakamiStatusResult>>;
  reconcile(request: GhMakamiReconcileRequest): Promise<GhMakamiResult<GhMakamiReconcileResult>>;
  await(request: GhMakamiAwaitRequest): Promise<GhMakamiResult<GhMakamiAwaitResult>>;
}

export interface ManagedPullRequestLifecycleResult {
  ok: true;
  state: ManagedPullRequestState;
  event: ManagedPrLifecycleEvent;
  changed: boolean;
  /** Inputs newly invalidated by this head rollover; historical stale rows are omitted. */
  staleDerivedInputIds: readonly string[];
  /** Makami waiting is represented here only as orchestration state. */
  requiresLiveSession: false;
}

export interface ManagedPullRequestLifecycleFailure {
  ok: false;
  reason: "identity-mismatch" | "observation-failed" | "state-write-failed";
  detail: string;
}

export type ManagedPullRequestLifecycleReconcileResult =
  | ManagedPullRequestLifecycleResult
  | ManagedPullRequestLifecycleFailure;

export interface ReconcileManagedPullRequestInput {
  store: WorkflowStateStore;
  record: PullRequestRecord;
  makami: ManagedPullRequestMakamiClient;
  /** Supplying a prior snapshot enables a same-process reconcile delta. */
  previousSnapshot?: GhMakamiJsonObject;
  operation?: "status" | "reconcile" | "await";
  now?: number;
}

interface Observation {
  operation: "status" | "reconcile" | "await";
  generation: ManagedPullRequestGeneration;
  payload: GhMakamiJsonObject;
}

/**
 * Map Makami's normalized public delta to four bounded Mottainai states.
 * Unknown/detail-only changes intentionally preserve the prior coarse state;
 * no check/review Cartesian product is recreated in this module.
 */
export function mapMakamiDeltaToCoarseState(
  value: GhMakamiJsonObject,
  previous: ManagedPullRequestCoarseState | undefined,
): { state: ManagedPullRequestCoarseState; changed: boolean } {
  if (isExplicitUnchanged(value)) return { state: previous ?? "awaiting", changed: false };

  if (previous === "merged") return { state: "merged", changed: false };

  const explicit = [...directLifecycleSignals(value), ...lifecycleChangeSignals(value)];
  for (const signal of explicit) {
    const state = coarseStateForSignal(signal);
    if (state !== undefined) return { state, changed: previous !== state };
  }

  return { state: previous ?? "awaiting", changed: false };
}

/**
 * Re-observe one persisted PR through the #415 boundary and persist only the
 * exact generation plus a bounded coarse projection/provenance. A missing
 * prior snapshot (including after restart) intentionally uses `status`, so no
 * old agent/remediation session is resumed merely to wait for change.
 */
export async function reconcileManagedPullRequest(
  input: ReconcileManagedPullRequestInput,
): Promise<ManagedPullRequestLifecycleReconcileResult> {
  if (input.record.provider !== "github") {
    return {
      ok: false,
      reason: "identity-mismatch",
      detail: `Makami PR observation requires github provider: ${input.record.provider}`,
    };
  }
  const repository = input.record.repositoryId;
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    return { ok: false, reason: "identity-mismatch", detail: `invalid repository identity: ${repository}` };
  }

  const existing = input.store.getManagedPullRequestState(
    input.record.provider,
    input.record.repositoryId,
    input.record.prNumber,
  );
  const previouslyStaleDerivedInputIds = new Set(
    existing === undefined
      ? []
      : input.store
          .listManagedPullRequestDerivedInputs(existing.stateId)
          .filter((derived) => derived.state === "stale")
          .map((derived) => derived.inputId),
  );
  const operation = input.operation ?? (input.previousSnapshot === undefined ? "status" : "reconcile");
  let observed: GhMakamiResult<GhMakamiStatusResult | GhMakamiReconcileResult | GhMakamiAwaitResult>;
  try {
    if (operation === "status") {
      observed = await input.makami.status({ repository, prNumber: input.record.prNumber });
    } else if (operation === "reconcile") {
      if (input.previousSnapshot === undefined)
        return { ok: false, reason: "observation-failed", detail: "reconcile requires a prior Makami snapshot" };
      observed = await input.makami.reconcile({
        repository,
        prNumber: input.record.prNumber,
        previous: input.previousSnapshot,
      });
    } else {
      if (input.previousSnapshot === undefined)
        return { ok: false, reason: "observation-failed", detail: "await requires a starting Makami snapshot" };
      observed = await input.makami.await({
        repository,
        prNumber: input.record.prNumber,
        startingSnapshot: input.previousSnapshot,
      });
    }
  } catch (error) {
    return {
      ok: false,
      reason: "observation-failed",
      detail: `Makami observation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!observed.ok) return { ok: false, reason: "observation-failed", detail: observed.error.message };

  const observation = normalizeObservation(operation, observed.value);
  if (observation.generation.repository !== repository || observation.generation.prNumber !== input.record.prNumber) {
    return {
      ok: false,
      reason: "identity-mismatch",
      detail: "Makami returned a generation for a different repository or pull request",
    };
  }

  const projection = mapMakamiDeltaToCoarseState(observation.payload, existing?.coarseState);
  const event: ManagedPrLifecycleEvent =
    existing === undefined
      ? "initial"
      : existing.generation.headSha === observation.generation.headSha
        ? "same-generation"
        : "head-rollover";
  const digest = crypto.createHash("sha256").update(canonicalJson(observation.payload)).digest("hex");
  const observationRef = `${MANAGED_PR_OBSERVATION_SOURCE}:${observation.operation}:${repository}#${input.record.prNumber}@${observation.generation.headSha}`;

  let state: ManagedPullRequestState;
  try {
    state = input.store.recordManagedPullRequestState({
      taskId: input.record.taskId,
      instanceId: input.record.instanceId,
      provider: input.record.provider,
      repositoryId: input.record.repositoryId,
      prNumber: input.record.prNumber,
      generation: observation.generation,
      coarseState: projection.state,
      observationSource: MANAGED_PR_OBSERVATION_SOURCE,
      observationContract: GH_MAKAMI_MACHINE_CONTRACT,
      observationOperation: observation.operation,
      observationRef,
      observationDigest: digest,
      recordedAt: input.now,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "state-write-failed",
      detail: `managed PR lifecycle state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const staleDerivedInputIds =
    event === "head-rollover"
      ? input.store
          .listManagedPullRequestDerivedInputs(state.stateId)
          .filter((derived) => derived.state === "stale" && !previouslyStaleDerivedInputIds.has(derived.inputId))
          .map((derived) => derived.inputId)
      : [];
  return {
    ok: true,
    state,
    event,
    changed: projection.changed || event === "head-rollover",
    staleDerivedInputIds,
    requiresLiveSession: false,
  };
}

function normalizeObservation(
  operation: "status" | "reconcile" | "await",
  value: GhMakamiStatusResult | GhMakamiReconcileResult | GhMakamiAwaitResult,
): Observation {
  if (operation === "status") {
    const result = value as GhMakamiStatusResult;
    return { operation, generation: result.generation, payload: result.snapshot };
  }
  if (operation === "reconcile") {
    const result = value as GhMakamiReconcileResult;
    return { operation, generation: result.generation, payload: result.delta };
  }
  const result = value as GhMakamiAwaitResult;
  return { operation, generation: result.generation, payload: result.delta ?? result.result };
}

function isExplicitUnchanged(value: GhMakamiJsonObject): boolean {
  return value.kind === "unchanged" || value.changed === false;
}

function directLifecycleSignals(value: GhMakamiJsonObject): string[] {
  const signals: string[] = [];
  for (const key of ["coarseState", "lifecycle"]) {
    const candidate = value[key];
    if (typeof candidate === "string") signals.push(candidate);
  }
  return signals;
}

function lifecycleChangeSignals(value: GhMakamiJsonObject): string[] {
  if (!Array.isArray(value.changes)) return [];
  const signals: string[] = [];
  for (const entry of value.changes.slice(0, 64)) {
    if (!isRecord(entry)) continue;
    if (entry.kind !== "lifecycle-change" || entry.path !== "lifecycle") continue;
    if (typeof entry.after === "string") signals.push(entry.after);
  }
  return signals;
}

function coarseStateForSignal(value: string): ManagedPullRequestCoarseState | undefined {
  return value === "awaiting" || value === "remediation-required" || value === "merge-ready" || value === "merged"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical JSON is used only for provenance hashing; Makami's detail remains opaque. */
function canonicalJson(value: GhMakamiJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
