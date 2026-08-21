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

test("Wabachi repository is preserved as presentation intent, not just instruction", () => {
  const wabachi = readManagerAssets()["/mockups/wabachi.html"].body;
  assert.match(wabachi, /repository:\s*"mottainai"/u);
  assert.match(wabachi, /repository:\s*intent\.repository/u);
  const mottainai = readManagerViewer();
  // Manager must read repository off both the query-string and stored-intent
  // handoff channels, not just focus/instruction.
  assert.match(mottainai, /params\.get\("repository"\)/u);
  assert.match(mottainai, /repository:\s*params\.get\("repository"\)/u);
  // The focus must stay visible to the operator in the New Task WORK step
  // instead of being silently discarded.
  assert.match(mottainai, /wabachiIntent/u);
  assert.match(mottainai, /intent\.focus/u);
  // Manager must still independently resolve execution authority: the
  // Wabachi intent is never wired into the actual claim/scope fields.
  assert.doesNotMatch(mottainai, /taskState\.scope\.path\s*=\s*intent/u);
});

test("New Task preflight only treats clear/not-applicable claim status as launchable", () => {
  const html = readManagerViewer();
  const match = html.match(/function isLaunchableClaimStatus\(status\) \{ return[^}]+\}/u);
  assert.ok(match, "expected preflight() to gate on an extractable isLaunchableClaimStatus helper");
  const isLaunchableClaimStatus = new Function(
    "status",
    match[0].replace(/^function isLaunchableClaimStatus\(status\) \{ return/, "return").replace(/\}$/, ""),
  );
  assert.equal(isLaunchableClaimStatus("clear"), true);
  assert.equal(isLaunchableClaimStatus("not-applicable"), true);
  assert.equal(isLaunchableClaimStatus("conflict"), false);
  assert.equal(isLaunchableClaimStatus("stale"), false);
  assert.equal(isLaunchableClaimStatus("unavailable"), false);
  assert.equal(isLaunchableClaimStatus("ambiguous"), false);
  // A blocked status must not retain a launchable preview or render READY.
  assert.match(html, /taskPreview = undefined;\s*\n\s*var reason/u);
  assert.match(html, /<b>BLOCKED<\/b>/u);
  assert.match(html, /Launch remains disabled/u);
});

test("Manager operational console ships no fabricated operational truth in its initial markup", () => {
  const html = readManagerViewer();
  for (const fakeMarker of [
    "2 UNRESOLVED",
    "#378",
    "#381",
    "#380",
    "#379",
    "#377",
    "PR REVIEW",
    "NOMINAL",
    "Cleanup blocked",
    "Open session #379",
    "Inspect attention #378",
  ]) {
    assert.ok(!html.includes(fakeMarker), `initial Manager HTML must not contain fabricated state: ${fakeMarker}`);
  }
  // Neutral/loading placeholders take their place instead.
  assert.match(html, /Loading operational data…/u);
  assert.match(html, /Session detail/u);
});

test("Manager overlays declare accessible names and the drawer close controls are wired", () => {
  const html = readManagerViewer();
  assert.match(html, /id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"/u);
  assert.match(html, /id="newTaskModal" role="dialog" aria-modal="true" aria-labelledby="newTaskModalTitle"/u);
  assert.match(html, /id="palette" role="dialog" aria-modal="true" aria-label="Command palette"/u);
  assert.match(html, /qa\("\[data-close\]"\)\.forEach\(function \(b\) \{ b\.onclick = closeDrawer; \}\)/u);
  assert.match(html, /function trapFocus\(/u);
});

test("Manager list projection stays separate from full session detail projection", () => {
  const html = readManagerViewer();
  // The drawer must fetch authoritative single-session detail rather than
  // reusing the bounded list summary already held in memory.
  assert.match(html, /request\("\/sessions\/" \+ encodeURIComponent\(id\)\)/u);
});
