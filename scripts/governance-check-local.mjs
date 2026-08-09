#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { finish, parseArgs, readLines, validateBranchName, validatePullRequest } from "./governance-lib.mjs";

/**
 * `gh pr create` 前にローカルで governance validation を通すための CLI。
 * validate-pr.mjs は GitHub Actions の pull_request イベント payload を前提にしているため、
 * ローカルの git 状態（未 push の branch/commit）からは直接使えない — これはその代替入力経路。
 * ブランチ名（validate-branch-name.mjs と同じ規則）も合わせて検証する — PR 本文だけ通っても
 * ブランチ名違反で CI が落ちるケースを、同じコマンドで一度に防ぐ。
 */

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveTitle(args) {
  if (typeof args.title === "string") return args.title;
  return git(["log", "-1", "--format=%s"]);
}

function resolveBody(args) {
  if (typeof args["body-file"] === "string") {
    return readLines(args["body-file"]).join("\n");
  }
  if (typeof args.body === "string") return args.body;
  return git(["log", "-1", "--format=%b"]);
}

function resolveFiles(args) {
  if (typeof args.files === "string") return readLines(args.files);
  const base = typeof args.base === "string" ? args.base : "origin/main";
  return git(["diff", "--name-only", `${base}...HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
}

function resolveBranch(args) {
  if (typeof args.branch === "string") return args.branch;
  return git(["branch", "--show-current"]);
}

const args = parseArgs(process.argv);
const result = validatePullRequest({
  title: resolveTitle(args),
  body: resolveBody(args),
  draft: args.draft === true || args.draft === "true",
  files: resolveFiles(args),
});
const errors = [...validateBranchName(resolveBranch(args)), ...result.errors];
finish(errors, args.report, result.warnings);
