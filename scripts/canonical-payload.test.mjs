import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { packCanonicalPayload, verifyCanonicalPayload } from "./lib/canonical-payload.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixtureRoot;
let packed;

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-canonical-payload-test-"));
  fs.writeFileSync(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify(
      {
        name: "mottainai",
        version: "0.0.0-payload-fixture",
        bin: {
          mottainai: "dist/index.js",
          mtnai: "dist/index.js",
          "mottainai-mcp": "dist/mcp.js",
        },
        files: ["dist"],
      },
      null,
      2,
    ),
  );
  fs.copyFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"), path.join(fixtureRoot, "pnpm-lock.yaml"));
  fs.mkdirSync(path.join(fixtureRoot, "dist"));
  fs.writeFileSync(path.join(fixtureRoot, "dist/index.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(fixtureRoot, "dist/mcp.js"), "#!/usr/bin/env node\n");
  packed = packCanonicalPayload(fixtureRoot, path.join(fixtureRoot, "payload"));
});

after(() => {
  if (fixtureRoot !== undefined) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test("canonical payload records and verifies package identity and file surface", () => {
  const identity = verifyCanonicalPayload(packed.tarballPath, packed.metadataPath);
  assert.equal(identity.contractId, "mottainai.canonical-application-payload.v1");
  assert.equal(identity.package.version, "0.0.0-payload-fixture");
  assert.ok(identity.files.some((entry) => entry.path === "dist/index.js"));
});

test("canonical payload verification fails closed when tarball bytes differ", () => {
  const changedPath = path.join(fixtureRoot, "payload", "changed.tgz");
  const bytes = fs.readFileSync(packed.tarballPath);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(changedPath, bytes);
  assert.throws(
    () => verifyCanonicalPayload(changedPath, packed.metadataPath),
    /canonical payload verification failed/,
  );
});

test("canonical payload verification fails closed when the declared file surface differs", () => {
  const changedIdentityPath = path.join(fixtureRoot, "payload", "changed.identity.json");
  const identity = JSON.parse(fs.readFileSync(packed.metadataPath, "utf8"));
  identity.files = identity.files.slice(1);
  fs.writeFileSync(changedIdentityPath, `${JSON.stringify(identity)}\n`);
  assert.throws(
    () => verifyCanonicalPayload(packed.tarballPath, changedIdentityPath),
    /canonical payload verification failed: included file surface changed/,
  );
});
