import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDirectory = process.argv[2];
if (packageDirectory === undefined) throw new Error("installed Mottainai package directory is required");

const { GhInariClient } = await import(pathToFileURL(path.join(packageDirectory, "dist", "gh-inari.js")).href);

function fakeGhInariExecutable() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-inari-package-smoke-"));
  const executable = path.join(directory, "gh-inari");
  const rejection = JSON.stringify({
    ok: false,
    error: { code: "TEMPLATE_NOT_FOUND", message: "template not found" },
  });
  const source = `if (process.argv.includes("--version")) process.stdout.write("gh-inari 0.2.0\\n");
else if (process.argv.includes("--help")) process.stdout.write("  pr create --from <file.json>\\n  pr get <number> --json\\n");
else process.stdout.write(${JSON.stringify(rejection)});`;
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable };
}

const fake = process.env.GH_INARI_EXECUTABLE === undefined ? fakeGhInariExecutable() : undefined;
try {
  const client = new GhInariClient({
    command: process.env.GH_INARI_EXECUTABLE ?? fake.executable,
    cwd: process.cwd(),
  });

  const capabilities = await client.checkCapabilities();
  assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
  if (capabilities.ok) {
    assert.equal(capabilities.value.version, "0.2.0");
    assert.deepEqual(capabilities.value.operations, ["pr.create", "pr.get"]);
  }

  const rejected = await client.createPullRequest({
    repository: "yohn-jp/mottainai",
    template: "missing-template-for-package-smoke",
    input: { fields: {}, head: "feat/inari-package-smoke", base: "main" },
  });
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "INARI_REJECTED");
    assert.equal(rejected.error.remote?.code, "TEMPLATE_NOT_FOUND");
  }
} finally {
  if (fake !== undefined) fs.rmSync(fake.directory, { recursive: true, force: true });
}
