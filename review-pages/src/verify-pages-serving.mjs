const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export const PAGES_SERVING_OUTCOMES = Object.freeze({
  PUSH_FAILURE: "push-failure",
  PUBLISHED_NOT_SERVING: "published-but-not-serving",
  SERVING_WRONG_IDENTITY: "serving-wrong-identity",
  SUCCESS: "success",
});

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePrNumber(value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError("prNumber must be a positive integer");
  return String(value);
}

function requireHeadSha(value) {
  const headSha = requireNonEmptyString(value, "headSha");
  if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new TypeError("headSha must be a full lowercase commit SHA");
  return headSha;
}

function parsePublicHttpUrl(value, label) {
  const raw = requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${label} must use HTTP(S)`);
  }
  if (url.username || url.password) throw new TypeError(`${label} must not contain credentials`);
  if (url.search || url.hash) throw new TypeError(`${label} must not contain a query or fragment`);
  return url;
}

/**
 * Build the immutable public URL for one exact PR/head manifest.
 * The base URL is an explicit Pages site URL (or the repository-derived
 * default supplied by the workflow); no local checkout path participates.
 */
export function buildExpectedManifestUrl({ pagesBaseUrl, prNumber, headSha }) {
  const url = parsePublicHttpUrl(pagesBaseUrl, "pagesBaseUrl");
  const pr = requirePrNumber(prNumber);
  const sha = requireHeadSha(headSha);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/reviews/pr/${encodeURIComponent(pr)}/${encodeURIComponent(sha)}/manifest.json`;
  return url.toString();
}

// Keep the name descriptive for callers that treat this as a Pages URL
// builder rather than specifically as the manifest verifier's input.
export const buildPagesManifestUrl = buildExpectedManifestUrl;

function normalizeExpectedRepository(repository, repositoryFullName) {
  const fullName =
    repositoryFullName ??
    (typeof repository === "string"
      ? repository
      : (repository?.fullName ?? `${repository?.owner ?? ""}/${repository?.name ?? ""}`));
  const normalized = requireNonEmptyString(fullName, "repositoryFullName");
  if (!/^[^/]+\/[^/]+$/u.test(normalized)) throw new TypeError("repositoryFullName must be owner/name");
  return normalized;
}

function expectedIdentityFromOptions({ repository, repositoryFullName, prNumber, headSha }) {
  return {
    repositoryFullName: normalizeExpectedRepository(repository, repositoryFullName),
    prNumber: Number(requirePrNumber(prNumber)),
    headSha: requireHeadSha(headSha),
  };
}

function identityMismatches(manifest, expected) {
  const mismatches = [];
  const [owner, name] = expected.repositoryFullName.split("/");
  if (
    manifest?.repository?.fullName !== expected.repositoryFullName ||
    manifest?.repository?.owner !== owner ||
    manifest?.repository?.name !== name
  ) {
    mismatches.push("repository");
  }
  if (manifest?.pullRequest?.number !== expected.prNumber) mismatches.push("pullRequest.number");
  if (manifest?.pullRequest?.headSha !== expected.headSha) mismatches.push("pullRequest.headSha");
  if (manifest?.revision?.id !== expected.headSha) mismatches.push("revision.id");
  return mismatches;
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : null;
}

function responseIsOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  const status = responseStatus(response);
  return status !== null && status >= 200 && status < 300;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function normalizeNonNegativeInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function result(outcome, fields) {
  return Object.freeze({ outcome, ...fields });
}

/**
 * Verify that a just-published exact revision is served by GitHub Pages.
 * A non-2xx response or request error is retried up to maxAttempts. A
 * reachable JSON document with a different identity fails closed immediately:
 * retrying a wrong immutable revision could hide a publication/storage bug.
 */
export async function verifyPagesManifest({
  manifestUrl,
  repository,
  repositoryFullName,
  prNumber,
  headSha,
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const url = parsePublicHttpUrl(manifestUrl, "manifestUrl").toString();
  const expected = expectedIdentityFromOptions({ repository, repositoryFullName, prNumber, headSha });
  const attemptsLimit = normalizePositiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
  const delay = normalizeNonNegativeInteger(retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
  const timeout = normalizePositiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  if (typeof fetchFn !== "function") throw new TypeError("fetchFn must be a function");
  if (typeof sleepFn !== "function") throw new TypeError("sleepFn must be a function");

  let lastStatus = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        // Deliberately no Authorization header or other repository credential.
        signal: AbortSignal.timeout(timeout),
      });
      lastStatus = responseStatus(response);
      lastError = null;

      if (responseIsOk(response)) {
        let manifest;
        try {
          manifest = await response.json();
        } catch {
          return result(PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY, {
            manifestUrl: url,
            attempts: attempt,
            status: lastStatus,
            reason: "invalid-json",
          });
        }
        const mismatches = identityMismatches(manifest, expected);
        if (mismatches.length > 0) {
          return result(PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY, {
            manifestUrl: url,
            attempts: attempt,
            status: lastStatus,
            mismatches,
          });
        }
        return result(PAGES_SERVING_OUTCOMES.SUCCESS, {
          manifestUrl: url,
          attempts: attempt,
          status: lastStatus,
        });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.name : "request-error";
      lastStatus = null;
    }

    if (attempt < attemptsLimit) await sleepFn(delay);
  }

  return result(PAGES_SERVING_OUTCOMES.PUBLISHED_NOT_SERVING, {
    manifestUrl: url,
    attempts: attemptsLimit,
    status: lastStatus,
    reason: lastError ?? (lastStatus === null ? "request-failed" : `http-${lastStatus}`),
  });
}

export const verifyPublishedManifest = verifyPagesManifest;
