import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));
const inariIssuesDir = new URL("../.github/inari/issues/", import.meta.url);
const inariIssueTemplates = readdirSync(inariIssuesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, inariIssuesDir), "utf8")))
  .map((template) => ({
    id: template.id,
    sections: Array.isArray(template.sections) ? template.sections : [],
  }));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionBody(markdown, heading) {
  const escaped = escapeRegExp(heading);
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => new RegExp(`^(#{2,3})\\s+${escaped}\\s*$`, "i").test(line));
  if (headingIndex === -1) return "";
  const level = lines[headingIndex].match(/^#+/)?.[0].length;
  const boundary = new RegExp(`^#{2,${level}}\\s+`);
  const content = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (boundary.test(line)) break;
    content.push(line);
  }
  return content.join("\n").trim();
}

function isPlaceholder(value) {
  return value.length === 0 || /^(?:n\/?a|none|tbd|todo|not applicable|<!--.*-->)\.?$/is.test(value);
}

function meaningful(value) {
  return !isPlaceholder(value.replace(/<!--[^]*?-->/g, "").trim());
}

function changed(files, patterns) {
  return files.some((file) => patterns.some((pattern) => new RegExp(pattern).test(file)));
}

function hasCompletedCheckbox(body, item) {
  return body.split(/\r?\n/).some((line) => {
    for (const prefix of [`- [x] ${item}`, `- [X] ${item}`, `\\- [x] ${item}`, `\\- [X] ${item}`]) {
      if (!line.startsWith(prefix)) continue;
      const suffix = line.slice(prefix.length);
      if (suffix.length === 0 || /^[, ]/.test(suffix)) return true;
    }
    return false;
  });
}

function bodyHeadings(body) {
  return new Set(
    body
      .split(/\r?\n/)
      .map((line) => /^#{2,3}\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((heading) => heading !== undefined),
  );
}

/**
 * The repository has multiple Issue-form templates (bug, feature,
 * architecture, maintenance, research) with disjoint required fields, so no
 * single fixed heading list can validate every Issue. The Inari templates
 * are the shape authority: pick the template whose required labels are all
 * present as headings in the body, preferring the template with the most
 * required labels when more than one matches (the more specific template).
 */
function matchIssueTemplate(body) {
  const headings = bodyHeadings(body);
  let best;
  for (const template of inariIssueTemplates) {
    const required = template.sections
      .filter((section) => section?.required === true)
      .map((section) => section.label)
      .filter((label) => typeof label === "string" && label.trim().length > 0);
    if (required.length === 0) continue;
    if (!required.every((label) => headings.has(label))) continue;
    if (best === undefined || required.length > best.required.length) best = { template, required };
  }
  return best;
}

export function validateIssue(body) {
  const errors = [];
  if (body.trim().length < rules.issue.minimumBodyLength)
    errors.push(`body must be at least ${rules.issue.minimumBodyLength} characters`);

  const match = matchIssueTemplate(body);
  if (match === undefined) {
    errors.push(
      `Issue body does not match any Inari issue template's required sections (${inariIssueTemplates.map((template) => template.id).join(", ")})`,
    );
    return errors;
  }
  for (const heading of match.required) {
    if (!meaningful(sectionBody(body, heading))) errors.push(`required section is empty: ${heading}`);
  }
  const acceptance = sectionBody(body, "Acceptance criteria");
  if (!/- \[[ xX]\]\s+\S/.test(acceptance)) errors.push("Acceptance criteria must contain a checklist item");
  return errors;
}

export function extractClosingIssues(body) {
  return [
    ...new Set(
      [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((match) => Number(match[1])),
    ),
  ];
}

export function validatePullRequest({ title, body, draft = false, files = [] }) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
  if (!new RegExp(rules.pullRequest.titlePattern).test(title)) errors.push("PR title format or scope is invalid");
  if (body.trim().length < rules.pullRequest.minimumBodyLength)
    errors.push(`body must be at least ${rules.pullRequest.minimumBodyLength} characters`);

  // Inari owns PR headings, fields, and the fixed Validation checklist.
  // Mottainai owns only shared metadata and conditional product-specific gates.

  const issues = extractClosingIssues(body);
  if (issues.length !== 1) errors.push("exactly one closing Issue is required");

  if (!draft) {
    // This conditional gate is Mottainai-specific; it is not an Inari fixed
    // checklist item and does not add a PR-template section.
    if (changed(files, rules.pullRequest.packageCheckPaths) && !hasCompletedCheckbox(body, "Package check")) {
      errors.push("Validation must be completed: Package check");
    }
  }

  const changedFileRules = rules.pullRequest.changedFileRules;
  if (changed(files, changedFileRules.compressionPaths)) {
    const hasCompressionTest = changed(files, changedFileRules.compressionTestPaths);
    if (!hasCompressionTest)
      errors.push("compression changes require a test change under configured compression test paths");
    if (
      !/\btransform(?:s|ed|ation|ations)?\b/i.test(body) ||
      !/\bpreserv(?:e|es|ed|ing|ation|ations)?\b|\bunmodified\b/i.test(body)
    ) {
      errors.push("compression changes require validation for transformation and preservation cases");
    }
  }
  if (changed(files, changedFileRules.cliPaths) && !changed(files, changedFileRules.cliEvidencePaths))
    errors.push("CLI changes require a README or CLI test change");

  return {
    errors,
    warnings,
    diagnostics,
    closingIssues: issues,
    regressionProof: { status: "retired", reason: "PR body regression-proof contract retired in favor of Inari + CI" },
  };
}

export function validateBranchName(branch) {
  return new RegExp(rules.pullRequest.branchPattern).test(branch) ? [] : ["branch name format is invalid"];
}

/** Compatibility exports for callers from the retired report-only proof path. */
export function buildRegressionProofPlan() {
  return { status: "retired", reason: "PR body regression-proof contract retired in favor of Inari + CI" };
}

export function executeRegressionProof() {
  return { status: "skipped", reason: "PR body regression-proof contract retired in favor of Inari + CI" };
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
