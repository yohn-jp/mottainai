import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCommandDigest, computeConfigDigest } from "./identity.js";

test("computeCommandDigest is deterministic for identical inputs", () => {
  const command = { command: "pnpm", args: ["run", "lint"], cwd: "/repo" };
  assert.equal(computeCommandDigest(command), computeCommandDigest({ ...command }));
});

test("computeCommandDigest changes when args differ", () => {
  const base = { command: "pnpm", args: ["run", "lint"], cwd: "/repo" };
  const changed = { command: "pnpm", args: ["run", "test"], cwd: "/repo" };
  assert.notEqual(computeCommandDigest(base), computeCommandDigest(changed));
});

test("computeCommandDigest changes when cwd differs", () => {
  const base = { command: "pnpm", args: ["run", "lint"], cwd: "/repo" };
  const changed = { command: "pnpm", args: ["run", "lint"], cwd: "/other" };
  assert.notEqual(computeCommandDigest(base), computeCommandDigest(changed));
});

const baseConfigInput = {
  checkId: "test",
  command: { command: "pnpm", args: ["test"], cwd: "/repo" },
  configFileDigests: { "package.json": "abc123" },
  relevantEnv: {},
};

test("computeConfigDigest is deterministic for identical inputs", () => {
  assert.equal(computeConfigDigest(baseConfigInput), computeConfigDigest({ ...baseConfigInput }));
});

test("computeConfigDigest changes when a config file digest changes", () => {
  const changed = { ...baseConfigInput, configFileDigests: { "package.json": "different" } };
  assert.notEqual(computeConfigDigest(baseConfigInput), computeConfigDigest(changed));
});

test("computeConfigDigest changes when relevant env values change", () => {
  const withEnv = { ...baseConfigInput, relevantEnv: { NODE_ENV: "production" } };
  const withDifferentEnv = { ...baseConfigInput, relevantEnv: { NODE_ENV: "test" } };
  assert.notEqual(computeConfigDigest(withEnv), computeConfigDigest(withDifferentEnv));
});

test("computeConfigDigest changes when checkId differs, even with identical command", () => {
  const other = { ...baseConfigInput, checkId: "other-check" };
  assert.notEqual(computeConfigDigest(baseConfigInput), computeConfigDigest(other));
});
