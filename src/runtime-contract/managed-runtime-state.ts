import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { replaceFileAtomically } from "../atomic-file.js";
import type { BoundaryOperations } from "../boundary.js";
import { DIRECT_BOUNDARIES } from "../boundary.js";

/**
 * Durable activation/recovery authority for Issue #628.
 *
 * This record intentionally contains managed-generation evidence only. The
 * desired manifest remains owned by #624 and user/workspace state remains
 * outside this file and outside the `current` pointer transaction.
 */
export const MANAGED_RUNTIME_STATE_CONTRACT_ID = "mottainai.managed-runtime-state.v1" as const;
export const MANAGED_RUNTIME_CONTRACT_ID = MANAGED_RUNTIME_STATE_CONTRACT_ID;
export const MANAGED_RUNTIME_STATE_SCHEMA_VERSION = 1 as const;
export const MANAGED_RUNTIME_STATE_RELATIVE_PATH = "managed-runtime/state.json" as const;
export const MANAGED_RUNTIME_CURRENT_RELATIVE_PATH = "managed-runtime/current" as const;
export const MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH = "managed-packages/manifest.json" as const;
export const MANAGED_RUNTIME_LOCK_RELATIVE_PATH = "managed-runtime/reconcile.lock" as const;
export const MANAGED_RUNTIME_CONTROL_STATE_ROOT = "/var/lib/mottainai-control" as const;
export const MANAGED_RUNTIME_STATE_FILE_PATH = path.join(
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  MANAGED_RUNTIME_STATE_RELATIVE_PATH,
);
export const MANAGED_RUNTIME_CURRENT_POINTER_PATH = path.join(
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  MANAGED_RUNTIME_CURRENT_RELATIVE_PATH,
);
export const MANAGED_RUNTIME_MANIFEST_PATH = path.join(
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH,
);
export const MANAGED_RUNTIME_LOCK_PATH = path.join(
  MANAGED_RUNTIME_CONTROL_STATE_ROOT,
  MANAGED_RUNTIME_LOCK_RELATIVE_PATH,
);

export const MANAGED_RUNTIME_ACTIVATION_PHASES = [
  "idle",
  "prepared",
  "switched-health-pending",
  "rollback-pending",
  "rollback-health-pending",
] as const;
export type ManagedRuntimeActivationPhase = (typeof MANAGED_RUNTIME_ACTIVATION_PHASES)[number];
export type ManagedRuntimeTransactionPhase = ManagedRuntimeActivationPhase;

export const MANAGED_RUNTIME_FAILURE_CODES = [
  "invalid_manifest",
  "unsupported_managed_package",
  "compatibility_mismatch",
  "build_failure",
  "generation_verification_failure",
  "activation_failure",
  "health_failure",
  "rollback_failure",
  "interrupted_activation",
  "ambiguous_activation",
  "state_corrupt",
  "pointer_corrupt",
] as const;
export type ManagedRuntimeFailureCode = (typeof MANAGED_RUNTIME_FAILURE_CODES)[number];

export const MANAGED_RUNTIME_HEALTH_STATES = ["healthy", "unhealthy", "pending", "unknown"] as const;
export type ManagedRuntimeHealthState = (typeof MANAGED_RUNTIME_HEALTH_STATES)[number];

const MAX_IDENTITY_LENGTH = 256 as const;
const MAX_STORE_PATH_LENGTH = 4_096 as const;
const MAX_MESSAGE_LENGTH = 2_048 as const;
const MAX_PACKAGE_IDS = 64 as const;
const MAX_TRANSACTION_ID_LENGTH = 128 as const;
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/iu)
  .transform((value) => value.toLowerCase());
const boundedIdentitySchema = z.string().min(1).max(MAX_IDENTITY_LENGTH);
const storePathSchema = z.string().min(1).max(MAX_STORE_PATH_LENGTH);
const timestampSchema = z.string().datetime({ offset: true });

/** A verified generation eligible for a transaction, but not necessarily active. */
export const ManagedRuntimeCandidateSchema = z
  .object({
    generationIdentity: boundedIdentitySchema,
    storePath: storePathSchema,
    desiredManifestSemanticIdentity: sha256Schema,
    compatibilityContractVersion: z.number().int().min(1),
    packageIds: z
      .array(z.string().min(1).max(MAX_IDENTITY_LENGTH))
      .max(MAX_PACKAGE_IDS)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate packageId in managed generation candidate")
      .optional(),
  })
  .strict();
export type ManagedRuntimeCandidate = z.infer<typeof ManagedRuntimeCandidateSchema>;

const healthEvidenceSchema = z
  .object({
    state: z.literal("healthy"),
    checkedAt: timestampSchema,
    evidence: z.string().max(MAX_MESSAGE_LENGTH).optional(),
  })
  .strict();

/** Active/previous records are known-good records; an unproven candidate never appears here. */
export const ManagedRuntimeGenerationRecordSchema = ManagedRuntimeCandidateSchema.extend({
  health: healthEvidenceSchema,
}).strict();
export type ManagedRuntimeGenerationRecord = z.infer<typeof ManagedRuntimeGenerationRecordSchema>;

export const ManagedRuntimeFailureEvidenceSchema = z
  .object({
    code: z.enum(MANAGED_RUNTIME_FAILURE_CODES),
    phase: z.enum(MANAGED_RUNTIME_ACTIVATION_PHASES),
    message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    recordedAt: timestampSchema,
    generationIdentity: boundedIdentitySchema.optional(),
    storePath: storePathSchema.optional(),
  })
  .strict();
export type ManagedRuntimeFailureEvidence = z.infer<typeof ManagedRuntimeFailureEvidenceSchema>;

export const ManagedRuntimeObservedStateSchema = z
  .object({
    observedAt: timestampSchema,
    currentStorePath: storePathSchema.optional(),
    generationIdentity: boundedIdentitySchema.optional(),
    desiredManifestSemanticIdentity: sha256Schema.optional(),
    health: z.enum(MANAGED_RUNTIME_HEALTH_STATES).optional(),
    reason: z.string().max(MAX_MESSAGE_LENGTH).optional(),
  })
  .strict();
export type ManagedRuntimeObservedState = z.infer<typeof ManagedRuntimeObservedStateSchema>;

export const ManagedRuntimeActivationSchema = z
  .object({
    phase: z.enum(MANAGED_RUNTIME_ACTIVATION_PHASES),
    transactionId: z.string().min(1).max(MAX_TRANSACTION_ID_LENGTH).optional(),
    candidate: ManagedRuntimeCandidateSchema.optional(),
    previous: ManagedRuntimeGenerationRecordSchema.optional(),
    failure: ManagedRuntimeFailureEvidenceSchema.optional(),
    startedAt: timestampSchema.optional(),
    updatedAt: timestampSchema.optional(),
  })
  .strict();
export type ManagedRuntimeActivation = z.infer<typeof ManagedRuntimeActivationSchema>;
export type ManagedRuntimeTransaction = ManagedRuntimeActivation;

export const ManagedRuntimeStateSchema = z
  .object({
    contractId: z.literal(MANAGED_RUNTIME_STATE_CONTRACT_ID),
    schemaVersion: z.literal(MANAGED_RUNTIME_STATE_SCHEMA_VERSION),
    desiredManifestSemanticIdentity: sha256Schema,
    active: ManagedRuntimeGenerationRecordSchema.optional(),
    previous: ManagedRuntimeGenerationRecordSchema.optional(),
    activation: ManagedRuntimeActivationSchema,
    observed: ManagedRuntimeObservedStateSchema.optional(),
    failure: ManagedRuntimeFailureEvidenceSchema.optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export type ManagedRuntimeState = z.infer<typeof ManagedRuntimeStateSchema>;

export class ManagedRuntimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedRuntimeStateError";
  }
}

export type ManagedRuntimeLockErrorCode = "busy" | "unavailable";

export class ManagedRuntimeLockError extends ManagedRuntimeStateError {
  readonly code: ManagedRuntimeLockErrorCode;
  readonly operation: string;

  constructor(code: ManagedRuntimeLockErrorCode, message: string, operation = "unknown") {
    super(message);
    this.name = "ManagedRuntimeLockError";
    this.code = code;
    this.operation = operation;
  }
}

export interface ManagedRuntimeWriterLock {
  release(): void;
}

export interface ManagedRuntimePaths {
  readonly stateRoot: string;
  readonly managedRuntimeDirectory: string;
  readonly stateFile: string;
  readonly currentPointer: string;
  readonly manifestFile: string;
  readonly lockFile: string;
}

/** Compatibility aliases for consumers that call the pointer an activation path. */
export const MANAGED_RUNTIME_CURRENT_PATH = MANAGED_RUNTIME_CURRENT_RELATIVE_PATH;
export const MANAGED_RUNTIME_STATE_FILE_RELATIVE_PATH = MANAGED_RUNTIME_STATE_RELATIVE_PATH;
export const MANAGED_RUNTIME_CURRENT_POINTER_RELATIVE_PATH = MANAGED_RUNTIME_CURRENT_RELATIVE_PATH;
export type ManagedGenerationCandidate = ManagedRuntimeCandidate;
export type ManagedGenerationRecord = ManagedRuntimeGenerationRecord;

/** Resolve the canonical control-state layout without consulting provider or PATH state. */
export function resolveManagedRuntimePaths(
  stateRoot: string = MANAGED_RUNTIME_CONTROL_STATE_ROOT,
): ManagedRuntimePaths {
  const root = path.resolve(stateRoot);
  const managedRuntimeDirectory = path.join(root, "managed-runtime");
  return {
    stateRoot: root,
    managedRuntimeDirectory,
    stateFile: path.join(root, MANAGED_RUNTIME_STATE_RELATIVE_PATH),
    currentPointer: path.join(root, MANAGED_RUNTIME_CURRENT_RELATIVE_PATH),
    manifestFile: path.join(root, MANAGED_RUNTIME_MANIFEST_RELATIVE_PATH),
    lockFile: path.join(root, MANAGED_RUNTIME_LOCK_RELATIVE_PATH),
  };
}

const MAX_LOCK_OWNER_LENGTH = 128 as const;
const LOCK_OWNER_PATTERN = /^pid:([1-9][0-9]{0,9}):([0-9a-f-]{36})$/u;

function lockErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lockUnavailable(operation: string, error: unknown): ManagedRuntimeLockError {
  return new ManagedRuntimeLockError(
    "unavailable",
    `managed Runtime writer lock ${operation} failed: ${lockErrorMessage(error)}`,
    operation,
  );
}

function readLockOwnerDirect(lockFile: string): string | undefined {
  const stat = fs.lstatSync(lockFile);
  if (!stat.isSymbolicLink()) {
    throw new ManagedRuntimeLockError("unavailable", "managed Runtime writer lock is not a symlink");
  }
  const owner = fs.readlinkSync(lockFile);
  if (owner.length > MAX_LOCK_OWNER_LENGTH || !LOCK_OWNER_PATTERN.test(owner)) {
    throw new ManagedRuntimeLockError("unavailable", "managed Runtime writer lock owner is invalid");
  }
  return owner;
}

function readLockOwner(lockFile: string, boundaries: BoundaryOperations): string | undefined {
  try {
    return boundaries.file("managed-runtime-writer-lock.inspect", () => readLockOwnerDirect(lockFile));
  } catch (error) {
    if (error instanceof ManagedRuntimeLockError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw lockUnavailable("read", error);
  }
}

/**
 * Reclaim only the marker that was verified by this attempt. The owner check
 * and unlink are kept in one synchronous file-boundary operation so a test or
 * another actor cannot replace the marker between the final check and the
 * stale break. A replacement is treated as a failed reclaim and retried as a
 * normal lock acquisition, which preserves the replacement owner's lock.
 */
function removeStaleLockIfOwned(
  lockFile: string,
  expectedOwner: string,
  boundaries: BoundaryOperations,
): boolean {
  try {
    return boundaries.file("managed-runtime-writer-lock.stale-break", () => {
      let currentOwner: string | undefined;
      try {
        currentOwner = readLockOwnerDirect(lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (currentOwner !== expectedOwner) return false;
      try {
        fs.unlinkSync(lockFile);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof ManagedRuntimeLockError) throw error;
    throw lockUnavailable("stale break", error);
  }
}

function ownerPid(owner: string): number {
  const match = LOCK_OWNER_PATTERN.exec(owner);
  if (match === null) {
    throw new ManagedRuntimeLockError("unavailable", "managed Runtime writer lock owner is invalid");
  }
  return Number(match[1]);
}

/** Treat permission/unknown process errors conservatively as a live owner. */
function isProcessAlive(pid: number, boundaries: BoundaryOperations): boolean {
  try {
    boundaries.process("managed-runtime-writer-lock.owner-probe", () => process.kill(pid, 0));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw lockUnavailable("owner probe", error);
  }
}

/**
 * Acquire the non-blocking writer boundary for one canonical managed-runtime
 * state root. The symlink creation is the exclusive create operation; its
 * bounded owner identity makes a marker left by a dead process recoverable
 * without introducing another managed-generation registry.
 */
export function acquireManagedRuntimeWriterLock(
  lockFile: string,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): ManagedRuntimeWriterLock {
  const directory = path.dirname(lockFile);
  try {
    boundaries.file("managed-runtime-writer-lock.directory.create", () =>
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }),
    );
  } catch (error) {
    throw lockUnavailable("directory preparation", error);
  }

  const owner = `pid:${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      boundaries.file("managed-runtime-writer-lock.create", () => fs.symlinkSync(owner, lockFile));
      let released = false;
      return {
        release(): void {
          if (released) return;
          const currentOwner = readLockOwner(lockFile, boundaries);
          if (currentOwner === undefined) {
            throw new ManagedRuntimeLockError("unavailable", "managed Runtime writer lock disappeared before release");
          }
          if (currentOwner !== owner) {
            throw new ManagedRuntimeLockError("unavailable", "managed Runtime writer lock ownership changed");
          }
          try {
            boundaries.file("managed-runtime-writer-lock.release", () => fs.unlinkSync(lockFile));
          } catch (error) {
            throw lockUnavailable("release", error);
          }
          released = true;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (error instanceof ManagedRuntimeLockError) throw error;
        throw lockUnavailable("create", error);
      }
    }

    const incumbent = readLockOwner(lockFile, boundaries);
    if (incumbent === undefined) continue;
    const incumbentPid = ownerPid(incumbent);
    if (isProcessAlive(incumbentPid, boundaries)) {
      throw new ManagedRuntimeLockError("busy", "managed Runtime reconcile is busy");
    }

    // Re-read before the ownership-safe stale break so a contender that
    // replaced it is never accidentally unlinked. This is deliberately
    // bounded and non-blocking; a live/unknown owner remains fail-closed.
    const confirmedOwner = readLockOwner(lockFile, boundaries);
    if (confirmedOwner === undefined) continue;
    if (confirmedOwner !== incumbent) continue;
    if (isProcessAlive(ownerPid(confirmedOwner), boundaries)) {
      throw new ManagedRuntimeLockError("busy", "managed Runtime reconcile is busy");
    }
    if (!removeStaleLockIfOwned(lockFile, confirmedOwner, boundaries)) continue;
  }

  throw new ManagedRuntimeLockError("busy", "managed Runtime reconcile is busy");
}

/** Fails closed before a path can become an activation target. */
export function assertManagedStorePath(storePath: string): string {
  if (typeof storePath !== "string") {
    throw new ManagedRuntimeStateError("managed generation store path must be a string");
  }
  const normalized = path.normalize(storePath);
  const storeName = normalized.slice("/nix/store/".length);
  if (
    storePath.length === 0 ||
    storePath.length > MAX_STORE_PATH_LENGTH ||
    !path.isAbsolute(storePath) ||
    storePath.includes("\0") ||
    !normalized.startsWith("/nix/store/") ||
    storeName.length === 0 ||
    storeName.includes(path.sep)
  ) {
    throw new ManagedRuntimeStateError(
      `managed generation store path is invalid or outside the Nix store: ${storePath}`,
    );
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new ManagedRuntimeStateError("managed Runtime state contains an unsupported value for canonicalization");
}

/** Parse a canonical state record; unknown fields and malformed identities fail closed. */
export function parseManagedRuntimeState(value: unknown): ManagedRuntimeState {
  const result = ManagedRuntimeStateSchema.safeParse(value);
  if (!result.success) {
    throw new ManagedRuntimeStateError(
      `managed Runtime state is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const state = result.data;
  const storePaths: Array<[string, string | undefined]> = [
    ["active.storePath", state.active?.storePath],
    ["previous.storePath", state.previous?.storePath],
    ["activation.candidate.storePath", state.activation.candidate?.storePath],
    ["activation.previous.storePath", state.activation.previous?.storePath],
    ["failure.storePath", state.failure?.storePath],
    ["observed.currentStorePath", state.observed?.currentStorePath],
  ];
  for (const [field, storePath] of storePaths) {
    if (storePath === undefined) continue;
    try {
      assertManagedStorePath(storePath);
    } catch (error) {
      throw new ManagedRuntimeStateError(
        `managed Runtime state field ${field} contains an invalid store path: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return state;
}

/** Canonical JSON text suitable for an atomic state-file write. */
export function canonicalManagedRuntimeStateText(state: ManagedRuntimeState): string {
  return stableStringify(state);
}

export function readManagedRuntimeState(stateFile: string): ManagedRuntimeState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagedRuntimeStateError(
      `managed Runtime state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ManagedRuntimeStateError(
      `managed Runtime state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseManagedRuntimeState(value);
}

export function writeManagedRuntimeState(
  stateFile: string,
  state: ManagedRuntimeState,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): void {
  const validated = parseManagedRuntimeState(state);
  replaceFileAtomically(
    stateFile,
    `${canonicalManagedRuntimeStateText(validated)}\n`,
    boundaries,
    "managed-runtime-state-write",
    { mode: 0o600 },
  );
}

/** Read the exact physical consumer-selection pointer; never infer from a store listing. */
export function readManagedRuntimePointer(currentPointer: string): string | undefined {
  try {
    const stat = fs.lstatSync(currentPointer);
    if (!stat.isSymbolicLink()) {
      throw new ManagedRuntimeStateError("managed Runtime current pointer is not a symlink");
    }
    const target = fs.readlinkSync(currentPointer);
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(currentPointer), target);
    return assertManagedStorePath(resolved);
  } catch (error) {
    if (error instanceof ManagedRuntimeStateError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ManagedRuntimeStateError(
      `managed Runtime current pointer cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function syncDirectory(directory: string, boundaries: BoundaryOperations, operation: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = boundaries.file(`${operation}.directory.open`, () => fs.openSync(directory, "r"));
    boundaries.file(`${operation}.directory.sync`, () => fs.fsyncSync(descriptor!));
  } catch {
    // Filesystem implementations that do not support directory fsync still
    // retain the rename atomicity guarantee; the pointer rename itself is
    // intentionally not downgraded to a non-atomic write.
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the pointer operation result.
      }
    }
  }
}

/** Replace `current` with a temporary symlink + same-directory atomic rename. */
export function atomicallySelectManagedRuntimeGeneration(
  currentPointer: string,
  storePath: string,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): void {
  const target = assertManagedStorePath(storePath);
  const directory = path.dirname(currentPointer);
  boundaries.file("managed-runtime-pointer.directory.create", () => fs.mkdirSync(directory, { recursive: true }));
  try {
    const existing = fs.lstatSync(currentPointer);
    if (!existing.isSymbolicLink()) {
      throw new ManagedRuntimeStateError("managed Runtime current pointer is not a symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${currentPointer}.tmp-${randomUUID()}`;
  try {
    boundaries.file("managed-runtime-pointer.temp.create", () => fs.symlinkSync(target, temporary));
    boundaries.file("managed-runtime-pointer.rename", () => fs.renameSync(temporary, currentPointer));
    syncDirectory(directory, boundaries, "managed-runtime-pointer");
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best effort cleanup; the existing current pointer was not replaced if rename failed.
    }
    throw new ManagedRuntimeStateError(
      `managed Runtime current pointer activation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove an unproven initial pointer; no managed generation is promoted by this operation. */
export function clearManagedRuntimePointer(
  currentPointer: string,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): void {
  try {
    const stat = fs.lstatSync(currentPointer);
    if (!stat.isSymbolicLink()) {
      throw new ManagedRuntimeStateError("managed Runtime current pointer is not a symlink");
    }
    boundaries.file("managed-runtime-pointer.clear", () => fs.unlinkSync(currentPointer));
    syncDirectory(path.dirname(currentPointer), boundaries, "managed-runtime-pointer-clear");
  } catch (error) {
    if (error instanceof ManagedRuntimeStateError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ManagedRuntimeStateError(
      `managed Runtime current pointer clear failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const atomicActivateManagedGeneration = atomicallySelectManagedRuntimeGeneration;
export const atomicSwitchManagedGeneration = atomicallySelectManagedRuntimeGeneration;
export const readManagedRuntimeCurrent = readManagedRuntimePointer;
