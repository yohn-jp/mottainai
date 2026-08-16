import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDirectory = process.argv[2];
if (packageDirectory === undefined) throw new Error("installed Mottainai package directory is required");

const { GhInariClient } = await import(pathToFileURL(path.join(packageDirectory, "dist", "gh-inari.js")).href);
const { GhInariPullRequestAdapter } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "providers", "gh-inari.js")).href
);

function fakeGhInariExecutable({ version = "0.2.0", response } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-inari-package-smoke-"));
  const executable = path.join(directory, "gh-inari");
  const defaultResponse = JSON.stringify({
    ok: false,
    error: { code: "TEMPLATE_NOT_FOUND", message: "template not found" },
  });
  const source = `if (process.argv.includes("--version")) process.stdout.write("gh-inari ${version}\\n");
	else if (process.argv.includes("--help")) process.stdout.write("  pr create --from <file.json>\\n  pr get <number> --json\\n");
	else process.stdout.write(${JSON.stringify(response ?? defaultResponse)});`;
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable };
}

const fake = process.env.GH_INARI_EXECUTABLE === undefined ? fakeGhInariExecutable() : undefined;
let compatible;
let incompatible;
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

  const githubProviderSource = fs.readFileSync(
    path.join(packageDirectory, "dist", "workflow", "providers", "github.js"),
    "utf8",
  );
  assert.doesNotMatch(githubProviderSource, /["']pr["']\s*,\s*["']create["']/u);

  compatible = fakeGhInariExecutable({
    response: JSON.stringify({
      ok: true,
      artifact: {
        number: 42,
        url: "https://github.com/yohn-jp/mottainai/pull/42",
        head: "feat/package-smoke",
        base: "main",
      },
    }),
  });
  let lookupCalls = 0;
  const lookupAdapter = {
    findPullRequests: async () => {
      lookupCalls += 1;
      return { ok: true, value: [], attempts: 1 };
    },
  };
  const createInput = {
    repository: { provider: "github", id: "yohn-jp/mottainai", namespace: "yohn-jp", name: "mottainai" },
    title: "package smoke",
    head: { name: "feat/package-smoke", revision: "head-sha" },
    base: { name: "main", revision: "base-sha" },
    draft: { sections: { Summary: "typed package smoke intent" } },
  };
  const governed = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: compatible.executable, cwd: process.cwd() }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(governed.ok, true, JSON.stringify(governed));
  assert.equal(lookupCalls, 0, "governed create must not use the GitHub read adapter as a mutation fallback");

  const missing = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: path.join(os.tmpdir(), "mottainai-no-such-gh-inari-package-smoke") }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(missing.ok, false, JSON.stringify(missing));
  if (!missing.ok) assert.equal(missing.error.inari?.code, "INARI_COMPANION_MISSING");

  incompatible = fakeGhInariExecutable({ version: "0.1.0" });
  const incompatibleResult = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: incompatible.executable, cwd: process.cwd() }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(incompatibleResult.ok, false, JSON.stringify(incompatibleResult));
  if (!incompatibleResult.ok) assert.equal(incompatibleResult.error.inari?.code, "INARI_COMPANION_INCOMPATIBLE");
  assert.equal(lookupCalls, 0, "capability failure must not fall back to a provider mutation");
} finally {
  if (fake !== undefined) fs.rmSync(fake.directory, { recursive: true, force: true });
  if (compatible !== undefined) fs.rmSync(compatible.directory, { recursive: true, force: true });
  if (incompatible !== undefined) fs.rmSync(incompatible.directory, { recursive: true, force: true });
}
