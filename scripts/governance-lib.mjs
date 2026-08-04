import { readFileSync, writeFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = `${markdown}\n## __END__`.match(new RegExp(`^#{2,3}\\s+${escaped}\\s*$([\\s\\S]*?)(?=^#{2,3}\\s+)`, "im"));
  return match?.[1].trim() ?? "";
}

function isPlaceholder(value) {
  return value.length === 0 || /^(?:n\/?a|none|tbd|todo|未定|なし|該当なし|<!--.*-->)\.?$/is.test(value);
}

function meaningful(value) {
  return !isPlaceholder(value.replace(/<!--[^]*?-->/g, "").trim());
}

export function validateIssue(body) {
  const errors = [];
  if (body.trim().length < rules.issue.minimumBodyLength) errors.push(`本文は${rules.issue.minimumBodyLength}文字以上必要`);
  for (const heading of rules.issue.requiredSections) {
    if (!meaningful(sectionBody(body, heading))) errors.push(`必須項目が空: ${heading}`);
  }
  const acceptance = sectionBody(body, "Acceptance criteria");
  if (!/- \[[ xX]\]\s+\S/.test(acceptance)) errors.push("Acceptance criteriaにチェック項目が必要");
  return errors;
}

function changed(files, pattern) {
  return files.some((file) => pattern.test(file));
}

export function extractClosingIssues(body) {
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((match) => Number(match[1]));
}

export function validatePullRequest({ title, body, draft = false, files = [] }) {
  const errors = [];
  if (!new RegExp(rules.pullRequest.titlePattern).test(title)) errors.push("PRタイトル形式またはscopeが不正");
  if (body.trim().length < rules.pullRequest.minimumBodyLength) errors.push(`本文は${rules.pullRequest.minimumBodyLength}文字以上必要`);
  for (const heading of rules.pullRequest.requiredSections) {
    if (!meaningful(sectionBody(body, heading))) errors.push(`必須項目が空: ${heading}`);
  }
  const issues = [...new Set(extractClosingIssues(body))];
  if (issues.length !== 1) errors.push("Closes対象は1件必要");
  for (const item of rules.pullRequest.validationItems) {
    if (!new RegExp(`- \\[[ xX]\\] ${item}(?:$|[, ])`, "m").test(body)) errors.push(`Validation項目がない: ${item}`);
  }
  if (!draft && /\b(?:TBD|TODO|FIXME|WIP)\b|\[記入|<!--\s*(?:required|必須)/i.test(body)) errors.push("非Draft PRに未完了プレースホルダーあり");
  if (!/^(?:No|Yes)(?:[.。:]|\s|$)/i.test(sectionBody(body, "Breaking changes"))) errors.push("Breaking changesはYes/Noで明示必要");
  if (changed(files, /^(?:src\/config\.ts|mottainai\.config)/) && !meaningful(sectionBody(body, "Migration / compatibility"))) errors.push("設定変更にはMigration / compatibilityが必要");
  if (changed(files, /^src\/compress\//)) {
    const hasCompressionTest = files.some((file) => /^src\/compress\/.*\.test\.ts$/.test(file));
    if (!hasCompressionTest) errors.push("圧縮変更にはsrc/compress配下のテスト変更が必要");
    if (!/短縮|compress(?:ed|ion)|変換/i.test(body) || !/無変形|変換されない|preserv/i.test(body)) errors.push("圧縮変更は短縮例と無変形例の検証記述が必要");
  }
  if (changed(files, /^package\.json$/) && !/- \[[xX]\] Package check(?:$|[, ])/m.test(body)) errors.push("package.json変更時はPackage check実施必須");
  if (changed(files, /^(?:src\/index\.ts|scripts\/mcp\.ts)$/) && !files.some((file) => file === "README.md" || /(?:cli|index).*\.test\.ts$/.test(file))) errors.push("CLI変更にはREADMEまたはCLIテスト変更が必要");
  if (changed(files, /(?:security|auth|sandbox|local-tools)/i) && !meaningful(sectionBody(body, "Security impact"))) errors.push("security関連変更にはSecurity impactが必要");
  return { errors, closingIssues: issues };
}

export function validateBranchName(branch) {
  return new RegExp(rules.pullRequest.branchPattern).test(branch) ? [] : ["ブランチ名形式が不正"];
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
