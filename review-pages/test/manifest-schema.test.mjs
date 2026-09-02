import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest, validatePrIndex } from "../src/validate-manifest.mjs";

const validManifest = {
  schemaVersion: "mottainai.review-pages.manifest/v1",
  generator: { name: "mottainai-review-pages", version: "1.0.0" },
  repository: { owner: "yohn-jp", name: "mottainai", fullName: "yohn-jp/mottainai" },
  pullRequest: {
    number: 704,
    title: "example",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "feature",
    headSha: "b".repeat(40),
    draft: false,
  },
  revision: { id: "b".repeat(40), shortId: "b".repeat(12), immutable: true },
  resources: { issue: "issue.json", diff: "diff.json", ocr: "ocr.json", checks: "checks.json", html: "index.html" },
  volatile: { fields: ["volatile.generatedAt"], generatedAt: "2026-09-01T00:00:00.000Z" },
};

test("a well-formed manifest validates", () => {
  const result = validateManifest(validManifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("a missing required field is rejected", () => {
  const { draft: _draft, ...withoutDraft } = validManifest.pullRequest;
  const result = validateManifest({ ...validManifest, pullRequest: withoutDraft });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('missing required property "draft"')));
});

test("a non-full SHA is rejected", () => {
  const result = validateManifest({
    ...validManifest,
    pullRequest: { ...validManifest.pullRequest, headSha: "abc123" },
  });
  assert.equal(result.valid, false);
});

test("revision.immutable must be true", () => {
  const result = validateManifest({ ...validManifest, revision: { ...validManifest.revision, immutable: false } });
  assert.equal(result.valid, false);
});

test("an unknown top-level property is rejected", () => {
  const result = validateManifest({ ...validManifest, extra: true });
  assert.equal(result.valid, false);
});

test("a well-formed PR index validates, including a null latest", () => {
  assert.equal(
    validatePrIndex({ schemaVersion: "mottainai.review-pages.pr-index/v1", number: 704, latest: null }).valid,
    true,
  );
  assert.equal(
    validatePrIndex({
      schemaVersion: "mottainai.review-pages.pr-index/v1",
      number: 704,
      latest: { headSha: "b".repeat(40), shortId: "b".repeat(12), path: "704/b/manifest.json", generatedAt: "now" },
    }).valid,
    true,
  );
});
