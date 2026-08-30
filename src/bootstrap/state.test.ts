import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import {
  BOOTSTRAP_STATE_CONTRACT_ID,
  BOOTSTRAP_STATE_SCHEMA_VERSION,
  BootstrapStateError,
  canonicalBootstrapStateText,
  parseBootstrapState,
  readBootstrapState,
  writeBootstrapState,
} from "./state.js";
import type { BootstrapState } from "./state.js";

function tempStatePath(): { root: string; filePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-bootstrap-state-test-"));
  return { root, filePath: path.join(root, "bootstrap", "state.json") };
}

function attemptOnlyState(overrides: Partial<BootstrapState["lastAttempt"]> = {}): BootstrapState {
  return {
    contractId: BOOTSTRAP_STATE_CONTRACT_ID,
    schemaVersion: BOOTSTRAP_STATE_SCHEMA_VERSION,
    lastAttempt: {
      completedAt: "2026-08-30T00:00:00.000Z",
      outcome: "failure",
      errorCode: "invalid_manifest",
      message: "manifest is invalid",
      ...overrides,
    },
  };
}

function stateWithSuccessfulBuild(): BootstrapState {
  return {
    contractId: BOOTSTRAP_STATE_CONTRACT_ID,
    schemaVersion: BOOTSTRAP_STATE_SCHEMA_VERSION,
    lastAttempt: {
      completedAt: "2026-08-30T01:00:00.000Z",
      outcome: "success",
      desiredManifestSemanticIdentity: "a".repeat(64),
    },
    lastSuccessfulBuild: {
      completedAt: "2026-08-30T01:00:00.000Z",
      desiredManifestSemanticIdentity: "a".repeat(64),
      resolvedMottainaiSource: { version: "0.7.1", narHashSha256: "b".repeat(64) },
      generationIdentity: "c".repeat(64),
      generationStorePath: "/nix/store/example-mottainai-managed-generation",
    },
  };
}

test("parses a well-formed attempt-only bootstrap state", () => {
  const parsed = parseBootstrapState(attemptOnlyState());
  assert.equal(parsed.lastAttempt.outcome, "failure");
  assert.equal(parsed.lastSuccessfulBuild, undefined);
});

test("rejects a failure attempt missing errorCode or message", () => {
  const state = attemptOnlyState();
  const broken = { ...state, lastAttempt: { ...state.lastAttempt, errorCode: undefined } };
  assert.throws(() => parseBootstrapState(broken), BootstrapStateError);
});

test("rejects a success attempt that carries an errorCode", () => {
  const state = attemptOnlyState({ outcome: "success", errorCode: undefined, message: undefined });
  const broken = { ...state, lastAttempt: { ...state.lastAttempt, errorCode: "invalid_manifest" } };
  assert.throws(() => parseBootstrapState(broken), BootstrapStateError);
});

test("rejects a field outside the bounded contract (strict schema, fail closed)", () => {
  assert.throws(() => parseBootstrapState({ ...attemptOnlyState(), extra: "field" }), BootstrapStateError);
});

test("persisted evidence round-trips deterministically: attempt-only state", () => {
  const { root, filePath } = tempStatePath();
  try {
    const state = attemptOnlyState();
    writeBootstrapState(filePath, state, DIRECT_BOUNDARIES);
    const read = readBootstrapState(filePath);
    assert.deepEqual(read, state);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted evidence round-trips deterministically: state with lastSuccessfulBuild", () => {
  const { root, filePath } = tempStatePath();
  try {
    const state = stateWithSuccessfulBuild();
    writeBootstrapState(filePath, state, DIRECT_BOUNDARIES);
    const read = readBootstrapState(filePath);
    assert.deepEqual(read, state);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonicalBootstrapStateText is byte-identical regardless of construction key order", () => {
  const state = stateWithSuccessfulBuild();
  const reordered: BootstrapState = {
    schemaVersion: state.schemaVersion,
    lastSuccessfulBuild: state.lastSuccessfulBuild,
    contractId: state.contractId,
    lastAttempt: state.lastAttempt,
  };
  assert.equal(canonicalBootstrapStateText(state), canonicalBootstrapStateText(reordered));
});

test("readBootstrapState returns undefined when no state file exists yet (never attempted)", () => {
  const { root, filePath } = tempStatePath();
  try {
    assert.equal(readBootstrapState(filePath), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted persisted state (malformed JSON) fails closed", () => {
  const { root, filePath } = tempStatePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not json");
    assert.throws(() => readBootstrapState(filePath), BootstrapStateError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted persisted state (schema-invalid JSON) fails closed", () => {
  const { root, filePath } = tempStatePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ contractId: "wrong", schemaVersion: 1 }));
    assert.throws(() => readBootstrapState(filePath), BootstrapStateError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
