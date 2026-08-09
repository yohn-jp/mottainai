#!/usr/bin/env node
import {
  buildRegressionProofPlan,
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
writeValue(args["issue-number-file"], result.closingIssues[0] ?? "");
finish(result.errors, args.report, result.warnings);
