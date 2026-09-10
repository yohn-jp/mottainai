#!/usr/bin/env node
import { finish, parseArgs, readJson, readLines } from "./governance-lib.mjs";
import { validateProductChecks } from "./product-pr-checks-lib.mjs";

const args = parseArgs(process.argv);
if (!args.event) throw new Error("--event is required");
const event = readJson(args.event);
const pullRequest = event.pull_request;
if (!pullRequest) throw new Error("event has no pull_request");
const result = validateProductChecks({
  body: pullRequest.body ?? "",
  draft: pullRequest.draft === true,
  files: readLines(args.files),
});
finish(result.errors, args.report);
