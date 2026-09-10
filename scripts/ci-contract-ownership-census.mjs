// Proves that every tracked executable or governed path is both classified and
// connected to a real required CI gate (Issue #875). A path class by itself
// is not protection: this census checks the class-to-job ownership graph and
// the deliberately separate workflows that own governance, CodeQL, and Review
// Pages execution.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { loadContractOwnershipClasses, matchesPattern } from "./ci-contract-ownership.mjs";

const CI_WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";
const GOVERNANCE_WORKFLOW_RELATIVE_PATH = ".github/workflows/governance.yml";

export const EXEMPT_PATH_PATTERNS = Object.freeze([
  "docs/**",
  "*.md",
  "LICENSE",
  ".github/ISSUE_TEMPLATE/**",
  ".github/PULL_REQUEST_TEMPLATE/**",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".editorconfig",
  ".gitignore",
  ".mcp.json",
  ".claude/**",
  "mise.toml",
  ".mottainai/workflow.json",
  "mottainai.config.json.example",
  "pnpm-workspace.yaml",
  "release/deployment-provider-profile-linux-x86_64.json",
]);

export const CI_CLASS_GATE_CONSUMERS = Object.freeze({
  host_bootstrap: ["host-bootstrap"],
  runtime_nix: ["runtime-nix"],
  runtime_vm: ["runtime-vm"],
  runtime_appliance: ["runtime-appliance"],
  node: ["typescript-ci", "static-integrity"],
  integration: ["test-integration"],
  package: ["build-and-package-e2e"],
});

export const DIRECT_GATE_CONTRACTS = Object.freeze({
  ".github/workflows/codeql.yml": {
    workflow: ".github/workflows/codeql.yml",
    jobs: ["analyze"],
  },
  ".github/codeql/codeql-config.yml": {
    workflow: ".github/workflows/codeql.yml",
    jobs: ["analyze"],
  },
  ".github/workflows/review-pages.yml": {
    workflow: ".github/workflows/review-pages.yml",
    jobs: ["generate", "publish"],
  },
});

export function isExemptPath(filePath) {
  return EXEMPT_PATH_PATTERNS.some((pattern) => matchesPattern(pattern, filePath));
}

export function listTrackedFiles(repositoryRoot) {
  return execFileSync("git", ["ls-files"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
}

function jobBlocks(workflowText) {
  const lines = workflowText.split(/\r?\n/u);
  const jobs = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^  ([A-Za-z0-9_.-]+):\s*$/u);
    if (header === null) continue;
    const end = lines.slice(index + 1).findIndex((line) => /^  [A-Za-z0-9_.-]+:\s*$/u.test(line));
    const endIndex = end === -1 ? lines.length : index + 1 + end;
    jobs.set(header[1], lines.slice(index, endIndex).join("\n"));
  }
  return jobs;
}

function hasPullRequestTrigger(workflowText) {
  return /^  pull_request(?:_target)?:/mu.test(workflowText);
}

function directGateIsValid(repositoryRoot, contract) {
  const workflowPath = repositoryRoot + "/" + contract.workflow;
  if (!fs.existsSync(workflowPath)) return false;
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  if (!hasPullRequestTrigger(workflowText)) return false;
  const jobs = jobBlocks(workflowText);
  return contract.jobs.every((job) => jobs.has(job));
}

function ciClassGateIsValid(ciWorkflowText, className, jobs) {
  const blocks = jobBlocks(ciWorkflowText);
  return jobs.every((job) => {
    const block = blocks.get(job);
    return (
      block !== undefined &&
      new RegExp("needs\\.runtime-contract-changes\\.outputs\\." + className + "\\b", "u").test(block)
    );
  });
}

export function findUnconsumedOwnershipClasses(repositoryRoot, { classes, ciWorkflowText } = {}) {
  const resolvedClasses = classes ?? loadContractOwnershipClasses(repositoryRoot);
  const resolvedCiText = ciWorkflowText ?? fs.readFileSync(repositoryRoot + "/" + CI_WORKFLOW_RELATIVE_PATH, "utf8");
  const unconsumed = [];

  for (const className of Object.keys(resolvedClasses)) {
    const ciConsumers = CI_CLASS_GATE_CONSUMERS[className];
    if (ciConsumers !== undefined) {
      if (!ciClassGateIsValid(resolvedCiText, className, ciConsumers)) unconsumed.push(className);
      continue;
    }
    if (className === "governance") {
      const governancePath = repositoryRoot + "/" + GOVERNANCE_WORKFLOW_RELATIVE_PATH;
      const governanceText = fs.readFileSync(governancePath, "utf8");
      const jobs = jobBlocks(governanceText);
      if (
        hasPullRequestTrigger(governanceText) &&
        jobs.has("standards-self-check") &&
        jobs.has("governance") &&
        jobs.has("product-checks")
      ) {
        continue;
      }
    }
    unconsumed.push(className);
  }

  return unconsumed;
}

export function isDirectlyGatedPath(filePath, repositoryRoot) {
  const contract = DIRECT_GATE_CONTRACTS[filePath];
  return contract !== undefined && directGateIsValid(repositoryRoot, contract);
}

function isOwned(classes, filePath) {
  return Object.values(classes).some((patterns) => patterns.some((pattern) => matchesPattern(pattern, filePath)));
}

export function findUnownedTrackedFiles(repositoryRoot, { trackedFiles, classes } = {}) {
  const resolvedClasses = classes ?? loadContractOwnershipClasses(repositoryRoot);
  const resolvedFiles = trackedFiles ?? listTrackedFiles(repositoryRoot);

  return resolvedFiles.filter(
    (filePath) =>
      !isExemptPath(filePath) && !isOwned(resolvedClasses, filePath) && !isDirectlyGatedPath(filePath, repositoryRoot),
  );
}

function main() {
  const repositoryRoot = new URL("..", import.meta.url).pathname;
  const unconsumed = findUnconsumedOwnershipClasses(repositoryRoot);
  if (unconsumed.length > 0) {
    console.error("ci-contract-ownership census: classes without actual CI gate consumers:");
    for (const className of unconsumed) console.error("  - " + className);
    process.exitCode = 1;
    return;
  }

  const unowned = findUnownedTrackedFiles(repositoryRoot);
  if (unowned.length > 0) {
    console.error("ci-contract-ownership census: tracked paths without ownership or a direct required gate:");
    for (const filePath of unowned) console.error("  - " + filePath);
    console.error(
      "Each path must be added to a consumed ownership class, connected to a direct required workflow, " +
        "or added to EXEMPT_PATH_PATTERNS with a documented reason.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("ci-contract-ownership census: every tracked path is owned and every class reaches a required gate.");
}

if (import.meta.url === "file://" + process.argv[1]) {
  main();
}
