import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureTimestamp,
  readLatencyFile,
  recordMilestone,
  recordStage,
  recordVisibility,
  writeLatencyFile,
} from "./lib/latency.mjs";

export const DEFAULT_VISIBILITY_ATTEMPTS = 12;
export const DEFAULT_VISIBILITY_DELAY_MS = 5_000;
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 10_000;
export const MAX_MANIFEST_BYTES = 128 * 1024;

function boundedAttempts(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : DEFAULT_VISIBILITY_ATTEMPTS;
}

function boundedDelay(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 30_000 ? parsed : DEFAULT_VISIBILITY_DELAY_MS;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 30_000 ? parsed : DEFAULT_VISIBILITY_TIMEOUT_MS;
}

function validSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

function validPrNumber(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function defaultPagesBaseUrl({ repository, configuredBaseUrl } = {}) {
  const configured = typeof configuredBaseUrl === "string" ? configuredBaseUrl.trim() : "";
  if (configured) return configured.replace(/\/+$/u, "");
  if (typeof repository !== "string") throw new Error("GITHUB_REPOSITORY is required when Pages URL is not configured");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || owner.includes("/") || repo.includes("/")) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  return `https://${owner}.github.io/${repo}`;
}

export function expectedManifestUrl({ baseUrl, prNumber, headSha } = {}) {
  const number = validPrNumber(prNumber);
  const sha = validSha(headSha);
  if (!number || !sha) throw new Error("a positive PR number and full lowercase head SHA are required");
  const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/reviews/pr/${number}/${sha}/manifest.json`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Pages URL must use HTTP(S)");
  return url;
}

async function responseBody(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MANIFEST_BYTES) return null;
  const body = await response.text();
  if (body.length > MAX_MANIFEST_BYTES) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function identityMatches(manifest, { repository, prNumber, headSha }) {
  return (
    manifest &&
    typeof manifest === "object" &&
    manifest.revision?.id === headSha &&
    manifest.pullRequest?.number === prNumber &&
    (!repository || manifest.repository?.fullName === repository)
  );
}

function observedHeadSha(manifest) {
  return validSha(manifest?.revision?.id);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function measurePagesVisibility({
  filePath,
  job,
  baseUrl,
  repository,
  prNumber,
  headSha,
  publishSucceeded = true,
  attempts = DEFAULT_VISIBILITY_ATTEMPTS,
  delayMs = DEFAULT_VISIBILITY_DELAY_MS,
  timeoutMs = DEFAULT_VISIBILITY_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  now = captureTimestamp,
} = {}) {
  if (!filePath || !job) throw new Error("latency file and job are required");
  const number = validPrNumber(prNumber);
  const sha = validSha(headSha);
  if (!number || !sha) throw new Error("a positive PR number and full lowercase head SHA are required");
  if (typeof fetchFn !== "function") throw new Error("fetch is unavailable");

  const evidence = readLatencyFile(filePath);
  const url = expectedManifestUrl({ baseUrl, prNumber: number, headSha: sha });
  const expectedPath = url.pathname;
  const maxAttempts = boundedAttempts(attempts);
  const retryDelayMs = boundedDelay(delayMs);
  const requestTimeoutMs = boundedTimeout(timeoutMs);
  const servingStarted = recordStage(evidence, { job, stage: "pages-serving", phase: "start", timestamp: now() });

  let status = "published-but-not-serving";
  let visibleAttempt = null;
  let lastStatusCode = null;
  let lastObservedHeadSha = null;

  if (!publishSucceeded) {
    status = "push-failure";
  } else {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response;
        try {
          response = await fetchFn(url, { redirect: "follow", signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        lastStatusCode = Number.isInteger(response.status) ? response.status : null;
        if (response.ok) {
          const manifest = await responseBody(response);
          lastObservedHeadSha = observedHeadSha(manifest);
          if (identityMatches(manifest, { repository, prNumber: number, headSha: sha })) {
            visibleAttempt = attempt;
            status = "success";
            recordMilestone(evidence, {
              job,
              name: "http-visible",
              timestamp: now(),
              details: { attempt, statusCode: lastStatusCode, path: expectedPath },
            });
            break;
          }
          status = "wrong-served-revision";
        }
      } catch {
        // A transient Pages/CDN/network failure is measurement evidence, not
        // a reason to fail the publication job or expose response contents.
      }
      if (attempt < maxAttempts) await sleepFn(retryDelayMs);
    }
  }

  recordVisibility(evidence, {
    job,
    status,
    attempts: visibleAttempt ?? maxAttempts,
    expectedPath,
    observedHeadSha: lastObservedHeadSha,
    lastStatusCode,
  });
  const servingCompleted = recordStage(evidence, {
    job,
    stage: "pages-serving",
    phase: "complete",
    timestamp: now(),
  });
  writeLatencyFile(filePath, evidence);
  return { status, attempts: visibleAttempt ?? maxAttempts, expectedPath, servingStarted, servingCompleted };
}

function environmentBoolean(value) {
  return value === "true" || value === "1" || value === "yes";
}

async function main() {
  const environment = process.env;
  const filePath = environment.REVIEW_PAGES_LATENCY_FILE;
  const job = environment.REVIEW_PAGES_LATENCY_JOB;
  const repository = environment.GITHUB_REPOSITORY;
  const prNumber = environment.REVIEW_PAGES_PR_NUMBER;
  const headSha = environment.REVIEW_PAGES_HEAD_SHA;
  const baseUrl = defaultPagesBaseUrl({
    repository,
    configuredBaseUrl: environment.REVIEW_PAGES_BASE_URL,
  });
  const result = await measurePagesVisibility({
    filePath,
    job,
    baseUrl,
    repository,
    prNumber,
    headSha,
    publishSucceeded: environmentBoolean(environment.REVIEW_PAGES_PUBLISH_SUCCEEDED),
    attempts: environment.REVIEW_PAGES_HTTP_ATTEMPTS,
    delayMs: environment.REVIEW_PAGES_HTTP_DELAY_MS,
    timeoutMs: environment.REVIEW_PAGES_HTTP_TIMEOUT_MS,
  });
  console.log(`Review Pages HTTP visibility: ${result.status} (${result.attempts} attempt(s), ${result.expectedPath})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    // Measurement must not turn a successful publication into a failed run.
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 0;
  });
}
