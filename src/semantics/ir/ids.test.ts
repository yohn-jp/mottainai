import assert from "node:assert/strict";
import test from "node:test";
import {
  createEffectId,
  createLogicalId,
  createSymbolId,
  isEffectId,
  isLogicalId,
} from "./ids.js";

test("symbol logical IDs ignore source range movement", () => {
  const before = createSymbolId({
    kind: "symbol",
    language: "typescript",
    package: "mottainai",
    file: "src/config.ts",
    symbol: "loadConfig",
    signature: "(): Config",
    range: { start: { line: 10, column: 1 }, end: { line: 15, column: 2 } },
  });
  const after = createSymbolId({
    kind: "symbol",
    language: "typescript",
    package: "mottainai",
    file: "src/config.ts",
    symbol: "loadConfig",
    signature: "(): Config",
    range: { start: { line: 110, column: 1 }, end: { line: 115, column: 2 } },
  });
  assert.equal(before, "symbol:typescript:mottainai:src/config.ts#loadConfig~%28%29%3a%20Config");
  assert.equal(before, after);
  assert.equal(isLogicalId(before), true);
});

test("logical IDs reject malformed values and effect IDs remain extensible", () => {
  assert.throws(() => createLogicalId("Invalid Namespace", "value"), /invalid logical id namespace/);
  assert.equal(isLogicalId("missing-namespace"), false);
  assert.equal(createEffectId("vendor.cache.refresh"), "vendor.cache.refresh");
  assert.equal(createEffectId("network"), "network");
  assert.equal(isEffectId("filesystem.read"), true);
  assert.equal(isEffectId("filesystem read"), false);
});
