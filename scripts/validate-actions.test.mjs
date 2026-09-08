import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateActionText, validateElevatedCheckoutRefs, validateRepositoryActions } from "./validate-actions.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40);

test("accepts immutable external actions and repository-local actions", () => {
  const result = validateActionText(
    [
      "      uses: actions/checkout@" + sha + " # v4.4.0",
      "      - uses: github/codeql-action/init@" + sha,
      "      uses: ./.github/actions/local-action",
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.references.length, 3);
  assert.equal(result.references.filter((reference) => reference.local).length, 1);
});

test("rejects mutable, incomplete, and missing external action refs", () => {
  const result = validateActionText(
    ["      uses: actions/checkout@v4", "      uses: actions/setup-node@1234", "      uses:"].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
  assert.match(result.errors[2], /same line/u);
});

test("all repository-owned workflow and composite-action refs are pinned", () => {
  const result = validateRepositoryActions(repositoryRoot);

  assert.deepEqual(result.errors, []);
  assert.ok(result.files.length > 0);
  assert.ok(result.references.some((reference) => !reference.local));
});

test("accepts yohn-jp/.github's own reusable-workflow reference on @main", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/pr-governance.yml@main",
    ".github/workflows/governance.yml",
  );

  assert.deepEqual(result.errors, []);
});

test("accepts the shared TypeScript CI workflow on @main like any other org-owned workflow", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/typescript-cli-ci.yml@main",
    ".github/workflows/ci.yml",
  );

  assert.deepEqual(result.errors, []);
});

test("accepts the shared Node.js and pnpm composite action on @main", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/actions/setup-node-pnpm@main",
    ".github/workflows/ci.yml",
  );

  assert.deepEqual(result.errors, []);
});

test("rejects a commit-SHA pin on the shared TypeScript CI workflow (Issue #802 regression)", () => {
  const result = validateActionText(
    "    uses: yohn-jp/.github/.github/workflows/typescript-cli-ci.yml@" + sha,
    ".github/workflows/ci.yml",
  );

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /organization-owned reusable workflow must follow @main/u);
});

test("the CI caller follows the live TypeScript foundation and retains product lanes", () => {
  const ciWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(ciWorkflow, /uses:\s*yohn-jp\/\.github\/\.github\/workflows\/typescript-cli-ci\.yml@main(?:\s+#.*)?$/mu);
  assert.match(ciWorkflow, /conformance-script:\s*["']architecture:check["']/u);
  assert.match(ciWorkflow, /run-governance:\s*false/u);
  for (const localJob of ["test-integration:", "build-and-package-e2e:", "runtime-contract:"]) {
    assert.match(ciWorkflow, new RegExp(`^  ${localJob}`, "mu"), `missing retained local lane: ${localJob}`);
  }
});

test("CI delegates ordinary dependency installation to the shared Node.js and pnpm action", () => {
  const ciWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const sharedSetupAction = "yohn-jp/.github/.github/actions/setup-node-pnpm@main";

  assert.equal((ciWorkflow.match(new RegExp(sharedSetupAction, "gu")) ?? []).length, 6);
  assert.doesNotMatch(ciWorkflow, /uses:\s*\.\/\.github\/actions\/setup-pnpm-node/u);
  assert.doesNotMatch(ciWorkflow, /run:\s*pnpm install --frozen-lockfile/u);
  assert.match(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    /"packageManager":\s*"pnpm@11\.25\.0"/u,
  );
});

test("Review Pages' standalone pnpm/action-setup version matches the root packageManager authority (Issue #821)", () => {
  const packageManager = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).packageManager;
  const pinnedPnpmVersion = packageManager.replace(/^pnpm@/u, "");

  const reviewPagesWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/review-pages.yml"), "utf8");
  const versionMatch = reviewPagesWorkflow.match(
    /uses:\s*pnpm\/action-setup@[0-9a-f]{40}[^\n]*\n\s*with:\s*\n\s*version:\s*([^\s#]+)/u,
  );

  assert.ok(versionMatch, "expected a pnpm/action-setup step with a version input in review-pages.yml");
  assert.equal(
    versionMatch[1],
    pinnedPnpmVersion,
    `review-pages.yml pins pnpm/action-setup to ${versionMatch[1]}, which has drifted from package.json's packageManager (${pinnedPnpmVersion}); update review-pages.yml to match`,
  );
});

function pullRequestWorkflow(jobBody) {
  return [
    "on:",
    "  pull_request:",
    "    types: [opened]",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    jobBody,
  ].join("\n");
}

test("flags an elevated (write) job whose checkout carries no ref on a pull_request-triggered workflow (Issue #865)", () => {
  const workflow = pullRequestWorkflow(
    [
      "  publish:",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          persist-credentials: false",
    ].join("\n"),
  );

  const errors = validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /checkout has no ref/u);
});

test("flags an elevated job pinned to the untrusted PR head SHA", () => {
  const workflow = pullRequestWorkflow(
    [
      "  publish:",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      "          persist-credentials: false",
    ].join("\n"),
  );

  const errors = validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lacks trusted repository provenance/u);
});

test("flags workflow-level write permissions inherited by a job", () => {
  const workflow = [
    "on:",
    "  pull_request:",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  publish:",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@" + sha,
  ].join("\n");

  const errors = validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /checkout has no ref/u);
});

test("flags every checkout in an elevated job, including an unsafe second checkout", () => {
  const workflow = pullRequestWorkflow(
    [
      "  publish:",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - name: Trusted checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: ${{ github.event.repository.default_branch }}",
      "      - name: Second checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ].join("\n"),
  );

  const errors = validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lacks trusted repository provenance/u);
});

test("rejects arbitrary branch refs and literal SHAs as unproven elevated checkout refs", () => {
  const workflow = pullRequestWorkflow(
    [
      "  publish:",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: refs/heads/main",
    ].join("\n"),
  );

  const errors = validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /lacks trusted repository provenance/u);
});
test("accepts an elevated job pinned to the repository default branch", () => {
  const workflow = pullRequestWorkflow(
    [
      "  publish:",
      "    permissions:",
      "      contents: write",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: ${{ github.event.repository.default_branch }}",
      "          persist-credentials: false",
    ].join("\n"),
  );

  assert.deepEqual(validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml"), []);
});

test("does not flag a read-only job on a pull_request-triggered workflow", () => {
  const workflow = pullRequestWorkflow(
    [
      "  generate:",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@" + sha,
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ].join("\n"),
  );

  assert.deepEqual(validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml"), []);
});

test("does not flag an elevated job on a push-only workflow (its default ref is already a trusted branch commit)", () => {
  const workflow = [
    "on:",
    "  push:",
    "    branches: [main]",
    "",
    "jobs:",
    "  publish:",
    "    permissions:",
    "      contents: write",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@" + sha,
  ].join("\n");

  assert.deepEqual(validateElevatedCheckoutRefs(workflow, ".github/workflows/example.yml"), []);
});

test("every elevated job across the repository's real pull_request-triggered workflows checks out a trusted ref (Issue #865)", () => {
  const result = validateRepositoryActions(repositoryRoot);

  assert.deepEqual(
    result.errors.filter((error) => /carries an elevated \(write\) permission/u.test(error)),
    [],
  );
});

test("the Review Pages publish job pins its checkout to the repository default branch, not the event-default ref", () => {
  const reviewPagesWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/review-pages.yml"), "utf8");
  const errors = validateElevatedCheckoutRefs(reviewPagesWorkflow, ".github/workflows/review-pages.yml");

  assert.deepEqual(errors, []);
  assert.match(reviewPagesWorkflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/u);
});

test("rejects @main for every non-org external reference, and rejects non-@main org-owned workflow refs", () => {
  const result = validateActionText(
    [
      "      uses: actions/checkout@main",
      "      uses: yohn-jp/.github@main",
      "      uses: yohn-jp/.github/.github/actions/example@v1",
      "      uses: yohn-jp/other-repo/.github/workflows/pr-governance.yml@main",
      "      uses: yohn-jp/.github/.github/workflows/pr-governance.yml@v1",
      "      uses: yohn-jp/.github/.github/workflows/pr-governance.yml@" + sha,
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 6);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
  assert.match(result.errors[1], /full 40-character commit SHA/u);
  assert.match(result.errors[2], /organization-owned composite action must follow @main/u);
  assert.match(result.errors[3], /full 40-character commit SHA/u);
  assert.match(result.errors[4], /organization-owned reusable workflow must follow @main/u);
  assert.match(result.errors[5], /organization-owned reusable workflow must follow @main/u);
});
