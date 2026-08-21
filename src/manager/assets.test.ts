import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagerViewer } from "./assets.js";

test("packaged Manager UI exposes bounded scope editing and pre-start preview", () => {
  const html = readManagerViewer();
  assert.match(html, /id="add-path"/u);
  assert.match(html, /id="add-claim"/u);
  assert.match(html, /id="scope-rows"/u);
  assert.match(html, /\/sessions\/preview/u);
  assert.match(html, /id="start-session" disabled/u);
  assert.match(html, /Projected Nawabari declaration/u);
  assert.match(html, /claim-preflight/u);
  assert.match(html, /Inspect session/u);
  assert.match(html, /Refresh preflight/u);
  assert.match(html, /Reconcile/u);
  assert.match(html, /Remove/u);
});
