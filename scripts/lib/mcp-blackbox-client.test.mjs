import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { cleanupClient, createWorkspace, isolatedEnv } from "./mcp-blackbox-test-support.mjs";
import { MAX_STDERR_TAIL_BYTES, McpStdioClient } from "./mcp-blackbox-client.mjs";
import { BLACKBOX_TIMEOUTS } from "./mcp-blackbox-timeouts.mjs";

function fixturePath(workspace) {
  return path.join(workspace, "child.mjs");
}

function launchFixture(source) {
  const workspace = createWorkspace({ config: null, extraFiles: { "child.mjs": source } });
  const client = McpStdioClient.launchNode(fixturePath(workspace), {
    cwd: workspace,
    env: isolatedEnv(workspace),
  });
  return { client, workspace };
}

test("harness retains a blank stdout line as a protocol violation", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const { client, workspace } = launchFixture("process.stdout.write('\\n'); process.exit(0);\n");
  try {
    await client.waitForExit(BLACKBOX_TIMEOUTS.processStartup);
    assert.deepEqual(client.stdoutLines, [""]);
    assert.deepEqual(client.stdoutPurityViolations(), [""]);
  } finally {
    await cleanupClient(client, workspace);
  }
});

test(
  "harness retains a final non-newline stdout fragment after close",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const { client, workspace } = launchFixture("process.stdout.write('fragment'); process.exit(0);\n");
    try {
      await client.waitForExit(BLACKBOX_TIMEOUTS.processStartup);
      assert.deepEqual(client.stdoutLines, ["fragment"]);
      assert.deepEqual(client.stdoutPurityViolations(), ["fragment"]);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test("harness timeout diagnostics include bounded process context", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const { client, workspace } = launchFixture("process.stdin.resume(); setInterval(() => {}, 1_000);\n");
  try {
    await assert.rejects(client.request("fixture/never", {}, 100), (error) => {
      assert.match(error.message, /operation=fixture\/never/);
      assert.match(error.message, /method=fixture\/never/);
      assert.match(error.message, /request_id=1/);
      assert.match(error.message, /exited=false/);
      assert.match(error.message, /stderr_tail=/);
      assert.match(error.message, /stdout_transcript=/);
      return true;
    });
  } finally {
    client.forceKill();
    await cleanupClient(client, workspace);
  }
});

test("harness reports a child exit before its response", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const { client, workspace } = launchFixture("process.exit(17);\n");
  try {
    await assert.rejects(client.request("fixture/exit", {}, BLACKBOX_TIMEOUTS.request), (error) => {
      assert.match(error.message, /process exited/);
      assert.match(error.message, /request_id=1/);
      assert.match(error.message, /exit_code=17/);
      return true;
    });
  } finally {
    await cleanupClient(client, workspace);
  }
});

test(
  "harness bounds the captured stderr tail while draining the stream",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const { client, workspace } = launchFixture(
      "process.stderr.write('x'.repeat(64 * 1024) + 'stderr-tail-marker'); process.exit(0);\n",
    );
    try {
      await client.waitForExit(BLACKBOX_TIMEOUTS.processStartup);
      assert.ok(client.stderrBytes > MAX_STDERR_TAIL_BYTES);
      assert.ok(Buffer.byteLength(client.stderrText()) <= MAX_STDERR_TAIL_BYTES);
      assert.match(client.stderrText(), /stderr-tail-marker/);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test("harness parses a response split across stdout chunks", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const { client, workspace } = launchFixture(
    'process.stdout.write(\'{"jsonrpc":"2.0","id":1,\'); setImmediate(() => { process.stdout.write(\'"result":{"ok":true}}\\n\'); process.exit(0); });\n',
  );
  try {
    const pending = client.prepareRequest("fixture/partial", {}, BLACKBOX_TIMEOUTS.request);
    const response = await pending.response;
    assert.deepEqual(response.result, { ok: true });
    await client.waitForExit(BLACKBOX_TIMEOUTS.processStartup);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(client, workspace);
  }
});

test("harness forced cleanup terminates a stubborn child", { timeout: BLACKBOX_TIMEOUTS.test }, async () => {
  const { client, workspace } = launchFixture("process.stdin.resume(); setInterval(() => {}, 1_000);\n");
  try {
    client.forceKill();
    const exitInfo = await client.waitForExit(BLACKBOX_TIMEOUTS.forcedCleanup);
    assert.ok(exitInfo.code !== undefined || exitInfo.signal !== undefined);
  } finally {
    await cleanupClient(client, workspace);
  }
});
