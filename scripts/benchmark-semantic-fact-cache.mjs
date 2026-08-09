import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { FileSystemSemanticFactCache } from "../src/semantics/cache/index.ts";
import { compileRepositoryModel } from "../src/semantics/model/compiler.ts";

// Keep the measurement bounded and reproducible while exercising the same #50
// TypeScript producer and #53 model compiler used by the live repository path.
const repositoryRoot = resolve(fileURLToPath(new URL("../src/semantics/fixtures/typescript", import.meta.url)));
const cacheRoot = mkdtempSync(join(tmpdir(), "mottainai-semantic-cache-benchmark-"));

try {
  const cache = new FileSystemSemanticFactCache({ rootDir: cacheRoot });
  const measure = () => {
    const startedAt = performance.now();
    const result = compileRepositoryModel({ rootDir: repositoryRoot, cache });
    return {
      wallMs: performance.now() - startedAt,
      compileMs: result.benchmark.compileMs,
      cacheStatus: result.benchmark.cacheStatus,
      cacheHit: result.benchmark.cacheHit ?? false,
      factCounts: result.benchmark.factCounts,
    };
  };

  const cold = measure();
  const warm = measure();
  console.log(JSON.stringify({
    benchmark: "semantic-fact-cache",
    producer: "typescript-symbol-facts",
    consumer: "repository-model-compiler",
    root: repositoryRoot,
    cold,
    warm,
    compileSpeedup: cold.compileMs / Math.max(warm.compileMs, Number.EPSILON),
    wallSpeedup: cold.wallMs / Math.max(warm.wallMs, Number.EPSILON),
  }, null, 2));
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
