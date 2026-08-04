#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { finish, parseArgs, validateBranchName } from "./governance-lib.mjs";

const args = parseArgs(process.argv);
const branch = args.branch || execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
finish(validateBranchName(branch), args.report);
