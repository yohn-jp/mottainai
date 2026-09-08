#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ACTION_ROOTS = Object.freeze([".github/workflows", ".github/actions"]);
const USES_LINE_PATTERN = /^\s*(?:-\s+)?uses:\s*(.*)$/u;
const VALUE_PATTERN = /^(\S+)(?:\s+#.*)?$/u;
const IMMUTABLE_EXTERNAL_ACTION_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
// yohn-jp/.github centrally governs its reusable workflows and composite
// actions: consumers must follow the live @main revision so merged provider
// fixes take effect without per-repository pin churn (Issues #802 and #811).
// A commit-SHA pin on an org-owned resource is therefore rejected, not
// accepted.
const ORG_GOVERNANCE_WORKFLOW_REF_PATTERN =
  /^yohn-jp\/\.github\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@/u;
const ORG_GOVERNANCE_ACTION_REF_PATTERN =
  /^yohn-jp\/\.github\/\.github\/actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@/u;
const ORG_GOVERNANCE_LIVE_REF_PATTERN =
  /^yohn-jp\/\.github\/\.github\/(?:workflows\/[A-Za-z0-9_.-]+\.ya?ml|actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@main$/u;

export function validateActionText(source, filePath = "<text>") {
  const references = [];
  const errors = [];

  source.split(/\r?\n/u).forEach((line, index) => {
    const usesMatch = line.match(USES_LINE_PATTERN);
    if (usesMatch === null) return;

    const lineNumber = index + 1;
    const rawValue = usesMatch[1].trim();
    if (rawValue.length === 0) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": uses reference must be on the same line",
      );
      return;
    }

    const valueMatch = rawValue.match(VALUE_PATTERN);
    if (valueMatch === null) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": uses reference is not a single YAML value",
      );
      return;
    }

    const reference = valueMatch[1];
    const local = reference.startsWith("./");
    references.push({ file: filePath, line: lineNumber, reference, local });
    if (!local && ORG_GOVERNANCE_LIVE_REF_PATTERN.test(reference)) {
      // org-owned resource on @main: accepted, no further checks.
    } else if (!local && ORG_GOVERNANCE_WORKFLOW_REF_PATTERN.test(reference)) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": organization-owned reusable workflow must follow @main, not a commit SHA or other ref: " +
          reference,
      );
    } else if (!local && ORG_GOVERNANCE_ACTION_REF_PATTERN.test(reference)) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": organization-owned composite action must follow @main, not a commit SHA or other ref: " +
          reference,
      );
    } else if (!local && !IMMUTABLE_EXTERNAL_ACTION_PATTERN.test(reference)) {
      errors.push(
        filePath +
          ":" +
          lineNumber +
          ": external GitHub Action must use a full 40-character commit SHA: " +
          reference,
      );
    }
  });

  return { references, errors };
}

// An elevated job in a pull_request-family workflow can inherit write
// permissions from the workflow-level permissions block. The validator must
// reason about effective permissions, not only job-local declarations.
const PULL_REQUEST_TRIGGER_PATTERN =
  /^on:\r?\n(?:.*\r?\n)*?[ \t]{2}pull_request(?:_target)?:/mu;
const JOB_HEADER_PATTERN = /^ {2}([A-Za-z0-9_.-]+):\s*$/u;
const WORKFLOW_PERMISSIONS_PATTERN = /^permissions:\s*(\S.*)?$/u;
const JOB_PERMISSIONS_PATTERN = /^ {4}permissions:\s*(\S.*)?$/u;
const ELEVATED_PERMISSION_VALUE_PATTERN =
  /(?:^|[\s,{:])(write|write-all)(?:$|[\s,}])/u;
const CHECKOUT_USES_PATTERN = /^(\s*)(?:-\s+)?uses:\s*actions\/checkout@/u;
const REF_INPUT_PATTERN = /^\s*ref:\s*(\S.*)$/u;
// Lexical shape is not provenance. In a privileged PR-triggered job, only the
// repository default branch expression is accepted here; arbitrary branch
// names and literal SHAs must be tied to trusted event/repository authority by
// a stronger, explicit mechanism before they can be treated as trusted.
const TRUSTED_ELEVATED_CHECKOUT_REF_PATTERN =
  /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/u;
const UNTRUSTED_ELEVATED_CHECKOUT_REF_PATTERN =
  /pull_request|github\.sha\b|head_ref|head\.sha|head\.ref/u;

function indentOf(line) {
  return line.match(/^(\s*)/u)[1].length;
}

function permissionDeclaration(lines, headerPattern, headerIndent) {
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));
  if (headerIndex === -1) return { declared: false, elevated: false };

  const inlineMatch = lines[headerIndex].match(headerPattern);
  if (inlineMatch?.[1])
    return {
      declared: true,
      elevated: ELEVATED_PERMISSION_VALUE_PATTERN.test(inlineMatch[1]),
    };

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= headerIndent) break;
    if (ELEVATED_PERMISSION_VALUE_PATTERN.test(line.trim()))
      return { declared: true, elevated: true };
  }
  return { declared: true, elevated: false };
}

function workflowIsElevated(lines) {
  return permissionDeclaration(lines, WORKFLOW_PERMISSIONS_PATTERN, 0).elevated;
}

function jobIsElevated(jobLines, workflowElevated) {
  const local = permissionDeclaration(jobLines, JOB_PERMISSIONS_PATTERN, 4);
  return local.declared ? local.elevated : workflowElevated;
}

function findCheckoutRefs(jobLines) {
  const checkouts = [];
  for (let usesIndex = 0; usesIndex < jobLines.length; usesIndex += 1) {
    const usesMatch = jobLines[usesIndex].match(CHECKOUT_USES_PATTERN);
    if (usesMatch === null) continue;

    const usesIndent = indentOf(jobLines[usesIndex]);
    let ref = null;
    let withIndex = -1;
    for (let index = usesIndex + 1; index < jobLines.length; index += 1) {
      const line = jobLines[index];
      if (line.trim().length === 0) continue;
      const indent = indentOf(line);
      if (indent < usesIndent) break;
      if (indent === usesIndent && /^with:\s*$/u.test(line.trim())) {
        withIndex = index;
        break;
      }
      if (indent === usesIndent && CHECKOUT_USES_PATTERN.test(line)) break;
    }
    if (withIndex !== -1) {
      for (let index = withIndex + 1; index < jobLines.length; index += 1) {
        const line = jobLines[index];
        if (line.trim().length === 0) continue;
        if (indentOf(line) <= usesIndent) break;
        const refMatch = line.match(REF_INPUT_PATTERN);
        if (refMatch) {
          ref = refMatch[1].trim();
          break;
        }
      }
    }
    checkouts.push({ ref, lineOffset: usesIndex });
  }
  return checkouts;
}

export function validateElevatedCheckoutRefs(source, filePath = "<text>") {
  const errors = [];
  if (!/^jobs:\s*$/mu.test(source)) return errors;
  if (!PULL_REQUEST_TRIGGER_PATTERN.test(source)) return errors;

  const lines = source.split(/\r?\n/u);
  const workflowElevated = workflowIsElevated(lines);
  const jobHeaders = [];
  lines.forEach((line, index) => {
    const match = line.match(JOB_HEADER_PATTERN);
    if (match) jobHeaders.push({ name: match[1], index });
  });

  for (let jobIndex = 0; jobIndex < jobHeaders.length; jobIndex += 1) {
    const { name, index } = jobHeaders[jobIndex];
    const end =
      jobIndex + 1 < jobHeaders.length
        ? jobHeaders[jobIndex + 1].index
        : lines.length;
    const jobLines = lines.slice(index, end);
    if (!jobIsElevated(jobLines, workflowElevated)) continue;

    for (const checkout of findCheckoutRefs(jobLines)) {
      const lineNumber = index + checkout.lineOffset + 1;
      if (checkout.ref === null) {
        errors.push(
          filePath +
            ":" +
            lineNumber +
            ': job "' +
            name +
            "\" carries an elevated (write) permission but its checkout has no ref: it defaults to the triggering event's " +
            "ref, which for a pull_request event is PR-controlled; pin the repository default branch expression",
        );
        continue;
      }
      if (
        UNTRUSTED_ELEVATED_CHECKOUT_REF_PATTERN.test(checkout.ref) ||
        !TRUSTED_ELEVATED_CHECKOUT_REF_PATTERN.test(checkout.ref)
      ) {
        errors.push(
          filePath +
            ":" +
            lineNumber +
            ': job "' +
            name +
            '" carries an elevated (write) permission but its checkout ref "' +
            checkout.ref +
            '" lacks trusted repository provenance (expected github.event.repository.default_branch)',
        );
      }
    }
  }

  return errors;
}

export function repositoryActionFiles(root) {
  const output = execFileSync("git", ["ls-files", "--", ...ACTION_ROOTS], {
    cwd: path.resolve(root),
    encoding: "utf8",
  });
  return output.split(/\r?\n/u).filter(Boolean);
}

export function validateRepositoryActions(
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const resolvedRoot = path.resolve(root);
  const files = repositoryActionFiles(resolvedRoot);
  const references = [];
  const errors = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(resolvedRoot, file), "utf8");
    const result = validateActionText(text, file);
    references.push(...result.references);
    errors.push(...result.errors);
    if (file.startsWith(".github/workflows/")) {
      errors.push(...validateElevatedCheckoutRefs(text, file));
    }
  }

  return { root: resolvedRoot, files, references, errors };
}

function runAsCommand() {
  const result = validateRepositoryActions();
  if (result.errors.length > 0) {
    console.error("GitHub Action pin validation failed");
    for (const error of result.errors) console.error("- " + error);
    process.exitCode = 1;
    return;
  }

  const externalCount = result.references.filter(
    (reference) => !reference.local,
  ).length;
  const localCount = result.references.filter(
    (reference) => reference.local,
  ).length;
  console.log(
    "GitHub Action pin validation passed: " +
      externalCount +
      " external reference(s), " +
      localCount +
      " local reference(s).",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runAsCommand();
}
