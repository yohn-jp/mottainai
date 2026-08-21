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
    "/mockups/styles.css",
    "/mockups/wabachi.html",
    "/styles.css",
  ]);
  assert.match(assets["/mockups/wabachi.html"].body, /Semantic Investigation Desk/u);
  assert.match(assets["/styles.css"].body, /\.mottainai/u);
});

test("Manager New Task keeps explicit input state for the same preflight and launch request", () => {
  const html = readManagerViewer();
  assert.match(html, /createTaskState/u);
  assert.match(html, /saveTaskInputs/u);
  assert.match(html, /taskSnapshot/u);
  assert.match(html, /normalizeIssueRef/u);
  assert.match(html, /post\("\/sessions", taskRequest\)/u);
});

test("Manager inspect Nawabari routes through the execution session identity", () => {
  const html = readManagerViewer();
  assert.match(html, /executionSessionId/u);
  assert.match(html, /no inspect request was sent/u);
  assert.match(html, /\/nawabari\/sessions\//u);
  assert.match(html, /encodeURIComponent\(executionSessionId\)/u);
});

test("mockup stylesheet links resolve under the /mockups/ HTTP mount", () => {
  const assets = readManagerAssets();
  assert.match(assets["/mockups/mottainai.html"].body, /href="\/styles\.css"/u);
  assert.match(assets["/mockups/wabachi.html"].body, /href="\/styles\.css"/u);
  assert.ok(assets["/mockups/styles.css"], "styles.css must be published at /mockups/styles.css");
  assert.match(assets["/mockups/styles.css"].body, /\.mottainai/u);
});

test("Manager operational console does not render hard-coded operational truth", () => {
  const html = readManagerViewer();
  assert.match(html, /renderRecentSignal/u);
  assert.match(html, /recentSignal/u);
  assert.match(html, /updateHealth/u);
});

test("New Task golden path wires WORK -> EXECUTION -> AUTHORITY -> PREFLIGHT -> LAUNCH without bypassing backend authority", () => {
  const html = readManagerViewer();
  assert.match(html, /advance/u);
  assert.match(html, /preflight/u);
  assert.match(html, /taskPreview/u);
  assert.match(html, /post\("\/sessions"/u);
  assert.match(html, /post\("\/sessions\/preview"/u);
  assert.match(html, /disabled = taskStep === 4 && !taskPreview/u);
  assert.match(html, /openSession\(body\.session\.sessionId\)/u);
});

test("Wabachi presentation intent hands off a focus/instruction to Manager without authority", () => {
  const wabachi = readManagerAssets()["/mockups/wabachi.html"].body;
  assert.match(wabachi, /createWorkIntent/u);
  assert.match(wabachi, /wabachiWorkIntent/u);
  assert.match(wabachi, /mottainai\.html\?openNew=1/u);
  const mottainai = readManagerViewer();
  assert.match(mottainai, /readWabachiWorkIntent/u);
  assert.match(mottainai, /wabachiWorkIntent/u);
});
