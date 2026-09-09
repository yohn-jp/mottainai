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
  assert.match(workflowText, /npm install --global npm@12\.0\.2/u);
  assert.match(workflowText, /npm publish "\$\(find \. -maxdepth 1 -type f -name 'mottainai-\*\.tgz'/u);
});

test("release descriptor keeps Route 1 payload bytes separate from Route 2 source NAR identity", () => {
  assert.match(workflowText, /source_nar_sha256: \$\{\{ steps\.route2_closure_smoke\.outputs\.source_nar_sha256 \}\}/u);
  assert.match(workflowText, /sourceStorePath/u);
  assert.match(workflowText, /nix path-info --json --json-format 2/u);
  assert.match(workflowText, /--arg source "\$source_nar_sha256"/u);
  assert.match(workflowText, /sourceSha256:\$source/u);
  assert.match(workflowText, /\.source\.sourceSha256 == \$source/u);
  assert.doesNotMatch(workflowText, /sourceSha256:\$payload/u);
});

test("draft release lookup resolves by tag name through gh release view, not the raw REST tag endpoint (#726)", () => {
  assert.doesNotMatch(workflowText, /releases\/tags\/\$TAG/u);
  assert.match(
    workflowText,
    /if gh release view "\$TAG" --json isDraft,tagName > "\$release_json" 2> "\$release_error"; then/u,
  );
  assert.match(workflowText, /grep -Eq 'release not found' "\$release_error"/u);
  assert.match(
    workflowText,
    /gh release view "\$TAG" --json isDraft,tagName > "\$created_release"\n\s+jq -e --arg tag "\$TAG" '\.isDraft == true and \.tagName == \$tag' "\$created_release"/u,
  );
});

test("publish depends on integration and e2e certification for the exact release SHA (#869)", () => {
  // A regression that only integration/e2e coverage catches must not reach
  // `publish` merely because it passed the fast suite (build) and the
  // packed-tarball smoke test (smoke-test). Assert directly on the
  // `needs:` edge rather than trying to execute a real publish: `publish`
  // must list test-integration and test-e2e as prerequisites, in addition
  // to its existing prepare-release/smoke-test dependencies.
  assert.match(workflowText, /publish:\n\s+needs: \[prepare-release, smoke-test, test-integration, test-e2e\]/u);

  // Both certification jobs must gate on prepare-release having decided to
  // release, and must run against the exact tag/SHA prepare-release
  // resolved -- the same ref build/smoke-test already check out -- not an
  // arbitrary or later revision of main.
  for (const jobName of ["test-integration", "test-e2e"]) {
    const jobPattern = new RegExp(
      "^  " +
        jobName +
        ":\\n(?:.*\\n)*?\\s+needs: prepare-release\\n(?:.*\\n)*?\\s+if: needs\\.prepare-release\\.outputs\\.should_release == 'true'\\n(?:.*\\n)*?\\s+ref: \\$\\{\\{ needs\\.prepare-release\\.outputs\\.tag \\}\\}",
      "mu",
    );
    assert.match(workflowText, jobPattern, jobName + " must depend on prepare-release and check out its exact tag");
  }

  // The certification jobs must actually invoke the integration/e2e test
  // scripts (not merely exist as placeholders) so a real regression in
  // either suite fails the job standing between prepare-release and
  // publish.
  assert.match(workflowText, /run: pnpm run test:integration -- --shard=\$\{\{ matrix\.shard \}\}\/4/u);
  assert.match(workflowText, /run: pnpm run test:e2e/u);

  // Structural DAG proof: every path from prepare-release to publish must
  // pass through both certification jobs. Parse each job's `needs:` list
  // (the workflow uses only bare and bracketed single-line forms) and walk
  // publish's transitive closure.
  const jobBlockPattern = /^  ([a-zA-Z0-9_-]+):\n((?:(?:    .*)?\n)*)/gmu;
  const needsOf = new Map();
  for (const match of workflowText.matchAll(jobBlockPattern)) {
    const [, jobName, body] = match;
    const needsMatch = body.match(/^\s+needs:\s*(.+)$/mu);
    if (needsMatch === null) {
      needsOf.set(jobName, []);
      continue;
    }
    const raw = needsMatch[1].trim();
    const list = raw.startsWith("[")
      ? raw
          .slice(1, -1)
          .split(",")
          .map((entry) => entry.trim())
      : [raw];
    needsOf.set(jobName, list);
  }
  assert.ok(needsOf.has("publish"), "expected to parse a publish job from the workflow");
  assert.ok(needsOf.has("test-integration"), "expected to parse a test-integration job from the workflow");
  assert.ok(needsOf.has("test-e2e"), "expected to parse a test-e2e job from the workflow");

  const ancestorsOf = (jobName) => {
    const seen = new Set();
    const stack = [...(needsOf.get(jobName) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(needsOf.get(current) ?? []));
    }
    return seen;
  };

  const publishAncestors = ancestorsOf("publish");
  assert.ok(publishAncestors.has("test-integration"), "publish must transitively depend on test-integration");
  assert.ok(publishAncestors.has("test-e2e"), "publish must transitively depend on test-e2e");
});

test("finalize-release only runs once every asset-producing job has succeeded", () => {
  assert.match(
    workflowText,
    /needs: \[prepare-release, publish, runtime-appliance, host-bootstrap-init, deployment-descriptor\]/u,
  );
  assert.match(workflowText, /needs\.publish\.result == 'success' &&/u);
  assert.match(workflowText, /needs\.runtime-appliance\.result == 'success' &&/u);
  assert.match(workflowText, /needs\.host-bootstrap-init\.result == 'success' &&/u);
  assert.match(workflowText, /needs\.deployment-descriptor\.result == 'success'/u);
  assert.match(workflowText, /gh release edit "\$RELEASE_TAG" --draft=false/u);
});
