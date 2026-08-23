import type { ExecutionClaim } from "../semantics/execution-plan.js";
import type { NawabariClaimEvidence, NawabariClaimEvidenceSnapshot } from "../workflow/nawabari.js";

/**
 * This is an advisory projection of Nawabari's versioned claim evidence. It
 * is intentionally not persisted and never authorizes a later mutation.
 */
export const NAWABARI_RESOURCE_CLAIM_SCHEMA_VERSION = 2 as const;
export const MAX_MANAGER_CLAIM_CONFLICTS = 32;

export type ManagerClaimPreflightStatus =
  | "not-applicable"
  | "clear"
  | "conflict"
  | "unavailable"
  | "ambiguous"
  | "stale";

export interface ManagerClaimConflict {
  requested: { resource: string; mode: ExecutionClaim["mode"] };
  existing: {
    sessionId: string;
    resource: string;
    mode: ExecutionClaim["mode"];
    worktree?: string;
    branch?: string;
    state?: string;
    label?: string;
    /** Optional local Mottainai projection; Nawabari remains authoritative. */
    taskId?: string;
    taskSlug?: string;
    issueRef?: string;
    claimId: string;
  };
}

export interface ManagerClaimTaskIdentity {
  taskId: string;
  taskSlug: string;
  issueRef?: string;
}

export interface ManagerClaimPreflight {
  status: ManagerClaimPreflightStatus;
  authoritative: "nawabari";
  evidence: {
    source: "nawabari.session-list+session-claims" | "not-applicable";
    claimSchemaVersion?: number;
    observedAt: string;
    bounded: true;
  };
  conflicts: readonly ManagerClaimConflict[];
  conflictsTruncated: boolean;
  safeActions: readonly (
    | "inspect-blocking-session"
    | "refresh-preflight"
    | "reconcile"
    | "retain-session"
    | "retry-after-stabilization"
  )[];
  message?: string;
  nawabariCode?: string;
}

function compareCodePointStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Exact bounded intersection for Nawabari's canonical path/glob syntax:
 * `*`/`?` within a segment and `**` as a complete path segment. This is an
 * advisory compatibility projection only; Nawabari's claim mutation remains
 * the final authority. Unsupported syntax is rejected by Nawabari before it
 * can become persisted evidence.
 */
function resourcePatternsOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const queue: [number, number, boolean][] = [[0, 0, false]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex, consumed] = queue.shift()!;
    const key = `${leftIndex}:${rightIndex}:${consumed ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) {
      if (consumed) return true;
      continue;
    }
    const leftGlobStar = leftSegments[leftIndex] === "**";
    const rightGlobStar = rightSegments[rightIndex] === "**";
    if (leftGlobStar) {
      queue.push([leftIndex + 1, rightIndex, consumed]);
      queue.push([leftIndex, rightIndex, true]);
    }
    if (rightGlobStar) {
      queue.push([leftIndex, rightIndex + 1, consumed]);
      queue.push([leftIndex, rightIndex, true]);
    }
    if (leftGlobStar && rightGlobStar) {
      queue.push([leftIndex + 1, rightIndex + 1, consumed]);
      continue;
    }
    if (leftIndex >= leftSegments.length || rightIndex >= rightSegments.length) continue;
    if (rightGlobStar) {
      queue.push([leftIndex + 1, rightIndex, true]);
      continue;
    }
    if (leftGlobStar) {
      queue.push([leftIndex, rightIndex + 1, true]);
      continue;
    }
    if (segmentPatternsOverlap(leftSegments[leftIndex]!, rightSegments[rightIndex]!)) {
      queue.push([leftIndex + 1, rightIndex + 1, true]);
    }
  }
  return false;
}

function segmentPatternsOverlap(left: string, right: string): boolean {
  const queue: [number, number, boolean][] = [[0, 0, false]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex, consumed] = queue.shift()!;
    const key = `${leftIndex}:${rightIndex}:${consumed ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) {
      if (consumed) return true;
      continue;
    }
    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];
    if (leftChar === "*") queue.push([leftIndex + 1, rightIndex, consumed]);
    if (rightChar === "*") queue.push([leftIndex, rightIndex + 1, consumed]);
    if (leftChar === "*" && rightIndex < right.length) queue.push([leftIndex, rightIndex + 1, true]);
    if (rightChar === "*" && leftIndex < left.length) queue.push([leftIndex + 1, rightIndex, true]);
    if (leftIndex < left.length && rightIndex < right.length && leftChar !== "*" && rightChar !== "*") {
      if (leftChar === "?" || rightChar === "?" || leftChar === rightChar) {
        queue.push([leftIndex + 1, rightIndex + 1, true]);
      }
    }
  }
  return false;
}

function modesConflict(left: ExecutionClaim["mode"], right: ExecutionClaim["mode"]): boolean {
  if (left === "read" && (right === "read" || right === "write")) return false;
  if (right === "read" && left === "write") return false;
  return true;
}

function conflictFromEvidence(
  requested: ExecutionClaim,
  existing: NawabariClaimEvidence,
  owner: NawabariClaimEvidenceSnapshot["sessions"][number] | undefined,
  task: ManagerClaimTaskIdentity | undefined,
): ManagerClaimConflict {
  return {
    requested: { resource: requested.resource, mode: requested.mode },
    existing: {
      sessionId: existing.sessionId,
      resource: existing.resource,
      mode: existing.mode,
      ...(owner === undefined ? {} : { worktree: owner.worktree, branch: owner.branch, state: owner.state }),
      ...(owner?.label === undefined ? {} : { label: owner.label }),
      ...(task === undefined
        ? {}
        : {
            taskId: task.taskId,
            taskSlug: task.taskSlug,
            ...(task.issueRef === undefined ? {} : { issueRef: task.issueRef }),
          }),
      claimId: existing.claimId,
    },
  };
}

export function createClaimPreflight(
  claims: readonly ExecutionClaim[],
  snapshot: NawabariClaimEvidenceSnapshot,
  observedAt = new Date().toISOString(),
  taskBySession = new Map<string, ManagerClaimTaskIdentity>(),
): ManagerClaimPreflight {
  const sessions = new Map(snapshot.sessions.map((session) => [session.sessionId, session]));
  const conflicts: ManagerClaimConflict[] = [];
  for (const requested of claims) {
    for (const existing of snapshot.claims) {
      if (!resourcePatternsOverlap(requested.resource, existing.resource)) continue;
      if (!modesConflict(requested.mode, existing.mode)) continue;
      conflicts.push(
        conflictFromEvidence(
          requested,
          existing,
          sessions.get(existing.sessionId),
          taskBySession.get(existing.sessionId),
        ),
      );
    }
  }
  conflicts.sort((left, right) =>
    compareCodePointStrings(
      `${left.existing.sessionId}\u0000${left.existing.resource}\u0000${left.existing.mode}\u0000${left.requested.resource}\u0000${left.requested.mode}\u0000${left.existing.claimId}`,
      `${right.existing.sessionId}\u0000${right.existing.resource}\u0000${right.existing.mode}\u0000${right.requested.resource}\u0000${right.requested.mode}\u0000${right.existing.claimId}`,
    ),
  );
  const conflictsTruncated = conflicts.length > MAX_MANAGER_CLAIM_CONFLICTS;
  return {
    status: conflicts.length === 0 ? "clear" : "conflict",
    authoritative: "nawabari",
    evidence: {
      source: "nawabari.session-list+session-claims",
      claimSchemaVersion: NAWABARI_RESOURCE_CLAIM_SCHEMA_VERSION,
      observedAt,
      bounded: true,
    },
    conflicts: conflicts.slice(0, MAX_MANAGER_CLAIM_CONFLICTS),
    conflictsTruncated,
    safeActions:
      conflicts.length === 0
        ? ["refresh-preflight"]
        : ["inspect-blocking-session", "refresh-preflight", "reconcile", "retain-session"],
    ...(conflicts.length === 0 ? { message: "Nawabari reports no conflicting active claim." } : {}),
  };
}

export function notApplicableClaimPreflight(observedAt = new Date().toISOString()): ManagerClaimPreflight {
  return {
    status: "not-applicable",
    authoritative: "nawabari",
    evidence: { source: "not-applicable", observedAt, bounded: true },
    conflicts: [],
    conflictsTruncated: false,
    safeActions: [],
    message: "workspace-mode Manager launch has no Nawabari task claim boundary",
  };
}

export function failedClaimPreflight(
  status: Extract<ManagerClaimPreflightStatus, "unavailable" | "ambiguous" | "stale">,
  message: string,
  nawabariCode?: string,
  observedAt = new Date().toISOString(),
): ManagerClaimPreflight {
  return {
    status,
    authoritative: "nawabari",
    evidence: {
      source: "nawabari.session-list+session-claims",
      observedAt,
      bounded: true,
    },
    conflicts: [],
    conflictsTruncated: false,
    safeActions: ["retry-after-stabilization", "refresh-preflight", "reconcile"],
    message: message.slice(0, 512),
    ...(nawabariCode === undefined ? {} : { nawabariCode }),
  };
}
