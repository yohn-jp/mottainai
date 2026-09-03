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
