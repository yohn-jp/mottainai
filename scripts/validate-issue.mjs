#!/usr/bin/env node
import { finish, parseArgs, readJson, validateIssue } from "./governance-lib.mjs";

const args = parseArgs(process.argv);
let body = "";
if (args.event) body = readJson(args.event).issue?.body ?? "";
else if (args.body) body = readJson(args.body).body ?? "";
else throw new Error("--event or --body is required");
finish(validateIssue(body), args.report);
