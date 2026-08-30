import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RUNTIME_APPLIANCE_CONTRACT_ID,
  RUNTIME_APPLIANCE_SCHEMA_VERSION,
  RuntimeApplianceManifestError,
  parseRuntimeApplianceManifest,
  readRuntimeApplianceManifest,
  verifyRuntimeApplianceManifest,
} from "./appliance-manifest.js";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    contractId: RUNTIME_APPLIANCE_CONTRACT_ID,
    schemaVersion: RUNTIME_APPLIANCE_SCHEMA_VERSION,
    architecture: "x86_64-linux",
    sourceRevision: "a".repeat(40),
    nixSystemClosure: "/nix/store/abc123-nixos-system-mottainai-runtime-appliance",
    mottainaiVersion: "0.6.0",
    nawabariVersion: "0.6.1",
    image: {
      filename: "mottainai-runtime-appliance.raw",
      format: "raw",
      sizeBytes: 1024,
      sha256: "b".repeat(64),
    },
    canonicalSource: {
      flake: "nix/flake.nix",
      output: "applianceConfigurations.x86_64-linux.config.system.build.toplevel",
    },
    ...overrides,
  };
}

test("parses a well-formed bounded Appliance manifest", () => {
  const parsed = parseRuntimeApplianceManifest(validManifest());
  assert.equal(parsed.contractId, RUNTIME_APPLIANCE_CONTRACT_ID);
  assert.equal(parsed.image.format, "raw");
});

test("rejects an unrecognized contractId", () => {
  assert.throws(() => parseRuntimeApplianceManifest(validManifest({ contractId: "other" })), RuntimeApplianceManifestError);
});

test("rejects an unbounded/short source revision", () => {
  assert.throws(() => parseRuntimeApplianceManifest(validManifest({ sourceRevision: "not-a-sha" })));
});

test("rejects an unknown field (strict schema)", () => {
  assert.throws(() => parseRuntimeApplianceManifest(validManifest({ extra: "field" })));
});

test("readRuntimeApplianceManifest surfaces unreadable-file errors", () => {
  assert.throws(
    () => readRuntimeApplianceManifest(path.join(os.tmpdir(), "does-not-exist-runtime-appliance.json")),
    RuntimeApplianceManifestError,
  );
});

test("verifyRuntimeApplianceManifest accepts a disk matching its recorded digest/size", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-appliance-manifest-"));
  try {
    const diskPath = path.join(directory, "mottainai-runtime-appliance.raw");
    const content = Buffer.from("canonical-runtime-appliance-disk-fixture");
    fs.writeFileSync(diskPath, content);
    const manifest = parseRuntimeApplianceManifest(
      validManifest({
        image: {
          filename: "mottainai-runtime-appliance.raw",
          format: "raw",
          sizeBytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      }),
    );
    assert.doesNotThrow(() => verifyRuntimeApplianceManifest(manifest, diskPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyRuntimeApplianceManifest fails closed on a digest mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-appliance-manifest-"));
  try {
    const diskPath = path.join(directory, "mottainai-runtime-appliance.raw");
    fs.writeFileSync(diskPath, Buffer.from("tampered-disk-content"));
    const manifest = parseRuntimeApplianceManifest(
      validManifest({
        image: {
          filename: "mottainai-runtime-appliance.raw",
          format: "raw",
          sizeBytes: "tampered-disk-content".length,
          sha256: "c".repeat(64),
        },
      }),
    );
    assert.throws(() => verifyRuntimeApplianceManifest(manifest, diskPath), RuntimeApplianceManifestError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyRuntimeApplianceManifest fails closed on a missing disk", () => {
  const manifest = parseRuntimeApplianceManifest(validManifest());
  assert.throws(
    () => verifyRuntimeApplianceManifest(manifest, path.join(os.tmpdir(), "does-not-exist.raw")),
    RuntimeApplianceManifestError,
  );
});
