import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDirectory = process.argv[2];
if (packageDirectory === undefined) throw new Error("installed Mottainai package directory is required");

const { GhInariClient } = await import(pathToFileURL(path.join(packageDirectory, "dist", "gh-inari.js")).href);
const client = new GhInariClient({
  command: process.env.GH_INARI_EXECUTABLE ?? "gh-inari",
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
