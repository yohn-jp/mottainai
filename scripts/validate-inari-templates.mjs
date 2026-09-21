#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_REPOSITORY = "yohn-jp/mottainai";
const ISSUE_SOURCE_PREFIX = ".github/inari/issues/";
const INTEGRATION_CASES = Object.freeze([
  { number: 265, template: "feature" },
  { number: 229, template: "maintenance" },
]);

function semanticPath(root, id) {
  return path.join(root, ".github", "inari", "issues", `${id}.json`);
}

export function readCanonicalIssueTemplateIds(root) {
  const manifestPath = path.join(root, ".github", "inari", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files))
    throw new Error(`canonical Inari manifest has no file list: ${path.relative(root, manifestPath)}`);
  const issuePaths = manifest.files
    .map((entry) => entry?.path)
    .filter((file) => typeof file === "string" && file.startsWith(ISSUE_SOURCE_PREFIX));
  if (
    issuePaths.length === 0 ||
    issuePaths.some((file) => !file.endsWith(".json") || file.slice(ISSUE_SOURCE_PREFIX.length, -5).includes("/"))
  ) {
    throw new Error(`canonical Inari manifest has invalid issue sources: ${issuePaths.join(", ")}`);
  }
  const ids = issuePaths.map((file) => file.slice(ISSUE_SOURCE_PREFIX.length, -5)).sort();
  if (new Set(ids).size !== ids.length || ids.some((id) => id.length === 0)) {
    throw new Error(`canonical Inari manifest has duplicate or empty issue source IDs: ${ids.join(", ")}`);
  }
  return Object.freeze(ids);
}

function readSemanticTemplateSet(root) {
  const issueTemplateIds = readCanonicalIssueTemplateIds(root);
  const templates = new Map();
  for (const id of issueTemplateIds) {
    const file = semanticPath(root, id);
    if (!fs.existsSync(file)) throw new Error(`missing canonical Inari source: ${path.relative(root, file)}`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const fieldIds = value.sections?.filter((section) => section.kind === "input").map((section) => section.id);
    if (!Array.isArray(fieldIds) || fieldIds.length === 0 || fieldIds.some((id) => typeof id !== "string")) {
      throw new Error(`canonical Inari source has no input fields: ${path.relative(root, file)}`);
    }
    templates.set(id, { file, fieldIds });
  }
  const files = fs
    .readdirSync(path.join(root, ".github", "inari", "issues"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(issueTemplateIds)) {
    throw new Error(`canonical Inari issue source set drifted: ${files.join(", ")}`);
  }
  return { issueTemplateIds, templates };
}

export function readSemanticTemplates(root) {
  return readSemanticTemplateSet(root).templates;
}

function sorted(values) {
  return [...values].sort();
}

export function validateSyncReport(report, issueTemplateIds) {
  const errors = [];
  if (report?.check !== true) errors.push("template sync did not run in check mode");
  if (report?.changed !== false) errors.push("template sync reports changed projections");
  if (!Array.isArray(report?.drift) || report.drift.length !== 0) errors.push("template projection drift detected");
  if (!Array.isArray(report?.staleGenerated) || report.staleGenerated.length !== 0) {
    errors.push("stale generated template projections detected");
  }
  const expected = issueTemplateIds.map((id) => `.github/ISSUE_TEMPLATE/${id}.yml`).sort();
  const generated = Array.isArray(report?.generated)
    ? report.generated.filter((file) => file.startsWith(".github/ISSUE_TEMPLATE/")).sort()
    : [];
  if (JSON.stringify(generated) !== JSON.stringify(expected)) {
    errors.push(`generated Issue Form set mismatch: ${generated.join(", ")}`);
  }
  return errors;
}

export function validateSchemaReport(template, report, semantic) {
  const schema = report?.schema;
  const actual = schema?.fields === null || typeof schema?.fields !== "object" ? [] : Object.keys(schema.fields);
  const errors = [];
  if (schema?.kind !== "issue") errors.push(`${template}: compiled schema kind is not issue`);
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(semantic.fieldIds))) {
    errors.push(`${template}: compiled field IDs differ from canonical source`);
  }
  return errors;
}

export function validateIssueReport(operation, report) {
  const errors = [];
  if (report?.valid !== true) errors.push(`${operation}: gh-inari reported invalid`);
  if (report?.classification !== "valid") errors.push(`${operation}: classification is not valid`);
  return errors;
}

function resolveRepository() {
  return process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO ?? DEFAULT_REPOSITORY;
}

function resolveInariCommand() {
  const probe = spawnSync("gh", ["inari", "--version"], { stdio: "ignore" });
  return probe.status === 0 ? ["gh", "inari"] : ["npx", "--yes", "gh-inari"];
}

function createCommandRunner(root) {
  const [executable, ...prefix] = resolveInariCommand();
  return (args) => {
    try {
      const output = execFileSync(executable, [...prefix, ...args], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(output);
    } catch (error) {
      const stderr = error?.stderr?.toString?.().trim();
      throw new Error(`gh-inari ${args.join(" ")} failed${stderr ? `: ${stderr.slice(0, 400)}` : ""}`);
    }
  };
}

export function validateRepositoryInari(
  root,
  { repository = resolveRepository(), run = createCommandRunner(root), integration = false } = {},
) {
  const { issueTemplateIds, templates } = readSemanticTemplateSet(root);
  // Local snapshot/schema validation is hermetic: no --repository, so gh-inari
  // never falls through to a live gh/GitHub lookup for this default self-check path.
  const syncArgs = ["template", "sync", "--check", "--json"];
  const firstSync = run(syncArgs);
  const secondSync = run(syncArgs);
  const errors = [
    ...validateSyncReport(firstSync, issueTemplateIds),
    ...validateSyncReport(secondSync, issueTemplateIds),
  ];
  if (JSON.stringify(firstSync) !== JSON.stringify(secondSync)) errors.push("template sync is not deterministic");

  const schemas = {};
  for (const id of issueTemplateIds) {
    const report = run(["issue", "schema", id, "--compact", "--json"]);
    schemas[id] = report;
    errors.push(...validateSchemaReport(id, report, templates.get(id)));
  }

  const integrationReports = [];
  if (integration) {
    for (const item of INTEGRATION_CASES) {
      const get = run([
        "issue",
        "get",
        String(item.number),
        "--template",
        item.template,
        "--repository",
        repository,
        "--json",
      ]);
      const validate = run([
        "issue",
        "validate",
        String(item.number),
        "--template",
        item.template,
        "--repository",
        repository,
      ]);
      errors.push(...validateIssueReport(`issue get #${item.number}`, get));
      errors.push(...validateIssueReport(`issue validate #${item.number}`, validate));
      integrationReports.push({ number: item.number, template: item.template, get, validate });
    }
  }
  return { ok: errors.length === 0, errors, repository, sync: firstSync, schemas, integration: integrationReports };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateRepositoryInari(root, { integration: process.argv.includes("--integration") });
  console.log(
    JSON.stringify(
      { ok: result.ok, repository: result.repository, errors: result.errors, integration: result.integration },
      null,
      2,
    ),
  );
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
