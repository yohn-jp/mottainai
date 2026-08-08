import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectResult } from "./project.js";
import { IdentitySession } from "./dedupe.js";
import {
  createIdentityHint,
  createProjectionIdentity,
  hashContent,
  resolveFileContentIdentity,
} from "./identity.js";
import { inspectReadFile } from "./read-adapter.js";
import type { ProjectionBudget } from "./types.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function gitWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-identity-git-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

test("committed Git blob identity is reused and survives a committed identical rename", async () => {
  const root = await gitWorkspace();
  try {
    const original = path.join(root, "original.txt");
    await fs.writeFile(original, "same bytes\n");
    git(root, ["add", "original.txt"]);
    git(root, ["commit", "-q", "-m", "initial"]);

    const originalMetadata = await inspectReadFile(original);
    const originalIdentity = await resolveFileContentIdentity(original, root, originalMetadata.contentHash);
    assert.equal(originalIdentity?.source, "git-blob");
    assert.equal(originalIdentity?.id, `ci1:git-blob:${git(root, ["rev-parse", "HEAD:original.txt"])}`);

    git(root, ["mv", "original.txt", "renamed.txt"]);
    git(root, ["commit", "-q", "-m", "rename"]);
    const renamed = path.join(root, "renamed.txt");
    const renamedMetadata = await inspectReadFile(renamed);
    const renamedIdentity = await resolveFileContentIdentity(renamed, root, renamedMetadata.contentHash);
    assert.deepEqual(renamedIdentity, originalIdentity);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dirty and untracked identities use actual content and do not use mtime or path", async () => {
  const root = await gitWorkspace();
  try {
    const tracked = path.join(root, "tracked.txt");
    await fs.writeFile(tracked, "committed\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-q", "-m", "initial"]);
    await fs.writeFile(tracked, "dirty\n");
    const dirtyMetadata = await inspectReadFile(tracked);
    const dirty = await resolveFileContentIdentity(tracked, root, dirtyMetadata.contentHash);
    assert.equal(dirty?.source, "content-hash");
    assert.notEqual(dirty?.id, `ci1:git-blob:${git(root, ["rev-parse", "HEAD:tracked.txt"])}`);

    const first = path.join(root, "untracked-a.txt");
    const second = path.join(root, "untracked-b.txt");
    await fs.writeFile(first, "untracked bytes\n");
    await fs.writeFile(second, "untracked bytes\n");
    const firstMetadata = await inspectReadFile(first);
    const secondMetadata = await inspectReadFile(second);
    const firstIdentity = await resolveFileContentIdentity(first, root, firstMetadata.contentHash);
    const secondIdentity = await resolveFileContentIdentity(second, root, secondMetadata.contentHash);
    assert.equal(firstIdentity?.source, "content-hash");
    assert.deepEqual(secondIdentity, firstIdentity);
    assert.equal(firstMetadata.contentHash, hashContent("untracked bytes\n"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("projection identity changes with policy, versioned hint, and diagnostics", () => {
  const hint = createIdentityHint({
    content_id: "ci1:sha256:content",
    adapter: "local_file_read_v1",
    source_key: "file:src/example.ts",
    projection_key: "rk1:policy-a",
  });
  const projected = projectResult({
    structuredContent: {
      operation: "read",
      status: "success",
      summary: "example",
      facts: [],
      diagnostics: [],
      metrics: {},
      result_id: "mx_result",
      truncated: false,
      identity: hint,
      path: "src/example.ts",
      mode: "raw",
    },
    content: [{ type: "text", text: "example" }],
  });
  const budget: ProjectionBudget = { softTokens: 100, hardTokens: 200, hardBytes: 800 };
  const first = createProjectionIdentity({ hint, budget, projected });
  const budgetChanged = createProjectionIdentity({
    hint,
    budget: { ...budget, hardBytes: 900 },
    projected,
  });
  const policyChanged = createProjectionIdentity({
    hint: { ...hint, projection_key: "rk1:policy-b" },
    budget,
    projected,
  });
  const diagnosticsChanged = createProjectionIdentity({
    hint,
    budget,
    projected: { ...projected, diagnostics: [{ severity: "warning", message: "changed" }] },
  });
  assert.notEqual(first, budgetChanged);
  assert.notEqual(first, policyChanged);
  assert.notEqual(first, diagnosticsChanged);
});

test("identity session detects tuple collision and invalid content identity conservatively", async () => {
  const session = new IdentitySession();
  const observation = {
    identity_id: "ri1:collision",
    content_id: "ci1:a",
    projection_id: "pi1:a",
    result_id: "mx_a",
    source_key: "file:a",
  };
  session.remember(observation);
  const collision = session.lookup({ ...observation, content_id: "ci1:b", result_id: "mx_b" });
  assert.equal(collision.hit, false);
  assert.equal(collision.collision, true);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-identity-invalid-"));
  try {
    const filePath = path.join(root, "file.txt");
    await fs.writeFile(filePath, "content");
    assert.equal(await resolveFileContentIdentity(filePath, root, "not-a-hash"), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

