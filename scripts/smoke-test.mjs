#!/usr/bin/env node
// packed tarball を実際に install し、生成された bin を実行して検証する。
// npm pack --dry-run は内容列挙のみで install/exec を検証しないため、
// 公開前にこのスクリプトで実物の動作を確認する。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function fail(message) {
  console.error(`smoke test failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function packageBinTargets(packageDirectory) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const bin = packageJson.bin;
  if (typeof bin !== "object" || bin === null) fail("installed package.json has no bin map");
  return Object.entries(bin).map(([name, relativeTarget]) => ({
    name,
    target: path.join(packageDirectory, relativeTarget),
  }));
}

function parseArgs(argv) {
  const index = argv.indexOf("--tarball");
  return { tarball: index === -1 ? undefined : argv[index + 1] };
}

function main() {
  const { tarball } = parseArgs(process.argv.slice(2));
  // 明示的な tarball が渡されればそれを使う（公開前に検証したものと同一の tarball を publish するため）。
  // 渡されなければローカル開発用に自前で pack する。
  let tarballPath;
  let ownsTarball;
  if (tarball !== undefined) {
    tarballPath = path.resolve(tarball);
    ownsTarball = false;
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  } else {
    console.log("packing tarball...");
    const packResult = run("npm", ["pack", "--json"], { cwd: repoRoot });
    const [packInfo] = JSON.parse(packResult.stdout);
    tarballPath = path.join(repoRoot, packInfo.filename);
    ownsTarball = true;
  }

  const installDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-smoke-"));
  try {
    fs.writeFileSync(
      path.join(installDirectory, "package.json"),
      JSON.stringify({ name: "mottainai-smoke-consumer", private: true, version: "0.0.0" }, null, 2),
    );

    console.log("installing packed tarball into isolated directory...");
    run("npm", ["install", "--no-save", tarballPath], { cwd: installDirectory });

    const installedPackageDirectory = path.join(installDirectory, "node_modules", "mottainai");
    if (!fs.existsSync(installedPackageDirectory)) fail("mottainai was not installed under node_modules");

    const binTargets = packageBinTargets(installedPackageDirectory);
    const expectedNames = ["mottainai", "mtnai"];
    for (const name of expectedNames) {
      if (!binTargets.some((entry) => entry.name === name)) fail(`bin entry "${name}" missing from installed package.json`);
    }

    for (const { name, target } of binTargets) {
      if (!fs.existsSync(target)) fail(`bin target for "${name}" does not exist at ${target}`);
    }

    const primaryBin = binTargets.find((entry) => entry.name === "mottainai").target;
    const configPath = path.join(installDirectory, "mottainai.config.json");

    console.log("running init --yes --scope project --client none --no-doctor --json...");
    const initResult = spawnSync(
      process.execPath,
      [primaryBin, "init", "--yes", "--scope", "project", "--client", "none", "--no-doctor", "--json", "--config", configPath],
      { cwd: installDirectory, encoding: "utf8" },
    );
    if (initResult.status !== 0) fail(`init exited with status ${initResult.status}:\n${initResult.stdout}\n${initResult.stderr}`);
    let initSummary;
    try {
      initSummary = JSON.parse(initResult.stdout);
    } catch {
      fail(`init --json did not print valid JSON:\n${initResult.stdout}`);
    }
    if (initSummary.ok !== true) fail(`init summary.ok was not true: ${JSON.stringify(initSummary)}`);
    if (!fs.existsSync(configPath)) fail(`init did not write configuration file at ${configPath}`);

    console.log("running bare invocation without a configuration...");
    const missingConfigPath = path.join(installDirectory, "missing.config.json");
    const bareResult = spawnSync(process.execPath, [primaryBin], {
      cwd: installDirectory,
      encoding: "utf8",
      env: { ...process.env, MOTTAINAI_CONFIG: missingConfigPath },
      timeout: 10_000,
    });
    if (bareResult.stdout.trim() !== "") fail(`bare invocation wrote to stdout: ${bareResult.stdout}`);
    if (!bareResult.stderr.includes("Initialize this workspace with:")) {
      fail(`bare invocation stderr did not contain initialization guidance:\n${bareResult.stderr}`);
    }
    if (bareResult.status === 0) fail("bare invocation with a missing configuration unexpectedly exited 0");

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(installDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
