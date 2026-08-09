import { readdir, readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
import type { SnapshotValidationResult } from "../ir/types.js";
import type { SemanticMutationResult } from "../mutations/types.js";

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

export async function loadSemanticSource(rootDir: string): Promise<SnapshotValidationResult> {
  const root = resolve(rootDir);
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
    };
  }
  return parseSemanticSource(files);
}

function targetPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const prefix = `${root}/`;
  if (target !== root && !target.startsWith(prefix))
    throw new Error(`semantic source path escapes repository root: ${relativePath}`);
  const normalized = relative(root, target).split("\\").join("/");
  if (normalized !== relativePath) throw new Error(`semantic source path is not canonical: ${relativePath}`);
  return target;
}

export async function persistSemanticMutation(rootDir: string, result: SemanticMutationResult): Promise<void> {
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
    const target = targetPath(root, write.path);
    if (write.operation === "delete") {
      try {
        await unlink(target);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      continue;
    }
    if (write.content === undefined) throw new Error(`semantic source write has no content: ${write.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.content, "utf8");
  }
}
