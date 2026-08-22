import assert from "node:assert/strict";
import { test } from "node:test";
import { readDashboardAssets, readDashboardViewer } from "./assets.js";

test("dashboard root uses the current semantic viewer instead of the legacy v2 asset", () => {
  const viewer = readDashboardViewer();
  assert.match(viewer, /Semantic Project Viewer/);
  assert.match(viewer, /class="semantic-dashboard"/);
  assert.match(viewer, /\/api\/v1\/project/);
  assert.match(viewer, /\/api\/v1\/components/);
  assert.doesNotMatch(viewer, /Mottainai Semantic Project Viewer v2/);
  assert.doesNotMatch(viewer, /--bg:#080b10/);
});

test("dashboard exposes the shared current UX stylesheet", () => {
  const assets = readDashboardAssets();
  assert.deepEqual(Object.keys(assets), ["/styles.css"]);
  assert.equal(assets["/styles.css"]?.contentType, "text/css; charset=utf-8");
  assert.match(assets["/styles.css"]?.body ?? "", /--paper:/);
  assert.match(assets["/styles.css"]?.body ?? "", /--violet:/);
});
