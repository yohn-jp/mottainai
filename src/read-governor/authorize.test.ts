import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { authorizeRead } from "./authorize.js";
import { InMemoryEvidenceStore } from "./evidence.js";

function baseRequest(worktreeRoot: string) {
  return {
    repositoryId: "repo-1",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    path: "src/foo.ts",
    startLine: 15,
    endLine: 20,
    worktreeRoot,
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

/** authorizeRead の realpath 検査を通すため、worktreeRoot 配下に評価対象ファイルを実体として作る。 */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-evidence-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "foo.ts"), "// fixture\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("no evidenceId is rejected without touching the store", () => {
  const store = new InMemoryEvidenceStore();
  const result = authorizeRead(baseRequest(""), store);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "no evidenceId provided");
});

test("valid authorization: request range within evidence range allows", () => {
  const { root, cleanup } = makeWorktree();
  try {
    const store = new InMemoryEvidenceStore();
    const evidence = issueBaseEvidence(store);
    const result = authorizeRead({ ...baseRequest(root), evidenceId: evidence.evidenceId }, store);
    assert.equal(result.outcome, "allow");
    assert.equal(result.evidence?.evidenceId, evidence.evidenceId);
  } finally {
    cleanup();
  }
});

test("missing worktreeRoot is rejected even when the range and path otherwise match", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead({ ...baseRequest(""), evidenceId: evidence.evidenceId }, store);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "worktree root required");
});

test("path mismatch is rejected", () => {
  const { root, cleanup } = makeWorktree();
  try {
    const store = new InMemoryEvidenceStore();
    const evidence = issueBaseEvidence(store);
    const result = authorizeRead(
      { ...baseRequest(root), path: "src/bar.ts", evidenceId: evidence.evidenceId },
      store,
    );
    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "path mismatch");
  } finally {
    cleanup();
  }
});

test("range overflow is rewritten to the evidence bounds", () => {
  const { root, cleanup } = makeWorktree();
  try {
    const store = new InMemoryEvidenceStore();
    const evidence = issueBaseEvidence(store);
    const result = authorizeRead(
      { ...baseRequest(root), startLine: 1, endLine: 500, evidenceId: evidence.evidenceId },
      store,
    );
    assert.equal(result.outcome, "rewrite");
    assert.deepEqual(result.rewrittenRange, { startLine: 10, endLine: 40 });
  } finally {
    cleanup();
  }
});

test("inverted, negative, and fractional line ranges are rejected", () => {
  const { root, cleanup } = makeWorktree();
  try {
    const store = new InMemoryEvidenceStore();
    const evidence = issueBaseEvidence(store);
    for (const [startLine, endLine] of [[20, 10], [-1, 20], [15, 20.5], [0, 20]] as const) {
      const result = authorizeRead(
        { ...baseRequest(root), startLine, endLine, evidenceId: evidence.evidenceId },
        store,
      );
      assert.equal(result.outcome, "rejected", `startLine=${startLine} endLine=${endLine}`);
      assert.equal(result.reason, "invalid line range");
    }
  } finally {
    cleanup();
  }
});

test("session mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(""), sessionId: "session-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "session mismatch");
});

test("worktree mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(""), worktreeId: "worktree-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "worktree mismatch");
});

test("repository mismatch is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(""), repositoryId: "repo-2", evidenceId: evidence.evidenceId },
    store,
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "repository mismatch");
});

test("expired evidence is rejected", () => {
  const store = new InMemoryEvidenceStore({ now: () => 1000, ttlMs: 10 });
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead({ ...baseRequest(""), evidenceId: evidence.evidenceId }, store, 2000);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "evidence expired");
});

test("unknown evidenceId is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const result = authorizeRead({ ...baseRequest(""), evidenceId: "rev_does-not-exist" }, store);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "evidence not found");
});

test("path traversal in the request path is rejected", () => {
  const store = new InMemoryEvidenceStore();
  const evidence = issueBaseEvidence(store);
  const result = authorizeRead(
    { ...baseRequest(""), path: "../../etc/passwd", evidenceId: evidence.evidenceId },
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
