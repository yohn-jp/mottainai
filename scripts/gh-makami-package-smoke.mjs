import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDirectory = process.argv[2];
if (packageDirectory === undefined) throw new Error("installed Mottainai package directory is required");

const { GhMakamiClient, GH_MAKAMI_MACHINE_CONTRACT, GH_MAKAMI_REQUIRED_CAPABILITIES, GH_MAKAMI_SUPPORTED_OPERATIONS } =
  await import(pathToFileURL(path.join(packageDirectory, "dist", "gh-makami.js")).href);

const repository = "packed/example";
const headSha = "b".repeat(40);
const generation = { repository, prNumber: 9, headSha };
const contract = {
  identifier: GH_MAKAMI_MACHINE_CONTRACT,
  package: { name: "gh-makami", version: "0.1.0" },
  capabilities: GH_MAKAMI_REQUIRED_CAPABILITIES.map((id) => ({ id, version: 0, stability: "stable" })),
};

function fakeExecutable({ contractPayload = contract, timeout = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-makami-package-smoke-"));
  const executable = path.join(directory, "gh-makami");
  const source = `
if (process.argv.includes("--contract")) process.stdout.write(${JSON.stringify(JSON.stringify(contractPayload))});
else if (${timeout ? "true" : "false"}) setTimeout(() => undefined, 10_000);
else if (process.argv[2] === "status") process.stdout.write(${JSON.stringify(JSON.stringify({ generation, state: "open" }))});
else if (process.argv[2] === "reconcile") process.stdout.write(${JSON.stringify(
    JSON.stringify({
      kind: "unchanged",
      changed: false,
      generation,
      changes: [],
    }),
  )});
else if (process.argv[2] === "await") process.stdout.write(${JSON.stringify(
    JSON.stringify({
      kind: "unchanged",
      changed: false,
      generation,
      changes: [],
    }),
  )});
else process.exitCode = 2;
`;
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable };
}

const startingSnapshot = { repository, prNumber: 9, generation, headSha };
const fake = fakeExecutable();
try {
  assert.deepEqual([...GH_MAKAMI_SUPPORTED_OPERATIONS], ["status", "reconcile", "await"]);
  const client = new GhMakamiClient({ command: fake.executable, cwd: packageDirectory });

  const capabilities = await client.checkCapabilities();
  assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
  const status = await client.status({ repository, prNumber: 9 });
  assert.equal(status.ok, true, JSON.stringify(status));
  if (status.ok) assert.deepEqual(status.value.generation, generation);

  const reconcile = await client.reconcile({ repository, prNumber: 9, previous: startingSnapshot });
  assert.equal(reconcile.ok, true, JSON.stringify(reconcile));
  if (reconcile.ok) assert.equal(reconcile.value.delta.kind, "unchanged");

  const awaited = await client.await({ repository, prNumber: 9, previous: startingSnapshot });
  assert.equal(awaited.ok, true, JSON.stringify(awaited));
  if (awaited.ok) assert.equal(awaited.value.result.kind, "unchanged");
} finally {
  fs.rmSync(fake.directory, { recursive: true, force: true });
}

const incompatible = fakeExecutable({
  contractPayload: { ...contract, identifier: "other/contracts/v1" },
});
try {
  const result = await new GhMakamiClient({ command: incompatible.executable }).checkCapabilities();
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "MAKAMI_COMPANION_INCOMPATIBLE");
} finally {
  fs.rmSync(incompatible.directory, { recursive: true, force: true });
}

const missing = await new GhMakamiClient({
  command: path.join(os.tmpdir(), "mottainai-no-such-gh-makami-package-smoke"),
}).checkCapabilities();
assert.equal(missing.ok, false, JSON.stringify(missing));
if (!missing.ok) assert.equal(missing.error.code, "MAKAMI_COMPANION_MISSING");

const timeoutFake = fakeExecutable({ timeout: true });
try {
  const result = await new GhMakamiClient({ command: timeoutFake.executable, timeoutMs: 20 }).status({
    repository,
    prNumber: 9,
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "MAKAMI_TIMEOUT");
} finally {
  fs.rmSync(timeoutFake.directory, { recursive: true, force: true });
}
