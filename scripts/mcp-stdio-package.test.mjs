// Issue #22 package-compatible subset。full protocol/fault suiteは built dist suite にあり、
// ここでは npm pack artifact の bin/runtime 解決と最小 MCP handshake を確認する。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupClient, createWorkspace, INITIALIZE_PARAMS, isolatedEnv } from "./lib/mcp-blackbox-test-support.mjs";
import {
  extractTarball,
  linkDependencies,
  McpStdioClient,
  packRepository,
  resolvePackagedBin,
} from "./lib/mcp-blackbox-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let suiteRoot;
let binPath;
let packedFiles;
let distMtimeBeforePack;

before(() => {
  const distEntry = path.join(repoRoot, "dist", "index.js");
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before pnpm run e2e:package");
  distMtimeBeforePack = fs.statSync(distEntry).mtimeMs;
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-package-e2e-"));
  const packed = packRepository(repoRoot, suiteRoot);
  packedFiles = packed.packedFiles;
  const extracted = extractTarball(packed.tarballPath, path.join(suiteRoot, "extracted"));
  linkDependencies(extracted, repoRoot);
  binPath = resolvePackagedBin(extracted);
});

after(() => {
  if (suiteRoot !== undefined) fs.rmSync(suiteRoot, { recursive: true, force: true });
});

test("packed artifact contains its declared runtime entry and pack does not rebuild dist", () => {
  assert.ok(packedFiles.includes("package.json"));
  assert.ok(packedFiles.includes("dist/index.js"));
  assert.equal(fs.statSync(path.join(repoRoot, "dist", "index.js")).mtimeMs, distMtimeBeforePack);
});

test("packed artifact serves a minimal MCP handshake, list, call, and EOF shutdown", { timeout: 20_000 }, async () => {
  const workspace = createWorkspace();
  const client = McpStdioClient.launchPackaged(binPath, { cwd: workspace, env: isolatedEnv(workspace) });
  try {
    const initializeResponse = await client.request("initialize", INITIALIZE_PARAMS, 3_000);
    assert.equal(initializeResponse.error, undefined);
    client.notify("notifications/initialized", {});

    const listResponse = await client.request("tools/list", {}, 3_000);
    assert.equal(listResponse.error, undefined);
    assert.ok(listResponse.result.tools.some((tool) => tool.name === "mottainai_list"));

    const callResponse = await client.request("tools/call", { name: "mottainai_list", arguments: {} }, 3_000);
    assert.equal(callResponse.error, undefined);
    assert.equal(callResponse.result.structuredContent.status, "success");

    const exitInfo = await client.closeGracefully(5_000);
    assert.equal(exitInfo.code, 0);
    assert.equal(exitInfo.signal, null);
    assert.deepEqual(client.stdoutPurityViolations(), []);
  } finally {
    await cleanupClient(client, workspace);
  }
});
