import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createTempDir } from "../test-support/tmp-dir.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("mottainai manager starts a loopback endpoint and reports the Zellij runtime", async (t) => {
  const temporary = createTempDir(t, "mottainai-manager-cli-");
  const fakeZellij = path.join(temporary, "zellij");
  fs.writeFileSync(
    fakeZellij,
    "#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==='--version'){console.log('zellij fake-0.1');process.exit(0)} if(args[0]==='list-sessions'){process.exit(0)} process.exit(0);\n",
    { mode: 0o755 },
  );
  fs.chmodSync(fakeZellij, 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "manager", "--no-open", "--port", "0"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MOTTAINAI_ZELLIJ_BINARY: fakeZellij,
      MOTTAINAI_STATE_DIR: temporary,
      MOTTAINAI_DASHBOARD_PROVIDER: "fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/Mottainai manager listening at (http:\/\/127\.0\.0\.1:\d+\/)/u);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`manager exited before ready: ${code}\n${stderr}`)));
  });
  const url = await ready;
  const response = await fetch(`${url}api/v1/manager/health`);
  assert.equal(response.status, 200);
  const health = (await response.json()) as { manager: string; zellij: { available: boolean; version: string } };
  assert.equal(health.manager, "ready");
  assert.equal(health.zellij.available, true);
  assert.equal(health.zellij.version, "zellij fake-0.1");
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
});
