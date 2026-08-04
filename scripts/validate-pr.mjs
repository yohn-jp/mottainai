#!/usr/bin/env node
import { finish, parseArgs, readJson, readLines, validatePullRequest, writeValue } from "./governance-lib.mjs";

const args = parseArgs(process.argv);
if (!args.event) throw new Error("--event is required");
const event = readJson(args.event);
const pullRequest = event.pull_request;
if (!pullRequest) throw new Error("event has no pull_request");
const result = validatePullRequest({
  title: pullRequest.title ?? "",
  body: pullRequest.body ?? "",
  draft: pullRequest.draft === true,
  files: readLines(args.files),
});
writeValue(args["issue-number-file"], result.closingIssues[0] ?? "");
finish(result.errors, args.report);
