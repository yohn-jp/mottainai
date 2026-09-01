import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  HEALTHY_RECONCILIATION_STATES,
  MAX_COMPANIONS,
  MAX_RUNTIME_IDENTITY_LENGTH,
  RUNTIME_CONTRACT_ID,
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  RuntimeCapabilityResultSchema,
  RuntimeRollbackError,
  isRuntimeContractCompatible,
  parseRuntimeCapabilityResult,
  planRollback,
  type RuntimeGenerationRecord,
} from "./contract.js";

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    contractId: RUNTIME_CONTRACT_ID,
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runtimeIdentity: "runtime-test-1",
    architecture: "x86_64-linux",
    buildIdentity: "/nix/store/abc123-nixos-system",
    generation: 42,
    stateOwners: {
      system: ["/var/lib/mottainai-control"],
      repositoryUser: ["/var/lib/mottainai/repositories"],
    },
    requiredCompanions: [{ name: "nawabari", minimumVersion: "0.2.0", present: true }],
    readiness: "managed-runtime-ready",
    bootstrapReady: true,
    managedRuntimeReady: true,
    reconciliation: "current",
    upgradeRequired: false,
    ...overrides,
  };
}

function nixRuntimeContractSchemaVersion(): number {
  const source = fs.readFileSync(fileURLToPath(new URL("../../nix/modules/runtime.nix", import.meta.url)), "utf8");
  const match = source.match(/^\s*schemaVersion = (\d+);\s*$/mu);
  assert.ok(match, "nix/modules/runtime.nix must declare the canonical Runtime schema version");
  return Number(match[1]);
}

test("Nix and TypeScript Runtime contract authorities remain aligned", () => {
  assert.equal(nixRuntimeContractSchemaVersion(), RUNTIME_CONTRACT_SCHEMA_VERSION);
});

test("parses a well-formed bounded health/capability result", () => {
  const parsed = parseRuntimeCapabilityResult(validResult());
  assert.equal(parsed.contractId, RUNTIME_CONTRACT_ID);
  assert.equal(parsed.reconciliation, "current");
});

test("rejects a result missing a required field", () => {
  const { generation: _generation, ...withoutGeneration } = validResult();
  assert.throws(() => parseRuntimeCapabilityResult(withoutGeneration));
});

test("rejects a result carrying fields outside the bounded contract (no secret/env dump)", () => {
  const leaking = { ...validResult(), env: { SECRET_TOKEN: "leaked" } };
  assert.throws(() => parseRuntimeCapabilityResult(leaking));
});

test("safeParse reports failure without throwing for callers that prefer it", () => {
  const outcome = RuntimeCapabilityResultSchema.safeParse({ ...validResult(), reconciliation: "unknown" });
  assert.equal(outcome.success, false);
});

test("parses a fresh appliance as bootstrap-ready while managed runtime is absent", () => {
  const parsed = parseRuntimeCapabilityResult(
    validResult({ readiness: "bootstrap-ready", bootstrapReady: true, managedRuntimeReady: false }),
  );
  assert.equal(parsed.readiness, "bootstrap-ready");
  assert.equal(parsed.managedRuntimeReady, false);
});

test("rejects contradictory readiness flags", () => {
  assert.throws(() =>
    parseRuntimeCapabilityResult(
      validResult({ readiness: "bootstrap-ready", bootstrapReady: true, managedRuntimeReady: true }),
    ),
  );
});

test("rejects a runtimeIdentity longer than the bounded maximum", () => {
  const oversized = { ...validResult(), runtimeIdentity: "x".repeat(MAX_RUNTIME_IDENTITY_LENGTH + 1) };
  assert.throws(() => parseRuntimeCapabilityResult(oversized));
});

test("rejects a requiredCompanions list longer than the bounded maximum (an external Runtime cannot inflate the payload)", () => {
  const companion = { name: "nawabari", minimumVersion: "0.2.0", present: true };
  const overflowing = {
    ...validResult(),
    requiredCompanions: Array.from({ length: MAX_COMPANIONS + 1 }, () => companion),
  };
  assert.throws(() => parseRuntimeCapabilityResult(overflowing));
});

test("accepts a requiredCompanions list at exactly the bounded maximum", () => {
  const companion = { name: "nawabari", minimumVersion: "0.2.0", present: true };
  const atLimit = {
    ...validResult(),
    requiredCompanions: Array.from({ length: MAX_COMPANIONS }, () => companion),
  };
  assert.equal(parseRuntimeCapabilityResult(atLimit).requiredCompanions.length, MAX_COMPANIONS);
});

test("rejects a non-integer generation (must line up with RuntimeGenerationRecord for rollback matching)", () => {
  assert.throws(() => parseRuntimeCapabilityResult({ ...validResult(), generation: "42" }));
});

test("isRuntimeContractCompatible accepts a matching contract at or above the minimum schema version", () => {
  assert.equal(isRuntimeContractCompatible({ contractId: RUNTIME_CONTRACT_ID, schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION }), true);
  assert.equal(
    isRuntimeContractCompatible({ contractId: RUNTIME_CONTRACT_ID, schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION + 1 }),
    true,
  );
});

test("released client understands the Runtime version contract: rejects an unrecognized major contract id", () => {
  assert.equal(isRuntimeContractCompatible({ contractId: "mottainai.linux-runtime.v2", schemaVersion: 1 }), false);
});

test("released client understands the Runtime version contract: rejects a schema version below its minimum", () => {
  assert.equal(isRuntimeContractCompatible({ contractId: RUNTIME_CONTRACT_ID, schemaVersion: 1 }, 2), false);
});

test("HEALTHY_RECONCILIATION_STATES only covers current and repairable", () => {
  assert.deepEqual([...HEALTHY_RECONCILIATION_STATES].sort(), ["current", "repairable"]);
});

test("planRollback: deterministic fixture picks the most recent healthy generation, skipping a bad current one", () => {
  const history: RuntimeGenerationRecord[] = [
    { generation: 1, buildIdentity: "/nix/store/gen1", reconciliation: "current" },
    { generation: 2, buildIdentity: "/nix/store/gen2", reconciliation: "current" },
    { generation: 3, buildIdentity: "/nix/store/gen3", reconciliation: "incompatible" },
  ];
  const target = planRollback(history);
  assert.equal(target.generation, 2);
  assert.equal(target.buildIdentity, "/nix/store/gen2");
});

test("planRollback: a repairable generation is a valid rollback target", () => {
  const history: RuntimeGenerationRecord[] = [
    { generation: 1, buildIdentity: "/nix/store/gen1", reconciliation: "repairable" },
    { generation: 2, buildIdentity: "/nix/store/gen2", reconciliation: "stale" },
  ];
  assert.equal(planRollback(history).generation, 1);
});

test("planRollback: throws when no generation in history ever reported a healthy result", () => {
  const history: RuntimeGenerationRecord[] = [
    { generation: 1, buildIdentity: "/nix/store/gen1", reconciliation: "stale" },
    { generation: 2, buildIdentity: "/nix/store/gen2", reconciliation: "incompatible" },
  ];
  assert.throws(() => planRollback(history), RuntimeRollbackError);
});

test("planRollback: throws on an empty history", () => {
  assert.throws(() => planRollback([]), RuntimeRollbackError);
});
