import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { buildExpectedManifestUrl, PAGES_SERVING_OUTCOMES, verifyPagesManifest } from "../src/verify-pages-serving.mjs";

const repositoryFullName = "yohn-jp/mottainai";
const prNumber = 725;
const headSha = "a".repeat(40);

function manifest(overrides = {}) {
  return {
    repository: { owner: "yohn-jp", name: "mottainai", fullName: repositoryFullName },
    pullRequest: { number: prNumber, headSha },
    revision: { id: headSha },
    ...overrides,
  };
}

async function withHttpFixture(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/mottainai`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body === undefined ? "" : JSON.stringify(body));
}

function verificationOptions(manifestUrl) {
  return {
    manifestUrl,
    repositoryFullName,
    prNumber,
    headSha,
    maxAttempts: 4,
    retryDelayMs: 0,
    requestTimeoutMs: 1_000,
  };
}

test("delayed Pages availability succeeds within the bounded retry window", async () => {
  let requests = 0;
  await withHttpFixture(
    (request, response) => {
      requests += 1;
      if (requests < 3) {
        sendJson(response, 404, { message: "not yet propagated" });
        return;
      }
      sendJson(response, 200, manifest());
    },
    async (baseUrl) => {
      const manifestUrl = buildExpectedManifestUrl({ pagesBaseUrl: baseUrl, prNumber, headSha });
      const result = await verifyPagesManifest(verificationOptions(manifestUrl));
      assert.equal(result.outcome, PAGES_SERVING_OUTCOMES.SUCCESS);
      assert.equal(result.attempts, 3);
      assert.equal(requests, 3);
    },
  );
});

test("persistent 404 is classified as published but not serving and remains bounded", async () => {
  let requests = 0;
  await withHttpFixture(
    (request, response) => {
      requests += 1;
      sendJson(response, 404, { message: "Pages is not configured" });
    },
    async (baseUrl) => {
      const manifestUrl = buildExpectedManifestUrl({ pagesBaseUrl: baseUrl, prNumber, headSha });
      const result = await verifyPagesManifest(verificationOptions(manifestUrl));
      assert.equal(result.outcome, PAGES_SERVING_OUTCOMES.PUBLISHED_NOT_SERVING);
      assert.equal(result.attempts, 4);
      assert.equal(result.status, 404);
      assert.equal(requests, 4);
    },
  );
});

test("a reachable manifest with the wrong revision identity fails closed", async () => {
  let requests = 0;
  await withHttpFixture(
    (request, response) => {
      requests += 1;
      sendJson(response, 200, manifest({ revision: { id: "b".repeat(40) } }));
    },
    async (baseUrl) => {
      const manifestUrl = buildExpectedManifestUrl({ pagesBaseUrl: baseUrl, prNumber, headSha });
      const result = await verifyPagesManifest(verificationOptions(manifestUrl));
      assert.equal(result.outcome, PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY);
      assert.deepEqual(result.mismatches, ["revision.id"]);
      assert.equal(result.attempts, 1);
      assert.equal(requests, 1);
    },
  );
});

test("successful serving verification sends no credentials to the public endpoint", async () => {
  let authorization;
  let requestedPath;
  await withHttpFixture(
    (request, response) => {
      authorization = request.headers.authorization;
      requestedPath = request.url;
      sendJson(response, 200, manifest());
    },
    async (baseUrl) => {
      const manifestUrl = buildExpectedManifestUrl({ pagesBaseUrl: baseUrl, prNumber, headSha });
      const result = await verifyPagesManifest(verificationOptions(manifestUrl));
      assert.equal(result.outcome, PAGES_SERVING_OUTCOMES.SUCCESS);
      assert.equal(authorization, undefined);
      assert.equal(new URL(manifestUrl).pathname, requestedPath);
    },
  );
});
