import fs from "node:fs";
import path from "node:path";
import { buildDiff } from "./build-diff.mjs";
import { buildOcr } from "./build-ocr.mjs";
import { buildIssue } from "./build-issue.mjs";
import { buildChecks } from "./build-checks.mjs";
import { renderHtml } from "./render-html.mjs";
import { canonicalStringify } from "./lib/canonical-json.mjs";

export const MANIFEST_SCHEMA_VERSION = "mottainai.review-pages.manifest/v1";
export const PR_INDEX_SCHEMA_VERSION = "mottainai.review-pages.pr-index/v1";
export const GENERATOR_VERSION = "1.0.0";

const SHORT_SHA_LENGTH = 12;

// A draft PR is not a review-ready revision: ready_for_review produces
// the first one, and every later eligible head change produces the
// next. This is the single gate the workflow and tests both call.
export function isEligibleForGeneration(pullRequest) {
  return pullRequest.draft !== true;
}

export async function generateReviewPackage({
  repository,
  pullRequest,
  token,
  cwd,
  generatedAt = new Date().toISOString(),
  fetchIssueFn,
  fetchCheckRunsFn,
}) {
  if (!isEligibleForGeneration(pullRequest)) {
    throw new Error("draft pull requests do not produce a review-ready revision");
  }

  const diff = buildDiff({ baseSha: pullRequest.baseSha, headSha: pullRequest.headSha, cwd });
  const ocr = buildOcr({ cwd, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha });
  const issue = await buildIssue({
    owner: repository.owner,
    repo: repository.name,
    prBody: pullRequest.body,
    token,
    ...(fetchIssueFn ? { fetchIssueFn } : {}),
  });
  const checks = await buildChecks({
    owner: repository.owner,
    repo: repository.name,
    headSha: pullRequest.headSha,
    token,
    ...(fetchCheckRunsFn ? { fetchCheckRunsFn } : {}),
  });

  const shortId = pullRequest.headSha.slice(0, SHORT_SHA_LENGTH);

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: { name: "mottainai-review-pages", version: GENERATOR_VERSION },
    repository: {
      owner: repository.owner,
      name: repository.name,
      fullName: `${repository.owner}/${repository.name}`,
    },
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title ?? null,
      baseRef: pullRequest.baseRef,
      baseSha: pullRequest.baseSha,
      headRef: pullRequest.headRef,
      headSha: pullRequest.headSha,
      draft: pullRequest.draft,
    },
    revision: { id: pullRequest.headSha, shortId, immutable: true },
    resources: {
      issue: "issue.json",
      diff: "diff.json",
      ocr: "ocr.json",
      checks: "checks.json",
      html: "index.html",
    },
    volatile: {
      fields: ["volatile.generatedAt", "checks.checkRuns"],
      generatedAt,
    },
  };

  const html = renderHtml({ manifest, diff, issue });

  const prIndex = {
    schemaVersion: PR_INDEX_SCHEMA_VERSION,
    number: pullRequest.number,
    latest: {
      headSha: pullRequest.headSha,
      shortId,
      path: `${pullRequest.number}/${pullRequest.headSha}/manifest.json`,
      generatedAt,
    },
  };

  return {
    manifest,
    resources: { "issue.json": issue, "diff.json": diff, "ocr.json": ocr, "checks.json": checks },
    html,
    prIndex,
  };
}

export function writeReviewPackage(destDir, generated) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "manifest.json"), canonicalStringify(generated.manifest));
  for (const [name, value] of Object.entries(generated.resources)) {
    fs.writeFileSync(path.join(destDir, name), canonicalStringify(value));
  }
  fs.writeFileSync(path.join(destDir, "index.html"), generated.html);
}

function readEvent(eventPath) {
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

async function main() {
  const environment = process.env;
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const event = readEvent(eventPath);
  const pr = event.pull_request;
  if (!pr) throw new Error("event payload has no pull_request");

  const [owner, name] = (environment.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY must be set as owner/name");

  const pullRequest = {
    number: pr.number,
    title: pr.title ?? null,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    draft: Boolean(pr.draft),
    body: pr.body ?? "",
  };

  if (!isEligibleForGeneration(pullRequest)) {
    console.log(`skipping review package generation: PR #${pullRequest.number} is a draft`);
    return 0;
  }

  const outputDir = environment.REVIEW_PAGES_OUTPUT_DIR;
  if (!outputDir) throw new Error("REVIEW_PAGES_OUTPUT_DIR is required");

  const generated = await generateReviewPackage({
    repository: { owner, name },
    pullRequest,
    token: environment.GITHUB_TOKEN,
    cwd: environment.GITHUB_WORKSPACE ?? process.cwd(),
  });

  writeReviewPackage(path.join(outputDir, pullRequest.headSha), generated);
  fs.writeFileSync(path.join(outputDir, "pr-index.json"), canonicalStringify(generated.prIndex));

  console.log(`generated review package for PR #${pullRequest.number} @ ${generated.manifest.revision.shortId}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("generate-review-package.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
