import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { digestCanonicalValue } from "../ir/canonical.js";
import { compareRepositorySnapshots } from "../diff/index.js";
import { parseSemanticTransaction } from "../ir/serialize.js";
import { validateSnapshot } from "../ir/schema.js";
import type {
  ContentDigest,
  RepositorySemanticSnapshot,
  SemanticDiagnostic,
  SemanticTransaction,
  IntegrityStatus,
} from "../ir/types.js";
import {
  parseSemanticSource,
  serializeSemanticSource,
  serializeSemanticTransactionSource,
  SEMANTIC_SOURCE_ROOT,
  SEMANTIC_TRANSACTION_SOURCE_ROOT,
  type SemanticSourceWrite,
} from "../source/index.js";
import type { SemanticIntegrityReport } from "./types.js";

export interface SemanticSourceInspection extends SemanticIntegrityReport {
  snapshot?: RepositorySemanticSnapshot;
  baselineSnapshot?: RepositorySemanticSnapshot;
  transactions: readonly SemanticTransaction[];
}

function diagnostic(code: string, message: string, path?: string): SemanticDiagnostic {
  return { code, severity: "error", message, ...(path === undefined ? {} : { path }) };
}

function digestBytes(value: Buffer): ContentDigest {
  return { algorithm: "sha256", value: createHash("sha256").update(value).digest("hex") };
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

async function readSourceFiles(rootDir: string): Promise<SemanticSourceWrite[]> {
  const root = resolve(rootDir);
  const files: SemanticSourceWrite[] = [];
  await collectJsonFiles(join(root, SEMANTIC_SOURCE_ROOT), root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function mapWrites(writes: readonly SemanticSourceWrite[]): Map<string, SemanticSourceWrite> {
  return new Map(writes.map((write) => [write.path, write]));
}

function changedCanonicalPaths(before: RepositorySemanticSnapshot, after: RepositorySemanticSnapshot): string[] {
  const beforeMap = mapWrites(serializeSemanticSource(before));
  const afterMap = mapWrites(serializeSemanticSource(after));
  const paths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  return [...paths].sort().filter((path) => beforeMap.get(path)?.content !== afterMap.get(path)?.content);
}

function transactionMatches(
  transaction: SemanticTransaction | undefined,
  transactions: readonly SemanticTransaction[],
): boolean {
  if (transaction === undefined) return false;
  const digest = digestCanonicalValue(transaction).value;
  return transactions.some((candidate) => digestCanonicalValue(candidate).value === digest);
}

function transactionAuthorizesChange(
  before: RepositorySemanticSnapshot,
  after: RepositorySemanticSnapshot,
  transactions: readonly SemanticTransaction[],
): boolean {
  return transactions.some((candidate) => {
    try {
      const change = compareRepositorySnapshots(before, after, { transaction: candidate });
      return (
        change.authorizedVsActual.actualKinds.length > 0 &&
        change.authorizedVsActual.status === "matched" &&
        !change.authorizedVsActual.unauthorized
      );
    } catch {
      return false;
    }
  });
}

function baselineFromGit(
  rootDir: string,
  baselineRef?: string,
  environment: NodeJS.ProcessEnv = {},
): RepositorySemanticSnapshot | undefined {
  try {
    const configuredRef = baselineRef?.trim();
    const environmentRef = environment.GITHUB_BASE_REF?.trim();
    const candidates = [
      ...(configuredRef === undefined || configuredRef.length === 0 ? [] : [configuredRef, `origin/${configuredRef}`]),
      ...(environmentRef === undefined || environmentRef.length === 0 ? [] : [`origin/${environmentRef}`, environmentRef]),
      "origin/main",
      "main",
      "HEAD^",
    ];
    let revision: string | undefined;
    for (const candidate of candidates) {
      try {
        revision = execFileSync("git", ["merge-base", "HEAD", candidate], {
          cwd: rootDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (revision.length > 0) break;
      } catch {
        // Try the next locally available base. CI checkouts may be shallow.
      }
    }
    if (revision === undefined || revision.length === 0) return undefined;
    const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", `${SEMANTIC_SOURCE_ROOT}/`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (paths.length === 0) return undefined;
    const files: SemanticSourceWrite[] = paths.map((path) => ({
      path,
      operation: "write",
      content: execFileSync("git", ["show", `${revision}:${path}`], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    }));
    const parsed = parseSemanticSource(files);
    return parsed.ok ? parsed.snapshot : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the canonical semantic source and compare its bytes with the serializer output.
 * A valid-but-hand-edited JSON document is still a direct edit when it is not accompanied
 * by a supported transaction. This is deliberately a source boundary check, not a second
 * semantic parser or classifier.
 */
export async function inspectSemanticSource(options: {
  rootDir: string;
  baselineRef?: string;
  environment?: NodeJS.ProcessEnv;
  baselineSnapshot?: RepositorySemanticSnapshot;
  transaction?: SemanticTransaction;
  supportedMutation?: boolean;
}): Promise<SemanticSourceInspection> {
  const rootDir = resolve(options.rootDir);
  const diagnostics: SemanticDiagnostic[] = [];
  const directEdits: string[] = [];
  const staleReasons: string[] = [];
  let files: SemanticSourceWrite[] = [];
  try {
    files = await readSourceFiles(rootDir);
  } catch (error) {
    return {
      status: "invalid",
      sourceAvailable: false,
      sourceCanonical: false,
      directEdits: [],
      staleReasons: [],
      diagnostics: [
        diagnostic(
          "semantic_source_unavailable",
          error instanceof Error ? error.message : "semantic source could not be read",
        ),
      ],
      transactions: [],
    };
  }

  const parsed = parseSemanticSource(files);
  if (!parsed.ok) {
    const integrityMismatch = parsed.diagnostics.some((item) => item.code === "integrity_digest_mismatch");
    const direct = integrityMismatch
      ? files.filter((file) => !file.path.startsWith(`${SEMANTIC_TRANSACTION_SOURCE_ROOT}/`)).map((file) => file.path)
      : [];
    return {
      status: "invalid",
      sourceAvailable: true,
      sourceCanonical: false,
      directEdits: direct,
      staleReasons: [],
      diagnostics: integrityMismatch
        ? [
            ...parsed.diagnostics,
            diagnostic("direct_canonical_edit", "semantic source digest anchor does not match canonical state"),
          ]
        : parsed.diagnostics,
      transactions: [],
    };
  }
  const snapshot = parsed.snapshot;
  const expected = mapWrites(serializeSemanticSource(snapshot));
  const actual = mapWrites(files);
  const canonicalPaths = new Set(expected.keys());
  const sourcePaths = new Set(
    files.filter((file) => !file.path.startsWith(`${SEMANTIC_TRANSACTION_SOURCE_ROOT}/`)).map((file) => file.path),
  );
  for (const path of [...new Set([...canonicalPaths, ...sourcePaths])].sort()) {
    if (expected.get(path)?.content !== actual.get(path)?.content) directEdits.push(path);
  }

  const transactions: SemanticTransaction[] = [];
  for (const file of files.filter((item) => item.path.startsWith(`${SEMANTIC_TRANSACTION_SOURCE_ROOT}/`))) {
    const parsedTransaction = parseSemanticTransaction(file.content ?? "");
    if (!parsedTransaction.ok) {
      diagnostics.push(...parsedTransaction.diagnostics.map((item) => ({ ...item, path: file.path })));
      continue;
    }
    const expectedWrite = serializeSemanticTransactionSource(parsedTransaction.transaction);
    if (expectedWrite.path !== file.path || expectedWrite.content !== file.content) {
      directEdits.push(file.path);
      diagnostics.push(
        diagnostic("non_canonical_semantic_transaction", "transaction file is not canonical", file.path),
      );
    }
    transactions.push(parsedTransaction.transaction);
  }

  const baselineSnapshot =
    options.baselineSnapshot ?? baselineFromGit(rootDir, options.baselineRef, options.environment);
  if (baselineSnapshot !== undefined) {
    const changed = changedCanonicalPaths(baselineSnapshot, snapshot);
    const supported =
      options.supportedMutation ||
      transactionMatches(options.transaction, transactions) ||
      transactionAuthorizesChange(baselineSnapshot, snapshot, transactions);
    if (changed.length > 0 && !supported) {
      directEdits.push(...changed);
      diagnostics.push(
        diagnostic(
          "direct_canonical_edit",
          "canonical semantic state changed without a transaction written through the supported mutation path",
        ),
      );
    }
  }

  if (snapshot.integrity.status !== "fresh") {
    staleReasons.push(snapshot.integrity.statusReason ?? `semantic source is ${snapshot.integrity.status}`);
  }
  if (directEdits.length > 0) {
    diagnostics.push(
      diagnostic(
        "direct_canonical_edit",
        `canonical semantic source differs from deterministic serialization: ${[...new Set(directEdits)].sort().join(", ")}`,
      ),
    );
  }
  const uniqueEdits = [...new Set(directEdits)].sort();
  const status: IntegrityStatus = diagnostics.some((item) => item.code !== "direct_canonical_edit")
    ? "invalid"
    : uniqueEdits.length > 0 || snapshot.integrity.status !== "fresh"
      ? "stale"
      : "fresh";
  return {
    status,
    sourceAvailable: true,
    sourceCanonical: uniqueEdits.length === 0,
    directEdits: uniqueEdits,
    staleReasons,
    diagnostics: [
      ...new Map(diagnostics.map((item) => [`${item.code}:${item.path ?? ""}:${item.message}`, item])).values(),
    ],
    snapshot,
    ...(baselineSnapshot === undefined ? {} : { baselineSnapshot }),
    transactions,
    snapshotDigest: snapshot.integrity.snapshotDigest,
  };
}

/** Re-check physical/Git identity against the #53 extractor's integrity facts. */
export function assessSnapshotIntegrity(
  rootDir: string | undefined,
  snapshot: RepositorySemanticSnapshot,
): SemanticIntegrityReport {
  const diagnostics: SemanticDiagnostic[] = [];
  const staleReasons: string[] = [];
  if (snapshot.integrity.status === "invalid") {
    diagnostics.push(diagnostic("invalid_semantic_snapshot", "snapshot integrity is invalid"));
  }
  const root = rootDir === undefined ? undefined : resolve(rootDir);
  if (root !== undefined && existsSync(root)) {
    const expectedFiles = new Map(snapshot.integrity.trackedFiles.map((file) => [file.path, file]));
    for (const [path, expected] of expectedFiles) {
      const absolute = join(root, path);
      try {
        const current = digestBytes(readFileSync(absolute));
        if (
          current.value !== expected.physicalFingerprint.value ||
          current.algorithm !== expected.physicalFingerprint.algorithm
        )
          staleReasons.push(`tracked file changed: ${path}`);
      } catch {
        staleReasons.push(`tracked file unavailable: ${path}`);
      }
    }
    const git = (args: string[]): string | undefined => {
      try {
        return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return undefined;
      }
    };
    const revision = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    if (
      snapshot.integrity.git?.revision !== undefined &&
      revision !== undefined &&
      snapshot.integrity.git.revision !== revision
    )
      staleReasons.push("Git revision changed since semantic extraction");
    if (snapshot.integrity.git?.tree !== undefined && tree !== undefined && snapshot.integrity.git.tree !== tree)
      staleReasons.push("Git tree changed since semantic extraction");
  }
  const status: IntegrityStatus =
    diagnostics.length > 0
      ? "invalid"
      : staleReasons.length > 0 || snapshot.integrity.status !== "fresh"
        ? "stale"
        : "fresh";
  return {
    status,
    sourceAvailable: true,
    sourceCanonical: true,
    directEdits: [],
    staleReasons: [...new Set(staleReasons)].sort(),
    diagnostics,
    snapshotDigest: snapshot.integrity.snapshotDigest,
  };
}

export function validateSnapshotIntegrity(snapshot: RepositorySemanticSnapshot): SemanticDiagnostic[] {
  const validation = validateSnapshot(snapshot);
  return validation.ok ? [] : validation.diagnostics;
}
