import assert from "node:assert/strict";
import { test } from "node:test";
import { readDashboardAssets, readDashboardViewer } from "./assets.js";

test("dashboard root is the approved API-backed Wabachi investigation surface", () => {
  const viewer = readDashboardViewer();
  assert.match(viewer, /Wabachi — Semantic Investigation Desk v2/);
  assert.match(viewer, /<body class="wabachi">/);
  assert.match(viewer, /\/api\/v1\/project/);
  assert.match(viewer, /\/api\/v1\/changes/);
  assert.match(viewer, /\/api\/v1\/projections\/review/);
  assert.match(viewer, /\/api\/v1\/entities\//);
  assert.match(viewer, /\/api\/v1\/graph\?/);
  assert.match(viewer, /Create work intent/);
  assert.match(viewer, /Manager\/Nawabari must re-establish execution authority/);
  assert.doesNotMatch(viewer, /Semantic Project Viewer/);
  assert.doesNotMatch(viewer, /semantic-project-viewer-v\d+/);
  assert.doesNotMatch(viewer, /FIND-0012/);
});

test("Wabachi inline interaction script is syntactically valid JavaScript", () => {
  const viewer = readDashboardViewer();
  const match = viewer.match(/<script>([^]*?)<\/script>/u);
  assert.ok(match?.[1], "expected Wabachi to contain one inline interaction script");
  assert.doesNotThrow(() => new Function(match[1]));
});

test("dashboard exposes the shared approved interaction stylesheet", () => {
  const assets = readDashboardAssets();
  assert.deepEqual(Object.keys(assets), ["/styles.css"]);
  assert.equal(assets["/styles.css"]?.contentType, "text/css; charset=utf-8");
  assert.match(assets["/styles.css"]?.body ?? "", /--paper:/);
  assert.match(assets["/styles.css"]?.body ?? "", /\/\* WABACHI \*\//);
});
