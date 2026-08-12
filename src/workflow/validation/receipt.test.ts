import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedFailureDiagnostics } from "./receipt.js";

test("boundedFailureDiagnostics returns the tail lines within the byte/line budget", () => {
  const stderr = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
  const diagnostics = boundedFailureDiagnostics({ stdout: "", stderr }, 5, 4_000);
  assert.deepEqual(diagnostics, ["line 95", "line 96", "line 97", "line 98", "line 99"]);
});

test("boundedFailureDiagnostics prefers stderr over stdout when both are present", () => {
  const diagnostics = boundedFailureDiagnostics({ stdout: "from stdout", stderr: "from stderr" });
  assert.deepEqual(diagnostics, ["from stderr"]);
});

test("boundedFailureDiagnostics falls back to stdout when stderr is empty", () => {
  const diagnostics = boundedFailureDiagnostics({ stdout: "from stdout", stderr: "" });
  assert.deepEqual(diagnostics, ["from stdout"]);
});

test("a single line exceeding the byte budget is truncated, not dropped (regression: must not report empty diagnostics)", () => {
  const oneHugeLine = "x".repeat(10_000);
  const diagnostics = boundedFailureDiagnostics({ stdout: "", stderr: oneHugeLine }, 40, 200);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0]!.length > 0);
  assert.ok(Buffer.byteLength(diagnostics[0]!, "utf8") <= 200);
});

test("truncating a single huge multi-byte line does not produce invalid UTF-8 output", () => {
  const oneHugeLine = "あ".repeat(5_000);
  const diagnostics = boundedFailureDiagnostics({ stdout: "", stderr: oneHugeLine }, 40, 197);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.includes("�"), false);
  assert.ok(Buffer.byteLength(diagnostics[0]!, "utf8") <= 197);
});
