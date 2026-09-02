import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mergeRevisionIntoSite,
  publishGeneratedRevision,
  prepareWorkingTree,
  refreshWorkingTreeFromRemote,
  ImmutableRevisionConflictError,
} from "../src/publish-to-pages.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBareRemote() {
  const dir = tempDir("mottainai-review-pages-remote-");
  git(["init", "--bare", "--initial-branch", "gh-pages", dir], process.cwd());
  return dir;
}

// A minimal, self-identifying revision directory carrying every file
// the immutability comparison reads (manifest, issue, diff, ocr,
// index.html, checks), enough to prove both cross-PR isolation and
// same-SHA immutability without running the full generator.
function writeRevision(prNumber, headSha, { contentMarker = "a", checksMarker = "success", generatedAt } = {}) {
  const outputDir = tempDir(`mottainai-review-pages-out-${prNumber}-`);
  const revisionDir = path.join(outputDir, headSha);
  fs.mkdirSync(revisionDir, { recursive: true });
  fs.writeFileSync(
    path.join(revisionDir, "manifest.json"),
    JSON.stringify({ prNumber, headSha, volatile: { generatedAt: generatedAt ?? new Date().toISOString() } }),
  );
  fs.writeFileSync(path.join(revisionDir, "issue.json"), JSON.stringify({ marker: contentMarker }));
  fs.writeFileSync(path.join(revisionDir, "diff.json"), JSON.stringify({ marker: contentMarker }));
  fs.writeFileSync(path.join(revisionDir, "ocr.json"), JSON.stringify({ status: "unavailable" }));
  fs.writeFileSync(path.join(revisionDir, "index.html"), `<html>${contentMarker}</html>`);
  fs.writeFileSync(path.join(revisionDir, "checks.json"), JSON.stringify({ checkRuns: [checksMarker] }));
  const prIndexFile = path.join(outputDir, "pr-index.json");
  fs.writeFileSync(prIndexFile, JSON.stringify({ number: prNumber, latest: { headSha } }));
  return { revisionDir, prIndexFile };
}

function cloneForInspection(remoteUrl, branch) {
  const dir = tempDir("mottainai-review-pages-inspect-");
  git(["clone", "--branch", branch, "--single-branch", remoteUrl, "."], dir);
  return dir;
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), "utf8"));
}

test("publishing two different PRs never erases either PR's data", () => {
  const remote = makeBareRemote();
  const branch = "gh-pages";
  try {
    const prA = writeRevision(101, "a".repeat(40));
    const prB = writeRevision(102, "b".repeat(40));

    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 101,
      revisionDir: prA.revisionDir,
      prIndexFile: prA.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-a-"),
    });
    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 102,
      revisionDir: prB.revisionDir,
      prIndexFile: prB.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-b-"),
    });

    const inspect = cloneForInspection(remote, branch);
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "101", "a".repeat(40), "manifest.json")));
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "102", "b".repeat(40), "manifest.json")));
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "101", "index.json")));
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "102", "index.json")));
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("a second revision for the same PR updates latest but keeps the first revision intact", () => {
  const remote = makeBareRemote();
  const branch = "gh-pages";
  try {
    const revisionOne = writeRevision(704, "1".repeat(40));
    const revisionTwo = writeRevision(704, "2".repeat(40));

    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 704,
      revisionDir: revisionOne.revisionDir,
      prIndexFile: revisionOne.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-1-"),
    });
    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 704,
      revisionDir: revisionTwo.revisionDir,
      prIndexFile: revisionTwo.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-2-"),
    });

    const inspect = cloneForInspection(remote, branch);
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "704", "1".repeat(40), "manifest.json")));
    assert.ok(fs.existsSync(path.join(inspect, "reviews", "pr", "704", "2".repeat(40), "manifest.json")));
    const index = readJson(inspect, "reviews", "pr", "704", "index.json");
    assert.equal(index.latest.headSha, "2".repeat(40));
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("republishing the same SHA with identical deterministic content is a no-op except the volatile checks.json refresh", () => {
  const remote = makeBareRemote();
  const branch = "gh-pages";
  const sha = "3".repeat(40);
  try {
    const first = writeRevision(705, sha, {
      contentMarker: "a",
      checksMarker: "pending",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 705,
      revisionDir: first.revisionDir,
      prIndexFile: first.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-first-"),
    });

    // Same deterministic content, but a later generatedAt and advanced
    // check state — exactly what a genuine re-run looks like.
    const second = writeRevision(705, sha, {
      contentMarker: "a",
      checksMarker: "success",
      generatedAt: "2026-01-02T00:00:00.000Z",
    });
    const result = publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 705,
      revisionDir: second.revisionDir,
      prIndexFile: second.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-second-"),
    });
    assert.equal(result.pushed, true, "the checks.json refresh is itself a real, pushed change");

    const inspect = cloneForInspection(remote, branch);
    const revisionDir = path.join(inspect, "reviews", "pr", "705", sha);
    assert.equal(
      readJson(revisionDir, "manifest.json").volatile.generatedAt,
      "2026-01-01T00:00:00.000Z",
      "original generatedAt is preserved, not overwritten",
    );
    assert.deepEqual(readJson(revisionDir, "issue.json"), { marker: "a" });
    assert.equal(fs.readFileSync(path.join(revisionDir, "index.html"), "utf8"), "<html>a</html>");
    assert.deepEqual(readJson(revisionDir, "checks.json"), { checkRuns: ["success"] }, "checks.json is refreshed");
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("republishing the same SHA with different deterministic content is rejected and leaves the existing revision untouched", () => {
  const remote = makeBareRemote();
  const branch = "gh-pages";
  const sha = "4".repeat(40);
  try {
    const first = writeRevision(706, sha, { contentMarker: "original" });
    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 706,
      revisionDir: first.revisionDir,
      prIndexFile: first.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-orig-"),
    });

    const conflicting = writeRevision(706, sha, { contentMarker: "different" });
    assert.throws(
      () =>
        publishGeneratedRevision({
          remoteUrl: remote,
          branch,
          prNumber: 706,
          revisionDir: conflicting.revisionDir,
          prIndexFile: conflicting.prIndexFile,
          workDir: tempDir("mottainai-review-pages-work-conflict-"),
        }),
      ImmutableRevisionConflictError,
    );

    const inspect = cloneForInspection(remote, branch);
    const revisionDir = path.join(inspect, "reviews", "pr", "706", sha);
    assert.deepEqual(
      readJson(revisionDir, "issue.json"),
      { marker: "original" },
      "the rejected publish left the original revision untouched",
    );
    assert.equal(fs.readFileSync(path.join(revisionDir, "index.html"), "utf8"), "<html>original</html>");
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test("a stale push is rejected, and a refetch-and-retry recovers without erasing the other PR's data", () => {
  const remote = makeBareRemote();
  const branch = "gh-pages";
  try {
    const seed = writeRevision(1, "1".repeat(40));
    publishGeneratedRevision({
      remoteUrl: remote,
      branch,
      prNumber: 1,
      revisionDir: seed.revisionDir,
      prIndexFile: seed.prIndexFile,
      workDir: tempDir("mottainai-review-pages-work-seed-"),
    });

    const prA = writeRevision(2, "a".repeat(40));
    const prB = writeRevision(3, "b".repeat(40));
    const workDirA = tempDir("mottainai-review-pages-work-race-a-");
    const workDirB = tempDir("mottainai-review-pages-work-race-b-");

    // Both writers start from the same remote tip (post-seed), simulating
    // two workflow runs that fetched before either had pushed.
    prepareWorkingTree(workDirA, remote, branch);
    prepareWorkingTree(workDirB, remote, branch);

    mergeRevisionIntoSite(workDirA, 2, prA.revisionDir, prA.prIndexFile);
    git(["add", "-A"], workDirA);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "publish PR 2"], workDirA);
    git(["push", "origin", `HEAD:${branch}`], workDirA);

    mergeRevisionIntoSite(workDirB, 3, prB.revisionDir, prB.prIndexFile);
    git(["add", "-A"], workDirB);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "publish PR 3"], workDirB);
    assert.throws(() => git(["push", "origin", `HEAD:${branch}`], workDirB), /rejected|non-fast-forward|fetch first/u);

    // The recovery: refetch the new tip and reapply PR 3's own merge on
    // top of it, then push again.
    refreshWorkingTreeFromRemote(workDirB, branch);
    mergeRevisionIntoSite(workDirB, 3, prB.revisionDir, prB.prIndexFile);
    git(["add", "-A"], workDirB);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "publish PR 3 (retry)"], workDirB);
    git(["push", "origin", `HEAD:${branch}`], workDirB);

    const inspect = cloneForInspection(remote, branch);
    assert.ok(
      fs.existsSync(path.join(inspect, "reviews", "pr", "1", "1".repeat(40), "manifest.json")),
      "seed PR survives",
    );
    assert.ok(
      fs.existsSync(path.join(inspect, "reviews", "pr", "2", "a".repeat(40), "manifest.json")),
      "PR 2 survives",
    );
    assert.ok(
      fs.existsSync(path.join(inspect, "reviews", "pr", "3", "b".repeat(40), "manifest.json")),
      "PR 3 survives",
    );
  } finally {
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
