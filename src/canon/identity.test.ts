import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANON_CONTRACT_ID,
  CANON_SCHEMA_VERSION,
  CanonError,
  canonicalCanonPrefixText,
  executionStateIdentityOf,
  identitiesOf,
  parseCanonDocument,
  prefixIdentityOf,
  type CanonDocument,
} from "./identity.js";

function prefix(overrides: Record<string, unknown> = {}): CanonDocument["prefix"] {
  return {
    c0: {
      runtimeContract: { contractId: "mottainai.runtime.v1", schemaVersion: 1 },
      projectContract: { contractId: "mottainai.project.v1", schemaVersion: 1 },
      runtimeInstructions: [
        { instructionId: "runtime-instruction-b", provenance: "already-supplied" },
        { instructionId: "runtime-instruction-a", provenance: "required" },
      ],
    },
    c1: {
      repository: {
        repositoryId: "github:yohn-jp/mottainai",
        sourceRevision: "source-commit-1",
        baseRevision: "base-commit-1",
      },
      packageFacts: { typescript: { version: "5.8.3" }, packageManager: "pnpm" },
      workspaceFacts: { root: { packages: ["mottainai"] }, layout: "single-package" },
    },
    c2: [
      {
        contentId: "task-2",
        value: { title: "second", labels: ["b", "a"] },
        provenance: { source: "gh-inari", reference: "issue:2", supplied: false },
      },
      {
        contentId: "task-1",
        value: { title: "first" },
        provenance: { source: "gh-inari", reference: "issue:1", supplied: false },
      },
    ],
    c3: [],
    ...overrides,
  } as CanonDocument["prefix"];
}

function document(overrides: Partial<CanonDocument> = {}): CanonDocument {
  return {
    contractId: CANON_CONTRACT_ID,
    schemaVersion: CANON_SCHEMA_VERSION,
    prefix: prefix(),
    executionAttachment: {
      generation: 1,
      sessionId: "session-1",
      worktreeId: "worktree-1",
      branchName: "feature/one",
      agentId: "agent-1",
      modelId: "model-1",
    },
    ...overrides,
  };
}

test("Canon is a versioned document with separate prefix and execution attachment", () => {
  const parsed = parseCanonDocument(document());
  assert.equal(parsed.contractId, CANON_CONTRACT_ID);
  assert.equal(parsed.schemaVersion, CANON_SCHEMA_VERSION);
  assert.equal(parsed.executionAttachment.generation, 1);
  assert.equal(parsed.prefix.c0.runtimeInstructions[0]?.provenance, "already-supplied");
});

test("schema version is fail-closed", () => {
  assert.throws(() => parseCanonDocument({ ...document(), schemaVersion: 2 }), CanonError);
  assert.throws(() => parseCanonDocument({ ...document(), prefix: { ...prefix(), extra: true } }), CanonError);
});

test("canonical order is C0, C1, C2, C3 and ignores incidental object/collection order", () => {
  const first = document();
  const second = document({
    prefix: {
      ...prefix(),
      c0: { ...prefix().c0, runtimeInstructions: [...prefix().c0.runtimeInstructions].reverse() },
      c1: {
        ...prefix().c1,
        packageFacts: { packageManager: "pnpm", typescript: { version: "5.8.3" } },
      },
      c2: [...prefix().c2].reverse(),
    },
  });
  const text = canonicalCanonPrefixText(first.prefix);
  assert.ok(text.indexOf('"section":"C0"') < text.indexOf('"section":"C1"'));
  assert.ok(text.indexOf('"section":"C1"') < text.indexOf('"section":"C2"'));
  assert.ok(text.indexOf('"section":"C2"') < text.indexOf('"section":"C3"'));
  assert.equal(prefixIdentityOf(first.prefix), prefixIdentityOf(second.prefix));
});

test("prefix identity changes for repository, base, task, and selected-artifact content", () => {
  const base = document();
  const baseId = prefixIdentityOf(base.prefix);
  assert.notEqual(
    prefixIdentityOf({
      ...base.prefix,
      c1: { ...base.prefix.c1, repository: { ...base.prefix.c1.repository, repositoryId: "other-repository" } },
    }),
    baseId,
  );
  assert.notEqual(
    prefixIdentityOf({
      ...base.prefix,
      c1: { ...base.prefix.c1, repository: { ...base.prefix.c1.repository, baseRevision: "base-commit-2" } },
    }),
    baseId,
  );
  assert.notEqual(
    prefixIdentityOf({
      ...base.prefix,
      c2: [{ ...base.prefix.c2[0]!, value: { title: "changed task" } }, ...base.prefix.c2.slice(1)],
    }),
    baseId,
  );
  assert.notEqual(
    prefixIdentityOf({
      ...base.prefix,
      c3: [
        {
          contentId: "artifact-1",
          value: { digest: "different" },
          provenance: { source: "suzukuri", reference: "artifact:1", supplied: false },
        },
      ],
    }),
    baseId,
  );
});

test("session/worktree/branch/agent/model facts do not fragment prefix identity", () => {
  const first = document();
  const second = document({
    executionAttachment: {
      generation: 2,
      sessionId: "session-2",
      worktreeId: "worktree-2",
      branchName: "feature/two",
      agentId: "agent-2",
      modelId: "model-2",
    },
  });
  assert.equal(prefixIdentityOf(first.prefix), prefixIdentityOf(second.prefix));
  assert.notEqual(
    executionStateIdentityOf(prefixIdentityOf(first.prefix), first.executionAttachment),
    executionStateIdentityOf(prefixIdentityOf(second.prefix), second.executionAttachment),
  );
});

test("different attachment generations produce distinct execution_state_id values for one prefix", () => {
  const current = document();
  const prefixId = prefixIdentityOf(current.prefix);
  const nextAttachment = { ...current.executionAttachment, generation: current.executionAttachment.generation + 1 };
  assert.notEqual(
    executionStateIdentityOf(prefixId, current.executionAttachment),
    executionStateIdentityOf(prefixId, nextAttachment),
  );
  const identities = identitiesOf(current);
  assert.equal(identities.prefix_id, prefixId);
  assert.equal(identities.execution_state_id, executionStateIdentityOf(prefixId, current.executionAttachment));
});

test("already-supplied runtime instruction is represented by provenance without a body", () => {
  const parsed = parseCanonDocument(document());
  const alreadySupplied = parsed.prefix.c0.runtimeInstructions.find(
    (instruction) => instruction.provenance === "already-supplied",
  );
  assert.ok(alreadySupplied);
  assert.equal("body" in alreadySupplied, false);
});
