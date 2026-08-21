import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagerAssets, readManagerViewer } from "./assets.js";

test("packaged Manager UI uses the agreed four-file mock surface", () => {
  const html = readManagerViewer();
  assert.match(html, /href="\/styles\.css"/u);
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

test("mockup stylesheet links resolve under the /mockups/ HTTP mount", () => {
  const assets = readManagerAssets();
  assert.match(assets["/mockups/mottainai.html"].body, /href="\/styles\.css"/u);
  assert.match(assets["/mockups/wabachi.html"].body, /href="\/styles\.css"/u);
  assert.doesNotMatch(assets["/mockups/mottainai.html"].body, /href="styles\.css"/u);
  assert.doesNotMatch(assets["/mockups/wabachi.html"].body, /href="styles\.css"/u);
});

test("Manager operational console does not render hard-coded operational truth", () => {
  const html = readManagerViewer();
  assert.doesNotMatch(html, />authority synchronized</u);
  assert.doesNotMatch(html, />runtime\/local-dev/u);
  assert.doesNotMatch(html, /OBSERVED 21:29:42/u);
  assert.doesNotMatch(html, />GitHub<\/b><br \/>authoritative integration/u);
  assert.doesNotMatch(html, />Nawabari<\/b><br \/>1 unreconciled close/u);
  assert.doesNotMatch(html, />Queue<\/b><br \/>draining normally/u);
  assert.doesNotMatch(html, /#378.*close proof rejected/u);
  assert.match(html, /function renderRecentSignal/u);
  assert.match(html, /id="recentSignal"/u);
});

test("New Task golden path wires WORK -> EXECUTION -> AUTHORITY -> PREFLIGHT -> LAUNCH without bypassing backend authority", () => {
  const html = readManagerViewer();
  // advance() drives the full step sequence and only calls preflight()/post("/sessions", ...);
  // it never fabricates a session or preview result client-side.
  assert.match(html, /function advance\(\)[\s\S]*?taskStep = 3; renderTask\(\); preflight\(\); return;[\s\S]*?return preflight\(\)\.then\(function \(\) \{ if \(taskPreview\) \{ taskStep = 4; renderTask\(\); \} \}\);[\s\S]*?if \(!taskPreview\) return;[\s\S]*?post\("\/sessions", taskRequest\)/u);
  // preflight() always derives its request from the same taskValues()/taskSnapshot() state used at step 0-2.
  assert.match(html, /function preflight\(\)[\s\S]*?taskRequest = taskValues\(\);[\s\S]*?post\("\/sessions\/preview", taskRequest\)/u);
  // Launch is disabled until a preflight response is stored, and the modal only opens the launched session after refresh.
  assert.match(html, /q\("#nextStep"\)\.disabled = taskStep === 4 && !taskPreview;/u);
  assert.match(html, /post\("\/sessions", taskRequest\)\.then\(function \(body\) \{ closeNew\(\); return refresh\(\)\.then\(function \(\) \{ openSession\(body\.session\.sessionId\); \}\); \}\)/u);
});

test("Wabachi presentation intent hands off a focus/instruction to Manager without authority", () => {
  const wabachi = readManagerAssets()["/mockups/wabachi.html"].body;
  assert.match(wabachi, /function createWorkIntent/u);
  assert.match(wabachi, /sessionStorage\.setItem\("wabachiWorkIntent"/u);
  assert.match(wabachi, /mottainai\.html\?openNew=1/u);
  const mottainai = readManagerViewer();
  assert.match(mottainai, /function readWabachiWorkIntent/u);
  assert.match(mottainai, /sessionStorage\.getItem\("wabachiWorkIntent"\)/u);
  assert.match(mottainai, /intent && intent\.instruction/u);
  // Manager still resolves issue identity, scope, and claim mode itself.
  assert.doesNotMatch(mottainai, /intent\.issueRef|intent\.scope|intent\.claimMode/u);
});
