import type { RunResult } from "../../subprocess.js";
import type { ManagedCheckDefinition } from "./registry.js";

const DEFAULT_MAX_DIAGNOSTIC_LINES = 40;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 4_000;

/**
 * issue #184 の「bounded retrievable failure detail」: 失敗時に model へ渡すのは
 * stderr/stdout の末尾を bounded に切り出した診断だけ。完全な raw 出力は呼び出し側が
 * `ArtifactStore` へ保存した `artifactRef` から明示的に取得する（既定では渡さない）。
 */
export function boundedFailureDiagnostics(
  result: Pick<RunResult, "stdout" | "stderr">,
  maxLines: number = DEFAULT_MAX_DIAGNOSTIC_LINES,
  maxBytes: number = DEFAULT_MAX_DIAGNOSTIC_BYTES,
): string[] {
  const source = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const lines = source.split("\n").filter((line) => line.length > 0);
  const tail = lines.slice(-maxLines);
  const bounded: string[] = [];
  let bytes = 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > maxBytes) break;
    bounded.unshift(line);
    bytes += lineBytes;
  }
  return bounded;
}

export function executionOutcomeSummary(
  check: ManagedCheckDefinition,
  passed: boolean,
  result: Pick<RunResult, "exitCode" | "timedOut" | "outputLimit" | "spawnError">,
  durationMs: number,
): string {
  if (result.spawnError !== undefined) return `${check.id} could not start: ${result.spawnError}`;
  if (result.timedOut) return `${check.id} timed out after ${durationMs}ms`;
  if (result.outputLimit) return `${check.id} exceeded the bounded output limit`;
  return passed
    ? `${check.id} passed in ${durationMs}ms`
    : `${check.id} failed with exit code ${result.exitCode ?? "unknown"} after ${durationMs}ms`;
}

export function combinedOutputText(result: Pick<RunResult, "stdout" | "stderr">): string {
  const parts = [result.stdout, result.stderr].filter((part) => part.trim().length > 0);
  return parts.join("\n\n");
}
