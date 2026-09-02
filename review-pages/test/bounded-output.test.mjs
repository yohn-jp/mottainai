import assert from "node:assert/strict";
import test from "node:test";
import { generateReviewPackage } from "../src/generate-review-package.mjs";
import { canonicalStringify } from "../src/lib/canonical-json.mjs";
import { createFixtureRepo, removeFixtureRepo } from "./helpers/fixture-repo.mjs";

const FORBIDDEN_RAW_CONTENT_KEYS = ["patch", "diffText", "rawDiff", "content", "log"];

function assertNoForbiddenKeys(value, filePath) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, filePath);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_RAW_CONTENT_KEYS.includes(key), `${filePath} unexpectedly carries raw content key "${key}"`);
      assertNoForbiddenKeys(nested, filePath);
    }
  }
}

test("generated resources exclude raw diff/log content and stay bounded", async () => {
  const fixture = createFixtureRepo();
  try {
    const generated = await generateReviewPackage({
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
      },
      token: "test-token",
      cwd: fixture.dir,
      generatedAt: "2026-09-01T00:00:00.000Z",
      fetchIssueFn: async () => null,
      fetchCheckRunsFn: async () => null,
    });

    for (const [name, value] of Object.entries(generated.resources)) {
      assertNoForbiddenKeys(value, name);
      const bytes = Buffer.byteLength(canonicalStringify(value), "utf8");
      assert.ok(bytes < 100_000, `${name} is ${bytes} bytes, larger than expected for a two-file fixture diff`);
    }
    assert.ok(Buffer.byteLength(canonicalStringify(generated.manifest), "utf8") < 5_000);
    assert.ok(Buffer.byteLength(generated.html, "utf8") < 100_000);
  } finally {
    removeFixtureRepo(fixture.dir);
  }
});
