import { readFileSync, writeFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));

/**
 * Branch-name governance is the one piece of shared repository governance
 * Mottainai owns directly, because it also backs a runtime product feature
 * (src/workflow/governance/branch.ts resolves this same
 * governance-rules.json as the bundled fallback authority for repositories
 * Mottainai governs execution in). Organization-level PR-title, PR-body, and
 * Issue-body contract semantics are owned by the canonical
 * yohn-jp/.github reusable governance workflows instead of being
 * reimplemented here (see .github/workflows/governance.yml).
 */
export function validateBranchName(branch) {
  return new RegExp(rules.pullRequest.branchPattern).test(branch) ? [] : ["branch name format is invalid"];
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

export function finish(errors, reportPath, warnings = []) {
  const sections =
    errors.length === 0
      ? ["## Governance validation", "", "Valid."]
      : ["## Governance validation failed", "", ...errors.map((error) => `- ${error}`)];
  if (warnings.length > 0)
    sections.push("", "## Governance observations", "", ...warnings.map((warning) => `- ${warning}`));
  const report = `${sections.join("\n")}\n`;
  if (reportPath) writeFileSync(reportPath, report);
  console.log(report);
  if (errors.length > 0) process.exitCode = 1;
}

export function writeValue(filePath, value) {
  if (filePath) writeFileSync(filePath, `${value}\n`);
}

export function writeJson(filePath, value) {
  if (filePath) writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readLines(filePath) {
  return filePath ? readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
}
