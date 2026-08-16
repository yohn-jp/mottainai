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
    "#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==='--version'){console.log('zellij 0.44.0');process.exit(0)} if(args[0]==='list-sessions'){process.exit(0)} process.exit(0);\n",
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
  assert.equal(health.zellij.version, "zellij 0.44.0");

  const piResponse = await fetch(`${url}api/v1/manager/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentKind: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4",
      instruction: "hermetic Pi process",
    }),
  });
  assert.equal(piResponse.status, 201);
  const piSession = (await piResponse.json()).session as {
    agentKind: string;
    launchProfile: string;
    provider: string;
    launchCommand: string;
    launchArgs: string[];
  };
  assert.equal(piSession.agentKind, "pi");
  assert.equal(piSession.launchProfile, "pi");
  assert.equal(piSession.provider, "anthropic");
  assert.equal(piSession.launchCommand, "pi");
  const guardIndex = piSession.launchArgs.indexOf("--extension");
  assert.ok(guardIndex >= 0);
  assert.deepEqual(piSession.launchArgs.slice(0, guardIndex), [
    "--provider",
    "anthropic",
    "--model",
    "claude-sonnet-4",
  ]);
  assert.equal(piSession.launchArgs[guardIndex + 1], path.join(repositoryRoot, "src", "manager", "pi-guard.ts"));
  assert.deepEqual(piSession.launchArgs.slice(guardIndex + 2), ["--", "hermetic Pi process"]);
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
});
