import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serializeSnapshot } from "../../ir/serialize.js";
import { validateSnapshot } from "../../ir/schema.js";
import type { RepositorySemanticSnapshot, SemanticFact, SemanticRelation, SymbolEntity } from "../../ir/types.js";
import { extractTypeScriptFacts } from "./index.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/typescript");

function extract(options: Partial<Parameters<typeof extractTypeScriptFacts>[0]> = {}): RepositorySemanticSnapshot {
  return extractTypeScriptFacts({ rootDir: fixtureRoot, ...options }).snapshot;
}

function symbol(snapshot: RepositorySemanticSnapshot, name: string, file?: string, signature?: string): SymbolEntity {
  const value = snapshot.derived.symbols.find(
    (item) => item.name === name && (file === undefined || item.locator.file === file) && (signature === undefined || item.locator.signature === signature),
  );
  assert.ok(value, `missing symbol ${name}`);
  return value;
}

function facts(snapshot: RepositorySemanticSnapshot, subject: string, predicate: string): SemanticFact[] {
  return snapshot.derived.facts.filter((fact) => fact.subject === subject && fact.predicate === predicate);
}

function relations(snapshot: RepositorySemanticSnapshot, kind: string): SemanticRelation[] {
  return snapshot.graph.relations.filter((relation) => relation.kind === kind);
}

test("TypeScript facts form a valid deterministic #84 snapshot", () => {
  const first = extract();
  const second = extract();
  const validation = validateSnapshot(first);

  assert.equal(validation.ok, true);
  assert.equal(serializeSnapshot(first), serializeSnapshot(second));
  assert.ok(first.derived.files.some((file) => file.path === "src/consumer.ts"));
  assert.ok(first.derived.files.some((file) => file.path === "package.json"));
  assert.ok(first.derived.facts.some((fact) => fact.predicate === "file.content_fingerprint"));
  assert.ok(first.integrity.trackedFiles.every((file) => file.physicalFingerprint.algorithm === "sha256"));
  assert.deepEqual(first.integrity.extractors.map((extractor) => extractor.id), ["typescript-symbol-facts"]);
  assert.deepEqual(Object.keys(first).filter((key) => key.includes("caller") || key.includes("callee")), []);
});

test("Compiler API declarations cover symbols, overloads, aliases, visibility, and export status", () => {
  const snapshot = extract();

  assert.ok(symbol(snapshot, "topLevel", "src/definitions.ts"));
  assert.ok(symbol(snapshot, "nestedCaller.nestedLocal", "src/definitions.ts"));
  assert.ok(symbol(snapshot, "BaseBox.method", "src/definitions.ts"));
  assert.ok(symbol(snapshot, "Contract", "src/definitions.ts"));
  assert.ok(symbol(snapshot, "ContractAlias", "src/definitions.ts"));
  assert.ok(symbol(snapshot, "aliasedTopLevel", "src/consumer.ts"));
  assert.ok(symbol(snapshot, "aliasTopLevel", "src/aliases.ts"));
  assert.ok(symbol(snapshot, "reExportedTopLevel", "src/consumer.ts"));
  assert.equal(snapshot.derived.symbols.filter((item) => item.name === "overloaded" && item.locator.file === "src/definitions.ts").length, 3);

  const hidden = symbol(snapshot, "BaseBox.hidden", "src/definitions.ts");
  const hiddenVisibility = facts(snapshot, hidden.id, "symbol.visibility");
  assert.deepEqual(hiddenVisibility.map((fact) => fact.value), ["private"]);
  const protectedValue = symbol(snapshot, "BaseBox.protectedValue", "src/definitions.ts");
  assert.deepEqual(facts(snapshot, protectedValue.id, "symbol.visibility").map((fact) => fact.value), ["protected"]);
  const exportedConstant = symbol(snapshot, "exportedConstant", "src/definitions.ts");
  assert.deepEqual(facts(snapshot, exportedConstant.id, "symbol.exported").map((fact) => fact.value), [true]);
  const hiddenConstant = symbol(snapshot, "hiddenConstant", "src/definitions.ts");
  assert.deepEqual(facts(snapshot, hiddenConstant.id, "symbol.exported").map((fact) => fact.value), [false]);
  assert.ok(facts(snapshot, hidden.id, "symbol.source_range").length === 1);
  assert.equal(serializeSnapshot(snapshot).includes("This comment is intentionally not a semantic input"), false);
});

test("TypeChecker resolves direct calls and universal relations without same-name text matching", () => {
  const snapshot = extract();
  const consume = symbol(snapshot, "consume", "src/consumer.ts");
  const topLevel = symbol(snapshot, "topLevel", "src/definitions.ts");
  const useOverload = symbol(snapshot, "useOverload", "src/consumer.ts");
  const overload = snapshot.derived.symbols.find(
    (item) => item.name === "overloaded" && item.locator.signature?.includes("value: string"),
  );
  assert.ok(overload);
  const shadowed = symbol(snapshot, "shadowed", "src/consumer.ts");
  const shadowedLocal = symbol(snapshot, "shadowed.sameName", "src/consumer.ts");
  const callRelations = relations(snapshot, "calls");

  assert.ok(callRelations.some((relation) => relation.from === consume.id && relation.to === topLevel.id));
  assert.ok(callRelations.some((relation) => relation.from === useOverload.id && relation.to === overload.id));
  assert.ok(callRelations.some((relation) => relation.from === shadowed.id && relation.to === shadowedLocal.id));
  assert.ok(!callRelations.some((relation) => relation.from === shadowed.id && relation.to.includes("definitions.ts#sameName")));
  assert.ok(relations(snapshot, "references").some((relation) => relation.from === consume.id && relation.to === topLevel.id));
  assert.ok(relations(snapshot, "extends").some((relation) => relation.from.includes("DerivedBox") && relation.to.includes("BaseBox")));
  assert.ok(relations(snapshot, "implements").some((relation) => relation.from.includes("DerivedBox") && relation.to.includes("Contract")));
  assert.ok(relations(snapshot, "imports").some((relation) => relation.metadata?.reExport === true));
});

test("Package facts distinguish declared, resolved, imported, and actually used APIs", () => {
  const snapshot = extract();
  const externalDependency = snapshot.derived.externalDependencies.find((item) => item.packageName === "fixture-external");
  const unusedDependency = snapshot.derived.externalDependencies.find((item) => item.packageName === "unused-dependency");
  const externalPackage = snapshot.derived.packages.find((item) => item.packageName === "fixture-external");
  const externalApi = snapshot.derived.externalApis.find((item) => item.apiName === "fixture-external.externalFunction");

  assert.ok(externalDependency);
  assert.ok(unusedDependency);
  assert.ok(externalPackage);
  assert.ok(externalApi);
  assert.deepEqual(externalDependency.metadata, {
    declared: true,
    resolved: true,
    imported: true,
    used: true,
    declarationType: "dependencies",
  });
  assert.deepEqual(unusedDependency.metadata, {
    declared: true,
    resolved: false,
    imported: false,
    used: false,
    declarationType: "dependencies",
  });
  assert.deepEqual(facts(snapshot, externalApi.id, "external_api.used").map((fact) => fact.value), [true]);
  assert.ok(
    relations(snapshot, "imports_api").some(
      (relation) => relation.to === externalApi.id && relation.metadata?.usage === "used" && relation.from.includes("consume"),
    ),
  );
  assert.ok(relations(snapshot, "uses_package").some((relation) => relation.to === externalPackage.id && relation.from.includes("consume")));
  assert.ok(relations(snapshot, "depends_on").some((relation) => relation.from === "package:typescript-fixture" && relation.to === externalPackage.id));
});

test("Unknown dynamic behavior is explicit and does not create fabricated call edges", () => {
  const snapshot = extract();
  assert.deepEqual([...new Set(snapshot.analysis.unknowns.map((unknown) => unknown.code))].sort(), [
    "any_mediated_target",
    "dynamic_call_target",
    "dynamic_import_unresolved",
  ]);
  assert.equal(snapshot.analysis.health.status, "partial");
  const dynamicSymbols = snapshot.derived.symbols.filter((item) => ["anyMediated", "computedCall", "unresolvedImport"].includes(item.name));
  assert.ok(dynamicSymbols.every((item) => !relations(snapshot, "calls").some((relation) => relation.from === item.id)));
});

test("Symbol IDs survive line-only source movement", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "mottainai-typescript-facts-"));
  try {
    cpSync(fixtureRoot, temporaryRoot, { recursive: true });
    const before = extract({ rootDir: temporaryRoot, repositoryName: "fixture/typescript", packageName: "typescript-fixture" });
    const definitionsPath = join(temporaryRoot, "src/definitions.ts");
    writeFileSync(definitionsPath, `\n\n${readFileSync(definitionsPath, "utf8")}`);
    const after = extract({ rootDir: temporaryRoot, repositoryName: "fixture/typescript", packageName: "typescript-fixture" });
    const beforeTopLevel = symbol(before, "topLevel", "src/definitions.ts");
    const afterTopLevel = symbol(after, "topLevel", "src/definitions.ts");
    const beforeNested = symbol(before, "nestedCaller.nestedLocal", "src/definitions.ts");
    const afterNested = symbol(after, "nestedCaller.nestedLocal", "src/definitions.ts");
    assert.equal(beforeTopLevel.id, afterTopLevel.id);
    assert.equal(beforeNested.id, afterNested.id);
    assert.notDeepEqual(beforeTopLevel.locator.range, afterTopLevel.locator.range);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Filesystem enumeration order does not affect canonical output", () => {
  const sourceNames = ["src/aliases.ts", "src/consumer.ts", "src/definitions.ts", "src/dynamic.ts"];
  const normal = sourceNames.map((filePath) => resolve(fixtureRoot, filePath));
  const reversed = [...normal].reverse();
  const first = extract({ rootNames: normal });
  const second = extract({ rootNames: reversed });
  assert.equal(serializeSnapshot(first), serializeSnapshot(second));
});
