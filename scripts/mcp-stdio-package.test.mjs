// Issue #22 package-compatible subset。full protocol/fault suiteは built dist suite にあり、
// ここでは npm pack artifact の bin/runtime 解決と最小 MCP handshake を確認する。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupClient, createWorkspace, INITIALIZE_PARAMS, isolatedEnv } from "./lib/mcp-blackbox-test-support.mjs";
import { BLACKBOX_TIMEOUTS } from "./lib/mcp-blackbox-timeouts.mjs";
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
  if (!fs.existsSync(distEntry)) throw new Error("dist is missing; run pnpm run build before pnpm run test:package");
  const suppliedTarball = process.env.MOTTAINAI_PACKAGE_TARBALL;
  distMtimeBeforePack = Number(process.env.MOTTAINAI_DIST_MTIME ?? fs.statSync(distEntry).mtimeMs);
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-package-e2e-"));
  const packed = suppliedTarball === undefined ? packRepository(repoRoot, suiteRoot) : undefined;
  const tarballPath = packed?.tarballPath ?? path.resolve(suppliedTarball);
  packedFiles = packed?.packedFiles ?? JSON.parse(process.env.MOTTAINAI_PACKED_FILES ?? "[]");
  if (!fs.existsSync(tarballPath)) throw new Error(`package tarball is missing: ${tarballPath}`);
  const extracted = extractTarball(tarballPath, path.join(suiteRoot, "extracted"));
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

test(
  "pack and extract helpers preserve paths containing spaces",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const spacedRoot = path.join(suiteRoot, "temporary package root");
    fs.mkdirSync(spacedRoot, { recursive: true });
    const packed = packRepository(repoRoot, spacedRoot);
    const extracted = extractTarball(packed.tarballPath, path.join(spacedRoot, "extracted package"));
    linkDependencies(extracted, repoRoot);
    const spacedBinPath = resolvePackagedBin(extracted);
    const workspace = createWorkspace();
    const client = McpStdioClient.launchPackaged(spacedBinPath, { cwd: workspace, env: isolatedEnv(workspace) });
    try {
      const response = await client.request("initialize", INITIALIZE_PARAMS, BLACKBOX_TIMEOUTS.request);
      assert.equal(response.error, undefined);
      assert.deepEqual(client.stdoutPurityViolations(), []);
      const exitInfo = await client.closeGracefully(BLACKBOX_TIMEOUTS.shutdown);
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);

test(
  "packed artifact serves a minimal MCP handshake, list, call, and EOF shutdown",
  { timeout: BLACKBOX_TIMEOUTS.test },
  async () => {
    const workspace = createWorkspace();
    const client = McpStdioClient.launchPackaged(binPath, { cwd: workspace, env: isolatedEnv(workspace) });
    try {
      const initializeResponse = await client.request("initialize", INITIALIZE_PARAMS, BLACKBOX_TIMEOUTS.request);
      assert.equal(initializeResponse.error, undefined);
      client.notify("notifications/initialized", {});
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const listResponse = await client.request("tools/list", {}, BLACKBOX_TIMEOUTS.request);
      assert.equal(listResponse.error, undefined);
      assert.ok(listResponse.result.tools.some((tool) => tool.name === "mottainai_list"));
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const callResponse = await client.request(
        "tools/call",
        { name: "mottainai_list", arguments: {} },
        BLACKBOX_TIMEOUTS.request,
      );
      assert.equal(callResponse.error, undefined);
      assert.equal(callResponse.result.structuredContent.status, "success");
      assert.deepEqual(client.stdoutPurityViolations(), []);

      const exitInfo = await client.closeGracefully(BLACKBOX_TIMEOUTS.shutdown);
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);
      assert.deepEqual(client.stdoutPurityViolations(), []);
    } finally {
      await cleanupClient(client, workspace);
    }
  },
);
