import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Issue #643 regression proof: PR #641 found that buildManagedGeneration's
// `nix build` invocation resolved `builtins.getFlake` unreliably when the
// subprocess's cwd was itself inside the same repository the flake ref
// points at. The unit tests in
// src/runtime-contract/managed-generation-build.test.ts mock `execFile` and
// only prove the fixed code no longer *constructs* a cwd/`--arg`-dependent
// invocation; they cannot prove the real `nix build`/`builtins.getFlake`
// self-reference behavior the original defect was actually about, since
// they never invoke Nix.
//
// This script does: it runs the real, unmocked buildManagedGeneration
// against this repository's own checkout as `repoRoot` twice — once with
// the caller's own process.cwd() set to inside that same repository (the
// literal self-reference condition #641 hit) and once from a neutral
// tmpdir — and asserts both invocations succeed and produce the identical
// generationIdentity. A manifest with an empty `packages` array is used
// deliberately: it exercises the exact `nix build --expr`/`builtins.getFlake`
// invocation shape under test while requiring no network fetch and no
// pre-known source NAR hash (Issue #625/#626's verifySourceIntegrity/
// assertResolvedVersionsMatch both iterate `manifest.packages`, so an empty
// manifest trivially satisfies them) — keeping this check small and fast
// rather than pulling in #630's VM/golden-path source-resolution machinery.
//
// Requires a real `nix` toolchain; run via
// `node --import tsx scripts/verify-managed-generation-cwd-independence.mjs`
// from the CI runtime-contract job (see .github/workflows/ci.yml), which
// already has Nix installed for the rest of that job's checks.

const { buildManagedGeneration } = await import("../src/runtime-contract/managed-generation-build.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const system = process.argv[2] ?? "x86_64-linux";

const manifest = {
  contractId: "mottainai.managed-package-manifest.v1",
  schemaVersion: 1,
  activation: { generation: 1 },
  packages: [],
};

// CI=true: matches every other production caller of buildManagedGeneration
// (nix/mottainai.nix's build reads the repository's own node_modules via
// `source = ../.`; a locally pnpm-installed node_modules otherwise makes
// pnpm prompt interactively to remove it) — irrelevant to an empty-packages
// manifest's own build, but kept for parity with the real invocation shape.
const env = { ...process.env, CI: "true" };

const originalCwd = process.cwd();
let fromInsideRepo;
let fromNeutralDir;
try {
  // The literal self-reference condition #641's investigation found: the
  // caller's cwd is inside the same repository `repoRoot` also names.
  process.chdir(repoRoot);
  fromInsideRepo = await buildManagedGeneration({
    repoRoot,
    manifest,
    system,
    mottainaiSourcePath: repoRoot,
    env,
  });

  process.chdir(os.tmpdir());
  fromNeutralDir = await buildManagedGeneration({
    repoRoot,
    manifest,
    system,
    mottainaiSourcePath: repoRoot,
    env,
  });
} finally {
  process.chdir(originalCwd);
}

if (fromInsideRepo.generationIdentity !== fromNeutralDir.generationIdentity) {
  console.error(
    `managed generation build depends on caller cwd: fromInsideRepo=${fromInsideRepo.generationIdentity} fromNeutralDir=${fromNeutralDir.generationIdentity}`,
  );
  process.exit(1);
}

console.log(
  `managed generation build is independent of caller cwd and repository self-reference (generationIdentity=${fromInsideRepo.generationIdentity})`,
);
