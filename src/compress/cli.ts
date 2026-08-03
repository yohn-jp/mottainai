export interface CliCompressOptions {
  command?: string;
}

function commandKind(command: string | undefined): "test" | "git-status" | "build" | "lint" | "git-diff" | undefined {
  if (!command) return undefined;
  if (/\bgit\s+status\b/.test(command)) return "git-status";
  if (/\bgit\s+diff\b/.test(command)) return "git-diff";
  if (/\b(cargo\s+test|pytest|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|vitest|jest)\b/.test(command)) return "test";
  if (/\b(cargo\s+(build|check)|tsc\b|npm\s+(run\s+)?build|pnpm\s+(run\s+)?build)\b/.test(command)) return "build";
  if (/\b(eslint|biome\s+check|cargo\s+clippy|npm\s+(run\s+)?lint|pnpm\s+(run\s+)?lint)\b/.test(command)) return "lint";
  return undefined;
}

function compressTestOutput(input: string): string {
  let omittedSuccesses = 0;
  const kept = input.split("\n").filter((line) => {
    if (/^test .+ \.\.\. ok$/.test(line) || /\bPASSED\b/.test(line) || /^\s*[✓✔]\s/.test(line)) {
      omittedSuccesses += 1;
      return false;
    }
    return true;
  });

  if (omittedSuccesses === 0) return input;
  const marker = `⋯ ${omittedSuccesses} successful test lines omitted ⋯`;
  const summary = kept.findIndex((line) => /test result:|=+ .* (passed|failed|error)/i.test(line));
  if (summary === -1) kept.push(marker);
  else kept.splice(summary, 0, marker);
  return kept.join("\n");
}

function compressGitStatus(input: string): string {
  const lines = input.split("\n");
  const kept = lines.filter((line) => !/^\s+\(use "git (add|restore|checkout|commit)/.test(line));
  const omitted = lines.length - kept.length;
  return omitted === 0 ? input : [...kept, `⋯ ${omitted} git help lines omitted ⋯`].join("\n");
}

function collapseKnownSuccessLines(input: string, pattern: RegExp, label: string): string {
  let omitted = 0;
  const kept = input.split("\n").filter((line) => {
    if (!pattern.test(line)) return true;
    omitted += 1;
    return false;
  });
  return omitted === 0 ? input : [...kept, `⋯ ${omitted} ${label} lines omitted ⋯`].join("\n");
}

function compressBuildOutput(input: string): string {
  return collapseKnownSuccessLines(
    input,
    /^\s*(Compiling|Checking)\s+.+$|^\s*Finished\s+.+$/,
    "build progress",
  );
}

function compressLintOutput(input: string): string {
  return collapseKnownSuccessLines(
    input,
    /^\s*(✔ No problems|Checked \d+ files? in .+|Done in .+)$/,
    "lint success",
  );
}

function collapseStaticBoilerplate(input: string, label: string): string {
  let omitted = 0;
  const kept = input.split("\n").filter((line) => {
    if (!analyzeStaticInformation(line).lowInformation) return true;
    omitted += 1;
    return false;
  });
  return omitted === 0 ? input : [...kept, `⋯ ${omitted} ${label} boilerplate lines omitted ⋯`].join("\n");
}

/** 既知CLIの定型成功出力だけを削減。未知コマンドは無変形。 */
export function compressKnownCliOutput(input: string, options: CliCompressOptions = {}): string {
  switch (commandKind(options.command)) {
    case "test": return collapseStaticBoilerplate(compressTestOutput(input), "test");
    case "git-status": return compressGitStatus(input);
    case "build": return collapseStaticBoilerplate(compressBuildOutput(input), "build");
    case "lint": return collapseStaticBoilerplate(compressLintOutput(input), "lint");
    // diffの削除行・文脈行はデバッグ根拠。定型圧縮しない。
    case "git-diff": return input;
    default: return input;
  }
}
import { analyzeStaticInformation } from "./static-information.js";
