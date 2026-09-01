import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./governance-check-local.mjs", import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? "" };
  }
}

test("governance-check-local passes with a valid title/body/files triple", (t) => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gov-check-")), "body.md");
  t.after(() => fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }));
  fs.writeFileSync(
    bodyFile,
    fs
      .readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE/default.md", import.meta.url), "utf8")
      .replace("Closes #", "Closes #1"),
  );
  const result = run(["--title", "feat(cli): add local governance check", "--body-file", bodyFile, "--files", "/dev/null"]);
  assert.equal(result.exitCode, 0, result.stdout);
});

test("governance-check-local fails on an invalid branch name even when title/body/files are otherwise valid", (t) => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gov-check-")), "body.md");
  t.after(() => fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }));
  fs.writeFileSync(
    bodyFile,
    fs
      .readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE/default.md", import.meta.url), "utf8")
      .replace("Closes #", "Closes #1"),
  );
  const result = run(["--title", "feat(cli): add local governance check", "--body-file", bodyFile, "--files", "/dev/null", "--branch", "no-issue-number-here"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /branch name format is invalid/);
});

test("governance-check-local fails and exits non-zero with an invalid title", (t) => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gov-check-")), "body.md");
  t.after(() => fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }));
  fs.writeFileSync(bodyFile, "not a real body");
  const result = run(["--title", "not a conventional title", "--body-file", bodyFile, "--files", "/dev/null"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Governance validation failed/);
});
