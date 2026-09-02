import assert from "node:assert/strict";
import test from "node:test";
import {
  generateReviewPackage,
  isEligibleForGeneration,
  MANIFEST_SCHEMA_VERSION,
} from "../src/generate-review-package.mjs";
import { canonicalStringify } from "../src/lib/canonical-json.mjs";
import { createFixtureRepo, removeFixtureRepo } from "./helpers/fixture-repo.mjs";

const stubIssue = async () => ({
  number: 704,
  title: "publish deterministic PR review context",
  html_url: "https://github.com/yohn-jp/mottainai/issues/704",
  state: "open",
  body: "## Acceptance criteria\n- [ ] first\n- [x] second\n",
  labels: [{ name: "enhancement" }],
});

const stubChecks = async () => [
  { name: "CI / test", status: "completed", conclusion: "success", details_url: "https://example.test/1" },
  { name: "Governance", status: "completed", conclusion: "success", details_url: "https://example.test/2" },
];

function baseInput(fixture, overrides = {}) {
  return {
    repository: { owner: "yohn-jp", name: "mottainai" },
    pullRequest: {
      number: 704,
      title: "feat: review pages",
      baseRef: "main",
      baseSha: fixture.baseSha,
      headRef: "feature/704",
      headSha: fixture.headSha,
      draft: false,
      body: "Closes #704",
      ...overrides,
    },
    token: "test-token",
    cwd: fixture.dir,
    generatedAt: "2026-09-01T00:00:00.000Z",
    fetchIssueFn: stubIssue,
    fetchCheckRunsFn: stubChecks,
  };
}

test("draft pull requests are excluded from generation", async () => {
  const fixture = createFixtureRepo();
  try {
    assert.equal(isEligibleForGeneration({ draft: true }), false);
    assert.equal(isEligibleForGeneration({ draft: false }), true);
    await assert.rejects(
      () => generateReviewPackage(baseInput(fixture, { draft: true })),
      /draft pull requests do not produce a review-ready revision/u,
    );
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("generation from fixed fixture inputs is byte-for-byte deterministic", async () => {
  const fixture = createFixtureRepo();
  try {
    const first = await generateReviewPackage(baseInput(fixture));
    const second = await generateReviewPackage(baseInput(fixture));

    assert.equal(canonicalStringify(first.manifest), canonicalStringify(second.manifest));
    assert.equal(canonicalStringify(first.resources["diff.json"]), canonicalStringify(second.resources["diff.json"]));
    assert.equal(canonicalStringify(first.resources["ocr.json"]), canonicalStringify(second.resources["ocr.json"]));
    assert.equal(first.html, second.html);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("revision identity uses the full head SHA; short SHA is display-only", async () => {
  const fixture = createFixtureRepo();
  try {
    const { manifest } = await generateReviewPackage(baseInput(fixture));
    assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.revision.id, fixture.headSha);
    assert.equal(manifest.revision.id.length, 40);
    assert.equal(manifest.revision.shortId, fixture.headSha.slice(0, 12));
    assert.equal(manifest.revision.immutable, true);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("diff.json records per-file status and counts from the fixture repo", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture));
    const diff = resources["diff.json"];
    const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
    assert.equal(byPath["a.js"].status, "modified");
    assert.equal(byPath["c.js"].status, "added");
    assert.equal(
      diff.files.some((file) => file.path === "b.js"),
      false,
    );
    assert.equal(diff.stats.filesChanged, 2);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("ocr.json consumes OCR's own delegate preview/rule output rather than reimplementing it", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture));
    const ocr = resources["ocr.json"];
    assert.equal(ocr.provider.package, "@alibaba-group/open-code-review");
    assert.match(ocr.provider.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(ocr.provider.cli, "ocr delegate");
    assert.equal(ocr.baseSha, fixture.baseSha);
    assert.equal(ocr.headSha, fixture.headSha);

    // preview: OCR's own changed-file selection (a.js/c.js are reviewable
    // .js files; b.js is unchanged and never appears).
    assert.equal("repository" in ocr.preview, false, "the local filesystem path is stripped");
    const reviewablePaths = ocr.preview.reviewable_files.map((file) => file.path).sort();
    assert.deepEqual(reviewablePaths, ["a.js", "c.js"]);

    // rule: OCR's own resolved review rules for those files.
    assert.ok(ocr.rule.groups.length > 0);
    const filesInGroups = ocr.rule.groups.flatMap((group) => group.files);
    assert.deepEqual([...filesInGroups].sort(), ["a.js", "c.js"]);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("diff.json carries Review Pages' own hunk-positioning metadata", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture));
    const diff = resources["diff.json"];
    const changed = diff.files.find((file) => file.path === "a.js");
    assert.ok(changed.hunks.length > 0);
    assert.ok(Number.isInteger(changed.hunks[0].newStart));
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("issue.json resolves the linked issue and its acceptance criteria", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture));
    const issue = resources["issue.json"];
    assert.equal(issue.linked.number, 704);
    assert.equal(issue.issue.number, 704);
    assert.deepEqual(issue.acceptanceCriteria, [
      { text: "first", checked: false },
      { text: "second", checked: true },
    ]);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("issue.json records no linked issue without inventing one", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture, { body: "no reference" }));
    const issue = resources["issue.json"];
    assert.equal(issue.linked, null);
    assert.equal(issue.issue, null);
    assert.deepEqual(issue.acceptanceCriteria, []);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("checks.json surfaces existing check-runs sorted by name", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage(baseInput(fixture));
    const checks = resources["checks.json"];
    assert.equal(checks.available, true);
    assert.deepEqual(
      checks.checkRuns.map((run) => run.name),
      ["CI / test", "Governance"],
    );
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("checks.json reports unavailability rather than fabricating evidence", async () => {
  const fixture = createFixtureRepo();
  try {
    const { resources } = await generateReviewPackage({
      ...baseInput(fixture),
      fetchCheckRunsFn: async () => null,
    });
    assert.equal(resources["checks.json"].available, false);
    assert.deepEqual(resources["checks.json"].checkRuns, []);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});

test("the PR-level index resolves to the just-generated revision", async () => {
  const fixture = createFixtureRepo();
  try {
    const { prIndex, manifest } = await generateReviewPackage(baseInput(fixture));
    assert.equal(prIndex.number, 704);
    assert.equal(prIndex.latest.headSha, manifest.revision.id);
    assert.equal(prIndex.latest.path, `704/${fixture.headSha}/manifest.json`);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});
