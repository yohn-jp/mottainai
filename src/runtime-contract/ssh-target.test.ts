import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  SshCommandAdapter,
  SshTargetError,
  SshTargetRegistry,
  SshTransportError,
  SSH_TARGET_CONTRACT_ID,
  SSH_TARGET_SCHEMA_VERSION,
  canonicalSshTargetRegistryText,
  readSshTargetRegistry,
  writeSshTargetRegistry,
} from "./ssh-target.js";
import type { RunResult } from "../subprocess.js";

const NOW = "2026-09-04T00:00:00.000Z";
const FINGERPRINT = "SHA256:first-host-key";

function harness(): { root: string; filePath: string; registry: SshTargetRegistry } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-ssh-target-test-"));
  const filePath = path.join(root, "control", "ssh-targets", "registry.json");
  const registry = new SshTargetRegistry({ filePath, now: () => new Date(NOW) });
  return { root, filePath, registry };
}

function closeHarness(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function register(registry: SshTargetRegistry, fingerprint = FINGERPRINT): void {
  registry.register({
    targetId: "target-a",
    hostname: "runtime.example.test",
    port: 22,
    user: "mottainai",
    hostKeyFingerprint: fingerprint,
    trustAction: "explicit",
  });
}

function success(stdout = "ok"): RunResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimit: false };
}

test("first-use trust is explicit and repeat connection requires the persisted host key", () => {
  const h = harness();
  try {
    assert.throws(
      () =>
        h.registry.register({
          targetId: "target-a",
          hostname: "runtime.example.test",
          port: 22,
          user: "mottainai",
          hostKeyFingerprint: FINGERPRINT,
          trustAction: "implicit" as "explicit",
        }),
      (error: unknown) => error instanceof SshTargetError && error.code === "trust_required",
    );
    register(h.registry);
    const verified = h.registry.verifyConnection("target-a", { observedHostKeyFingerprint: FINGERPRINT });
    assert.equal(verified.hostname, "runtime.example.test");
    assert.throws(
      () => h.registry.verifyConnection("target-a", { observedHostKeyFingerprint: "SHA256:changed" }),
      (error: unknown) => error instanceof SshTargetError && error.code === "host-key-mismatch",
    );
  } finally {
    closeHarness(h.root);
  }
});

test("Runtime identity is independent from transport and address reuse by a foreign Runtime fails closed", () => {
  const h = harness();
  try {
    register(h.registry);
    const originalConnectionId = h.registry.list()[0]?.connectionId;
    h.registry.bindRuntimeIdentity("target-a", "runtime-one", true);
    assert.throws(
      () =>
        h.registry.verifyConnection("target-a", {
          observedHostKeyFingerprint: FINGERPRINT,
          observedRuntimeIdentity: "runtime-foreign",
        }),
      (error: unknown) => error instanceof SshTargetError && error.code === "runtime-identity-mismatch",
    );
    assert.throws(
      () =>
        h.registry.rebind({
          targetId: "target-a",
          hostname: "new-address.example.test",
          port: 2222,
          user: "remote",
          hostKeyFingerprint: "SHA256:new-host-key",
          trustAction: "explicit",
          expectedRuntimeIdentity: "runtime-one",
          independentlyVerifiedRuntimeIdentity: "runtime-foreign",
        }),
      (error: unknown) => error instanceof SshTargetError && error.code === "runtime-identity-mismatch",
    );
    const rebound = h.registry.rebind({
      targetId: "target-a",
      hostname: "new-address.example.test",
      port: 2222,
      user: "remote",
      hostKeyFingerprint: "SHA256:new-host-key",
      trustAction: "explicit",
      expectedRuntimeIdentity: "runtime-one",
      independentlyVerifiedRuntimeIdentity: "runtime-one",
    });
    assert.equal(rebound.runtimeIdentity, "runtime-one");
    assert.equal(rebound.hostname, "new-address.example.test");
    assert.notEqual(rebound.connectionId, originalConnectionId);
  } finally {
    closeHarness(h.root);
  }
});

test("restart/reload preserves trusted records, while malformed state fails closed", () => {
  const h = harness();
  try {
    register(h.registry);
    const reloaded = new SshTargetRegistry({ filePath: h.filePath, now: () => new Date(NOW) });
    assert.equal(reloaded.list()[0]?.hostKeyFingerprint, FINGERPRINT);
    const status = reloaded.status()[0];
    assert.ok(status);
    assert.equal("privateKey" in status, false);
    assert.equal("agentSecret" in status, false);
    fs.writeFileSync(h.filePath, "{broken");
    assert.throws(
      () => new SshTargetRegistry({ filePath: h.filePath }),
      (error: unknown) => error instanceof SshTargetError && error.code === "state_corrupt",
    );
  } finally {
    closeHarness(h.root);
  }
});

test("registry schema is versioned, canonical, atomic, and rejects private-key-shaped fields", () => {
  const h = harness();
  try {
    register(h.registry);
    const state = h.registry.snapshot();
    assert.equal(state.contractId, SSH_TARGET_CONTRACT_ID);
    assert.equal(state.schemaVersion, SSH_TARGET_SCHEMA_VERSION);
    assert.match(canonicalSshTargetRegistryText(state), /"contractId":"mottainai\.ssh-target-registry\.v1"/u);
    assert.throws(
      () => writeSshTargetRegistry(h.filePath, { ...state, privateKey: "secret" } as never),
      SshTargetError,
    );
    const persisted = readSshTargetRegistry(h.filePath);
    assert.deepEqual(persisted, state);
  } finally {
    closeHarness(h.root);
  }
});

test("SSH adapter invokes argv-safe, bounded, finite process and returns connection evidence", async () => {
  const h = harness();
  try {
    register(h.registry);
    const calls: Array<{ args: readonly string[]; cwd: string; timeoutMs: number; maxOutputBytes: number }> = [];
    const adapter = new SshCommandAdapter({
      registry: h.registry,
      cwd: h.root,
      timeoutMs: 1234,
      maxOutputBytes: 4096,
      knownHostsFile: path.join(h.root, "known_hosts"),
      run: async (args, cwd, timeoutMs, maxOutputBytes) => {
        calls.push({ args, cwd, timeoutMs, maxOutputBytes });
        return success("remote-result");
      },
    });
    const result = await adapter.execute({
      targetId: "target-a",
      observedHostKeyFingerprint: FINGERPRINT,
      command: ["printf", "$HOME; rm -rf /"],
    });
    assert.equal(result.stdout, "remote-result");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${path.join(h.root, "known_hosts")}`,
      "-p",
      "22",
      "--",
      "mottainai@runtime.example.test",
      "printf",
      "$HOME; rm -rf /",
    ]);
    assert.equal(calls[0]?.timeoutMs, 1234);
    assert.equal(calls[0]?.maxOutputBytes, 4096);
  } finally {
    closeHarness(h.root);
  }
});

test("SSH adapter classifies timeout, authentication, unreachable, and host-key failures", async () => {
  const h = harness();
  try {
    register(h.registry);
    const runWith = (result: RunResult) =>
      new SshCommandAdapter({ registry: h.registry, cwd: h.root, run: async () => result }).execute({
        targetId: "target-a",
        observedHostKeyFingerprint: FINGERPRINT,
        command: ["true"],
      });
    await assert.rejects(
      runWith({ ...success(), timedOut: true }),
      (error: unknown) => error instanceof SshTransportError && error.code === "timeout",
    );
    await assert.rejects(
      runWith({ ...success(), exitCode: 255, stderr: "Permission denied (publickey)." }),
      (error: unknown) => error instanceof SshTransportError && error.code === "authentication",
    );
    await assert.rejects(
      runWith({ ...success(), exitCode: 255, stderr: "Could not resolve hostname" }),
      (error: unknown) => error instanceof SshTransportError && error.code === "unreachable",
    );
    await assert.rejects(
      runWith({ ...success(), exitCode: 255, stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED" }),
      (error: unknown) => error instanceof SshTransportError && error.code === "host-key-mismatch",
    );
  } finally {
    closeHarness(h.root);
  }
});
