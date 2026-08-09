#!/usr/bin/env node
import {
  buildRegressionProofPlan,
  executeRegressionProof,
  finish,
  parseArgs,
  readJson,
  readLines,
  validatePullRequest,
  writeJson,
  writeValue,
} from "./governance-lib.mjs";

const args = parseArgs(process.argv);
if (!args.event) throw new Error("--event is required");
const event = readJson(args.event);
const pullRequest = event.pull_request;
if (!pullRequest) throw new Error("event has no pull_request");
const body = pullRequest.body ?? "";
const files = readLines(args.files);
const result = validatePullRequest({
  title: pullRequest.title ?? "",
  body,
  draft: pullRequest.draft === true,
  files,
});
const regressionProof = buildRegressionProofPlan({
  title: pullRequest.title ?? "",
  body,
  files,
  baseSha: pullRequest.base?.sha,
  headSha: pullRequest.head?.sha,
});
writeJson(args["regression-plan-file"], regressionProof);
const warnings = [...result.warnings];
if (args["run-regression-proof"] === true) {
  if (!args["base-root"] || !args["head-root"]) {
    warnings.push(
      "quality.regression.execution: changed path(s)=none; matched path class/rule=regression-proof; missing evidence=base-root and head-root; how to satisfy=run the fixed runner only from isolated workflow checkouts",
    );
  } else {
    const proof = executeRegressionProof({
      plan: regressionProof,
      baseRoot: args["base-root"],
      headRoot: args["head-root"],
    });
    if (proof.status === "failed" || proof.status === "rejected") {
      warnings.push(
        `quality.regression.execution: changed path(s)=${proof.testPath ?? "none"}; matched path class/rule=regression-proof; missing evidence=${proof.status}; how to satisfy=${proof.output ?? proof.reason}`,
      );
    }
  }
}
writeValue(args["issue-number-file"], result.closingIssues[0] ?? "");
finish(result.errors, args.report, warnings);
