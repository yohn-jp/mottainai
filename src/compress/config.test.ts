import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedGatewayConfig } from "../config.js";
import { isCodeCompressionEnabled, isCompressionEnabled, isToolDescriptionCompressionEnabled, resolveTokenBudget } from "./config.js";

test("isCompressionEnabled defaults to true when unset", () => {
  assert.equal(isCompressionEnabled({}), true);
});

test("isCompressionEnabled is false for '0'", () => {
  assert.equal(isCompressionEnabled({ MOTTAINAI_COMPRESS: "0" }), false);
});

test("isCompressionEnabled is false for 'false' (case-insensitive)", () => {
  assert.equal(isCompressionEnabled({ MOTTAINAI_COMPRESS: "False" }), false);
});

test("isCompressionEnabled is true for any other value", () => {
  assert.equal(isCompressionEnabled({ MOTTAINAI_COMPRESS: "1" }), true);
  assert.equal(isCompressionEnabled({ MOTTAINAI_COMPRESS: "yes" }), true);
});

test("isToolDescriptionCompressionEnabled defaults to true and supports explicit disable", () => {
  assert.equal(isToolDescriptionCompressionEnabled({}), true);
  assert.equal(isToolDescriptionCompressionEnabled({ MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS: "0" }), false);
  assert.equal(isToolDescriptionCompressionEnabled({ MOTTAINAI_COMPRESS_TOOL_DESCRIPTIONS: "FALSE" }), false);
});

test("isCodeCompressionEnabled defaults to true and supports explicit disable", () => {
  assert.equal(isCodeCompressionEnabled({}), true);
  assert.equal(isCodeCompressionEnabled({ MOTTAINAI_COMPRESS_CODE: "0" }), false);
  assert.equal(isCodeCompressionEnabled({ MOTTAINAI_COMPRESS_CODE: "FALSE" }), false);
  assert.equal(isCodeCompressionEnabled({ MOTTAINAI_COMPRESS_CODE: "1" }), true);
});

test("resolveTokenBudget returns undefined when nothing is configured (opt-in, no limit by default)", () => {
  const config = { tokenBudgets: { tools: {}, capabilities: {}, profiles: {} } } as unknown as ResolvedGatewayConfig;
  assert.equal(resolveTokenBudget({ toolName: "codegraph__explore", config, isError: false }), undefined);
});

test("resolveTokenBudget resolves tool over capability over profile over gateway default", () => {
  const config = {
    activeProfile: "readonly",
    tokenBudgets: {
      tools: { "codegraph__explore": { success: 111 } },
      capabilities: { definitions: { success: 222 } },
      profiles: { readonly: { success: 333 } },
      default: { success: 444 },
    },
  } as unknown as ResolvedGatewayConfig;

  assert.deepEqual(
    resolveTokenBudget({ toolName: "codegraph__explore", capability: "definitions", config, isError: false }),
    { targetTokens: 111, source: "tool" },
  );
  assert.deepEqual(
    resolveTokenBudget({ toolName: "other__tool", capability: "definitions", config, isError: false }),
    { targetTokens: 222, source: "capability" },
  );
  assert.deepEqual(
    resolveTokenBudget({ toolName: "other__tool", config, isError: false }),
    { targetTokens: 333, source: "profile" },
  );
  assert.deepEqual(
    resolveTokenBudget({ toolName: "other__tool", config: { ...config, activeProfile: undefined }, isError: false }),
    { targetTokens: 444, source: "gateway" },
  );
});

test("resolveTokenBudget picks the failure value on error and falls back to success when failure is unset", () => {
  const config = {
    tokenBudgets: { tools: { exec: { success: 100, failure: 500 } }, capabilities: {}, profiles: {} },
  } as unknown as ResolvedGatewayConfig;
  assert.deepEqual(resolveTokenBudget({ toolName: "exec", config, isError: true }), { targetTokens: 500, source: "tool" });
  assert.deepEqual(resolveTokenBudget({ toolName: "exec", config, isError: false }), { targetTokens: 100, source: "tool" });

  const successOnly = { tokenBudgets: { tools: { exec: { success: 100 } }, capabilities: {}, profiles: {} } } as unknown as ResolvedGatewayConfig;
  assert.deepEqual(resolveTokenBudget({ toolName: "exec", config: successOnly, isError: true }), { targetTokens: 100, source: "tool" });
});
