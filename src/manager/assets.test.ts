import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagerAssets, readManagerViewer } from "./assets.js";

test("packaged Manager UI uses the agreed four-file mock surface", () => {
  const html = readManagerViewer();
  assert.match(html, /href="styles\.css"/u);
  assert.match(html, /Needs attention/u);
  assert.match(html, /Wabachi Work Intent/u);
  assert.match(html, /POST \/api\/v1\/manager\/sessions\/preview/u);
  assert.match(html, /SESSION DETAIL \/ AUTHORITATIVE PROJECTION/u);
  const assets = readManagerAssets();
  assert.deepEqual(Object.keys(assets).sort(), [
    "/mockups/index.html",
    "/mockups/mottainai.html",
    "/mockups/wabachi.html",
    "/styles.css",
  ]);
  assert.match(assets["/mockups/wabachi.html"].body, /Semantic Investigation Desk/u);
  assert.match(assets["/styles.css"].body, /\.mottainai/u);
});

test("Manager New Task keeps explicit input state for the same preflight and launch request", () => {
  const html = readManagerViewer();
  assert.match(html, /var taskState = createTaskState\(\);/u);
  assert.match(html, /function saveTaskInputs\(\)[\s\S]*taskState\.scope\.claimMode = input\.value;/u);
  assert.match(html, /function taskSnapshot\(\)[\s\S]*issueRef: normalizeIssueRef\(state\.issueRef\)/u);
  assert.match(html, /function taskValues\(\) \{\s*saveTaskInputs\(\);\s*return taskSnapshot\(\);/u);
  assert.match(html, /return issue\.replace\(\/\^#\+\/u, ""\) \|\| "406";/u);
  assert.match(html, /taskRequest = taskValues\(\);[\s\S]*post\("\/sessions", taskRequest\)/u);
});

test("Manager inspect Nawabari routes through the execution session identity", () => {
  const html = readManagerViewer();
  assert.match(html, /var executionSessionId = session\.operational && session\.operational\.identities && session\.operational\.identities\.executionSessionId;/u);
  assert.match(html, /if \(!executionSessionId\)[\s\S]*no inspect request was sent\./u);
  assert.match(html, /\/nawabari\/sessions\/" \+ encodeURIComponent\(executionSessionId\) \+ "\/inspect/u);
  assert.doesNotMatch(html, /\/nawabari\/sessions\/" \+ encodeURIComponent\(session\.sessionId\) \+ "\/inspect/u);
});
