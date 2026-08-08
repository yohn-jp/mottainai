import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isDependencyAllowed, RULE_IDS, validateSourceText, validateSourceTexts } from "./architecture-check.mjs";

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

test("local tool schema rejects an inline output schema in place of the shared OUTPUT_SCHEMA", () => {
  const diagnostics = validateSourceText(fixture("rejected-local-tool-inline-schema.ts"), "src/local-tools.ts");
  assert.ok(ruleIds(diagnostics).includes(RULE_IDS.localToolSchema));
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

test("workflow worker and bootstrap environment are explicit boundaries", () => {
  const worker = validateSourceText(
    "const [, , workspaceRoot] = process.argv; const value = factory(); process.stdout.write(JSON.stringify({ workspaceRoot, value }));",
    "src/workflow/domain/task-start-worker.mjs",
  );
  assert.equal(
    worker.some((diagnostic) => diagnostic.ruleId === RULE_IDS.importTimeSideEffect),
    false,
  );
  assert.equal(
    worker.some((diagnostic) => diagnostic.ruleId === RULE_IDS.protocolStdout),
    false,
  );
  assert.equal(
    worker.some((diagnostic) => diagnostic.ruleId === RULE_IDS.processBoundary),
    false,
  );

  const environment = validateSourceText("const path = process.env.PATH;", "src/workflow/git/worktree.ts");
  assert.equal(
    environment.some((diagnostic) => diagnostic.ruleId === RULE_IDS.processBoundary),
    false,
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

test("double assertion marker does not suppress unrelated violations elsewhere in the file", () => {
  const source = [
    "// architecture-check allow: double-assertion -- fixture models a validated native interop boundary",
    'const value = "native" as unknown as string;',
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    'const other = "native" as unknown as string;',
    "export { value, other };",
    "",
  ].join("\n");
  const diagnostics = validateSourceText(source, "src/compress/code.ts");
  const escapes = diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE_IDS.unsafeTypeEscape);
  assert.equal(escapes.length, 1);
  assert.equal(escapes[0].line, 11);
});

test("dependency direction accepts downward edges and rejects upward edges", () => {
  assert.equal(isDependencyAllowed("server", "compression", "src/compress/index.ts"), true);
  assert.equal(isDependencyAllowed("compression", "server", "src/proxy.ts"), false);
});

test("test-support and e2e helpers may depend on any production layer, but nothing depends back", () => {
  assert.equal(isDependencyAllowed("testInfrastructure", "persistence", "src/workflow/state/sqlite-store.ts"), true);
  assert.equal(isDependencyAllowed("testInfrastructure", "entry", "src/index.ts"), true);
  assert.equal(isDependencyAllowed("shared", "testInfrastructure", "src/test-support/env.ts"), false);
  assert.equal(isDependencyAllowed("persistence", "testInfrastructure", "src/e2e/stdio-client.ts"), false);
});

// checkImports only reaches isDependencyAllowed when the resolved import target is itself
// among the validated entries (see the comment on validateSourceTexts). A single-entry
// validateSourceText call never resolves into another file, so it can't exercise a
// cross-file dependency-direction edge — these two cases use validateSourceTexts with a
// stub second entry so the edge is actually checked, not skipped.
test("testInfrastructure depending on persistence (test-support -> workflow state store) is accepted", () => {
  const diagnostics = validateSourceTexts([
    {
      fileName: "src/test-support/workflow-store.ts",
      sourceText:
        'import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";\nexport function openMemoryStore() { return new WorkflowSqliteStateStore({ dbPath: ":memory:" }); }\n',
    },
    { fileName: "src/workflow/state/sqlite-store.ts", sourceText: "export class WorkflowSqliteStateStore {}\n" },
  ]);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.ruleId === RULE_IDS.dependencyDirection),
    false,
  );
});

test("shared depending on testInfrastructure (production -> test-support) is rejected", () => {
  const diagnostics = validateSourceTexts([
    {
      fileName: "src/config.ts",
      sourceText: 'import { createTempDir } from "./test-support/tmp-dir.js";\nexport { createTempDir };\n',
    },
    { fileName: "src/test-support/tmp-dir.ts", sourceText: "export function createTempDir() {}\n" },
  ]);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.ruleId === RULE_IDS.dependencyDirection),
    true,
  );
});

test("import-time execution is rejected outside the entry boundary", () => {
  const diagnostics = validateSourceText("const value = factory();", "src/server.ts");
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.ruleId === RULE_IDS.importTimeSideEffect),
    true,
  );
});

test("import-time-side-effect marker does not suppress unrelated top-level statements in the file", () => {
  const source = [
    "const first = factory();",
    "// architecture-check allow: import-time-side-effect -- fixture models a singleton boundary",
    "",
    "const second = factory();",
  ].join("\n");
  const diagnostics = validateSourceText(source, "src/server.ts");
  const effects = diagnostics.filter((diagnostic) => diagnostic.ruleId === RULE_IDS.importTimeSideEffect);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].line, 4);
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
