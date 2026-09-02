import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/review-pages.yml"), "utf8");
const generateStart = workflow.indexOf("  generate:");
const publishStart = workflow.indexOf("  publish:");
const generateJob = workflow.slice(generateStart, publishStart);

test("Review Pages generation checks out the event head and fetches only the exact base", () => {
  assert.notEqual(generateStart, -1);
  assert.notEqual(publishStart, -1);
  assert.match(generateJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(generateJob, /fetch-depth: 1/u);
  assert.doesNotMatch(generateJob, /fetch-depth:\s*0/u);
  assert.match(generateJob, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(generateJob, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(generateJob, /git fetch --no-tags --depth=1 origin "\$BASE_SHA"/u);
  assert.match(generateJob, /git rev-parse --verify HEAD\^\{commit\}/u);
  assert.match(generateJob, /git rev-parse --verify "\$BASE_SHA\^\{commit\}"/u);
  assert.match(generateJob, /unbounded-depth fallback/u);
});
