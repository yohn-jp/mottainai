import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entryPoint = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

test("early public CLI failure includes bounded runtime identity without stdout output", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-cli-runtime-"));
  const configPath = path.join(workspace, "missing.json");
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint], {
      cwd: path.resolve(path.dirname(entryPoint), ".."),
      env: { ...process.env, HOME: workspace, USERPROFILE: workspace, MOTTAINAI_CONFIG: configPath },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Mottainai configuration was not found/);
    assert.match(result.stderr, /Runtime diagnostic:/);
    assert.match(result.stderr, /package: mottainai@/);
    assert.match(result.stderr, /distribution: development\/source/);
    assert.match(result.stderr, /config_path: .*missing\.json/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
