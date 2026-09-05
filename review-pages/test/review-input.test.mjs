import assert from "node:assert/strict";
import test from "node:test";
import { assembleReviewInput, REVIEW_INPUT_SCHEMA_VERSION } from "../src/build-review-input.mjs";

const BASE_SHA = "1111111111111111111111111111111111111111";
const HEAD_SHA = "2222222222222222222222222222222222222222";

function completePackage() {
  const manifest = {
    schemaVersion: "mottainai.review-pages.manifest/v1",
    generator: { name: "mottainai-review-pages", version: "1.0.0" },
    repository: { owner: "yohn-jp", name: "mottainai", fullName: "yohn-jp/mottainai" },
    pullRequest: {
      number: 717,
      title: "assemble review input",
      baseRef: "main",
      baseSha: BASE_SHA,
      headRef: "feature/717",
      headSha: HEAD_SHA,
      draft: false,
    },
    revision: { id: HEAD_SHA, shortId: HEAD_SHA.slice(0, 12), immutable: true },
    resources: { issue: "issue.json", diff: "diff.json", ocr: "ocr.json", checks: "checks.json", html: "index.html" },
    volatile: { fields: ["volatile.generatedAt", "checks.checkRuns"], generatedAt: "2026-09-01T00:00:00.000Z" },
  };

  return {
    manifest,
    resources: {
      "issue.json": {
        schemaVersion: "mottainai.review-pages.issue/v1",
        linked: { number: 717 },
        issue: {
          number: 717,
          title: "assemble review input",
          url: "https://github.com/yohn-jp/mottainai/issues/717",
          state: "open",
          labels: ["enhancement"],
        },
        acceptanceCriteria: [{ text: "Keep the adapter bounded", checked: true }],
      },
      "diff.json": {
        schemaVersion: "mottainai.review-pages.diff/v1",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        files: [
          {
            path: "review-pages/src/build-review-input.mjs",
            status: "added",
            additions: 10,
            deletions: 0,
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10 }],
          },
        ],
        stats: { filesChanged: 1, additions: 10, deletions: 0 },
      },
      "ocr.json": {
        schemaVersion: "mottainai.review-pages.ocr/v1",
        provider: { package: "@alibaba-group/open-code-review", version: "1.11.4", cli: "ocr delegate" },
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        preview: {
          reviewable_files: [{ path: "review-pages/src/build-review-input.mjs" }],
          excluded_files: [{ path: "package-lock.json", reason: "unsupported extension" }],
        },
        rule: { groups: [{ name: "javascript", files: ["review-pages/src/build-review-input.mjs"] }] },
      },
      "checks.json": {
        schemaVersion: "mottainai.review-pages.checks/v1",
        headSha: HEAD_SHA,
        available: true,
        checkRuns: [{ name: "CI", status: "completed", conclusion: "success", detailsUrl: null }],
      },
    },
  };
}

test("assembles a complete revision without changing identity or resource semantics", () => {
  const revisionPackage = completePackage();
  const input = assembleReviewInput(revisionPackage);

  assert.equal(input.schemaVersion, REVIEW_INPUT_SCHEMA_VERSION);
  assert.deepEqual(input.identity.repository, revisionPackage.manifest.repository);
  assert.deepEqual(input.identity.pullRequest, revisionPackage.manifest.pullRequest);
  assert.deepEqual(input.identity.revision, revisionPackage.manifest.revision);
  assert.equal(input.identity.baseSha, BASE_SHA);
  assert.equal(input.identity.headSha, HEAD_SHA);
  assert.deepEqual(input.issue, revisionPackage.resources["issue.json"]);
  assert.deepEqual(input.diff, revisionPackage.resources["diff.json"]);
  assert.deepEqual(input.ocr.preview.reviewable_files, revisionPackage.resources["ocr.json"].preview.reviewable_files);
  assert.deepEqual(input.ocr.preview.excluded_files, revisionPackage.resources["ocr.json"].preview.excluded_files);
  assert.deepEqual(input.ocr.rule, revisionPackage.resources["ocr.json"].rule);
  assert.deepEqual(input.checks, revisionPackage.resources["checks.json"]);
  assert.deepEqual(input.missing, []);
  assert.deepEqual(input.partial, []);
  assert.deepEqual(input.unknown, []);
  assert.deepEqual(input.unknownDetails, []);
  assert.deepEqual(input.provenance.manifest.resources, revisionPackage.manifest.resources);
  assert.deepEqual(input.provenance.resources.issue, {
    path: "issue.json",
    schemaVersion: "mottainai.review-pages.issue/v1",
    state: "present",
  });
});

test("reports absent and partial resources instead of silently dropping them", () => {
  const revisionPackage = completePackage();
  delete revisionPackage.resources["ocr.json"];
  delete revisionPackage.resources["checks.json"];
  delete revisionPackage.resources["diff.json"].stats;

  const input = assembleReviewInput(revisionPackage);

  assert.deepEqual(input.missing, ["ocr.json", "checks.json"]);
  assert.deepEqual(input.partial, ["diff.json"]);
  assert.equal(input.provenance.resources.ocr.state, "missing");
  assert.equal(input.provenance.resources.checks.state, "missing");
  assert.equal(input.provenance.resources.diff.state, "partial");
  assert.equal(input.diff.stats, undefined);
  assert.ok(input.unknownDetails.some((detail) => detail.resource === "diff.json" && detail.path === "stats"));
});

test("marks malformed or mismatched resources unknown and excludes raw content", () => {
  const revisionPackage = completePackage();
  revisionPackage.manifest.revision.id = BASE_SHA;
  revisionPackage.resources["ocr.json"].headSha = BASE_SHA;
  revisionPackage.resources["ocr.json"].preview.body = "unbounded issue body";
  revisionPackage.resources["ocr.json"].preview.rawDiff = "raw patch";
  revisionPackage.resources["checks.json"] = { schemaVersion: "future", headSha: HEAD_SHA, checkRuns: [] };

  const input = assembleReviewInput(revisionPackage);

  assert.ok(input.unknown.includes("ocr.json"));
  assert.ok(input.unknown.includes("checks.json"));
  assert.equal(input.provenance.manifest.state, "unknown");
  assert.equal(input.ocr.preview.body, undefined);
  assert.equal(input.ocr.preview.rawDiff, undefined);
  assert.ok(
    input.unknownDetails.some(
      (detail) => detail.resource === "ocr.json" && detail.reason.includes("raw source or log content"),
    ),
  );
  assert.equal(input.provenance.resources.ocr.state, "unknown");
  assert.equal(input.provenance.resources.checks.state, "unknown");
});

test("fixed package input produces deterministic output", () => {
  const revisionPackage = completePackage();
  const first = assembleReviewInput(revisionPackage);
  const second = assembleReviewInput(revisionPackage);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
