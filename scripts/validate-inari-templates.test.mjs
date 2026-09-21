import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readCanonicalIssueTemplateIds,
  readSemanticTemplates,
  validateIssueReport,
  validateRepositoryInari,
  validateSchemaReport,
  validateSyncReport,
} from "./validate-inari-templates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const issueTemplateIds = readCanonicalIssueTemplateIds(repositoryRoot);

test("canonical issue source set follows the synced manifest", () => {
  const templates = readSemanticTemplates(repositoryRoot);
  assert.deepEqual([...templates.keys()], issueTemplateIds);
  assert.ok(issueTemplateIds.includes("implementation"));
  for (const template of templates.values()) {
    assert.ok(template.fieldIds.includes("acceptance") || template.fieldIds.includes("acceptance_criteria"));
  }
});

test("clean sync report is accepted and drift is rejected", () => {
  const clean = {
    check: true,
    changed: false,
    drift: [],
    staleGenerated: [],
    generated: issueTemplateIds.map((id) => `.github/ISSUE_TEMPLATE/${id}.yml`),
  };
  assert.deepEqual(validateSyncReport(clean, issueTemplateIds), []);
  assert.ok(validateSyncReport({ ...clean, changed: true }, issueTemplateIds).length > 0);
  assert.ok(validateSyncReport({ ...clean, drift: ["feature"] }, issueTemplateIds).length > 0);
  assert.ok(
    validateSyncReport(
      { ...clean, generated: [...clean.generated, ".github/ISSUE_TEMPLATE/stale.yml"] },
      issueTemplateIds,
    ).length > 0,
  );
});

test("compiled schema must preserve canonical field IDs", () => {
  const semantic = { fieldIds: ["summary", "problem"] };
  assert.deepEqual(
    validateSchemaReport("feature", { schema: { kind: "issue", fields: { summary: {}, problem: {} } } }, semantic),
    [],
  );
  assert.ok(
    validateSchemaReport("feature", { schema: { kind: "issue", fields: { summary: {} } } }, semantic).length > 0,
  );
});

test("issue integration reports require valid current gh-inari classification", () => {
  assert.deepEqual(validateIssueReport("issue get #265", { valid: true, classification: "valid" }), []);
  assert.ok(validateIssueReport("issue validate #265", { valid: false, classification: "ambiguous" }).length > 0);
});

test("default self-check is hermetic: no --repository reaches gh-inari and no network is required", () => {
  const templates = readSemanticTemplates(repositoryRoot);
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "template" && args[1] === "sync") {
      return {
        check: true,
        changed: false,
        drift: [],
        staleGenerated: [],
        generated: issueTemplateIds.map((id) => `.github/ISSUE_TEMPLATE/${id}.yml`),
      };
    }
    if (args[0] === "issue" && args[1] === "schema") {
      const fields = Object.fromEntries(templates.get(args[2]).fieldIds.map((id) => [id, {}]));
      return { schema: { kind: "issue", fields } };
    }
    throw new Error(`unexpected hermetic self-check invocation: ${args.join(" ")}`);
  };

  const result = validateRepositoryInari(repositoryRoot, { run });

  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
  for (const args of calls) {
    assert.ok(!args.includes("--repository"), `self-check must not pass --repository: ${args.join(" ")}`);
  }
});

test("default self-check still fails closed on local sync/schema drift", () => {
  const run = (args) => {
    if (args[0] === "template" && args[1] === "sync") {
      return { check: true, changed: false, drift: [], staleGenerated: [], generated: [] };
    }
    if (args[0] === "issue" && args[1] === "schema") {
      return { schema: { kind: "issue", fields: {} } };
    }
    throw new Error(`unexpected invocation: ${args.join(" ")}`);
  };

  const result = validateRepositoryInari(repositoryRoot, { run });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});
