import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * nix/bootstrap.nix hardcodes zod's and @types/node's exact versions + npm
 * tarball integrity hashes as `fetchurl` pins (mirroring
 * nix/packages/nawabari.nix's own single-dependency pinning style — Nix
 * files in this repository never parse pnpm-lock.yaml directly). Those
 * pins are a second, independently maintained authority against
 * pnpm-lock.yaml's own resolved entries, so this test fails loudly the
 * moment they diverge, rather than letting nix/bootstrap.nix silently
 * build a stale/wrong dependency.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function lockfilePin(packageName: string): { version: string; integrity: string } {
  const lockfile = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@([^:']+)'?:\\n {4}resolution: \\{integrity: (\\S+)\\}`, "mu");
  const match = pattern.exec(lockfile);
  assert.ok(match, `pnpm-lock.yaml has no top-level ${packageName}@<version>: resolution entry in the expected shape`);
  return { version: match[1], integrity: match[2] };
}

function bootstrapNixPin(versionVar: string, hashVar: string): { version: string; integrity: string } {
  const bootstrapNix = fs.readFileSync(path.join(repoRoot, "nix", "bootstrap.nix"), "utf8");
  const versionMatch = new RegExp(`${versionVar}\\s*=\\s*"([^"]+)"`, "u").exec(bootstrapNix);
  const hashMatch = new RegExp(`${hashVar}\\s*=\\s*"(sha512-[^"]+)"`, "u").exec(bootstrapNix);
  assert.ok(versionMatch, `nix/bootstrap.nix has no ${versionVar} = "..." pin`);
  assert.ok(hashMatch, `nix/bootstrap.nix has no ${hashVar} = "sha512-..." pin`);
  return { version: versionMatch[1], integrity: hashMatch[1] };
}

test("nix/bootstrap.nix's pinned zod version matches pnpm-lock.yaml's resolved zod entry", () => {
  const lockfile = lockfilePin("zod");
  const bootstrapNix = bootstrapNixPin("zodVersion", "zodSha512");
  assert.equal(bootstrapNix.version, lockfile.version, "nix/bootstrap.nix's zodVersion has drifted from pnpm-lock.yaml");
});

test("nix/bootstrap.nix's pinned zod integrity hash matches pnpm-lock.yaml's resolved zod entry", () => {
  const lockfile = lockfilePin("zod");
  const bootstrapNix = bootstrapNixPin("zodVersion", "zodSha512");
  assert.equal(bootstrapNix.integrity, lockfile.integrity, "nix/bootstrap.nix's zodSha512 has drifted from pnpm-lock.yaml");
});

test("nix/bootstrap.nix's pinned @types/node version matches pnpm-lock.yaml's resolved entry", () => {
  const lockfile = lockfilePin("@types/node");
  const bootstrapNix = bootstrapNixPin("typesNodeVersion", "typesNodeSha512");
  assert.equal(bootstrapNix.version, lockfile.version, "nix/bootstrap.nix's typesNodeVersion has drifted from pnpm-lock.yaml");
});

test("nix/bootstrap.nix's pinned @types/node integrity hash matches pnpm-lock.yaml's resolved entry", () => {
  const lockfile = lockfilePin("@types/node");
  const bootstrapNix = bootstrapNixPin("typesNodeVersion", "typesNodeSha512");
  assert.equal(bootstrapNix.integrity, lockfile.integrity, "nix/bootstrap.nix's typesNodeSha512 has drifted from pnpm-lock.yaml");
});
