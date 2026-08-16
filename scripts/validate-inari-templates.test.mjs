import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ISSUE_TEMPLATE_IDS,
  readSemanticTemplates,
  validateIssueReport,
  validateSchemaReport,
  validateSyncReport,
} from "./validate-inari-templates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("canonical issue source set contains exactly the five governed families", () => {
  const templates = readSemanticTemplates(repositoryRoot);
  assert.deepEqual([...templates.keys()], ISSUE_TEMPLATE_IDS);
  for (const template of templates.values()) assert.ok(template.fieldIds.includes("acceptance"));
});

test("clean sync report is accepted and drift is rejected", () => {
  const clean = {
    check: true,
    changed: false,
    drift: [],
    staleGenerated: [],
    generated: ISSUE_TEMPLATE_IDS.map((id) => `.github/ISSUE_TEMPLATE/${id}.yml`),
  };
  assert.deepEqual(validateSyncReport(clean), []);
  assert.ok(validateSyncReport({ ...clean, changed: true }).length > 0);
  assert.ok(validateSyncReport({ ...clean, drift: ["feature"] }).length > 0);
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
