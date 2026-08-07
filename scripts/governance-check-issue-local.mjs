#!/usr/bin/env node
import { finish, parseArgs, readLines, validateIssue } from "./governance-lib.mjs";

/**
 * `gh issue create` 前にローカルで governance validation を通すための CLI。
 * validate-issue.mjs は GitHub Actions の issues イベント payload を前提にしているため、
 * ローカルの下書き markdown からは直接使えない — これはその代替入力経路。
 */

const args = parseArgs(process.argv);
if (!args["body-file"] && !args.body) throw new Error("--body-file or --body is required");
const body = args["body-file"] ? readLines(args["body-file"]).join("\n") : args.body;
finish(validateIssue(body), args.report);
