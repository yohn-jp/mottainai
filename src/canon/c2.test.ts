import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhInariIssueReadResult } from "../gh-inari.js";
import { CanonC2Error, composeGovernedIssueC2, type ComposeGovernedIssueC2Input } from "./c2.js";
import { canonicalCanonPrefixText, prefixIdentityOf, type CanonPrefix } from "./identity.js";

function issue(overrides: Partial<GhInariIssueReadResult> = {}): GhInariIssueReadResult {
  return {
    kind: "issue",
    valid: true,
    projection: "canonical",
    classification: "valid",
    repository: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/issues/42",
    template: { id: "feature-v1", name: "Feature", path: ".github/ISSUE_TEMPLATE/feature.yml", source: "issue_form" },
    fields: { acceptance: ["one", "two"], scope: "small" },
    dependencies: { issue: 7 },
    diagnostics: [],
    metadata: { title: "Canon", state: "open", labels: ["feature"], assignees: ["sophia"] },
    ...overrides,
  };
}

function input(overrides: Partial<ComposeGovernedIssueC2Input> = {}): ComposeGovernedIssueC2Input {
  return {
    repository: "acme/repo",
    task: {
      taskId: "task-1",
      taskSlug: "canon",
      issueRef: "42",
      lifecycleState: "active",
      profile: { agentKind: "codex", model: "gpt-5" },
    },
    issue: issue(),
    governance: { generation: "governance-1", freshness: { observedAt: "2026-09-21" } },
    ...overrides,
  };
}

function prefix(c2: ReturnType<typeof composeGovernedIssueC2>): CanonPrefix {
  return {
    c0: {
      runtimeContract: { contractId: "mottainai.runtime.v1", schemaVersion: 1 },
      projectContract: { contractId: "mottainai.project.v1", schemaVersion: 1 },
      runtimeInstructions: [],
    },
    c1: {
      repository: { repositoryId: "github:acme/repo", sourceRevision: "source-1", baseRevision: "base-1" },
      packageFacts: {},
      workspaceFacts: {},
    },
    c2,
    c3: [],
  };
}

test("governed Issue C2 is ordered and includes artifact, governance, task, and provenance facts", () => {
  const result = composeGovernedIssueC2(input());
  assert.deepEqual(
    result.map((entry) => entry.contentId),
    [
      "c2.governed.artifact",
      "c2.governed.fields",
      "c2.governed.dependencies",
      "c2.mottainai.task",
      "c2.governance.evidence",
    ],
  );
  assert.equal((result[0]?.value as { artifact: { number: number } }).artifact.number, 42);
  assert.equal((result[3]?.value as { taskId: string }).taskId, "task-1");
  assert.equal((result[4]?.value as { generation: string }).generation, "governance-1");
});

test("equivalent governed/task inputs produce identical C2 and prefix identity", () => {
  const first = composeGovernedIssueC2(input());
  const second = composeGovernedIssueC2(
    input({
      issue: issue({ fields: { scope: "small", acceptance: ["one", "two"] }, dependencies: { issue: 7 } }),
    }),
  );
  assert.equal(canonicalCanonPrefixText(prefix(first)), canonicalCanonPrefixText(prefix(second)));
  assert.equal(prefixIdentityOf(prefix(first)), prefixIdentityOf(prefix(second)));
});

test("artifact and governance generations invalidate the C2 identity", () => {
  const base = prefix(composeGovernedIssueC2(input()));
  const artifactChanged = prefix(
    composeGovernedIssueC2(
      input({
        issue: issue({ url: "https://github.com/acme/repo/issues/43", number: 43 }),
        task: { ...input().task, issueRef: "43" },
      }),
    ),
  );
  const governanceChanged = prefix(
    composeGovernedIssueC2(
      input({ governance: { generation: "governance-2", freshness: { observedAt: "2026-09-21" } } }),
    ),
  );
  assert.notEqual(prefixIdentityOf(base), prefixIdentityOf(artifactChanged));
  assert.notEqual(prefixIdentityOf(base), prefixIdentityOf(governanceChanged));
});

test("invalid, incomplete, and wrong-template governed projections fail closed", () => {
  for (const invalid of [
    issue({ valid: false, classification: "semantic", projection: "unavailable" }),
    issue({ fields: undefined }),
    issue({ template: { id: "pr", name: "PR", path: "pull_request_template.md", source: "pull_request_template" } }),
  ]) {
    assert.throws(() => composeGovernedIssueC2(input({ issue: invalid })), CanonC2Error);
  }
});
