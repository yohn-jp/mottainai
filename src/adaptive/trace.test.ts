import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TRACE_SCHEMA_VERSION, createTraceStore } from "./trace.js";

function temporaryDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-trace-")), "trace");
}

async function seed(directory: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const store = createTraceStore({ MOTTAINAI_TRACE_DIR: directory, ...extraEnv });
  const request = await store.beginRequest({
    task_category: "bug_investigation",
    task_intent: "locate_root_cause",
    task_confidence: 0.8,
    caller_requested_capabilities: ["definitions"],
    planned_capabilities: ["definitions", "callers"],
    added_by_policy: ["callers"],
    suppressed_by_policy: [],
    policy_version: "builtin-1",
    context: "compression drops diagnostics lines",
  });
  await store.recordExecution({
    request_id: request.request_id, provider: "codegraph", tool: "codegraph__explore", capability: "callers",
    duration_ms: 12, result_count: 3, output_size: 900, status: "success",
  });
  return { store, request };
}

test("a request, its executions and its review fold into one trace", async () => {
  const directory = temporaryDir();
  const { store, request } = await seed(directory);

  assert.equal(await store.recordReview({
    request_id: request.request_id, expected_found: true, sufficient: false, usefulness: 4,
    missing_capabilities: ["ownership"], unexpected_noise: ["generated_files"],
    follow_up_requested: true, next_capabilities: ["ownership"],
  }), "recorded");

  const traces = store.load();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].executions.length, 1);
  assert.equal(traces[0].review?.usefulness, 4);
  assert.deepEqual(traces[0].review?.missing_capabilities, ["ownership"]);
  const executionId = traces[0].executions[0].execution_id;
  assert.equal(await store.recordExecutionReview({
    request_id: request.request_id, execution_id: executionId, useful: true,
    sufficient_for_capability: false, expected_found: true, missing_capabilities: [], unexpected_noise: [],
  }), "recorded");
  assert.equal(store.load()[0].execution_reviews?.[0].execution_id, executionId);
});

test("review for an unknown request_id is rejected instead of creating a trace", async () => {
  const directory = temporaryDir();
  const { store } = await seed(directory);
  const result = await store.recordReview({
    request_id: "rq_missing", expected_found: true, sufficient: true,
    missing_capabilities: [], unexpected_noise: [], follow_up_requested: false, next_capabilities: [],
  });
  assert.equal(result, "unknown_request");
  assert.equal(store.load({ requestId: "rq_missing" }).length, 0);
});

test("caller context is stored as a digest unless raw retention is enabled", async () => {
  const withoutRaw = temporaryDir();
  const { store: defaultStore, request } = await seed(withoutRaw);
  const stored = defaultStore.load({ requestId: request.request_id })[0];
  assert.equal(stored.request.context, undefined);
  assert.equal(typeof stored.request.context_digest, "string");
  assert.equal(stored.request.context_length, "compression drops diagnostics lines".length);

  const withRaw = temporaryDir();
  const { store: rawStore, request: rawRequest } = await seed(withRaw, { MOTTAINAI_TRACE_RAW: "1" });
  assert.equal(rawStore.load({ requestId: rawRequest.request_id })[0].request.context, "compression drops diagnostics lines");
});

test("traces survive a new store over the same directory", async () => {
  const directory = temporaryDir();
  const { request } = await seed(directory);
  const reopened = createTraceStore({ MOTTAINAI_TRACE_DIR: directory });
  assert.equal(reopened.knowsRequest(request.request_id), true);
  assert.equal(await reopened.recordReview({
    request_id: request.request_id, expected_found: false, sufficient: false,
    missing_capabilities: ["tests"], unexpected_noise: [], follow_up_requested: false, next_capabilities: [],
  }), "recorded");
  assert.equal(reopened.load({ reviewedOnly: true }).length, 1);
});

test("disabled tracing still issues request ids but writes nothing", async () => {
  const directory = temporaryDir();
  const store = createTraceStore({ MOTTAINAI_TRACE_DIR: directory, MOTTAINAI_TRACE: "0" });
  const request = await store.beginRequest({
    task_category: "symbol_lookup", caller_requested_capabilities: [], planned_capabilities: [], policy_version: "builtin-1",
  });
  assert.match(request.request_id, /^rq_[0-9a-f]{16}$/);
  assert.equal(store.enabled, false);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(store.load(), []);
});

test("the trace directory is not created until something is recorded", () => {
  const directory = temporaryDir();
  const store = createTraceStore({ MOTTAINAI_TRACE_DIR: directory });
  assert.equal(store.enabled, true);
  assert.equal(fs.existsSync(directory), false);
});

test("filters select by category, review state and time", async () => {
  const directory = temporaryDir();
  const { store, request } = await seed(directory);
  await store.beginRequest({
    task_category: "symbol_lookup", caller_requested_capabilities: ["definitions"], planned_capabilities: ["definitions"], policy_version: "builtin-1",
  });

  assert.equal(store.load({ taskCategory: "symbol_lookup" }).length, 1);
  assert.equal(store.load({ reviewedOnly: true }).length, 0);
  assert.equal(store.load({ since: Date.now() + 60_000 }).length, 0);
  assert.equal(store.load({ requestId: request.request_id })[0].request.task_intent, "locate_root_cause");
});

test("corrupt lines do not discard the rest of the file", async () => {
  const directory = temporaryDir();
  const { store } = await seed(directory);
  const file = fs.readdirSync(directory).find((name) => name.endsWith(".jsonl"))!;
  fs.appendFileSync(path.join(directory, file), "{ truncated json\n");
  assert.equal(store.load().length, 1);
});

test("new records carry the current schema version, caller intent stays separate from the plan, and executions get a stable id", async () => {
  const directory = temporaryDir();
  const { store, request } = await seed(directory);
  const trace = store.load({ requestId: request.request_id })[0];

  assert.equal(trace.request.schema_version, TRACE_SCHEMA_VERSION);
  assert.deepEqual(trace.request.caller_requested_capabilities, ["definitions"]);
  assert.deepEqual(trace.request.planned_capabilities, ["definitions", "callers"]);
  assert.deepEqual(trace.request.added_by_policy, ["callers"]);
  assert.deepEqual(trace.request.suppressed_by_policy, []);
  assert.equal(trace.executions[0].schema_version, TRACE_SCHEMA_VERSION);
  assert.match(trace.executions[0].execution_id, /^ex_[0-9a-f]{16}$/);
});

test("legacy records without schema_version are migrated on read instead of dropped", async () => {
  const directory = temporaryDir();
  fs.mkdirSync(directory, { recursive: true });
  const legacyRequest = {
    type: "request", request_id: "rq_legacy00000000", timestamp: "2026-01-01T00:00:00.000Z",
    task_category: "bug_investigation", requested_capabilities: ["definitions", "callers"], policy_version: "builtin-1",
  };
  const legacyExecution = {
    type: "execution", request_id: "rq_legacy00000000", timestamp: "2026-01-01T00:00:01.000Z",
    provider: "codegraph", tool: "codegraph__explore", capability: "callers",
    duration_ms: 5, result_count: 0, output_size: 0, status: "skipped",
  };
  fs.writeFileSync(path.join(directory, "legacy.jsonl"), `${JSON.stringify(legacyRequest)}\n${JSON.stringify(legacyExecution)}\n`);

  const store = createTraceStore({ MOTTAINAI_TRACE_DIR: directory });
  const trace = store.load({ requestId: "rq_legacy00000000" })[0];

  assert.equal(trace.request.schema_version, 0);
  // 旧形式は呼び出し側の元意図を区別して保存していなかった。best-effort で解決済みプラン
  // をそのまま両方の値として扱う（policy の寄与は不明のため 0 件とみなす）。
  assert.deepEqual(trace.request.caller_requested_capabilities, ["definitions", "callers"]);
  assert.deepEqual(trace.request.planned_capabilities, ["definitions", "callers"]);
  assert.deepEqual(trace.request.added_by_policy, []);
  assert.equal(trace.executions[0].status, "unavailable");
  assert.match(trace.executions[0].execution_id, /^ex_legacy_[0-9a-f]{12}$/);

  const reloaded = store.load({ requestId: "rq_legacy00000000" })[0];
  assert.equal(reloaded.executions[0].execution_id, trace.executions[0].execution_id);
});
