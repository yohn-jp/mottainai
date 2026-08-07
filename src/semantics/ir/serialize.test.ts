import assert from "node:assert/strict";
import test from "node:test";
import * as semantics from "../index.js";
import { allSemanticFixtures, logicalComponentFixture } from "../fixtures/snapshots.js";
import {
  parseSnapshot,
  semanticEqualSnapshots,
  serializeSnapshot,
} from "./serialize.js";

test("every fixture round-trips through deterministic JSON", () => {
  for (const [name, fixture] of Object.entries(allSemanticFixtures)) {
    const serialized = serializeSnapshot(fixture);
    const parsed = parseSnapshot(serialized);
    assert.equal(parsed.ok, true, name);
    if (!parsed.ok) continue;
    assert.equal(semanticEqualSnapshots(fixture, parsed.snapshot), true, name);
    assert.equal(serializeSnapshot(parsed.snapshot), serialized, name);
  }
});

test("serialization orders stable collections independent of insertion order", () => {
  const shuffled = {
    ...logicalComponentFixture,
    nodes: [...logicalComponentFixture.nodes].reverse(),
    edges: [...logicalComponentFixture.edges].reverse(),
  };
  assert.equal(serializeSnapshot(shuffled), serializeSnapshot(logicalComponentFixture));
});

test("unsupported and malformed serialized input returns structured diagnostics", () => {
  const unsupported = parseSnapshot(JSON.stringify({ schemaVersion: 99 }));
  if (unsupported.ok) assert.fail("unsupported version was accepted");
  assert.equal(unsupported.diagnostics[0]?.code, "unsupported_schema_version");

  const malformed = parseSnapshot("{not-json");
  if (malformed.ok) assert.fail("malformed JSON was accepted");
  assert.equal(malformed.diagnostics[0]?.code, "invalid_serialized_json");
});

test("public semantics boundary does not expose code-search routing", () => {
  assert.equal("callCodeSearchTool" in semantics, false);
  assert.equal(typeof semantics.serializeSnapshot, "function");
  assert.equal(typeof semantics.repositorySemanticSnapshotSchema.safeParse, "function");
});
