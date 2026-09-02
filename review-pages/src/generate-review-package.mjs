import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
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
export const MAX_BUILDER_CONCURRENCY = 4;
const MAX_BUILDER_DIAGNOSTIC_LENGTH = 512;
const BUILDER_WORKER_URL = new URL("./review-package-builder-worker.mjs", import.meta.url);

function runSynchronousBuilderInWorker(name, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BUILDER_WORKER_URL, { workerData: { name, args } });
    let completed = false;
    const complete = (callback) => {
      if (completed) return;
      completed = true;
      callback();
    };

    worker.on("message", (message) => {
      if (message?.ok === true) {
        complete(() => resolve(message.value));
      } else {
        complete(() => reject(new Error(message?.error?.message ?? "worker builder failed")));
      }
    });
    worker.on("error", (error) => complete(() => reject(error)));
    worker.on("exit", (code) => {
      if (code !== 0) complete(() => reject(new Error(`builder worker exited with code ${code}`)));
    });
  });
}

function boundedDiagnostic(error) {
  const message = String(error?.message ?? error ?? "unknown error")
    .replace(/\s+/gu, " ")
    .trim();
  if (message.length <= MAX_BUILDER_DIAGNOSTIC_LENGTH) return message || "unknown error";
  return `${message.slice(0, MAX_BUILDER_DIAGNOSTIC_LENGTH - 1)}…`;
}

export class ReviewPackageBuilderError extends Error {
  constructor(failures) {
    const diagnostics = failures.map(({ name, message }) => `${name}: ${message}`);
    super(`review package builder failure${diagnostics.length === 1 ? "" : "s"}: ${diagnostics.join("; ")}`);
    this.name = "ReviewPackageBuilderError";
    this.failures = failures.map(({ name, message }) => ({ name, message }));
  }
}

function normalizeBuilderDefinitions(builders) {
  if (!Array.isArray(builders) || builders.length === 0) {
    throw new TypeError("at least one review package builder is required");
  }

  const names = new Set();
  return builders.map((builder) => {
    if (!builder || typeof builder.name !== "string" || builder.name.length === 0) {
      throw new TypeError("review package builders require a non-empty name");
    }
    if (names.has(builder.name)) throw new TypeError(`duplicate review package builder: ${builder.name}`);
    if (typeof builder.run !== "function") throw new TypeError(`review package builder ${builder.name} requires run`);
    names.add(builder.name);
    const dependsOn = builder.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== "string")) {
      throw new TypeError(`review package builder ${builder.name} has invalid dependencies`);
    }
    return { name: builder.name, dependsOn: [...dependsOn], run: builder.run };
  });
}

// Run a small dependency graph with a fixed upper bound. The definition order
// is the tie-breaker for ready work, while results and diagnostics are always
// returned in that same order regardless of completion order.
export async function runBuilderGraph(builders, { maxConcurrency = MAX_BUILDER_CONCURRENCY } = {}) {
  const definitions = normalizeBuilderDefinitions(builders);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("max builder concurrency must be a positive integer");
  }
  const concurrency = Math.min(maxConcurrency, MAX_BUILDER_CONCURRENCY);
  const names = new Set(definitions.map((builder) => builder.name));
  for (const builder of definitions) {
    for (const dependency of builder.dependsOn) {
      if (!names.has(dependency)) {
        throw new TypeError(`review package builder ${builder.name} depends on unknown builder ${dependency}`);
      }
      if (dependency === builder.name) throw new TypeError(`review package builder ${builder.name} depends on itself`);
    }
  }

  const state = definitions.map(() => "pending");
  const values = new Map();
  const failures = new Array(definitions.length);
  let active = 0;
  let remaining = definitions.length;
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = () => {
      if (settled || remaining !== 0 || active !== 0) return;
      settled = true;
      const diagnostics = failures.filter(Boolean);
      if (diagnostics.length > 0) {
        reject(new ReviewPackageBuilderError(diagnostics));
        return;
      }
      resolve(Object.fromEntries(definitions.map((builder) => [builder.name, values.get(builder.name)])));
    };

    const schedule = () => {
      if (settled) return;

      // A failed dependency makes its dependent ineligible, but independent
      // work continues and all resulting diagnostics remain attributable.
      let blockedDependencyFound;
      do {
        blockedDependencyFound = false;
        for (let index = 0; index < definitions.length; index += 1) {
          if (state[index] !== "pending") continue;
          const failedDependencies = definitions[index].dependsOn.filter((dependency) => {
            const dependencyIndex = definitions.findIndex((candidate) => candidate.name === dependency);
            return state[dependencyIndex] === "rejected" || state[dependencyIndex] === "blocked";
          });
          if (failedDependencies.length === 0) continue;
          state[index] = "blocked";
          remaining -= 1;
          failures[index] = {
            name: definitions[index].name,
            message: `blocked by failed dependency: ${failedDependencies.join(", ")}`,
          };
          blockedDependencyFound = true;
        }
      } while (blockedDependencyFound);

      while (active < concurrency) {
        const index = definitions.findIndex((builder, candidateIndex) => {
          if (state[candidateIndex] !== "pending") return false;
          return builder.dependsOn.every((dependency) => {
            const dependencyIndex = definitions.findIndex((candidate) => candidate.name === dependency);
            return state[dependencyIndex] === "fulfilled";
          });
        });
        if (index < 0) break;

        const definition = definitions[index];
        state[index] = "running";
        active += 1;
        const dependencies = Object.fromEntries(
          definition.dependsOn.map((dependency) => [dependency, values.get(dependency)]),
        );

        void (async () => {
          try {
            values.set(definition.name, await definition.run(dependencies));
            state[index] = "fulfilled";
          } catch (error) {
            state[index] = "rejected";
            failures[index] = { name: definition.name, message: boundedDiagnostic(error) };
          } finally {
            active -= 1;
            remaining -= 1;
            schedule();
          }
        })();
      }

      if (active === 0 && remaining > 0) {
        const unresolved = definitions
          .filter((_builder, index) => state[index] === "pending")
          .map((builder) => builder.name)
          .join(", ");
        settled = true;
        reject(new Error(`review package builder dependency cycle or unresolved graph: ${unresolved}`));
        return;
      }
      finish();
    };

    schedule();
  });
}

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
  buildDiffFn = buildDiff,
  buildOcrFn = buildOcr,
  buildIssueFn = buildIssue,
  buildChecksFn = buildChecks,
  maxBuilderConcurrency = MAX_BUILDER_CONCURRENCY,
}) {
  if (!isEligibleForGeneration(pullRequest)) {
    throw new Error("draft pull requests do not produce a review-ready revision");
  }

  // These four builders have no dependencies on one another. Their stable
  // declaration order is only a scheduler tie-breaker; manifest/HTML assembly
  // below is the explicit join point and remains serial and deterministic.
  const built = await runBuilderGraph(
    [
      {
        name: "issue",
        dependsOn: [],
        run: () =>
          buildIssueFn({
            owner: repository.owner,
            repo: repository.name,
            prBody: pullRequest.body,
            token,
            ...(fetchIssueFn ? { fetchIssueFn } : {}),
          }),
      },
      {
        name: "checks",
        dependsOn: [],
        run: () =>
          buildChecksFn({
            owner: repository.owner,
            repo: repository.name,
            headSha: pullRequest.headSha,
            token,
            ...(fetchCheckRunsFn ? { fetchCheckRunsFn } : {}),
          }),
      },
      {
        name: "diff",
        dependsOn: [],
        run: () => {
          const args = { baseSha: pullRequest.baseSha, headSha: pullRequest.headSha, cwd };
          return buildDiffFn === buildDiff ? runSynchronousBuilderInWorker("diff", args) : buildDiffFn(args);
        },
      },
      {
        name: "ocr",
        dependsOn: [],
        run: () => {
          const args = { cwd, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha };
          return buildOcrFn === buildOcr ? runSynchronousBuilderInWorker("ocr", args) : buildOcrFn(args);
        },
      },
    ],
    { maxConcurrency: maxBuilderConcurrency },
  );
  const { diff, ocr, issue, checks } = built;

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
