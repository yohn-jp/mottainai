import { createHash, randomUUID } from "node:crypto";
import { link, open, readdir, readFile, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  parseSemanticSource,
  serializeSemanticSource,
  serializeSemanticTransactionSource,
  SEMANTIC_REPOSITORY_FILE,
  SEMANTIC_SOURCE_ROOT,
  SEMANTIC_TRANSACTION_SOURCE_ROOT,
} from "./serialization.js";
import { validateSnapshot, validateSemanticTransaction } from "../ir/schema.js";
import type { SemanticSourceWrite } from "./serialization.js";
import type { SemanticDiagnostic, SnapshotValidationResult } from "../ir/types.js";
import type { SemanticMutationResult } from "../mutations/types.js";

/**
 * These paths live beside (not inside) SEMANTIC_SOURCE_ROOT deliberately: a committed
 * consuming repository tracks only the canonical declaration/relation/transaction files at
 * their stable paths (git-diff-friendly, one file per declared entity), so the write-ahead
 * journal, staging area, and lock used to make a multi-file commit atomic must stay outside
 * that tree. Any of the three surviving on disk is transient, recoverable, and safe to ignore
 * or delete by hand; a consuming repository should gitignore them.
 */
const SEMANTIC_MOTTAINAI_ROOT = ".mottainai";
const SEMANTIC_STAGING_ROOT = ".mottainai/.semantics-staging";
const SEMANTIC_JOURNAL_FILE = ".mottainai/.semantics-journal.json";
const SEMANTIC_LOCK_DIR = ".mottainai/.semantics.lock";
const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 20;

interface JournalWriteOperation {
  kind: "write";
  targetPath: string;
  stagingPath: string;
}
interface JournalDeleteOperation {
  kind: "delete";
  targetPath: string;
}
type JournalOperation = JournalWriteOperation | JournalDeleteOperation;

interface SemanticCommitJournal {
  version: 1;
  createdAt: string;
  operations: readonly JournalOperation[];
}

interface SemanticLockOwner {
  version: 1;
  token: string;
  pid: number;
  startedAt: number;
  processStartTime?: string;
}

interface SemanticLockRemovalClaim {
  version: 1;
  token: string;
  pid: number;
  processStartTime?: string;
}

function diagnostic(code: string, message: string): SemanticDiagnostic {
  return { code, severity: "error", message };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort: directory fsync is unsupported on some platforms (notably Windows). */
async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability of the directory entry itself is a hardening best-effort here, not a
    // correctness requirement: the write-ahead journal is what makes recovery deterministic.
  }
}

async function collectJsonFiles(directory: string, root: string, output: SemanticSourceWrite[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonFiles(absolute, root, output);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    output.push({
      path: relative(root, absolute).split("\\").join("/"),
      operation: "write",
      content: await readFile(absolute, "utf8"),
    });
  }
}

/** Shared by computeSemanticSourceFingerprint and loadSemanticSourceWithFingerprint: both must
 *  agree byte-for-byte, since one produces the compare-and-swap baseline and the other verifies
 *  against it. A NUL separator would be neater, but keeping this to plain, easily-inspectable
 *  characters avoids any risk of a control character surviving a JSON/string round-trip mangled. */
function fingerprintOf(files: readonly SemanticSourceWrite[]): string {
  const serialized = files
    .map((file) => `${file.path.length}:${file.path}=${(file.content ?? "").length}:${file.content ?? ""}`)
    .sort()
    .join(";");
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * A content-addressed fingerprint of everything currently on disk under SEMANTIC_SOURCE_ROOT
 * (declarations, relations, repository.json, and transaction history). This is the
 * compare-and-swap key: a transaction captures it when it loads the source, then
 * `persistSemanticMutation` re-derives it immediately before committing and refuses to
 * proceed if the two disagree, because that means some other writer already committed here.
 */
export async function computeSemanticSourceFingerprint(rootDir: string): Promise<string> {
  const root = resolve(rootDir);
  const files: SemanticSourceWrite[] = [];
  try {
    await collectJsonFiles(resolve(root, SEMANTIC_SOURCE_ROOT), root, files);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return fingerprintOf(files);
}

/**
 * Loads the on-disk source and reports the exact fingerprint of the bytes that were read, in a
 * single directory scan. `applySemanticTransaction` uses this (rather than `loadSemanticSource`
 * plus a separate `computeSemanticSourceFingerprint` call) so the base digest it later hands to
 * `persistSemanticMutation` for compare-and-swap really is the digest of the state the in-memory
 * mutation was built on, with no second-read gap in between.
 */
export async function loadSemanticSourceWithFingerprint(
  rootDir: string,
): Promise<SnapshotValidationResult & { fingerprint: string }> {
  const root = resolve(rootDir);
  await recoverPendingCommit(root);
  const files: SemanticSourceWrite[] = [];
  try {
    await collectJsonFiles(resolve(root, SEMANTIC_SOURCE_ROOT), root, files);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "semantic_source_unavailable",
          severity: "error",
          message: error instanceof Error ? error.message : "semantic source could not be read",
        },
      ],
      fingerprint: fingerprintOf([]),
    };
  }
  return { ...parseSemanticSource(files), fingerprint: fingerprintOf(files) };
}

export async function loadSemanticSource(rootDir: string): Promise<SnapshotValidationResult> {
  const { fingerprint: _fingerprint, ...result } = await loadSemanticSourceWithFingerprint(rootDir);
  return result;
}

function targetPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix))
    throw new Error(`semantic source path escapes repository root: ${relativePath}`);
  const normalized = relative(root, target).split("\\").join("/");
  if (normalized !== relativePath) throw new Error(`semantic source path is not canonical: ${relativePath}`);
  return target;
}

/** Idempotent: replaying an operation whose staging file (or delete target) is already gone is a no-op. */
async function applyJournalOperation(root: string, operation: JournalOperation): Promise<void> {
  const target = targetPath(root, operation.targetPath);
  if (operation.kind === "delete") {
    try {
      await unlink(target);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    return;
  }
  const staging = resolve(root, operation.stagingPath);
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(staging, target);
  } catch (error) {
    if (!isEnoent(error)) throw error; // ENOENT: a prior (possibly crashed) attempt already applied this rename.
  }
  await fsyncDir(dirname(target));
}

/**
 * Self-healing crash recovery: if a prior `persistSemanticMutation` call was killed after it
 * made its journal durable but before it finished replaying every rename/unlink in it, this
 * finishes the job deterministically. A crash before the journal existed leaves nothing to
 * recover (the pre-transaction state is still fully intact); a crash after the journal existed
 * always converges forward to the fully-committed post-transaction state, never a torn mix.
 * Called both before persisting (so a writer never builds on a half-applied prior commit) and
 * before loading (so a plain reader also observes a converged state).
 */
async function recoverPendingCommit(root: string): Promise<void> {
  const journalPath = resolve(root, SEMANTIC_JOURNAL_FILE);
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  let journal: SemanticCommitJournal;
  try {
    journal = JSON.parse(raw) as SemanticCommitJournal;
  } catch (error) {
    // A journal is published with temp-file+rename+fsync. If it is nevertheless unreadable,
    // recovery cannot prove whether any operation from it has already been replayed. Preserve
    // the evidence and fail closed rather than converting an ambiguous state into an apparently
    // clean source.
    throw new Error(
      `semantic commit journal is corrupt and requires manual recovery: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  for (const operation of journal.operations) await applyJournalOperation(root, operation);
  await unlink(journalPath).catch((error) => {
    if (!isEnoent(error)) throw error;
  });
}

async function writeJournalDurably(root: string, journal: SemanticCommitJournal): Promise<void> {
  const journalPath = resolve(root, SEMANTIC_JOURNAL_FILE);
  const tempPath = `${journalPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(journal), "utf8");
  await fsyncFile(tempPath);
  await rename(tempPath, journalPath);
  await fsyncDir(dirname(journalPath));
}

interface LockHandle {
  token: string;
  release(): Promise<void>;
}

async function processStartTime(pid: number): Promise<string | undefined> {
  // Linux exposes a monotonic process-start token in /proc/<pid>/stat. It prevents a recycled
  // PID from being mistaken for the original owner. Other supported platforms do not expose an
  // equivalent through Node's portable API, so a live PID remains conservatively non-abandoned.
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return undefined;
    const fields = stat
      .slice(closingParen + 1)
      .trim()
      .split(/\s+/u);
    return fields[19];
  } catch {
    return undefined;
  }
}

async function readLockOwner(lockPath: string): Promise<SemanticLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")) as Partial<SemanticLockOwner>;
    if (
      parsed.version !== 1 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.startedAt !== "number"
    )
      return undefined;
    return parsed as SemanticLockOwner;
  } catch {
    // Missing or partially-written owner metadata means the successful mkdir owner is still
    // initializing. It is never evidence that the lock is abandoned.
    return undefined;
  }
}

async function publishLockOwner(lockPath: string, owner: SemanticLockOwner): Promise<void> {
  const ownerPath = resolve(lockPath, "owner.json");
  const tempPath = `${ownerPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(owner), "utf8");
  await fsyncFile(tempPath);
  await rename(tempPath, ownerPath);
  await fsyncDir(lockPath);
}

function lockRemovalClaimPath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.removing`;
}

function lockQuarantinePath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.quarantine`;
}

async function claimLockGeneration(lockPath: string, expectedToken: string): Promise<boolean> {
  const claimPath = lockRemovalClaimPath(lockPath, expectedToken);
  const claim: SemanticLockRemovalClaim = {
    version: 1,
    token: expectedToken,
    pid: process.pid,
    processStartTime: await processStartTime(process.pid),
  };
  const tempPath = `${claimPath}.${randomUUID()}.tmp`;
  try {
    // Publish the claim from a fully-written, fsynced temporary file through a hard link. The
    // link is atomic and no-replace, so two recovery actors cannot both claim one generation.
    await writeFile(tempPath, JSON.stringify(claim), "utf8");
    await fsyncFile(tempPath);
    await link(tempPath, claimPath);
    await unlink(tempPath);
    await fsyncDir(dirname(claimPath));
    return true;
  } catch (error) {
    await unlink(tempPath).catch((cleanupError) => {
      if (!isEnoent(cleanupError)) throw cleanupError;
    });
    if (errorCode(error) !== "EEXIST") throw error;
  }

  let existing: Partial<SemanticLockRemovalClaim>;
  try {
    existing = JSON.parse(await readFile(claimPath, "utf8")) as Partial<SemanticLockRemovalClaim>;
  } catch {
    // A claim is published with O_EXCL. A partial claim is treated as live until manual
    // recovery can identify its owner; it is never stolen eagerly.
    return false;
  }
  if (
    existing.version !== 1 ||
    existing.token !== expectedToken ||
    !Number.isInteger(existing.pid) ||
    (existing.processStartTime !== undefined && typeof existing.processStartTime !== "string")
  )
    return false;
  if (!(await isProcessAbandoned(existing.pid!, existing.processStartTime))) return false;
  await unlink(claimPath).catch((unlinkError) => {
    if (!isEnoent(unlinkError)) throw unlinkError;
  });
  return claimLockGeneration(lockPath, expectedToken);
}

async function removeLockGeneration(lockPath: string, expectedToken: string): Promise<void> {
  if (!(await claimLockGeneration(lockPath, expectedToken))) return;
  const claimPath = lockRemovalClaimPath(lockPath, expectedToken);
  const quarantinePath = lockQuarantinePath(lockPath, expectedToken);
  let completed = false;
  try {
    const owner = await readLockOwner(lockPath);
    if (owner?.token !== expectedToken) {
      const quarantinedOwner = await readLockOwner(quarantinePath);
      if (quarantinedOwner?.token === expectedToken) await rm(quarantinePath, { recursive: true, force: true });
      completed = true;
      return;
    }
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if (!isEexist(error)) {
        if (!isEnoent(error)) throw error;
        const quarantinedOwner = await readLockOwner(quarantinePath);
        if (quarantinedOwner?.token === expectedToken) await rm(quarantinePath, { recursive: true, force: true });
        completed = true;
        return;
      }
      const quarantinedOwner = await readLockOwner(quarantinePath);
      if (quarantinedOwner?.token !== expectedToken) throw error;
      await rm(quarantinePath, { recursive: true, force: true });
      await rename(lockPath, quarantinePath);
    }
    const quarantinedOwner = await readLockOwner(quarantinePath);
    if (quarantinedOwner?.token !== expectedToken) throw new Error("semantic lock quarantine token mismatch");
    await rm(quarantinePath, { recursive: true, force: true });
    completed = true;
  } catch (error) {
    if (isEnoent(error)) {
      completed = true;
      return;
    }
    throw error;
  } finally {
    if (completed)
      await unlink(claimPath).catch((unlinkError) => {
        if (!isEnoent(unlinkError)) throw unlinkError;
      });
  }
}

/**
 * A `mkdir` (non-recursive) is an atomic test-and-set on every POSIX filesystem: exactly one
 * concurrent caller observes success, every other caller observes EEXIST. That property is what
 * makes the compare-and-swap in `persistSemanticMutation` race-free: the fingerprint check and
 * the commit it guards run inside the same held lock, so no second writer can commit in between.
 * A lock left behind by a killed process is detected from its owner PID (and, on Linux, the
 * process-start token) and broken so persistence recovers after a crash. Age is deliberately not
 * destructive authority: a live writer may legitimately hold the lock through a long fsync,
 * debugger pause, or host suspension.
 */
async function acquireSemanticSourceLock(root: string): Promise<LockHandle | undefined> {
  await mkdir(resolve(root, SEMANTIC_MOTTAINAI_ROOT), { recursive: true });
  const lockPath = resolve(root, SEMANTIC_LOCK_DIR);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  const token = randomUUID();
  const owner: SemanticLockOwner = {
    version: 1,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    processStartTime: await processStartTime(process.pid),
  };
  for (;;) {
    try {
      await mkdir(lockPath);
      try {
        await publishLockOwner(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return {
        token,
        release: async () => {
          await removeLockGeneration(lockPath, token).catch(() => {});
        },
      };
    } catch (error) {
      if (!isEexist(error)) throw error;
      const observedOwner = await readLockOwner(lockPath);
      if (observedOwner !== undefined && (await isLockAbandoned(observedOwner))) {
        await removeLockGeneration(lockPath, observedOwner.token).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function isLockAbandoned(owner: SemanticLockOwner): Promise<boolean> {
  return isProcessAbandoned(owner.pid, owner.processStartTime);
}

async function isProcessAbandoned(pid: number, expectedProcessStartTime?: string): Promise<boolean> {
  try {
    process.kill(pid, 0); // Signal 0: existence probe only, does not actually signal.
  } catch (error) {
    return errorCode(error) === "ESRCH"; // Owning process no longer exists.
  }
  if (expectedProcessStartTime === undefined) return false;
  const currentProcessStartTime = await processStartTime(pid);
  return currentProcessStartTime !== undefined && currentProcessStartTime !== expectedProcessStartTime;
}

/** @internal Test-only access to the cross-process lock protocol. */
export async function acquireSemanticSourceLockForTest(rootDir: string): Promise<LockHandle | undefined> {
  return acquireSemanticSourceLock(resolve(rootDir));
}

/** @internal Test-only simulation of a recovery actor that already proved the generation stale. */
export async function removeSemanticSourceLockGenerationForTest(rootDir: string, token: string): Promise<void> {
  await removeLockGeneration(resolve(rootDir, SEMANTIC_LOCK_DIR), token);
}

export interface PersistSemanticMutationOptions {
  /** The fingerprint captured when the transaction's base snapshot was loaded from disk. */
  expectedBaseFingerprint?: string;
}

export type SemanticPersistOutcome = { ok: true } | { ok: false; diagnostics: readonly SemanticDiagnostic[] };

const CONFLICT_DIAGNOSTIC = diagnostic(
  "semantic_persist_conflict",
  "semantic source changed on disk since this transaction loaded its base state; reload and retry",
);

const LOCK_TIMEOUT_DIAGNOSTIC = diagnostic(
  "semantic_persist_conflict",
  "semantic source is held by another concurrent writer and did not release in time; retry",
);

export async function persistSemanticMutation(
  rootDir: string,
  result: SemanticMutationResult,
  options: PersistSemanticMutationOptions = {},
): Promise<SemanticPersistOutcome> {
  if (!result.ok)
    throw new Error(
      `cannot persist rejected semantic mutation: ${result.diagnostics.map((item) => item.code).join(",")}`,
    );
  const snapshotValidation = validateSnapshot(result.snapshot);
  if (!snapshotValidation.ok)
    throw new Error(
      `cannot persist invalid semantic snapshot: ${snapshotValidation.diagnostics.map((item) => item.code).join(",")}`,
    );
  const transactionValidation = validateSemanticTransaction(result.transaction);
  if (!transactionValidation.ok)
    throw new Error(
      `cannot persist invalid semantic transaction: ${transactionValidation.diagnostics.map((item) => item.code).join(",")}`,
    );
  const transactionWrite = serializeSemanticTransactionSource(transactionValidation.transaction);
  const canonicalWrites = new Map<string, SemanticSourceWrite>([
    ...serializeSemanticSource(snapshotValidation.snapshot).map((write) => [write.path, write] as const),
    [transactionWrite.path, transactionWrite],
  ]);
  const root = resolve(rootDir);
  const sourcePrefix = `${SEMANTIC_SOURCE_ROOT}/`;
  const mutationPrefixes = [
    `${SEMANTIC_SOURCE_ROOT}/declarations/`,
    `${SEMANTIC_SOURCE_ROOT}/relations/`,
    `${SEMANTIC_TRANSACTION_SOURCE_ROOT}/`,
  ];
  for (const write of result.writes) {
    if (!write.path.startsWith(sourcePrefix))
      throw new Error(`semantic source write must stay under ${SEMANTIC_SOURCE_ROOT}: ${write.path}`);
    if (write.path === SEMANTIC_REPOSITORY_FILE || !mutationPrefixes.some((prefix) => write.path.startsWith(prefix)))
      throw new Error(`semantic mutation write is outside the declared mutation boundary: ${write.path}`);
    const canonical = canonicalWrites.get(write.path);
    if (write.operation === "write") {
      if (canonical?.operation !== "write" || canonical.content !== write.content)
        throw new Error(`semantic mutation write is not canonical: ${write.path}`);
    } else if (canonical !== undefined) {
      throw new Error(`semantic mutation delete would remove canonical state: ${write.path}`);
    }
    targetPath(root, write.path); // Validated eagerly so a boundary violation always throws, lock or not.
    if (write.operation === "write" && write.content === undefined)
      throw new Error(`semantic source write has no content: ${write.path}`);
  }

  if (result.writes.length === 0) return { ok: true };

  const lock = await acquireSemanticSourceLock(root);
  if (lock === undefined) return { ok: false, diagnostics: [LOCK_TIMEOUT_DIAGNOSTIC] };
  try {
    await recoverPendingCommit(root);

    if (options.expectedBaseFingerprint !== undefined) {
      const currentFingerprint = await computeSemanticSourceFingerprint(root);
      if (currentFingerprint !== options.expectedBaseFingerprint) {
        return { ok: false, diagnostics: [CONFLICT_DIAGNOSTIC] };
      }
    }

    const stagingDir = resolve(root, SEMANTIC_STAGING_ROOT, randomUUID());
    try {
      const operations: JournalOperation[] = [];
      for (const write of result.writes) {
        if (write.operation === "delete") {
          operations.push({ kind: "delete", targetPath: write.path });
          continue;
        }
        const suffix = write.path.slice(SEMANTIC_SOURCE_ROOT.length + 1);
        const stagingPath = resolve(stagingDir, suffix);
        await mkdir(dirname(stagingPath), { recursive: true });
        await writeFile(stagingPath, write.content ?? "", "utf8");
        await fsyncFile(stagingPath);
        await fsyncDir(dirname(stagingPath));
        operations.push({
          kind: "write",
          targetPath: write.path,
          stagingPath: relative(root, stagingPath).split("\\").join("/"),
        });
      }

      // From here the transaction is durable and irreversible: the journal fully describes the
      // commit, so any crash from this point on is finished (never undone) by recoverPendingCommit.
      await writeJournalDurably(root, { version: 1, createdAt: new Date().toISOString(), operations });
      for (const operation of operations) await applyJournalOperation(root, operation);
      await unlink(resolve(root, SEMANTIC_JOURNAL_FILE)).catch((error) => {
        if (!isEnoent(error)) throw error;
      });
      return { ok: true };
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await lock.release();
  }
}
