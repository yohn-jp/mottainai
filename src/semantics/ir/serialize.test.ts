import assert from "node:assert/strict";
import test from "node:test";
import * as semantics from "../index.js";
import { allSemanticFixtures, logicalComponentFixture, pureFunctionFixture } from "../fixtures/snapshots.js";
import {
  computeModelDigest,
  computeSemanticStateDigest,
  computeSnapshotDigest,
  parseSemanticTransaction,
  parseSnapshot,
  semanticEqualSnapshots,
  serializeSemanticTransaction,
  serializeSnapshot,
} from "./serialize.js";

test("every symbol-first fixture round-trips through deterministic JSON", () => {
  for (const [name, fixture] of Object.entries(allSemanticFixtures)) {
    const serialized = serializeSnapshot(fixture);
    const parsed = parseSnapshot(serialized);
    assert.equal(parsed.ok, true, name);
    if (!parsed.ok) continue;
    assert.equal(semanticEqualSnapshots(fixture, parsed.snapshot), true, name);
    assert.equal(serializeSnapshot(parsed.snapshot), serialized, name);
  }
});

test("serialization orders state collections and relation graph independent of insertion order", () => {
  const shuffled = {
    ...logicalComponentFixture,
    declarations: {
      ...logicalComponentFixture.declarations,
      components: [...logicalComponentFixture.declarations.components].reverse(),
      facts: [...logicalComponentFixture.declarations.facts].reverse(),
    },
    derived: {
      ...logicalComponentFixture.derived,
      symbols: [...logicalComponentFixture.derived.symbols].reverse(),
      packages: [...logicalComponentFixture.derived.packages].reverse(),
    },
    graph: { relations: [...logicalComponentFixture.graph.relations].reverse() },
  };
  assert.equal(serializeSnapshot(shuffled), serializeSnapshot(logicalComponentFixture));
});

test("canonical semantic, model and snapshot digests are deterministic", () => {
  const first = [
    computeSemanticStateDigest(pureFunctionFixture),
    computeModelDigest(pureFunctionFixture),
    computeSnapshotDigest(pureFunctionFixture),
  ];
  const second = [
    computeSemanticStateDigest(pureFunctionFixture),
    computeModelDigest(pureFunctionFixture),
    computeSnapshotDigest(pureFunctionFixture),
  ];
  assert.deepEqual(first, second);
  assert.ok(first.every((digest) => digest.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(digest.value)));
});

test("semantic transaction serialization round-trips", () => {
  const transaction = {
    version: 1 as const,
    intent: "semantic-change" as const,
    delta: { version: 1 as const, intent: "semantic-change" as const, entries: [], unauthorized: false },
    provenance: pureFunctionFixture.derived.symbols[0]!.provenance,
  };
  const parsed = parseSemanticTransaction(serializeSemanticTransaction(transaction));
  assert.equal(parsed.ok, true);
  assert.equal(
    serializeSemanticTransaction(transaction),
    serializeSemanticTransaction(parsed.ok ? parsed.transaction : transaction),
  );
});

test("unsupported and malformed serialized input returns structured diagnostics", () => {
  const unsupported = parseSnapshot(JSON.stringify({ schemaVersion: 99 }));
  if (unsupported.ok) assert.fail("unsupported version was accepted");
  assert.equal(unsupported.diagnostics[0]?.code, "unsupported_schema_version");

  const malformed = parseSnapshot("{not-json");
  if (malformed.ok) assert.fail("malformed JSON was accepted");
  assert.equal(malformed.diagnostics[0]?.code, "invalid_serialized_json");
});

test("public semantics boundary exposes domain IR without UI query types", () => {
  assert.equal("callCodeSearchTool" in semantics, false);
  assert.equal(typeof semantics.serializeSnapshot, "function");
  assert.equal(typeof semantics.repositorySemanticSnapshotSchema.safeParse, "function");
  assert.equal("getGraph" in semantics, false);
});
