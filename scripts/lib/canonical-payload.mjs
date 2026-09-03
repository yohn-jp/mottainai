import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PAYLOAD_CONTRACT_ID = "mottainai.canonical-application-payload.v1";
const EXPECTED_BIN_ENTRIES = Object.freeze({
  mottainai: "dist/index.js",
  mtnai: "dist/index.js",
  "mottainai-mcp": "dist/mcp.js",
});

function digest(value, algorithm = "sha256") {
  return createHash(algorithm).update(value).digest("hex");
}

function fileDigest(filePath, algorithm = "sha256") {
  return digest(fs.readFileSync(filePath), algorithm);
}

function assert(condition, message) {
  if (!condition) throw new Error(`canonical payload verification failed: ${message}`);
}

function readIdentity(identityPath) {
  return JSON.parse(fs.readFileSync(identityPath, "utf8"));
}

/** Verify the immutable identity recorded beside a canonical payload. */
export function verifyCanonicalPayload(tarballPath, identityPath, sourceRoot) {
  const tarball = path.resolve(tarballPath);
  const identity = readIdentity(identityPath);
  assert(identity.contractId === PAYLOAD_CONTRACT_ID, "unexpected contractId");
  assert(identity.schemaVersion === 1, "unsupported schemaVersion");
  assert(identity.payload?.filename === path.basename(tarball), "payload filename does not match");

  const bytes = fs.readFileSync(tarball);
  assert(identity.payload.sizeBytes === bytes.length, "payload size changed");
  assert(identity.payload.sha256 === digest(bytes), "payload sha256 changed");
  assert(
    identity.payload.integrity === `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    "payload integrity changed",
  );

  const packageJsonBytes = execFileSync("tar", ["-xOf", tarball, "package/package.json"]);
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  assert(identity.package?.name === packageJson.name, "package name changed");
  assert(identity.package?.version === packageJson.version, "package version changed");
  assert(identity.package?.packageJsonSha256 === digest(packageJsonBytes), "package metadata changed");
  assert(JSON.stringify(identity.package?.bin) === JSON.stringify(packageJson.bin), "package bin entries changed");

  const actualFiles = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry.startsWith("package/") && entry !== "package/" && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
    .sort();
  const expectedFiles = (identity.files ?? []).map((entry) => entry.path).sort();
  assert(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), "included file surface changed");
  if (sourceRoot !== undefined) {
    const lockfilePath = path.join(sourceRoot, "pnpm-lock.yaml");
    assert(identity.source?.lockfile?.sha256 === fileDigest(lockfilePath), "source lockfile identity changed");
    if (identity.source?.revision !== undefined) {
      assert(identity.source.revision === gitOutput(sourceRoot, ["rev-parse", "HEAD"]), "source revision changed");
    }
  }
  return identity;
}

function gitOutput(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Produce the one release-local Route 1 payload. The caller must build first;
 * --ignore-scripts keeps this operation from silently creating a second build
 * while npm pack is being used as the payload authority.
 */
export function packCanonicalPayload(repoRoot, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const stdout = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destinationDir], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const [info] = JSON.parse(stdout);
  if (!info?.filename || !Array.isArray(info.files)) throw new Error("npm pack did not return package metadata");

  const tarballPath = path.resolve(destinationDir, info.filename);
  if (!fs.existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
  const packageJsonBytes = execFileSync("tar", ["-xOf", tarballPath, "package/package.json"]);
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  if (packageJson.name !== info.name || packageJson.version !== info.version) {
    throw new Error(
      `packed package identity mismatch: npm reported ${info.name}@${info.version}, tarball contains ${packageJson.name}@${packageJson.version}`,
    );
  }
  if (JSON.stringify(packageJson.bin) !== JSON.stringify(EXPECTED_BIN_ENTRIES)) {
    throw new Error(`packed CLI/MCP bin entries do not match the Route 1 contract: ${JSON.stringify(packageJson.bin)}`);
  }

  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const gitRevision = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  const sourceRevision = gitRevision && /^[0-9a-f]{40}$/.test(gitRevision) ? gitRevision : undefined;
  const files = info.files
    .map((entry) => ({ path: entry.path, size: entry.size, mode: entry.mode }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const tarballBytes = fs.statSync(tarballPath).size;
  const tarballSha256 = fileDigest(tarballPath);
  const metadata = {
    contractId: PAYLOAD_CONTRACT_ID,
    schemaVersion: 1,
    canonicalOperation: "npm pack --ignore-scripts",
    package: {
      name: packageJson.name,
      version: packageJson.version,
      bin: packageJson.bin,
      packageJsonSha256: digest(packageJsonBytes),
    },
    source: {
      ...(sourceRevision ? { revision: sourceRevision } : {}),
      lockfile: {
        filename: "pnpm-lock.yaml",
        sha256: fileDigest(lockfilePath),
      },
    },
    payload: {
      filename: path.basename(tarballPath),
      sizeBytes: tarballBytes,
      sha256: tarballSha256,
      integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarballPath)).digest("base64")}`,
    },
    files,
  };
  const metadataPath = path.join(destinationDir, `${path.basename(tarballPath)}.identity.json`);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    tarballPath,
    metadataPath,
    packedFiles: files.map((entry) => entry.path),
    metadata,
  };
}

export { PAYLOAD_CONTRACT_ID };
