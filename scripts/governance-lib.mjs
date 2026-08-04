import { readFileSync, writeFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));

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

export function validateIssue(body) {
  const errors = [];
  if (body.trim().length < rules.issue.minimumBodyLength) errors.push(`body must be at least ${rules.issue.minimumBodyLength} characters`);
  for (const heading of rules.issue.requiredSections) {
    if (!meaningful(sectionBody(body, heading))) errors.push(`required section is empty: ${heading}`);
  }
  const acceptance = sectionBody(body, "Acceptance criteria");
  if (!/- \[[ xX]\]\s+\S/.test(acceptance)) errors.push("Acceptance criteria must contain a checklist item");
  return errors;
}

function changed(files, patterns) {
  return files.some((file) => patterns.some((pattern) => new RegExp(pattern).test(file)));
}

function hasCompletedCheckbox(body, item) {
  return body.split(/\r?\n/).some((line) => {
    for (const prefix of [`- [x] ${item}`, `- [X] ${item}`]) {
      if (!line.startsWith(prefix)) continue;
      const suffix = line.slice(prefix.length);
      if (suffix.length === 0 || /^[, ]/.test(suffix)) return true;
    }
    return false;
  });
}

export function extractClosingIssues(body) {
  return [...new Set([...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((match) => Number(match[1])))];
}

export function validatePullRequest({ title, body, draft = false, files = [] }) {
  const errors = [];
  if (!new RegExp(rules.pullRequest.titlePattern).test(title)) errors.push("PR title format or scope is invalid");
  if (body.trim().length < rules.pullRequest.minimumBodyLength) errors.push(`body must be at least ${rules.pullRequest.minimumBodyLength} characters`);
  for (const heading of rules.pullRequest.requiredSections) {
    if (!meaningful(sectionBody(body, heading))) errors.push(`required section is empty: ${heading}`);
  }
  const issues = extractClosingIssues(body);
  if (issues.length !== 1) errors.push("exactly one closing Issue is required");
  if (!draft) {
    for (const item of rules.pullRequest.validationItems) {
      if (!hasCompletedCheckbox(body, item)) errors.push(`Validation must be completed: ${item}`);
    }
    if (changed(files, rules.pullRequest.packageCheckPaths) && !hasCompletedCheckbox(body, "Package check")) {
      errors.push("Validation must be completed: Package check");
    }
  }
  if (!draft && /\b(?:TBD|TODO|FIXME|WIP)\b|<!--\s*required/i.test(body)) errors.push("non-draft PR contains an unfinished placeholder");
  if (!/^(?:No|Yes)(?:[.。:]|\s|$)/i.test(sectionBody(body, "Breaking changes"))) errors.push("Breaking changes must explicitly start with Yes or No");
  const changedFileRules = rules.pullRequest.changedFileRules;
  if (changed(files, changedFileRules.configurationPaths) && !meaningful(sectionBody(body, "Migration / compatibility"))) {
    errors.push("configuration changes require Migration / compatibility");
  }
  if (changed(files, changedFileRules.compressionPaths)) {
    const hasCompressionTest = files.some((file) => /^src\/compress\/.*\.test\.ts$/.test(file));
    if (!hasCompressionTest) errors.push("compression changes require a test change under src/compress");
    if (!/\btransform(?:s|ed|ation|ations)?\b/i.test(body) || !/\bpreserv(?:e|es|ed|ing|ation|ations)?\b|\bunmodified\b/i.test(body)) {
      errors.push("compression changes require validation for transformation and preservation cases");
    }
  }
  if (changed(files, changedFileRules.cliPaths) && !changed(files, changedFileRules.cliEvidencePaths)) errors.push("CLI changes require a README or CLI test change");
  if (changed(files, changedFileRules.securityPaths) && !meaningful(sectionBody(body, "Security impact"))) errors.push("security-related changes require Security impact");
  return { errors, closingIssues: issues };
}

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

export function finish(errors, reportPath) {
  const report = errors.length === 0 ? "## Governance validation\n\nValid." : `## Governance validation failed\n\n${errors.map((error) => `- ${error}`).join("\n")}`;
  if (reportPath) writeFileSync(reportPath, `${report}\n`);
  console.log(report);
  if (errors.length > 0) process.exitCode = 1;
}

export function writeValue(path, value) {
  if (path) writeFileSync(path, `${value}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readLines(path) {
  return path ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean) : [];
}
