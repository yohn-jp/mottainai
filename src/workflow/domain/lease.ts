import type {
  CleanupLeaseRecord,
  CleanupLeaseState,
  MarkCleanupLeaseInput,
  ReserveCleanupLeaseInput,
  ReserveCleanupLeaseResult,
  WorkflowStateStore,
} from "../state/store.js";

export { CLEANUP_LEASE_STATES } from "../state/store.js";
export type { CleanupLeaseRecord, CleanupLeaseState } from "../state/store.js";

export const DEFAULT_CLEANUP_LEASE_TTL_MS = 30_000;

const ACTIVE_LEASE_STATES: readonly CleanupLeaseState[] = ["reserved", "mutating", "verifying"];

export interface CleanupLeaseReservation {
  operationId: string;
  planDigest: string;
  instanceId: ReserveCleanupLeaseInput["instanceId"];
  taskId: ReserveCleanupLeaseInput["taskId"];
  worktreeId?: ReserveCleanupLeaseInput["worktreeId"];
  owner?: string;
  now?: number;
  ttlMs?: number;
}

export function reserveLease(store: WorkflowStateStore, input: CleanupLeaseReservation): ReserveCleanupLeaseResult {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_CLEANUP_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("cleanup lease ttl must be a positive safe integer");
  return store.reserveCleanupLease({
    operationId: input.operationId,
    planDigest: input.planDigest,
    instanceId: input.instanceId,
    taskId: input.taskId,
    worktreeId: input.worktreeId,
    owner: input.owner ?? `mottainai:${process.pid}`,
    acquiredAt: now,
    expiresAt: now + ttlMs,
  });
}

export function isLeaseActive(lease: CleanupLeaseRecord, now = Date.now()): boolean {
  return ACTIVE_LEASE_STATES.includes(lease.state) && lease.expiresAt > now;
}

export function isLeaseRecoverable(lease: CleanupLeaseRecord, now = Date.now()): boolean {
  return !isLeaseActive(lease, now) && lease.state !== "committed";
}

function allowedLeaseTransition(from: CleanupLeaseState, to: CleanupLeaseState): boolean {
  if (from === to) return true;
  if (from === "reserved") return to === "mutating" || to === "failed";
  if (from === "mutating") return to === "verifying" || to === "failed";
  if (from === "verifying") return to === "mutating" || to === "committed" || to === "failed";
  if (from === "failed") return to === "reserved";
  return false;
}

export function markLease(store: WorkflowStateStore, input: MarkCleanupLeaseInput): CleanupLeaseRecord {
  const current = store.getCleanupLease(input.operationId);
  if (current === undefined) throw new Error(`cleanup lease not found: ${input.operationId}`);
  if (!allowedLeaseTransition(current.state, input.state)) {
    throw new Error(`invalid cleanup lease transition: ${current.state} -> ${input.state}`);
  }
  return store.markCleanupLease({ expectedState: current.state, ...input });
}
