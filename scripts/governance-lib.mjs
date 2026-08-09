import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const rules = JSON.parse(readFileSync(new URL("./governance-rules.json", import.meta.url), "utf8"));
const qualityGates = rules.pullRequest.qualityGates;

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

function cleanValue(value) {
  return value
    .replace(/`/g, "")
    .replace(/<!--[^]*?-->/g, "")
    .trim();
}

function normalizeKey(value) {
  return cleanValue(value).toLowerCase().replace(/\s+/g, " ");
}

function normalizeStatus(value) {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[_. ]+/g, "-");
}

function configuredPlaceholder(value) {
  const normalized = cleanValue(value)
    .toLowerCase()
    .replace(/[.。]$/u, "")
    .trim();
  return qualityGates.evidence.placeholderValues.some((placeholder) => normalized === placeholder);
}

function isPlaceholder(value) {
  return value.length === 0 || /^(?:n\/?a|none|tbd|todo|not applicable|<!--.*-->)\.?$/is.test(value);
}

function meaningful(value) {
  return !isPlaceholder(value.replace(/<!--[^]*?-->/g, "").trim());
}

function fieldIssueCode(value, missingCode, placeholderCode) {
  return cleanValue(value).length === 0 ? missingCode : placeholderCode;
}

function hasUnfinishedPlaceholder(body) {
  return body.split(/\r?\n/).some((line) => /^(?:tbd|todo|fixme|wip)(?:\s*[:.-].*)?$/i.test(line.trim()));
}

function parseFieldLines(markdown) {
  const fields = {};
  for (const line of markdown.replace(/<!--[^]*?-->/g, "").split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
    if (!match) continue;
    fields[normalizeKey(match[1])] = cleanValue(match[2]);
  }
  return fields;
}

function parseEvidenceRecord(line) {
  const fields = {};
  const parts = line.replace(/^\s*-\s*/, "").split(/\s*;\s*/);
  for (const part of parts) {
    const match = part.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    fields[normalizeKey(match[1])] = cleanValue(match[2]);
  }
  return { fields, line };
}

function parseEvidenceRecords(body) {
  return sectionBody(body, "Validation evidence")
    .replace(/<!--[^]*?-->/g, "")
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*class\s*:/i.test(line))
    .map(parseEvidenceRecord);
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

function matchingPathClasses(files) {
  return (rules.pullRequest.changedFileRules.pathClasses ?? [])
    .map((rule) => ({
      rule,
      paths: files.filter((file) => rule.patterns.some((pattern) => new RegExp(pattern).test(file))),
    }))
    .filter(({ paths }) => paths.length > 0);
}

function matchingEvidenceRules(matches) {
  const result = new Map();
  for (const { rule, paths } of matches) {
    for (const evidenceClass of rule.requiredEvidence ?? []) {
      const current = result.get(evidenceClass) ?? [];
      result.set(evidenceClass, [...current, { id: rule.id, paths }]);
    }
  }
  return result;
}

function matchingSectionRules(matches) {
  const result = new Map();
  for (const { rule, paths } of matches) {
    for (const section of rule.requiredSections ?? []) {
      const current = result.get(section) ?? [];
      result.set(section, [...current, { id: rule.id, paths }]);
    }
  }
  return result;
}

function matchingSectionConstraints(matches) {
  return matches.flatMap(({ rule, paths }) =>
    (rule.sectionConstraints ?? []).map((constraint) => ({ rule, paths, constraint })),
  );
}

function boundedList(values, limit = 12) {
  const unique = [...new Set(values)];
  if (unique.length <= limit) return unique.join(", ") || "none";
  return `${unique.slice(0, limit).join(", ")} (+${unique.length - limit} more)`;
}

function diagnosticMessage({ code, files, matchedRules, missing, howToSatisfy }) {
  return `${code}: changed path(s)=${boundedList(files)}; matched path class/rule=${boundedList(matchedRules)}; missing evidence=${missing}; how to satisfy=${howToSatisfy}`;
}

function addQualityDiagnostic({
  diagnostics,
  errors,
  warnings,
  mode,
  code,
  files,
  matchedRules,
  missing,
  howToSatisfy,
}) {
  const severity = mode === "enforced" ? "error" : "warning";
  const message = diagnosticMessage({ code, files, matchedRules, missing, howToSatisfy });
  const diagnostic = {
    code,
    severity,
    changedPaths: [...files],
    matchedRules: [...matchedRules],
    missingEvidence: missing,
    howToSatisfy,
    message,
  };
  diagnostics.push(diagnostic);
  if (severity === "error") errors.push(message);
  else warnings.push(message);
}

function evidenceContext(files, triggerRules) {
  return {
    files,
    matchedRules: triggerRules?.map(({ id }) => id) ?? ["generic-change"],
  };
}

function validateSectionFields({
  body,
  section,
  fieldRules,
  files,
  matchedRules,
  mode,
  diagnostics,
  errors,
  warnings,
}) {
  const fields = parseFieldLines(sectionBody(body, section));
  for (const field of fieldRules) {
    const value = fields[field] ?? "";
    const explicitNoImpact =
      section === "Release impact" && field === "impact" && /^(?:none|n\/a|not applicable)$/i.test(value);
    if ((meaningful(value) || explicitNoImpact) && (!configuredPlaceholder(value) || explicitNoImpact)) continue;
    addQualityDiagnostic({
      diagnostics,
      errors,
      warnings,
      mode,
      code: "quality.section-field.missing",
      files,
      matchedRules,
      missing: `${section}.${field}`,
      howToSatisfy: `add a concrete "${field}: ..." field under the ${section} section`,
    });
  }
  return fields;
}

function validateEvidence({ body, files, matches, mode, diagnostics, errors, warnings }) {
  const records = parseEvidenceRecords(body);
  const classes = qualityGates.evidence.classes;
  const knownClasses = new Map(classes.map((item) => [item.id, item]));
  const recordsByClass = new Map();
  for (const record of records) {
    const className = record.fields.class;
    const current = recordsByClass.get(className) ?? [];
    recordsByClass.set(className, [...current, record]);
    if (!knownClasses.has(className)) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.evidence.unknown-class",
        files,
        matchedRules: ["Validation evidence"],
        missing: `known evidence class for ${className || "empty class"}`,
        howToSatisfy: `use one of ${classes.map(({ id }) => id).join(", ")}`,
      });
    }
  }

  const evidenceRules = matchingEvidenceRules(matches);
  for (const evidenceClass of classes) {
    const recordsForClass = recordsByClass.get(evidenceClass.id) ?? [];
    const context = evidenceContext(files, evidenceRules.get(evidenceClass.id));
    if (recordsForClass.length === 0) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.evidence.missing",
        ...context,
        missing: evidenceClass.id,
        howToSatisfy: `add one structured record with class: ${evidenceClass.id}, status, command, target, and result`,
      });
      continue;
    }
    if (recordsForClass.length > 1) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.evidence.duplicate",
        ...context,
        missing: `one record for ${evidenceClass.id}`,
        howToSatisfy: `keep exactly one Validation evidence record for ${evidenceClass.id}`,
      });
      continue;
    }

    const record = recordsForClass[0];
    const status = normalizeStatus(record.fields.status ?? "");
    if (!qualityGates.evidence.statuses.map(normalizeStatus).includes(status)) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.evidence.status",
        ...context,
        missing: `supported status for ${evidenceClass.id}`,
        howToSatisfy: `use status: pass or status: not-applicable`,
      });
      continue;
    }
    if (status === "not-applicable") {
      if (evidenceRules.has(evidenceClass.id)) {
        addQualityDiagnostic({
          diagnostics,
          errors,
          warnings,
          mode,
          code: "quality.evidence.not-applicable-forbidden",
          ...context,
          missing: evidenceClass.id,
          howToSatisfy: `run and record ${evidenceClass.id} because the matched path class requires it; Not applicable is allowed only without that trigger`,
        });
      }
      if (!meaningful(record.fields.reason ?? "") || configuredPlaceholder(record.fields.reason ?? "")) {
        addQualityDiagnostic({
          diagnostics,
          errors,
          warnings,
          mode,
          code: "quality.evidence.placeholder",
          ...context,
          missing: `${evidenceClass.id}.reason`,
          howToSatisfy: `state a concrete reason for why ${evidenceClass.id} is not applicable`,
        });
      }
      continue;
    }

    for (const field of evidenceClass.requiredFields) {
      const value = record.fields[field] ?? "";
      const warningFreeRelease =
        evidenceClass.id === "release" && field === "warnings" && /^(?:none|0|zero|no warnings?)$/i.test(value);
      if (warningFreeRelease || (meaningful(value) && !configuredPlaceholder(value))) continue;
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: fieldIssueCode(value, "quality.evidence.missing", "quality.evidence.placeholder"),
        ...context,
        missing: `${evidenceClass.id}.${field}`,
        howToSatisfy: `replace the placeholder or empty ${field} with concrete evidence for ${evidenceClass.id}`,
      });
    }
    const result = (record.fields.result ?? "")
      .toLowerCase()
      .replace(/[.。]$/u, "")
      .trim();
    if (qualityGates.evidence.genericResults.includes(result)) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.evidence.placeholder",
        ...context,
        missing: `${evidenceClass.id}.result`,
        howToSatisfy: `include a bounded result such as a test count, exit status, or artifact digest instead of a generic ${result} claim`,
      });
    }
    if (evidenceClass.id === "release" && !/^(?:none|0|zero|no warnings?)$/i.test(record.fields.warnings ?? "")) {
      addQualityDiagnostic({
        diagnostics,
        errors,
        warnings,
        mode,
        code: "quality.release.warning-bearing",
        ...context,
        missing: "release.warnings=none",
        howToSatisfy: "record warning-free package metadata or publish dry-run evidence with warnings: none",
      });
    }
  }
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function runnerForPath(testPath) {
  if (!isSafeRelativePath(testPath)) return undefined;
  return qualityGates.regressionProof.runners.find((runner) =>
    runner.testPathPatterns.some((pattern) => new RegExp(pattern).test(testPath)),
  );
}

function evaluateRegressionProof({ title, body, files, baseSha, headSha }) {
  const fields = parseFieldLines(sectionBody(body, "Regression proof"));
  const contractFields = parseFieldLines(sectionBody(body, "Test contract"));
  const isBugFix =
    new RegExp(qualityGates.regressionProof.bugFixTitlePattern, "i").test(title) ||
    /^(?:bug[- ]?fix|fix)$/i.test(contractFields["change type"] ?? "");
  const status = normalizeStatus(fields.status ?? "");
  const plan = {
    status: isBugFix ? "invalid" : "not-applicable",
    isBugFix,
    testPath: fields["test path"] ?? "",
    testIdentifier: fields["test identifier"] ?? "",
    commandId: fields["command id"] ?? "",
    baseSha: typeof baseSha === "string" ? baseSha : "",
    headSha: typeof headSha === "string" ? headSha : "",
    sandbox: qualityGates.regressionProof.execution,
  };
  const issues = [];
  if (!isBugFix) return { plan: { ...plan, status: "not-applicable" }, issues };
  if (!qualityGates.regressionProof.statuses.map(normalizeStatus).includes(status)) {
    issues.push({
      code: "quality.regression.missing",
      missing: "Regression proof.status",
      howToSatisfy: "set a supported regression proof status for this bug-fix PR",
    });
    return { plan, issues };
  }
  if (status === "not-applicable") {
    issues.push({
      code: "quality.regression.not-applicable-forbidden",
      missing: "Regression proof for bug-fix PR",
      howToSatisfy:
        "provide automated, reviewer-attested, or explicitly unsupported proof; Not applicable is not allowed for bug fixes",
    });
    return { plan: { ...plan, status }, issues };
  }
  for (const field of qualityGates.regressionProof.requiredFields) {
    const value = fields[field] ?? "";
    if (meaningful(value) && !configuredPlaceholder(value)) continue;
    issues.push({
      code: fieldIssueCode(value, "quality.regression.missing", "quality.regression.placeholder"),
      missing: `Regression proof.${field}`,
      howToSatisfy: `add a concrete ${field} field`,
    });
  }
  if (status === "automated") {
    for (const field of qualityGates.regressionProof.automatedFields) {
      const value = fields[field] ?? "";
      if (meaningful(value) && !configuredPlaceholder(value)) continue;
      issues.push({
        code: fieldIssueCode(value, "quality.regression.missing", "quality.regression.placeholder"),
        missing: `Regression proof.${field}`,
        howToSatisfy: `add a concrete ${field} field from the fixed runner`,
      });
    }
    const runner = qualityGates.regressionProof.runners.find(({ id }) => id === fields["command id"]);
    if (!runner) {
      issues.push({
        code: "quality.regression.runner",
        missing: `trusted runner for ${fields["command id"] || "empty command id"}`,
        howToSatisfy: `use a command id declared by the trusted base rules: ${qualityGates.regressionProof.runners.map(({ id }) => id).join(", ")}`,
      });
    }
    const testPath = fields["test path"] ?? "";
    if (!runnerForPath(testPath)) {
      issues.push({
        code: "quality.regression.test-path",
        missing: "bounded supported regression test path",
        howToSatisfy:
          "name a changed test path matching a configured fixed runner; path is never executed as a shell command",
      });
    } else if (!files.includes(testPath)) {
      issues.push({
        code: "quality.regression.test-path",
        missing: `changed test path ${testPath}`,
        howToSatisfy:
          "include the declared regression test path in the PR diff or use reviewer-attested unsupported proof",
      });
    }
    if (issues.length === 0) {
      plan.status = "eligible";
      plan.commandId = runner.id;
      plan.argv = [...runner.argv];
    }
  } else if (status === "reviewer-attested") {
    for (const field of qualityGates.regressionProof.reviewerAttestedFields) {
      const value = fields[field] ?? "";
      if (meaningful(value) && !configuredPlaceholder(value)) continue;
      issues.push({
        code: fieldIssueCode(value, "quality.regression.missing", "quality.regression.placeholder"),
        missing: `Regression proof.${field}`,
        howToSatisfy: `add a concrete ${field}`,
      });
    }
    plan.status = issues.length === 0 ? "reviewer-attested" : status;
  } else if (status === "unsupported-automated-proof") {
    for (const field of ["reason", ...qualityGates.regressionProof.reviewerAttestedFields]) {
      const value = fields[field] ?? "";
      if (meaningful(value) && !configuredPlaceholder(value)) continue;
      issues.push({
        code: fieldIssueCode(value, "quality.regression.missing", "quality.regression.placeholder"),
        missing: `Regression proof.${field}`,
        howToSatisfy: `explain why automation is unsupported and add ${field}`,
      });
    }
    plan.status = issues.length === 0 ? "unsupported-automated-proof" : status;
  }
  return { plan, issues };
}

export function buildRegressionProofPlan(input) {
  return evaluateRegressionProof(input).plan;
}

function validateQualityGates({ title, body, draft, files, qualityGateMode, errors, warnings, diagnostics }) {
  if (draft) return { regressionProof: buildRegressionProofPlan({ title, body, files }) };
  const mode = qualityGateMode === "enforced" ? "enforced" : qualityGates.rollout.mode;
  const matches = matchingPathClasses(files);
  const matchedRules = matches.map(({ rule }) => rule.id);
  const evidenceRules = matchingEvidenceRules(matches);

  const testContractFields = validateSectionFields({
    body,
    section: "Test contract",
    fieldRules: qualityGates.testContract.requiredFields,
    files,
    matchedRules: matchedRules.length > 0 ? matchedRules : ["generic-change"],
    mode,
    diagnostics,
    errors,
    warnings,
  });
  validateSectionFields({
    body,
    section: "Release impact",
    fieldRules: qualityGates.releaseImpact.requiredFields,
    files,
    matchedRules: matchedRules.length > 0 ? matchedRules : ["generic-change"],
    mode,
    diagnostics,
    errors,
    warnings,
  });
  validateEvidence({ body, files, matches, mode, diagnostics, errors, warnings });

  for (const { rule, paths, constraint } of matchingSectionConstraints(matches)) {
    const fields = parseFieldLines(sectionBody(body, constraint.section));
    const value = (fields[constraint.field] ?? "").toLowerCase();
    if (!constraint.forbiddenValues.some((forbiddenValue) => value === forbiddenValue)) continue;
    addQualityDiagnostic({
      diagnostics,
      errors,
      warnings,
      mode,
      code: "quality.path.section-value",
      files: paths,
      matchedRules: [rule.id],
      missing: `${constraint.section}.${constraint.field}`,
      howToSatisfy: constraint.howToSatisfy,
    });
  }

  const sectionRules = matchingSectionRules(matches);
  for (const [section, rulesForSection] of sectionRules) {
    if (meaningful(sectionBody(body, section))) continue;
    const sectionFiles = rulesForSection.flatMap(({ paths }) => paths);
    addQualityDiagnostic({
      diagnostics,
      errors,
      warnings,
      mode,
      code: "quality.path.required-section",
      files: sectionFiles,
      matchedRules: rulesForSection.map(({ id }) => id),
      missing: section,
      howToSatisfy: `provide a meaningful ${section} section for the matched path class`,
    });
  }

  const regression = evaluateRegressionProof({ title, body, files });
  for (const issue of regression.issues) {
    addQualityDiagnostic({
      diagnostics,
      errors,
      warnings,
      mode,
      code: issue.code,
      files,
      matchedRules: ["regression-proof"],
      missing: issue.missing,
      howToSatisfy: issue.howToSatisfy,
    });
  }
  return { regressionProof: regression.plan, testContractFields, mode, evidenceRules };
}

function safeEnvironment(root) {
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: root,
    XDG_CONFIG_HOME: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    CI: "true",
    NO_COLOR: "1",
  };
}

function runFixedCommand(argv, cwd, environment, timeout, maxBuffer, input) {
  return execFileSync(argv[0], argv.slice(1), {
    cwd,
    env: environment,
    shell: false,
    timeout,
    maxBuffer,
    input,
    encoding: "utf8",
  });
}

function boundedTail(value, limit = 2000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(-limit);
}

function validCommit(value) {
  return /^[0-9a-f]{40}$/i.test(value);
}

export function executeRegressionProof({ plan, baseRoot, headRoot }) {
  if (plan?.status !== "eligible") return { status: "skipped", reason: plan?.status ?? "no plan" };
  const runner = qualityGates.regressionProof.runners.find(({ id }) => id === plan.commandId);
  if (!runner || !isSafeRelativePath(plan.testPath) || !validCommit(plan.baseSha) || !validCommit(plan.headSha)) {
    return { status: "rejected", reason: "regression proof plan failed trusted-boundary validation" };
  }
  const base = realpathSync(baseRoot);
  const head = realpathSync(headRoot);
  const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "mottainai-regression-"));
  const worktree = path.join(sandboxRoot, "base-with-test-diff");
  const headWorktree = path.join(sandboxRoot, "head");
  const environment = safeEnvironment(sandboxRoot);
  let worktreeAdded = false;
  let headWorktreeAdded = false;
  try {
    runFixedCommand(
      ["git", "-C", base, "worktree", "add", "--detach", worktree, plan.baseSha],
      base,
      environment,
      30_000,
      8_000,
    );
    worktreeAdded = true;
    const names = runFixedCommand(
      [
        "git",
        "-C",
        head,
        "diff",
        "--name-only",
        "--no-ext-diff",
        "--no-renames",
        `${plan.baseSha}...${plan.headSha}`,
        "--",
        plan.testPath,
      ],
      head,
      environment,
      30_000,
      8_000,
    )
      .split(/\r?\n/)
      .filter(Boolean);
    if (names.length !== 1 || names[0] !== plan.testPath)
      return { status: "rejected", reason: "declared test path is not the only changed path in the proof patch" };
    const mode = runFixedCommand(
      ["git", "-C", head, "ls-tree", "-r", "HEAD", "--", plan.testPath],
      head,
      environment,
      30_000,
      8_000,
    )
      .trim()
      .split(/\s+/)[0];
    if (mode !== "100644" && mode !== "100755")
      return { status: "rejected", reason: "declared regression test is not a regular file" };
    const patch = execFileSync(
      "git",
      [
        "-C",
        head,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-renames",
        `${plan.baseSha}...${plan.headSha}`,
        "--",
        plan.testPath,
      ],
      {
        cwd: head,
        env: environment,
        shell: false,
        timeout: 30_000,
        maxBuffer: qualityGates.regressionProof.execution.maxOutputBytes,
        encoding: "buffer",
      },
    );
    runFixedCommand(
      ["git", "-C", worktree, "apply", "--check", "--whitespace=nowarn"],
      worktree,
      environment,
      30_000,
      8_000,
      patch,
    );
    runFixedCommand(
      ["git", "-C", worktree, "apply", "--whitespace=nowarn"],
      worktree,
      environment,
      30_000,
      8_000,
      patch,
    );
    runFixedCommand(
      ["git", "-C", head, "worktree", "add", "--detach", headWorktree, plan.headSha],
      head,
      environment,
      30_000,
      8_000,
    );
    headWorktreeAdded = true;
    runFixedCommand(
      qualityGates.regressionProof.execution.installArgv,
      worktree,
      environment,
      qualityGates.regressionProof.execution.timeoutSeconds * 1000,
      qualityGates.regressionProof.execution.maxOutputBytes,
    );
    let baseOutput = "";
    try {
      baseOutput = runFixedCommand(
        runner.argv,
        worktree,
        environment,
        qualityGates.regressionProof.execution.timeoutSeconds * 1000,
        qualityGates.regressionProof.execution.maxOutputBytes,
      );
      return {
        status: "failed",
        commandId: runner.id,
        testPath: plan.testPath,
        reason: "base revision with only the regression test diff passed; no pre-fix failure was observed",
        output: boundedTail(baseOutput),
      };
    } catch (error) {
      baseOutput = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? error}`;
    }
    runFixedCommand(
      qualityGates.regressionProof.execution.installArgv,
      headWorktree,
      environment,
      qualityGates.regressionProof.execution.timeoutSeconds * 1000,
      qualityGates.regressionProof.execution.maxOutputBytes,
    );
    const headOutput = runFixedCommand(
      runner.argv,
      headWorktree,
      environment,
      qualityGates.regressionProof.execution.timeoutSeconds * 1000,
      qualityGates.regressionProof.execution.maxOutputBytes,
    );
    return {
      status: "passed",
      commandId: runner.id,
      testPath: plan.testPath,
      baseOutput: boundedTail(baseOutput),
      headOutput: boundedTail(headOutput),
    };
  } catch (error) {
    return {
      status: "failed",
      commandId: runner.id,
      testPath: plan.testPath,
      output: boundedTail(`${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? error}`),
    };
  } finally {
    if (worktreeAdded) {
      try {
        runFixedCommand(
          ["git", "-C", base, "worktree", "remove", "--force", worktree],
          base,
          environment,
          30_000,
          8_000,
        );
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    if (headWorktreeAdded) {
      try {
        runFixedCommand(
          ["git", "-C", head, "worktree", "remove", "--force", headWorktree],
          head,
          environment,
          30_000,
          8_000,
        );
      } catch {
        rmSync(headWorktree, { recursive: true, force: true });
      }
    }
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

export function validateIssue(body) {
  const errors = [];
  if (body.trim().length < rules.issue.minimumBodyLength)
    errors.push(`body must be at least ${rules.issue.minimumBodyLength} characters`);
  for (const heading of rules.issue.requiredSections) {
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

export function validatePullRequest({ title, body, draft = false, files = [], qualityGateMode }) {
  const errors = [];
  const warnings = [];
  const diagnostics = [];
  if (!new RegExp(rules.pullRequest.titlePattern).test(title)) errors.push("PR title format or scope is invalid");
  if (body.trim().length < rules.pullRequest.minimumBodyLength)
    errors.push(`body must be at least ${rules.pullRequest.minimumBodyLength} characters`);
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
  if (!draft && hasUnfinishedPlaceholder(body)) errors.push("non-draft PR contains an unfinished placeholder");
  if (!/^(?:No|Yes)(?:[.。:]|\s|$)/i.test(sectionBody(body, "Breaking changes")))
    errors.push("Breaking changes must explicitly start with Yes or No");
  const changedFileRules = rules.pullRequest.changedFileRules;
  if (
    changed(files, changedFileRules.configurationPaths) &&
    !meaningful(sectionBody(body, "Migration / compatibility"))
  ) {
    errors.push("configuration changes require Migration / compatibility");
  }
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
  if (changed(files, changedFileRules.securityPaths) && !meaningful(sectionBody(body, "Security impact")))
    errors.push("security-related changes require Security impact");
  const quality = validateQualityGates({ title, body, draft, files, qualityGateMode, errors, warnings, diagnostics });
  return { errors, warnings, diagnostics, closingIssues: issues, regressionProof: quality.regressionProof };
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

export function finish(errors, reportPath, warnings = []) {
  const sections =
    errors.length === 0
      ? ["## Governance validation", "", "Valid."]
      : ["## Governance validation failed", "", ...errors.map((error) => `- ${error}`)];
  if (warnings.length > 0)
    sections.push("", "## Report-only observations", "", ...warnings.map((warning) => `- ${warning}`));
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
