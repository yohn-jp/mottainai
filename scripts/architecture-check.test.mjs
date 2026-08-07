import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isDependencyAllowed, RULE_IDS, validateSourceText } from "./architecture-check.mjs";

const fixtureRoot = path.join(process.cwd(), "scripts", "fixtures", "architecture");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8");
}

function ruleIds(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.ruleId);
}

test("local tool schema and annotations accept the complete shared contract", () => {
  const diagnostics = validateSourceText(fixture("accepted-local-tool.ts"), "src/local-tools.ts");
  assert.deepEqual(ruleIds(diagnostics), []);
});

test("local tool schema and annotations reject incomplete metadata", () => {
  const diagnostics = validateSourceText(fixture("rejected-local-tool.ts"), "src/local-tools.ts");
  assert.ok(ruleIds(diagnostics).includes(RULE_IDS.localToolSchema));
  assert.ok(ruleIds(diagnostics).includes(RULE_IDS.localToolAnnotations));
});

test("stdout boundary accepts CLI output and rejects runtime output", () => {
  const accepted = validateSourceText(fixture("accepted-boundary.ts"), "src/cli.ts");
  const rejected = validateSourceText(fixture("rejected-boundary.ts"), "src/server.ts");
  assert.equal(
    accepted.some((diagnostic) => diagnostic.ruleId === RULE_IDS.protocolStdout),
    false,
  );
  assert.equal(
    rejected.some((diagnostic) => diagnostic.ruleId === RULE_IDS.protocolStdout),
    true,
  );
});

test("double assertion requires a local documented exception", () => {
  const accepted = validateSourceText(fixture("accepted-double-assertion.ts"), "src/compress/code.ts");
  const rejected = validateSourceText(fixture("rejected-double-assertion.ts"), "src/compress/code.ts");
  assert.equal(
    accepted.some((diagnostic) => diagnostic.ruleId === RULE_IDS.unsafeTypeEscape),
    false,
  );
  assert.equal(
    rejected.some((diagnostic) => diagnostic.ruleId === RULE_IDS.unsafeTypeEscape),
    true,
  );
});

test("dependency direction accepts downward edges and rejects upward edges", () => {
  assert.equal(isDependencyAllowed("server", "compression", "src/compress/index.ts"), true);
  assert.equal(isDependencyAllowed("compression", "server", "src/proxy.ts"), false);
});

test("import-time execution is rejected outside the entry boundary", () => {
  const diagnostics = validateSourceText("const value = factory();", "src/server.ts");
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.ruleId === RULE_IDS.importTimeSideEffect),
    true,
  );
});

test("process termination is restricted to the entry boundary", () => {
  const accepted = validateSourceText("process.exitCode = 0;", "src/index.ts");
  const rejected = validateSourceText("process.exitCode = 0;", "src/proxy.ts");
  assert.equal(
    accepted.some((diagnostic) => diagnostic.ruleId === RULE_IDS.processBoundary),
    false,
  );
  assert.equal(
    rejected.some((diagnostic) => diagnostic.ruleId === RULE_IDS.processBoundary),
    true,
  );
});
