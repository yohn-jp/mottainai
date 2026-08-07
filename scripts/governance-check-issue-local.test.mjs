import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./governance-check-issue-local.mjs", import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? "" };
  }
}

const validIssueBody = [
  "## Summary",
  "A concrete summary of the proposed change.",
  "## Problem",
  "The reproducible problem and supporting evidence.",
  "## Goal",
  "A specific state that defines completion.",
  "## Non-goals",
  "Explicitly excluded work.",
  "## Acceptance criteria",
  "- [ ] A verifiable condition is met",
  "## Affected areas",
  "Affected components and users.",
  "## Risks / compatibility",
  "Compatibility considerations and risks.",
  "## Dependencies",
  "No dependencies; this rationale is explicit.",
  "## Implementation notes",
  "Constraints, proposed approach, and completed investigation.",
].join("\n");

test("governance-check-issue-local passes with all required sections present", (t) => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gov-issue-check-")), "body.md");
  t.after(() => fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }));
  fs.writeFileSync(bodyFile, validIssueBody);
  const result = run(["--body-file", bodyFile]);
  assert.equal(result.exitCode, 0, result.stdout);
});

test("governance-check-issue-local fails and names the missing section when Implementation notes is omitted", (t) => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gov-issue-check-")), "body.md");
  t.after(() => fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true }));
  fs.writeFileSync(bodyFile, validIssueBody.replace(/## Implementation notes[^]*$/, ""));
  const result = run(["--body-file", bodyFile]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Implementation notes/);
});
