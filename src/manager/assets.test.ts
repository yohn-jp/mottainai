import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagerAssets, readManagerViewer } from "./assets.js";

test("packaged Manager UI uses the agreed four-file Mottainai/Wabachi surface", () => {
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
  assert.match(assets["/mockups/wabachi.html"].body, /Semantic Investigation Desk v2/u);
  assert.match(assets["/styles.css"].body, /\.mottainai/u);
});

test("Manager New Task keeps the exact approved request paired with its preview through launch", () => {
  const html = readManagerViewer();
  assert.match(html, /createTaskState/u);
  assert.match(html, /saveTaskInputs/u);
  assert.match(html, /taskSnapshot/u);
  assert.match(html, /normalizeIssueRef/u);
  assert.match(html, /approvedPreflight = \{ request: taskRequest, preview: preview \}/u);
  assert.match(html, /post\("\/sessions", approvedPreflight\.request\)/u);
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
  assert.match(html, /approvedPreflight/u);
  assert.match(html, /post\("\/sessions"/u);
  assert.match(html, /post\("\/sessions\/preview"/u);
  assert.match(html, /disabled = taskStep === 4 && !approvedPreflight/u);
  assert.match(html, /openSession\(body\.session\.sessionId\)/u);
});

test("live Wabachi creates a non-authoritative Work Intent that Manager re-preflights", () => {
  const wabachi = readManagerAssets()["/mockups/wabachi.html"].body;
  assert.match(wabachi, /function handoffToManager\(/u);
  assert.match(wabachi, /wabachiWorkIntent/u);
  assert.match(wabachi, /target\.searchParams\.set\("openNew", "1"\)/u);
  assert.match(wabachi, /Manager\/Nawabari must re-establish execution authority/u);
  assert.match(wabachi, /\/api\/v1\/changes/u);
  assert.match(wabachi, /\/api\/v1\/projections\/review/u);
  assert.doesNotMatch(wabachi, /FIND-0012/u);
  const mottainai = readManagerViewer();
  assert.match(mottainai, /readWabachiWorkIntent/u);
  assert.match(mottainai, /wabachiWorkIntent/u);
  assert.match(mottainai, /Wabachi presentation intent \(not authoritative\)/u);
  assert.match(mottainai, /post\("\/sessions\/preview"/u);
});

test("Wabachi repository and semantic focus remain presentation intent rather than execution scope authority", () => {
  const wabachi = readManagerAssets()["/mockups/wabachi.html"].body;
  assert.match(wabachi, /repository:\s*project\.project/u);
  assert.match(wabachi, /focus:\s*finding\.entityId/u);
  assert.match(wabachi, /scope:\s*firstRead/u);
  const mottainai = readManagerViewer();
  assert.match(mottainai, /params\.get\("repository"\)/u);
  assert.match(mottainai, /repository:\s*params\.get\("repository"\)/u);
  assert.match(mottainai, /wabachiIntent/u);
  assert.match(mottainai, /intent\.focus/u);
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
  assert.match(html, /approvedPreflight = undefined;\s*\n\s*var reason/u);
  assert.match(html, /<b>BLOCKED<\/b>/u);
  assert.match(html, /Launch remains disabled/u);
});

test("New Task preflight discards stale responses both across overlapping requests and modal lifecycles", () => {
  const html = readManagerViewer();
  const epochMatch = html.match(/function isPreflightResponseCurrent\(epoch, currentEpoch\) \{ return[^}]+\}/u);
  assert.ok(epochMatch, "expected preflight() to gate stale modal-lifecycle responses");
  const isPreflightResponseCurrent = new Function(
    "epoch",
    "currentEpoch",
    epochMatch[0].replace(/^function isPreflightResponseCurrent\(epoch, currentEpoch\) \{ return/, "return").replace(/\}$/, ""),
  );
  const tokenMatch = html.match(/function isCurrentPreflightResponse\(token, latestToken\) \{ return[^}]+\}/u);
  assert.ok(tokenMatch, "expected preflight() to gate out-of-order request responses");
  const isCurrentPreflightResponse = new Function(
    "token",
    "latestToken",
    tokenMatch[0].replace(/^function isCurrentPreflightResponse\(token, latestToken\) \{ return/, "return").replace(/\}$/, ""),
  );
  assert.equal(isPreflightResponseCurrent(0, 2), false);
  assert.equal(isPreflightResponseCurrent(2, 2), true);
  assert.equal(isCurrentPreflightResponse(1, 2), false);
  assert.equal(isCurrentPreflightResponse(2, 2), true);
  assert.match(html, /var preflightEpoch = 0;/u);
  assert.match(html, /var preflightToken = 0;/u);
  assert.match(html, /function openNew\(\)[^]*?preflightEpoch\+\+;[^]*?taskStep = 0;/u);
  assert.match(html, /function closeNew\(\) \{\s*\n\s*preflightEpoch\+\+;/u);
  assert.match(
    html,
    /return post\("\/sessions\/preview", taskRequest\)\.then\(function \(body\) \{\s*\n\s*if \(!isPreflightResponseCurrent\(epoch, preflightEpoch\)\) return;\s*\n\s*if \(!isCurrentPreflightResponse\(token, preflightToken\)\) return;/u,
  );
  assert.match(
    html,
    /\}\)\.catch\(function \(error\) \{\s*\n\s*if \(!isPreflightResponseCurrent\(epoch, preflightEpoch\)\) return;\s*\n\s*if \(!isCurrentPreflightResponse\(token, preflightToken\)\) return;/u,
  );
});

test("Manager live console polls bounded summaries and cleans up its timer", () => {
  const html = readManagerViewer();
  assert.match(html, /request\("\/sessions\?limit=500"\)/u);
  assert.match(html, /var refreshInFlight = false;/u);
  assert.match(html, /setInterval\(refresh, 5000\)/u);
  assert.match(html, /beforeunload/u);
  assert.match(html, /clearInterval\(pollTimer\)/u);
});

test("Manager overlays are mutually exclusive before focus trapping", () => {
  const html = readManagerViewer();
  assert.match(html, /function closeOverlaysExcept\(kept\)/u);
  assert.match(html, /closeOverlaysExcept\("drawer"\)/u);
  assert.match(html, /closeOverlaysExcept\("modal"\)/u);
  assert.match(html, /closeOverlaysExcept\("palette"\)/u);
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
    "2!",
    "Suzuki · Owner",
  ]) {
    assert.ok(!html.includes(fakeMarker), `initial Manager HTML must not contain fabricated state: ${fakeMarker}`);
  }
  assert.match(html, /Loading operational data…/u);
  assert.match(html, /id="authorityStatusValue">UNAVAILABLE/u);
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
  assert.match(html, /request\("\/sessions\/" \+ encodeURIComponent\(id\)\)/u);
});
