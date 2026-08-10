// @ts-nocheck -- The black-box suite intentionally consumes the shared MJS harness.
// Issue #76: exercise the packaged gateway only through its public stdio MCP boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { McpStdioClient } from "../../scripts/lib/mcp-blackbox-client.mjs";
import {
  cleanupClient,
  createWorkspace,
  isolatedEnv,
  writeConfig,
} from "../../scripts/lib/mcp-blackbox-test-support.mjs";
import { BLACKBOX_TIMEOUTS } from "../../scripts/lib/mcp-blackbox-timeouts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const DOGFOOD_MARKER = "DOGFOOD_PRIVATE_MARKER_SHOULD_NOT_APPEAR";
const SUCCESS_THRESHOLDS = {
  verboseReductionPercent: 70,
  unchangedReductionPercent: 80,
  maxWatchResponses: 1,
} as const;

const successLines = Array.from({ length: 260 }, (_, index) =>
  `ok ${index + 1} - deterministic build fixture ${"x".repeat(72)}`,
);
const successOutput = `${[...successLines, "# tests 260", "# pass 260", "# fail 0"].join("\n")}\n`;
const failureLines = [
  "TAP version 13",
  "not ok 1 - deterministic failure fixture",
  "  error: expected green build but received exit 1",
  ...Array.from({ length: 180 }, (_, index) => `  diagnostic-${index + 1}: ${"y".repeat(76)}`),
  "# tests 1",
  "# pass 0",
  "# fail 1",
];
const failureOutput = `${failureLines.join("\n")}\n`;
const sourceLines = Array.from({ length: 240 }, (_, index) =>
  `export const sourceLine${index + 1} = ${JSON.stringify(`line-${index + 1}-${"s".repeat(72)}`)};`,
);
const sourceText = `${sourceLines.join("\n")}\n`;
const unchangedText = `${Array.from({ length: 40 }, (_, index) => `unchanged-${index + 1}-${"u".repeat(140)}`).join("\n")}\n`;
const burstText = `${Array.from({ length: 60 }, (_, index) => `burst-${index + 1}-${"b".repeat(96)}`).join("\n")}\n`;

const config = {
  version: 2,
  mcpServers: {},
  gateway: {
    workspaceRoot: ".",
    maxOutputBytes: 2_000_000,
    execTargetTokens: 10_000,
    responseBudget: { softTokens: 8_000, hardTokens: 10_000, hardBytes: 40_000 },
    readGovernor: {
      mode: "enforce",
      maxRawLines: 80,
      maxRawBytes: 8_192,
      allowWholeFileBelowLines: 20,
      preferAuto: true,
      allowWholeFile: false,
    },
    burstBudget: {
      mode: "enforce",
      maxConcurrentProjectedTokens: 2_048,
      rollingWindowMs: 2_000,
      rollingProjectedTokens: 4_096,
      rollingProjectedBytes: 16_384,
    },
    await: { minPollIntervalMs: 25, maxPollIntervalMs: 50, maxAwaitMs: 1_000, jitterRatio: 0 },
    worktree: { allowedBranchPrefixes: ["test/"] },
  },
};

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function tokens(byteCount) {
  return Math.ceil(byteCount / 4);
}

function percentageReduction(before, after) {
  return before === 0 ? 0 : (1 - after / before) * 100;
}

function fakeGhScript() {
  return `#!/bin/sh
counter=".dogfood-gh-count"
count=0
if [ -f "$counter" ]; then count=$(cat "$counter"); fi
count=$((count + 1))
printf '%s' "$count" > "$counter"
if [ "$count" -lt 3 ]; then
  printf '%s\\n' '{"statusCheckRollup":[{"name":"dogfood-check","status":"IN_PROGRESS","conclusion":null}]}'
else
  printf '%s\\n' '{"statusCheckRollup":[{"name":"dogfood-check","status":"COMPLETED","conclusion":"SUCCESS"}]}'
fi
`;
}

function createFixture() {
  const workspace = createWorkspace({
    extraFiles: {
      "verbose-success.mjs": `process.stdout.write(${JSON.stringify(successOutput)});\n`,
      "failure-fixture.mjs": `process.stdout.write(${JSON.stringify(failureOutput)}); process.exitCode = 1;\n`,
      "await-fixture.mjs": "setTimeout(() => console.log('await-terminal'), 80);\n",
      "large-source.ts": sourceText,
      "unchanged.txt": unchangedText,
      "burst-a.txt": `${burstText}unique-a\n`,
      "burst-b.txt": `${burstText}unique-b\n`,
      "burst-c.txt": `${burstText}unique-c\n`,
      "burst-d.txt": `${burstText}unique-d\n`,
      "fake-bin/gh": fakeGhScript(),
    },
  });
  writeConfig(workspace, JSON.stringify(config, null, 2));
  fs.chmodSync(path.join(workspace, "fake-bin", "gh"), 0o755);
  const telemetryPath = path.join(workspace, "telemetry-summary.json");
  const environment = {
    ...isolatedEnv(workspace),
    MOTTAINAI_TELEMETRY: "1",
    MOTTAINAI_TELEMETRY_FILE: telemetryPath,
    PATH: `${path.join(workspace, "fake-bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  return { workspace, telemetryPath, environment };
}

function launch(workspace, environment) {
  return McpStdioClient.launchNode(distEntry, { cwd: workspace, env: environment });
}

async function initialize(client) {
  const response = await client.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "context-runtime-dogfood", version: "1.0.0" },
  }, BLACKBOX_TIMEOUTS.request);
  assert.equal(response.error, undefined, `initialize failed: ${JSON.stringify(response.error)}`);
  client.notify("notifications/initialized", {});
  assert.deepEqual(client.stdoutPurityViolations(), []);
}

async function callTool(client, name, args) {
  const response = await client.request(
    "tools/call",
    { name, arguments: args },
    BLACKBOX_TIMEOUTS.request,
  );
  assert.equal(response.error, undefined, `${name} failed: ${JSON.stringify(response.error)}`);
  assert.ok(response.result !== undefined, `${name} returned no result`);
  assert.ok(response.result.structuredContent !== undefined, `${name} returned no structuredContent`);
  return response.result;
}

function structured(result) {
  return result.structuredContent;
}

function omissionReasons(result) {
  return (structured(result).projection?.omissions ?? []).map((entry) => entry.reason);
}

/**
 * Telemetry persistence is debounced (see PERSIST_DEBOUNCE_MS in
 * src/telemetry.ts) and writes asynchronously, so the file is polled with a
 * bounded retry instead of read exactly once immediately after the request
 * that should have triggered the final write.
 */
async function readPersistedTelemetry(telemetryPath) {
  const deadline = Date.now() + BLACKBOX_TIMEOUTS.request;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return fs.readFileSync(telemetryPath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, BLACKBOX_TIMEOUTS.statePoll));
    }
  }
  throw new Error(`telemetry summary file was never persisted at ${telemetryPath}: ${lastError}`);
}

function scenario(name, beforeBytes, afterValues, beforeCalls, afterCalls, expansions, notes) {
  const afterBytes = afterValues.reduce((total, value) => total + bytes(value), 0);
  return {
    scenario: name,
    before_visible_bytes: beforeBytes,
    after_visible_bytes: afterBytes,
    before_visible_tokens: tokens(beforeBytes),
    after_visible_tokens: tokens(afterBytes),
    reduction_percent: percentageReduction(beforeBytes, afterBytes),
    calls_before: beforeCalls,
    calls_after: afterCalls,
    expansions,
    retries_or_diagnostics: notes,
  };
}

function renderReport(report) {
  const rows = report.scenarios.map((entry) =>
    `| ${entry.scenario} | ${entry.before_visible_bytes} | ${entry.after_visible_bytes} | ${entry.before_visible_tokens} | ${entry.after_visible_tokens} | ${entry.reduction_percent.toFixed(1)}% | ${entry.calls_before}/${entry.calls_after} | ${entry.expansions} | ${entry.retries_or_diagnostics} |`,
  );
  const telemetry = report.telemetry;
  return `# Context Runtime dogfood report

測定日: ${report.measured_at}

## 判定方法

本レポートは、build済み \`dist/index.js\` を外部stdio MCP clientから起動する決定的シナリオの実測値。一次ゲートはagent-visible JSONのbytes、4 bytes/tokenの保守的推定、tool call数、expansion数、正確性・診断保持。elapsed timeは補助値。

Beforeは、2026-08-08に観測したpathologyを再現する「全raw/full-inline」または反復status応答の合成基準。モデル課金額・client内部cache/replayは測定していない。AfterはMCP応答のJSON bytes合計。

成功基準（測定前に固定）: verbose-success reduction >=${SUCCESS_THRESHOLDS.verboseReductionPercent}%、unchanged repeat reduction >=${SUCCESS_THRESHOLDS.unchangedReductionPercent}%、selected await/watchの反復外向き応答を0（await <=${SUCCESS_THRESHOLDS.maxWatchResponses} call）。

## Scenario results

| scenario | before visible bytes | after visible bytes | before visible tokens | after visible tokens | reduction | calls before/after | expansions | retries/diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}

## Telemetry evidence

\`MOTTAINAI_TELEMETRY=1\` のsummary toolとsummary fileから取得。本文・source・command・secretは記録されていない。

\`\`\`json
${JSON.stringify(telemetry, null, 2)}
\`\`\`

## 2026-08-08 observationsとの方向比較

- 大きなraw source/resultと成功burstは、projection/read governor/burstでagent-visible payloadを縮小し、full evidenceはresult_idから取得可能。
- source readの反復はdedupe hitでunchanged metadataへ縮小。
- status確認の外向き反復はselected gh awaitで内部pollへ移し、terminal/change時の1応答へ集約。bytesはpoll応答が単一のawait応答へ置き換わるため増加し得る（観測: 284→478 bytes）が、外向きcall数は4→1へ縮小する。
- したがって、観測されたall-raw、30–40KB burst、反復readという方向に対し、bytes/expansionの方向は逆。status pollの反復という方向に対しては、outward call数の方向が逆（bytesはscenario依存で増加する場合がある）。41 waitsと約5.15M wait直後input、43.15M cumulative model-input numberの再現は行わない。

## Counter-cost gate

- 明示的な \`result_get\` expansion は ${telemetry.expansion.count} 件で、自動retry・mandatory expansionは観測されなかった。expansion/retry rateがmaterially増加した場合は、enforceを一般defaultへ進める前にprojection/read policyの原因を特定・解決し、observe/warnへ戻す。
- この測定の \`enforce\` はisolated fixture設定のみ。一般defaultは変更していない。

## Privacy and correctness

- telemetry summaryにscenario本文、fixture source、raw command output、environment dump、credentialを含めないことをassert。
- failure scenarioはfailure classification、first cause、structured TAP failure、bounded diagnostic、result_idを保持。
- exact raw range、変更後dedupe miss、full result retrievalをassert。
`;
}

test(
  "Context Runtime dogfood: packaged stdio scenarios satisfy boundedness, correctness, and privacy thresholds",
  { timeout: 120_000 },
  async () => {
    assert.equal(fs.existsSync(distEntry), true, "dist is missing; run pnpm run build before pnpm run test:e2e");
    const fixture = createFixture();
    const client = launch(fixture.workspace, fixture.environment);
    try {
      await initialize(client);
      const tools = (await client.request("tools/list", {}, BLACKBOX_TIMEOUTS.request)).result.tools;
      const toolNames = new Set(tools.map((tool) => tool.name));
      for (const required of [
        "mottainai_exec", "mottainai_result_get", "mottainai_read", "mottainai_telemetry_summary",
        "mottainai_exec_start", "mottainai_exec_await", "mottainai_gh_checks_await",
      ]) assert.equal(toolNames.has(required), true, `${required} is not exposed by the packaged gateway`);

      const scenarios = [];

      const success = await callTool(client, "mottainai_exec", { command: "node verbose-success.mjs" });
      const successContent = structured(success);
      assert.equal(successContent.status, "success");
      assert.equal(successContent.test_results.total, 260);
      assert.equal(successContent.test_results.pass, 260);
      assert.equal(typeof successContent.result_id, "string");
      assert.ok(successContent.result_id.length > 0);
      assert.equal("output" in successContent, false);
      assert.ok(omissionReasons(success).some((reason) => /verbose successful output/i.test(reason)));
      const expanded = await callTool(client, "mottainai_result_get", { id: successContent.result_id, maxLines: 1 });
      assert.equal(structured(expanded).status, "success");
      assert.ok(JSON.stringify(expanded).includes("ok 1 - deterministic build fixture"), JSON.stringify(expanded).slice(0, 2_000));
      scenarios.push(scenario(
        "verbose success + explicit retrieval",
        Buffer.byteLength(successOutput, "utf8"),
        [success, expanded],
        1,
        2,
        1,
        "TAP success counts retained; full output omitted then retrieved",
      ));

      const broad = await callTool(client, "mottainai_read", { path: "large-source.ts", mode: "raw" });
      const broadContent = structured(broad);
      assert.equal(broadContent.status, "partial");
      assert.equal(broadContent.policy_action, "deny");
      assert.equal("text" in broadContent, false);
      assert.ok(Array.isArray(broadContent.next_actions) && broadContent.next_actions.length > 0);
      const exact = await callTool(client, "mottainai_read", {
        path: "large-source.ts", mode: "raw", startLine: 10, endLine: 18,
      });
      const exactContent = structured(exact);
      assert.equal(exactContent.status, "success");
      assert.match(exactContent.text, /sourceLine10/);
      assert.match(exactContent.text, /sourceLine18/);
      scenarios.push(scenario(
        "broad raw read denied + exact range allowed",
        Buffer.byteLength(sourceText, "utf8"),
        [broad, exact],
        1,
        2,
        0,
        "deny metadata/actionable next actions; exact lines remain usable",
      ));

      const burstResults = await Promise.all(["a", "b", "c", "d"].map((suffix) =>
        callTool(client, "mottainai_read", { path: `burst-${suffix}.txt`, mode: "raw", startLine: 1, endLine: 60 }),
      ));
      assert.equal(burstResults.length, 4);
      assert.ok(
        burstResults.some((result) => omissionReasons(result).some((reason) => /burst/i.test(reason))),
        JSON.stringify(burstResults.map((result) => structured(result))),
      );
      const burstVisibleBytes = burstResults.reduce((total, result) => total + bytes(result), 0);
      assert.ok(
        burstVisibleBytes <= config.gateway.burstBudget.rollingProjectedBytes,
        `burst visible bytes exceeded rolling byte budget: ${burstVisibleBytes}`,
      );
      scenarios.push(scenario(
        "four-call concurrent burst",
        Buffer.byteLength(burstText, "utf8") * 4,
        burstResults,
        4,
        4,
        0,
        "four parallel reads; at least one response reduced by burst_budget",
      ));

      const awaitStart = await callTool(client, "mottainai_exec_start", {
        command: "node await-fixture.mjs",
      });
      const handle = structured(awaitStart).handle;
      assert.equal(typeof handle, "string");
      const awaitResult = await callTool(client, "mottainai_exec_await", { handle, timeoutMs: 500 });
      assert.equal(structured(awaitResult).status, "success");
      assert.equal(typeof structured(awaitResult).result_id, "string");
      assert.ok(structured(awaitResult).result_id.length > 0);

      const watchResult = await callTool(client, "mottainai_gh_checks_await", { number: 76, timeoutMs: 800 });
      assert.equal(structured(watchResult).status, "success");
      assert.equal(structured(watchResult).terminal, true);
      const repeatedStatusBytes = bytes({ statusCheckRollup: [{ name: "dogfood-check", status: "IN_PROGRESS" }] });
      scenarios.push(
        scenario(
          "local start + await",
          bytes(awaitStart) + bytes(awaitResult),
          [awaitStart, awaitResult],
          2,
          2,
          0,
          "opaque handle plus one terminal await response",
        ),
        scenario(
          "provider watch replaces repeated status",
          repeatedStatusBytes * 4,
          [watchResult],
          4,
          1,
          0,
          "one await/watch response; internal polls replace four outward status responses",
        ),
      );

      // Reset the configured rolling burst window before measuring identity equality;
      // the dedupe comparison must not be confounded by an intentionally reduced projection.
      await new Promise((resolve) => setTimeout(resolve, config.gateway.burstBudget.rollingWindowMs + 100));
      const repeatRange = { path: "unchanged.txt", mode: "raw", startLine: 1, endLine: 40 };
      const firstRead = await callTool(client, "mottainai_read", repeatRange);
      const firstIdentity = structured(firstRead).identity;
      assert.equal(typeof firstIdentity?.id, "string");
      const unchanged = await callTool(client, "mottainai_read", { ...repeatRange, ifChangedFrom: firstIdentity.id });
      assert.equal(structured(unchanged).status, "unchanged", JSON.stringify({ first: structured(firstRead), second: structured(unchanged) }));
      assert.equal(structured(unchanged).identity.changed, false);
      assert.ok(bytes(unchanged) < bytes(firstRead) * 0.2);
      fs.writeFileSync(path.join(fixture.workspace, "unchanged.txt"), unchangedText.replace("unchanged-20-", "changed-20-"));
      const changed = await callTool(client, "mottainai_read", { ...repeatRange, ifChangedFrom: firstIdentity.id });
      assert.equal(structured(changed).status, "success");
      assert.equal(structured(changed).identity.changed, true);
      assert.notEqual(structured(changed).identity.content_id, firstIdentity.content_id);
      scenarios.push(
        scenario(
          "unchanged repeat",
          bytes(firstRead),
          [unchanged],
          1,
          1,
          0,
          "repeat transfer only; setup read and later change check are excluded from the threshold",
        ),
        scenario(
          "changed-content miss",
          bytes(firstRead),
          [changed],
          1,
          1,
          0,
          "changed file returns normal bounded content with a new identity",
        ),
      );

      const failure = await callTool(client, "mottainai_exec", { command: "node failure-fixture.mjs" });
      const failureContent = structured(failure);
      assert.equal(failureContent.status, "failed");
      assert.equal(typeof failureContent.failure_classification, "string", JSON.stringify(failureContent));
      assert.match(JSON.stringify(failureContent.diagnostics), /expected green build/);
      assert.equal(failureContent.test_results.fail, 1);
      assert.ok(failureContent.result_id.length > 0);
      assert.ok(bytes(failure) < Buffer.byteLength(failureOutput, "utf8") * 0.7);
      scenarios.push(scenario(
        "actionable failure diagnostics",
        Buffer.byteLength(failureOutput, "utf8"),
        [failure],
        1,
        1,
        0,
        "classification, first cause, TAP failure, bounded diagnostic, result_id retained",
      ));

      await new Promise((resolve) => setTimeout(resolve, config.gateway.burstBudget.rollingWindowMs + 100));
      const telemetryResult = await callTool(client, "mottainai_telemetry_summary", {});
      const telemetry = structured(telemetryResult);
      assert.equal(telemetry.enabled, true);
      assert.ok(telemetry.projection_totals.raw_bytes > 0, JSON.stringify(telemetry));
      assert.ok(telemetry.projection_totals.returned_bytes > 0);
      assert.ok(telemetry.projection_totals.omitted_bytes > 0);
      assert.ok(telemetry.projection_totals.omitted_tokens > 0);
      assert.equal(telemetry.expansion.count, 1);
      assert.ok(telemetry.read_governor.deny >= 1);
      assert.ok(telemetry.read_governor.raw_lines_returned > 0);
      assert.ok(telemetry.burst.responses_reduced >= 1);
      assert.ok(telemetry.await.poll_count >= 1);
      assert.ok(telemetry.await.avoided_responses >= 1);
      assert.ok(telemetry.dedupe.hits >= 1);
      assert.ok(telemetry.dedupe.misses >= 1);
      const privateOutput = `${DOGFOOD_MARKER} ${successOutput} ${failureOutput}`;
      const privateOutputMarker = privateOutput.slice(0, 80);
      const serializedTelemetryResult = JSON.stringify(telemetryResult);
      assert.equal(serializedTelemetryResult.includes(DOGFOOD_MARKER), false);
      assert.doesNotMatch(serializedTelemetryResult, /deterministic build fixture/);
      assert.doesNotMatch(serializedTelemetryResult, /diagnostic-1:/);
      assert.equal(JSON.stringify(telemetry).includes(privateOutputMarker), false);

      // The MCP response only proves the in-memory snapshot is bounded and
      // private; the persisted summary file is a separate write path (see
      // createTelemetrySink in src/telemetry.ts) and must be validated on
      // its own so a persistence-only aggregation or privacy defect cannot
      // pass undetected.
      const persistedRaw = await readPersistedTelemetry(fixture.telemetryPath);
      const persisted = JSON.parse(persistedRaw);
      assert.equal(persisted.enabled, true, "persisted telemetry summary must be enabled");
      assert.ok(persisted.projection.raw_bytes > 0, persistedRaw);
      assert.ok(persisted.projection.returned_bytes > 0);
      assert.ok(persisted.projection.omitted_bytes > 0);
      assert.ok(persisted.projection.omitted_tokens > 0);
      assert.equal(persisted.expansion.count, telemetry.expansion.count);
      assert.ok(persisted.read_governor.deny >= 1);
      assert.ok(persisted.read_governor.raw_lines_returned > 0);
      assert.ok(persisted.burst.responses_reduced >= 1);
      assert.ok(persisted.await.poll_count >= 1);
      assert.ok(persisted.await.avoided_responses >= 1);
      assert.ok(persisted.dedupe.hits >= 1);
      assert.ok(persisted.dedupe.misses >= 1);
      assert.equal(persistedRaw.includes(DOGFOOD_MARKER), false);
      assert.doesNotMatch(persistedRaw, /deterministic build fixture/);
      assert.doesNotMatch(persistedRaw, /diagnostic-1:/);
      assert.equal(persistedRaw.includes(privateOutputMarker), false);

      const report = {
        measured_at: new Date().toISOString(),
        scenarios,
        telemetry: {
          projection: telemetry.projection_totals,
          expansion: telemetry.expansion,
          read_governor: telemetry.read_governor,
          burst: telemetry.burst,
          await: telemetry.await,
          dedupe: telemetry.dedupe,
          totals: telemetry.totals,
        },
      };
      const reportPath = process.env.MOTTAINAI_DOGFOOD_REPORT;
      if (reportPath !== undefined) {
        fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
        fs.writeFileSync(path.resolve(reportPath), renderReport(report));
      }
      assert.ok(
        scenarios.find((entry) => entry.scenario === "verbose success + explicit retrieval").reduction_percent >=
          SUCCESS_THRESHOLDS.verboseReductionPercent,
      );
      assert.ok(
        scenarios.find((entry) => entry.scenario === "unchanged repeat").reduction_percent >=
          SUCCESS_THRESHOLDS.unchangedReductionPercent,
      );
      assert.ok(
        scenarios.find((entry) => entry.scenario === "provider watch replaces repeated status").calls_after <=
          SUCCESS_THRESHOLDS.maxWatchResponses,
      );
      await client.closeGracefully(BLACKBOX_TIMEOUTS.shutdown);
    } finally {
      await cleanupClient(client, fixture.workspace);
    }
  },
);
