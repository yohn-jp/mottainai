import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceEntry = path.join(repoRoot, "src", "index.ts");

function runHook(workspace: string, client: "claude" | "codex", payload: unknown) {
  return spawnSync(process.execPath, ["--import", "tsx", sourceEntry, "hooks", "dispatch", "--client", client, "--workspace", workspace], {
    cwd: repoRoot,
    env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("black-box Claude and Codex hook commands enforce the same process boundary", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-hooks-e2e-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.mkdirSync(path.join(workspace, ".mottainai"));
  fs.writeFileSync(path.join(workspace, ".mottainai", "hooks.json"), JSON.stringify({
    version: 1,
    mode: "enforce",
    operationModes: {},
    failureModes: { other: "open" },
    timeoutMs: 1000,
    maxOutputBytes: 512,
  }));
  const payloads = ["cat file", "python -c 'open(\"file\").read()'", "/bin/node -e readFileSync()"];
  for (const client of ["claude", "codex"] as const) {
    for (const command of payloads) {
      const result = runHook(workspace, client, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(result.status, 2, `${client} ${command}: ${result.stderr}`);
      assert.equal(result.error, undefined);
      assert.match(`${result.stdout}${result.stderr}`, /managed_capability_available/);
      assert.ok(Buffer.byteLength(`${result.stdout}${result.stderr}`, "utf8") <= 512);
    }
  }
});
