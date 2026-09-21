import assert from "node:assert/strict";
import test from "node:test";
import type { CanonC3Candidate } from "./candidates.js";
import { admitCanonC3Candidates, type CanonC3SuzukuriCompanion } from "./admission.js";
import type { SuzukuriProjectionRequest, SuzukuriProjectionResult, SuzukuriResult } from "../suzukuri.js";

function candidate(id: string, generation = "generation-1"): CanonC3Candidate {
  return {
    candidateId: `c3:${id}`,
    source: { identity: `repo:${id}`, generation },
    selector: { type: "symbol", value: `symbol:${id}` },
    selectionReason: "explicit symbol selector",
    semanticProvenance: {
      source: "repository-semantics",
      reference: `symbol:${id}`,
      entityId: `symbol:${id}`,
      entityKind: "symbol",
      authority: "derived",
      relationIds: [],
      producer: { name: "fixture", version: "1" },
    },
  };
}

function projection(request: SuzukuriProjectionRequest, version = "1.0.0"): SuzukuriProjectionResult {
  const component = (id: string) => ({ id, version });
  return {
    source:
      request.source instanceof Uint8Array || typeof request.source === "string"
        ? { id: "unexpected" }
        : (request.source.identity as { id: string; revision: string }),
    sourceIdentity: request.sourceIdentity as { id: string; revision: string },
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    budget: request.budget,
    suzukuriVersion: "0.2.2",
    output: '{"value":"ok"}',
    outputSize: 14,
    byteLength: 14,
    coreVersion: version,
    adapter: component("adapter"),
    contract: component("contract"),
    semanticContract: component("contract"),
    view: component("view"),
    renderer: component("renderer"),
    components: {
      adapter: component("adapter"),
      semanticContract: component("contract"),
      view: component("view"),
      renderer: component("renderer"),
    },
    provenance: {
      core: component("suzukuri-projection-core"),
      adapter: component("adapter"),
      semanticContract: component("contract"),
      view: component("view"),
      renderer: component("renderer"),
    },
    projectionDigest: "a".repeat(64),
    completeness: "complete",
    loss: { state: "none", discarded: [] },
    diagnostics: [],
  };
}

function companion(
  version = "1.0.0",
  loss: SuzukuriProjectionResult["loss"] = { state: "none", discarded: [] },
): CanonC3SuzukuriCompanion & { requests: SuzukuriProjectionRequest[] } {
  const requests: SuzukuriProjectionRequest[] = [];
  return {
    requests,
    async project(request): Promise<SuzukuriResult<SuzukuriProjectionResult>> {
      requests.push(request);
      return { ok: true, value: { ...projection(request, version), loss } };
    },
  };
}

const intent = {
  adapter: "adapter@1.0.0",
  view: "view@1.0.0",
  budget: 1000,
  renderer: "renderer@1.0.0",
  contract: "contract@1.0.0",
  profile: "explicit-profile",
};
const identityIntent = { ...intent, adapter: "adapter", view: "view", renderer: "renderer", contract: "contract" };

test("admission invokes the companion in candidate order and retains provenance", async () => {
  const managed = companion();
  const result = await admitCanonC3Candidates({
    candidates: [candidate("first"), candidate("second")],
    sourceForCandidate: (item) => ({ content: item.candidateId }),
    projectionIntent: identityIntent,
    companion: managed,
  });

  assert.equal(result.ok, true);
  assert.equal(result.completeness, "complete");
  assert.deepEqual(
    managed.requests.map((request) => (request.source as { identity: { id: string } }).identity.id),
    ["repo:first", "repo:second"],
  );
  assert.deepEqual(
    result.entries.map((entry) => (entry.value as { ordinal: number }).ordinal),
    [0, 1],
  );
  const first = result.entries[0]!.value as {
    candidate: { source: { generation: string } };
    projection: Record<string, unknown>;
  };
  assert.equal(first.candidate.source.generation, "generation-1");
  assert.equal(first.projection.projectionDigest, "a".repeat(64));
  assert.equal((first.projection.loss as { state: string }).state, "none");
});

test("source generation and component version are admitted identity inputs", async () => {
  const first = await admitCanonC3Candidates({
    candidates: [candidate("one", "generation-1")],
    sourceForCandidate: () => "source",
    projectionIntent: identityIntent,
    companion: companion("1.0.0"),
  });
  const generationChanged = await admitCanonC3Candidates({
    candidates: [candidate("one", "generation-2")],
    sourceForCandidate: () => "source",
    projectionIntent: identityIntent,
    companion: companion("1.0.0"),
  });
  const componentChanged = await admitCanonC3Candidates({
    candidates: [candidate("one")],
    sourceForCandidate: () => "source",
    projectionIntent: identityIntent,
    companion: companion("2.0.0"),
  });
  assert.equal(first.ok, true);
  assert.equal(generationChanged.ok, true);
  assert.equal(componentChanged.ok, true);
  assert.notDeepEqual(first.entries, generationChanged.entries);
  assert.notDeepEqual(first.entries, componentChanged.entries);
});

test("missing or mismatched projection is an explicit incomplete result", async () => {
  const missing = await admitCanonC3Candidates({
    candidates: [candidate("one")],
    sourceForCandidate: () => "source",
    projectionIntent: intent,
    companion: {
      async project(): Promise<SuzukuriResult<SuzukuriProjectionResult>> {
        return {
          ok: false,
          error: {
            code: "SUZUKURI_CAPABILITY_UNAVAILABLE",
            phase: "capability",
            message: "unsupported",
            retryable: false,
            details: {},
          },
        };
      },
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.completeness, "incomplete");
  assert.deepEqual(missing.entries, []);
  assert.equal(missing.diagnostics[0]?.code, "projection-failed");

  const mismatch = await admitCanonC3Candidates({
    candidates: [candidate("one")],
    sourceForCandidate: () => ({ content: "source", identity: { id: "wrong", revision: "generation-1" } }),
    projectionIntent: intent,
    companion: companion(),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.diagnostics[0]?.code, "source-identity-mismatch");
});

test("bounded partial loss is retained as projection provenance", async () => {
  const result = await admitCanonC3Candidates({
    candidates: [candidate("one")],
    sourceForCandidate: () => "source",
    projectionIntent: intent,
    companion: companion("1.0.0", { state: "partial", discarded: ["optional-field"] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual((result.entries[0]!.value as { projection: { loss: unknown } }).projection.loss, {
    state: "partial",
    discarded: ["optional-field"],
  });
});
