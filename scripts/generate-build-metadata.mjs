import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const metadataPath = path.join(repositoryRoot, "dist", "runtime-build-metadata.json");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const gitSha = git(["rev-parse", "HEAD"]);
const gitStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
const clean = gitSha !== undefined && gitStatus === "";
const sourceState = gitSha === undefined || gitStatus === undefined ? "unavailable" : clean ? "clean" : "dirty";
const buildSuffix = clean ? `git.${gitSha}` : sourceState;
const metadata = {
  schema_version: 1,
  package_name: packageJson.name,
  package_version: packageJson.version,
  build_id: `${packageJson.name}@${packageJson.version}+${buildSuffix}`,
  ...(clean ? { git_sha: gitSha } : {}),
  source_state: sourceState,
  artifact: "npm",
};

fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`generated ${path.relative(repositoryRoot, metadataPath)} (${metadata.build_id})`);
