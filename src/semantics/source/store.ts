import { readdir, readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseSemanticSource, SEMANTIC_SOURCE_ROOT } from "./serialization.js";
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
  return target;
}

export async function persistSemanticMutation(rootDir: string, result: SemanticMutationResult): Promise<void> {
  if (!result.ok)
    throw new Error(
      `cannot persist rejected semantic mutation: ${result.diagnostics.map((item) => item.code).join(",")}`,
    );
  const root = resolve(rootDir);
  for (const write of result.writes) {
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
