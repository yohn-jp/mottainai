import assert from "node:assert/strict";
import test from "node:test";
import { pagesServingExitCode } from "../src/publish-to-pages.mjs";
import { PAGES_SERVING_OUTCOMES } from "../src/verify-pages-serving.mjs";

test("Pages propagation delay is non-fatal after gh-pages publication succeeds", () => {
  assert.equal(pagesServingExitCode(PAGES_SERVING_OUTCOMES.PUBLISHED_BUT_NOT_SERVING), 0);
});

test("serving the wrong revision identity remains fatal", () => {
  assert.equal(pagesServingExitCode(PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY), 1);
});
