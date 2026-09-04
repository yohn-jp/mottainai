import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github/workflows/publish.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");

test("release workflow records the #303 local exception against the current shared contract", () => {
  assert.match(workflowText, /Issue #303 decision[\s\S]*retain this repository-local release/u);
  assert.match(workflowText, /443f7a5b2283dde9f1e89b2a0a08413704e7b4fc/u);
  assert.match(workflowText, /48a44df33af04819f8cf971bbb5196b7cf2cc749/u);
  assert.match(workflowText, /yohn-jp\/mottainai#239 and yohn-jp\/\.github#10/u);
});

test("local release workflow preserves its release trigger and canonical artifact checks", () => {
  assert.match(workflowText, /push:\n    branches: \[main\]\n    paths: \[package\.json\]/u);
  assert.doesNotMatch(workflowText, /uses:\s*yohn-jp\/\.github\/\.github\/workflows\/npm-publish\.yml@/u);
  assert.match(workflowText, /node scripts\/pack-canonical-payload\.mjs/u);
  assert.ok((workflowText.match(/node scripts\/verify-canonical-payload\.mjs/gu) ?? []).length >= 3);
  assert.match(workflowText, /path: \$\{\{ runner\.temp \}\}\/mottainai-canonical-payload\/\*/u);
  assert.match(workflowText, /name: Publish to npm/u);
});

test("local publish remains OIDC-only and does not add a long-lived npm credential", () => {
  assert.match(workflowText, /id-token: write/u);
  assert.doesNotMatch(workflowText, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/u);
  assert.match(workflowText, /npm install --global npm@11\.5\.1/u);
  assert.match(workflowText, /npm publish "\$\(find \. -maxdepth 1 -type f -name 'mottainai-\*\.tgz'/u);
});
