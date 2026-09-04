// Parses the job-level `if:` gates for the decomposed Runtime contract jobs
// (runtime-nix, runtime-vm, runtime-appliance) out of
// .github/workflows/ci.yml and evaluates them against representative
// contract-ownership-changes outputs, so the PR-level job selection
// semantics from docs/ci-topology.md (Issue #767) can be exercised without
// running GitHub Actions.

import fs from "node:fs";

const CI_WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";

function extractJobIfExpression(ciWorkflowText, jobId) {
  const lines = ciWorkflowText.split(/\r?\n/u);
  const jobHeaderPattern = new RegExp(`^  ${jobId}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line) => jobHeaderPattern.test(line));
  if (jobIndex === -1) {
    throw new Error(`could not find job "${jobId}" in ${CI_WORKFLOW_RELATIVE_PATH}`);
  }

  let cursor = jobIndex + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line)) break; // next job
    const singleLine = line.match(/^\s*if:\s*(.+)$/u);
    if (singleLine !== null && !/^>-?\s*$/u.test(singleLine[1])) {
      return singleLine[1].trim();
    }
    const blockStart = line.match(/^(\s*)if:\s*>-\s*$/u);
    if (blockStart !== null) {
      const blockIndent = blockStart[1].length;
      const expressionLines = [];
      for (let index = cursor + 1; index < lines.length; index += 1) {
        const candidate = lines[index];
        if (candidate.trim().length === 0) break;
        const indent = candidate.match(/^(\s*)/u)[1].length;
        if (indent <= blockIndent) break;
        expressionLines.push(candidate.trim());
      }
      return expressionLines.join(" ");
    }
    cursor += 1;
  }

  throw new Error(`could not find an "if:" gate for job "${jobId}"`);
}

export function loadRuntimeContractGateExpressions(repositoryRoot) {
  const ciWorkflowText = fs.readFileSync(`${repositoryRoot}/${CI_WORKFLOW_RELATIVE_PATH}`, "utf8");
  return {
    "runtime-nix": extractJobIfExpression(ciWorkflowText, "runtime-nix"),
    "runtime-vm": extractJobIfExpression(ciWorkflowText, "runtime-vm"),
    "runtime-appliance": extractJobIfExpression(ciWorkflowText, "runtime-appliance"),
  };
}

function extractJobBlock(ciWorkflowText, jobId) {
  const lines = ciWorkflowText.split(/\r?\n/u);
  const jobHeaderPattern = new RegExp(`^  ${jobId}:\\s*$`, "u");
  const jobIndex = lines.findIndex((line) => jobHeaderPattern.test(line));
  if (jobIndex === -1) {
    throw new Error(`could not find job "${jobId}" in ${CI_WORKFLOW_RELATIVE_PATH}`);
  }

  let end = lines.length;
  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }

  return lines.slice(jobIndex, end);
}

// Finds the step whose `- name:` starts with `stepNamePrefix` inside job
// `jobId`, and returns its single-line `if:` expression, or `null` when the
// step has no `if:` at all (meaning it always runs whenever the job runs).
// PR-vs-`main` step content selection (Issue #768's PR/trusted-main tier
// split within the `runtime-appliance` job) lives at this step-level `if:`,
// not the job-level gate `loadRuntimeContractGateExpressions` already covers.
function extractStepIfExpression(ciWorkflowText, jobId, stepNamePrefix) {
  const jobLines = extractJobBlock(ciWorkflowText, jobId);
  const stepIndex = jobLines.findIndex((line) => {
    const match = line.match(/^\s*-\s*name:\s*(.+)$/u);
    return match !== null && match[1].startsWith(stepNamePrefix);
  });
  if (stepIndex === -1) {
    throw new Error(`could not find a step named "${stepNamePrefix}" in job "${jobId}"`);
  }

  const stepIndent = jobLines[stepIndex].match(/^(\s*)-/u)[1].length;
  for (let index = stepIndex + 1; index < jobLines.length; index += 1) {
    const line = jobLines[index];
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/u)[1].length;
    if (indent <= stepIndent && /^\s*-\s*name:/u.test(line)) break;
    if (indent <= stepIndent && !/^\s+/u.test(line)) break;
    const ifMatch = line.match(/^\s*if:\s*(.+)$/u);
    if (ifMatch !== null) return ifMatch[1].trim();
  }

  return null;
}

// Named steps inside the `runtime-appliance` job whose presence/absence
// implements the PR-vs-trusted-`main` composition-tier split (Issue #768):
// the canonical build + bounded manifest steps are PR-tier rejection proof
// and must run whenever the job runs (both an Appliance-defining PR and a
// trusted `main` integration run); the OCI-shaped composition, standalone
// `mottainai-init` composition verification, and Runtime Appliance golden
// path are cross-boundary integration evidence and must be trusted-`main`-only.
export function loadRuntimeApplianceStepGates(repositoryRoot) {
  const ciWorkflowText = fs.readFileSync(`${repositoryRoot}/${CI_WORKFLOW_RELATIVE_PATH}`, "utf8");
  return {
    build: extractStepIfExpression(ciWorkflowText, "runtime-appliance", "Build the canonical, self-bootable Runtime Appliance disk"),
    manifest: extractStepIfExpression(
      ciWorkflowText,
      "runtime-appliance",
      "Generate and verify the bounded Runtime Appliance manifest",
    ),
    ociFixture: extractStepIfExpression(
      ciWorkflowText,
      "runtime-appliance",
      "Build a local OCI-shaped fixture from the real canonical Runtime Appliance",
    ),
    mottainaiInitAndGoldenPath: extractStepIfExpression(
      ciWorkflowText,
      "runtime-appliance",
      "Prove mottainai-init resolves/verifies the real canonical Runtime Appliance",
    ),
  };
}

export function evaluateStepSelection(stepIfExpression, eventName) {
  if (stepIfExpression === null) return true;
  const github = { event_name: eventName };
  const evaluator = new Function("github", `return (${stepIfExpression.replaceAll(/(!=|==)/gu, (op) => (op === "!=" ? "!==" : "==="))});`);
  return Boolean(evaluator(github));
}

function startsWith(value, prefix) {
  return typeof value === "string" && value.startsWith(prefix);
}

// The job `if:` gates are already bare GitHub Actions expressions (no
// `${{ }}` wrapper, matching how GitHub Actions evaluates job-level `if:`).
// Their grammar here is a small, known-bounded subset: `==`/`!=` on string
// literals and dotted identifiers, `&&`/`||`/`!`, parentheses, and
// `startsWith(a, b)` calls. Translating that subset to JavaScript is enough
// to re-evaluate the real expressions without running GitHub Actions.
function evaluateGate(expression, context) {
  // GitHub Actions allows hyphenated bare identifiers after `needs.` (job
  // IDs like `runtime-contract-changes`); JavaScript does not, so rewrite
  // those to bracket access before evaluating as a JS expression.
  const withBracketedJobIds = expression.replaceAll(/needs\.([A-Za-z0-9_-]+)/gu, 'needs["$1"]');
  const translated = withBracketedJobIds.replaceAll(/(!=|==)/gu, (operator) => (operator === "!=" ? "!==" : "==="));
  const evaluator = new Function("needs", "github", "startsWith", `return (${translated});`);
  return Boolean(evaluator(context.needs, context.github, startsWith));
}

export function evaluateRuntimeContractSelection(gateExpressions, scenario) {
  const github = {
    event_name: scenario.eventName,
    actor: scenario.actor ?? "someone",
    event: {
      pull_request: {
        user: { login: scenario.actor ?? "someone" },
        head: { ref: scenario.headRef ?? "feature/x" },
      },
    },
  };

  const runtimeNixSelected = evaluateGate(gateExpressions["runtime-nix"], {
    needs: {
      "runtime-contract-changes": { outputs: scenario.outputs },
    },
    github,
  });

  const needsWithRuntimeNix = {
    "runtime-contract-changes": { outputs: scenario.outputs },
    "runtime-nix": { result: runtimeNixSelected ? "success" : "skipped" },
  };

  const runtimeVmSelected = evaluateGate(gateExpressions["runtime-vm"], { needs: needsWithRuntimeNix, github });
  const runtimeApplianceSelected = evaluateGate(gateExpressions["runtime-appliance"], {
    needs: needsWithRuntimeNix,
    github,
  });

  return {
    "runtime-nix": runtimeNixSelected,
    "runtime-vm": runtimeVmSelected,
    "runtime-appliance": runtimeApplianceSelected,
  };
}
