import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEALTHY_RECONCILIATION_STATES,
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
    generation: "42",
    stateOwners: {
      system: ["/var/lib/mottainai-control"],
      repositoryUser: ["/var/lib/mottainai/repositories"],
    },
    requiredCompanions: [{ name: "nawabari", minimumVersion: "0.2.0", present: true }],
    reconciliation: "current",
    upgradeRequired: false,
    ...overrides,
  };
}

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

test("isRuntimeContractCompatible accepts a matching contract at or above the minimum schema version", () => {
  assert.equal(isRuntimeContractCompatible({ contractId: RUNTIME_CONTRACT_ID, schemaVersion: 1 }), true);
  assert.equal(isRuntimeContractCompatible({ contractId: RUNTIME_CONTRACT_ID, schemaVersion: 3 }, 2), true);
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
