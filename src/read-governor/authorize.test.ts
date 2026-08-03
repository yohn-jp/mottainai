import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authorizeRead } from "./authorize.js";
import { InMemoryEvidenceStore } from "./evidence.js";

function baseRequest() {
  return {
    repositoryId: "repo-1",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    path: "src/foo.ts",
    startLine: 15,
    endLine: 20,
  };
}

function issueBaseEvidence(store: InMemoryEvidenceStore) {
  return store.issue({
    repositoryId: "repo-1",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    provider: "codegraph",
    path: "src/foo.ts",
    startLine: 10,
    endLine: 40,
    reason: "codegraph_explore located definition",
  });
}

test("no evidenceId is rejected without touching the store", () => {
  const store = new InMemoryEvidenceStore();
  const result = authorizeRead(baseRequest(), store);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "no evidenceId provided");
});

test("valid authorization: request range within evidence range allows", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead({ ...baseRequest(), evidenceId: evidence.evidenceId }, store);
  assert.equal(result.outcome, "allow");
  assert.equal(result.evidence?.evidenceId, evidence.evidenceId);
});

test("path mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), path: "src/bar.ts", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "path mismatch");
});

test("range overflow is rewritten to the evidence bounds", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), startLine: 1, endLine: 500, evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rewrite");
  assert.deepEqual(result.rewrittenRange, { startLine: 10, endLine: 40 });
});

test("session mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), sessionId: "session-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "session mismatch");
});

test("worktree mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), worktreeId: "worktree-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "worktree mismatch");
});

test("repository mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), repositoryId: "repo-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "repository mismatch");
});

test("expired evidence is rejected", () => {
  const store = new InMemoryEvidenceStore({ now: () => 1000, ttlMs: 10 });
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead({ ...baseRequest(), evidenceId: evidence.evidenceId }, store, 2000);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "evidence expired");
});

test("unknown evidenceId is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const result = authorizeRead({ ...baseRequest(), evidenceId: "rev_does-not-exist" }, store);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "evidence not found");
});

test("path traversal in the request path is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(), path: "../../etc/passwd", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "path traversal detected");
});

test("symlink escape outside the worktree root is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-evidence-"));
  try {
    const worktreeRoot = path.join(root, "worktree");
    fs.mkdirSync(worktreeRoot);
    fs.writeFileSync(path.join(root, "secret.txt"), "outside worktree");
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(worktreeRoot, "link.ts"));

    const store = new InMemoryEvidenceStore();
    const evidence = store.issue({
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
      provider: "codegraph",
      path: "link.ts",
      startLine: 1,
      endLine: 10,
      reason: "codegraph_explore located definition",
    });

    const result = authorizeRead(
      {
        repositoryId: "repo-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        path: "link.ts",
        startLine: 1,
        endLine: 5,
        evidenceId: evidence.evidenceId,
        worktreeRoot,
      },
      store,
    );
    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "symlink escape detected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
