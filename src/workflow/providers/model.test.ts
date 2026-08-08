import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { Issue, PullRequest } from "./model.js";

test("provider-neutral model represents issue and pull request lifecycle metadata", () => {
  const issue: Issue = {
    identity: { provider: "example", id: "issue-7" },
    reference: "#7",
    number: 7,
    title: "provider-neutral issue",
    state: "open",
    url: "https://example.test/issues/7",
    repository: { provider: "example", id: "org/repository", namespace: "org", name: "repository" },
    metadata: { labels: ["workflow"], assignees: ["agent"], values: { priority: 1 } },
  };
  const pullRequest: PullRequest = {
    identity: { provider: "example", id: "pr-11" },
    reference: "#11",
    number: 11,
    state: "open",
    lifecycleState: "open",
    url: "https://example.test/pulls/11",
    repository: issue.repository,
    head: { name: "feature/11", revision: "abc123" },
    base: { name: "main", revision: "def456" },
  };

  assert.equal(issue.metadata.values.priority, 1);
  assert.equal(pullRequest.head.revision, "abc123");
  assert.equal(pullRequest.lifecycleState, "open");
});

test("model module has no provider-specific wire field names", () => {
  const source = fs.readFileSync(new URL("./model.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /GitHub|GhIssue|headRefOid|baseRefOid|nameWithOwner/);
});
