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
  // Launch POSTs exactly the request an accepted preflight approved, never a separate global
  // that an overlapping/out-of-order preflight could have re-pointed at a different snapshot.
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
  assert.match(html, /approvedPreflight = undefined;\s*\n\s*var reason/u);
  assert.match(html, /<b>BLOCKED<\/b>/u);
  assert.match(html, /Launch remains disabled/u);
});

test("preflight discards an out-of-order response instead of corrupting a newer approval (regression)", () => {
  const html = readManagerViewer();
  const match = html.match(/function isCurrentPreflightResponse\(token, latestToken\) \{ return[^}]+\}/u);
  assert.ok(match, "expected preflight() to gate stale responses through an extractable isCurrentPreflightResponse helper");
  const isCurrentPreflightResponse = new Function(
    "token",
    "latestToken",
    match[0].replace(/^function isCurrentPreflightResponse\(token, latestToken\) \{ return/, "return").replace(/\}$/, ""),
  );
  // Preflight request A (token 1) is issued, then a newer preflight request B (token 2) is
  // issued before A's response arrives — an overlapping/out-of-order preflight. By the time
  // A's response resolves, preflightToken has already advanced to 2 (B is now the latest).
  assert.equal(isCurrentPreflightResponse(1, 2), false, "A's stale response must be discarded, not applied");
  assert.equal(isCurrentPreflightResponse(2, 2), true, "B's response, being the latest request, must still be applied");
  // Static shape: approvedPreflight/the rendered preflight state are stored together as one
  // pair and mutated only after this guard runs, both on the success and the error path — a
  // stale response can neither approve nor reject in place of the newer, still-pending request.
  assert.match(html, /var approvedPreflight;/u);
  assert.match(html, /var preflightToken = 0;/u);
  assert.match(html, /var token = \+\+preflightToken;/u);
  assert.match(
    html,
    /return post\("\/sessions\/preview", request\)\.then\(function \(body\) \{\s*\n\s*if \(!isCurrentPreflightResponse\(token, preflightToken\)\) return;/u,
  );
  assert.match(html, /\}\)\.catch\(function \(error\) \{\s*\n\s*if \(!isCurrentPreflightResponse\(token, preflightToken\)\) return;/u);
  assert.match(html, /approvedPreflight = \{ request: request, preview: preview \};/u);
  // Each preflight operates on one immutable snapshot captured synchronously before the
  // request is sent, and that exact snapshot is what Launch POSTs on approval.
  assert.match(html, /var request = taskValues\(\);\s*\n\s*var token = \+\+preflightToken;/u);
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
    "Suzuki",
  ]) {
    assert.ok(!html.includes(fakeMarker), `initial Manager HTML must not contain fabricated state: ${fakeMarker}`);
  }
  // Neutral/loading placeholders take their place instead.
  assert.match(html, /Loading operational data…/u);
  assert.match(html, /Session detail/u);
  // "Authority status" must not ship a hard-coded "CURRENT" in the initial markup; it starts
  // neutral and only updateHealth() may promote it to CURRENT once backend health is observed.
  assert.match(html, /<span class="count" id="authorityStatusValue">UNAVAILABLE<\/span>/u);
  assert.match(html, /q\("#authorityStatusValue"\)\.textContent = health \? "CURRENT" : "UNAVAILABLE";/u);
});

test("Manager overlays declare accessible names and the drawer close controls are wired", () => {
  const html = readManagerViewer();
  assert.match(html, /id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"/u);
  assert.match(html, /id="newTaskModal" role="dialog" aria-modal="true" aria-labelledby="newTaskModalTitle"/u);
  assert.match(html, /id="palette" role="dialog" aria-modal="true" aria-label="Command palette"/u);
  assert.match(html, /qa\("\[data-close\]"\)\.forEach\(function \(b\) \{ b\.onclick = closeDrawer; \}\)/u);
  assert.match(html, /function trapFocus\(/u);
});

test("Manager overlays are mutually exclusive so only one traps keyboard focus at a time", () => {
  const html = readManagerViewer();
  assert.match(html, /function closeOverlaysExcept\(kept\)/u);
  // Opening any one overlay must first deactivate the other two.
  assert.match(html, /function openSession\(id\) \{[\s\S]*?closeOverlaysExcept\("drawer"\);/u);
  assert.match(html, /function openNew\(\) \{\s*\n\s*closeOverlaysExcept\("modal"\);/u);
  assert.match(html, /q\("#openPalette"\)\.onclick = function \(\) \{\s*\n\s*closeOverlaysExcept\("palette"\);/u);
  // Tab/Shift+Tab trapping and Escape both resolve against whichever overlay is actually open —
  // correct by construction once at most one overlay ever carries the "open" class.
  assert.match(html, /if \(q\("#drawer"\)\.classList\.contains\("open"\)\) trapFocus\(q\("#drawer"\), event\);/u);
  assert.match(html, /else if \(q\("#newTaskModal"\)\.classList\.contains\("open"\)\) trapFocus\(q\("#newTaskModal"\), event\);/u);
  assert.match(html, /else if \(q\("#palette"\)\.classList\.contains\("open"\)\) trapFocus\(q\("#palette"\), event\);/u);
});

test("Manager Home polls the bounded session/health projection on a live interval and cleans up on unload", () => {
  const html = readManagerViewer();
  // ~5s bounded polling, guarded against overlapping executions.
  assert.match(html, /var refreshInFlight = false;/u);
  assert.match(html, /if \(refreshInFlight\) return Promise\.resolve\(\);/u);
  assert.match(html, /refreshInFlight = true;/u);
  assert.match(html, /var pollTimer = setInterval\(refresh, 5000\);/u);
  // The timer is cleaned up on page unload.
  assert.match(html, /window\.addEventListener\("beforeunload", function \(\) \{ clearInterval\(pollTimer\); \}\)/u);
  // The poll reuses the same lightweight health/sessions summary refresh() already used for the
  // post-action refresh — never the expensive full session detail endpoint.
  assert.match(html, /request\("\/health"\), request\("\/sessions\?limit=500"\)/u);
});

test("Manager list projection stays separate from full session detail projection", () => {
  const html = readManagerViewer();
  // The drawer must fetch authoritative single-session detail rather than
  // reusing the bounded list summary already held in memory.
  assert.match(html, /request\("\/sessions\/" \+ encodeURIComponent\(id\)\)/u);
});
