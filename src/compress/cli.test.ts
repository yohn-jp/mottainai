import assert from "node:assert/strict";
import { test } from "node:test";
import { compressKnownCliOutput } from "./cli.js";

test("compressKnownCliOutput collapses successful cargo test lines and preserves failure and summary", () => {
  const input = [
    "test parser::ok ... ok",
    "test parser::bad ... FAILED",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored",
  ].join("\n");

  assert.equal(compressKnownCliOutput(input, { command: "cargo test" }), [
    "test parser::bad ... FAILED",
    "⋯ 1 successful test lines omitted ⋯",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored",
  ].join("\n"));
});

test("compressKnownCliOutput collapses complete pytest PASSED result lines", () => {
  const input = [
    "test_math.py::test_add PASSED",
    "test_math.py::test_sub[case-1] PASSED [ 50%]",
    "test_math.py::test_div FAILED",
  ].join("\n");

  assert.equal(compressKnownCliOutput(input, { command: "pytest" }), [
    "test_math.py::test_div FAILED",
    "⋯ 2 successful test lines omitted ⋯",
  ].join("\n"));
});

test("compressKnownCliOutput keeps diagnostic lines that merely mention PASSED", () => {
  const input = [
    "test_math.py::test_add PASSED",
    "error: expected PASSED, received FAILED",
  ].join("\n");

  assert.equal(compressKnownCliOutput(input, { command: "pytest" }), [
    "error: expected PASSED, received FAILED",
    "⋯ 1 successful test lines omitted ⋯",
  ].join("\n"));
});

test("compressKnownCliOutput removes git status help only", () => {
  const input = [
    "On branch main",
    "Changes not staged for commit:",
    "  (use \"git add <file>...\" to update what will be committed)",
    "\tmodified: src/a.ts",
  ].join("\n");

  assert.equal(compressKnownCliOutput(input, { command: "git status" }), [
    "On branch main",
    "Changes not staged for commit:",
    "\tmodified: src/a.ts",
    "⋯ 1 git help lines omitted ⋯",
  ].join("\n"));
});

test("compressKnownCliOutput leaves unknown commands unchanged", () => {
  assert.equal(compressKnownCliOutput("important output", { command: "kubectl get pods" }), "important output");
});

test("compressKnownCliOutput collapses cargo build progress but preserves diagnostics", () => {
  const input = [
    "   Compiling dep v1.0.0",
    "    Checking app v0.1.0",
    "warning: unused variable",
    "    Finished `dev` profile [unoptimized] target(s) in 1.2s",
  ].join("\n");

  assert.equal(compressKnownCliOutput(input, { command: "cargo build" }), [
    "warning: unused variable",
    "⋯ 3 build progress lines omitted ⋯",
  ].join("\n"));
});

test("compressKnownCliOutput collapses only known lint success lines", () => {
  const input = ["src/a.ts", "✔ No problems", "Done in 1.2s"].join("\n");
  assert.equal(compressKnownCliOutput(input, { command: "pnpm lint" }), [
    "src/a.ts",
    "⋯ 2 lint success lines omitted ⋯",
  ].join("\n"));
});

test("compressKnownCliOutput preserves git diff exactly", () => {
  const input = ["diff --git a/a.ts b/a.ts", "-old", "+new"].join("\n");
  assert.equal(compressKnownCliOutput(input, { command: "git diff" }), input);
});

test("compressKnownCliOutput removes only protected-free static boilerplate for known commands", () => {
  const input = ["build completed successfully", "error: missing dependency"].join("\n");
  assert.equal(compressKnownCliOutput(input, { command: "cargo build" }), [
    "error: missing dependency",
    "⋯ 1 build boilerplate lines omitted ⋯",
  ].join("\n"));
});
