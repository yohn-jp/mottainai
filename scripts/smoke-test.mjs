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
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
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
    // Build stageで作成済みのdistをそのまま検証する。prepackの暗黙再buildは禁止。
    const packResult = run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: repoRoot });
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
    const expectedNames = ["mottainai", "mtnai", "mottainai-mcp"];
    for (const name of expectedNames) {
      if (!binTargets.some((entry) => entry.name === name))
        fail(`bin entry "${name}" missing from installed package.json`);
    }

    for (const { name, target } of binTargets) {
      if (!fs.existsSync(target)) fail(`bin target for "${name}" does not exist at ${target}`);
    }

    // npm が node_modules/.bin に生成した launcher を実際に経由して実行し、
    // bin ターゲットの存在確認だけでは検知できない launcher の破損を防ぐ。
    // "list" は未知の設定ファイルに対して decisive なエラーメッセージで終了するため、
    // launcher が実際に CLI ロジックまで到達したことを判別できる。
    const binDirectory = path.join(installDirectory, "node_modules", ".bin");
    for (const name of expectedNames) {
      const launcher = path.join(binDirectory, name);
      if (!fs.existsSync(launcher)) fail(`npm did not generate a launcher for "${name}" at ${launcher}`);
    }

    // The native MCP entry is a stdio protocol process, so only its installed
    // launcher is checked here; protocol behavior is exercised by the package
    // black-box suite with a real initialize/tools/list exchange.
    for (const name of ["mottainai", "mtnai"]) {
      console.log(`running ${name} list through its installed launcher...`);
      const launcher = path.join(binDirectory, name);
      const missingConfig = path.join(installDirectory, `${name}-missing.config.json`);
      const launcherResult = spawnSync(launcher, ["list", "--config", missingConfig], {
        cwd: installDirectory,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (launcherResult.error) fail(`launcher "${name}" failed to start: ${launcherResult.error.message}`);
      if (launcherResult.status === 0) fail(`launcher "${name}" unexpectedly exited 0 against a missing configuration`);
      if (!launcherResult.stderr.includes("ENOENT")) {
        fail(
          `launcher "${name}" did not report the expected ENOENT for a missing configuration:\n${launcherResult.stderr}`,
        );
      }
      const doctorResult = spawnSync(launcher, ["doctor", "--json", "--config", missingConfig], {
        cwd: installDirectory,
        env: { ...process.env, HOME: installDirectory, USERPROFILE: installDirectory },
        encoding: "utf8",
        timeout: 10_000,
      });
      if (doctorResult.status !== 1) fail(`launcher "${name}" doctor unexpectedly exited ${doctorResult.status}`);
      let doctor;
      try {
        doctor = JSON.parse(doctorResult.stdout);
      } catch {
        fail(`launcher "${name}" doctor did not return JSON:\n${doctorResult.stdout}\n${doctorResult.stderr}`);
      }
      if (doctor.identity?.package_name !== "mottainai")
        fail(`launcher "${name}" doctor identity missing package name: ${JSON.stringify(doctor)}`);
      if (doctor.identity?.distribution_kind !== "packed/npm")
        fail(`launcher "${name}" doctor identity kind mismatch: ${JSON.stringify(doctor.identity)}`);
      if (doctor.identity?.provenance?.config_path !== "cli")
        fail(`launcher "${name}" doctor config provenance mismatch: ${JSON.stringify(doctor.identity)}`);
    }

    const primaryBin = binTargets.find((entry) => entry.name === "mottainai").target;
    const configPath = path.join(installDirectory, "mottainai.config.json");

    // The packed consumer smoke is intentionally hermetic and must not claim
    // host virtualization hardware it does not own. `init` only validates the
    // released CLI/config surface; Runtime lifecycle belongs to `runtime`.
    console.log("running init --yes --dry-run --scope project --client none --no-doctor --json...");
    const initResult = spawnSync(
      process.execPath,
      [
        primaryBin,
        "init",
        "--yes",
        "--scope",
        "project",
        "--client",
        "none",
        "--no-doctor",
        "--dry-run",
        "--json",
        "--config",
        configPath,
      ],
      { cwd: installDirectory, encoding: "utf8", timeout: 10_000 },
    );
    if (initResult.status !== 0)
      fail(`init exited with status ${initResult.status}:\n${initResult.stdout}\n${initResult.stderr}`);
    let initSummary;
    try {
      initSummary = JSON.parse(initResult.stdout);
    } catch {
      fail(`init --json did not print valid JSON:\n${initResult.stdout}`);
    }
    if (initSummary.ok !== true) fail(`init summary.ok was not true: ${JSON.stringify(initSummary)}`);
    if (initSummary.config_written !== false)
      fail(`dry-run init unexpectedly wrote configuration: ${JSON.stringify(initSummary)}`);
    if (fs.existsSync(configPath)) fail(`dry-run init wrote configuration file at ${configPath}`);

    const runtimeStateDirectory = path.join(installDirectory, "runtime-state");
    console.log("running packed runtime ensure --help...");
    const runtimeEnsureHelpResult = spawnSync(process.execPath, [primaryBin, "runtime", "ensure", "--help"], {
      cwd: installDirectory,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (runtimeEnsureHelpResult.status !== 0 || !runtimeEnsureHelpResult.stdout.includes("runtime ensure"))
      fail(
        `runtime ensure help was not callable: ${runtimeEnsureHelpResult.status}\n${runtimeEnsureHelpResult.stdout}\n${runtimeEnsureHelpResult.stderr}`,
      );

    console.log("running packed runtime status --json...");
    const runtimeStatusResult = spawnSync(
      process.execPath,
      [primaryBin, "runtime", "status", "--json", "--state-directory", runtimeStateDirectory],
      {
        cwd: installDirectory,
        encoding: "utf8",
        env: { ...process.env, HOME: installDirectory, USERPROFILE: installDirectory },
        timeout: 10_000,
      },
    );
    if (runtimeStatusResult.status !== 0)
      fail(
        `runtime status exited with status ${runtimeStatusResult.status}:\n${runtimeStatusResult.stdout}\n${runtimeStatusResult.stderr}`,
      );
    let runtimeStatus;
    try {
      runtimeStatus = JSON.parse(runtimeStatusResult.stdout);
    } catch {
      fail(`runtime status --json did not print valid JSON:\n${runtimeStatusResult.stdout}`);
    }
    if (runtimeStatus.ok !== true || runtimeStatus.lifecycle !== "absent")
      fail(`runtime status did not report an absent Runtime: ${JSON.stringify(runtimeStatus)}`);
    if (fs.existsSync(runtimeStateDirectory)) fail("runtime status created the state directory");

    console.log("running packed Mottainai gh-inari companion smoke...");
    run(process.execPath, ["scripts/gh-inari-package-smoke.mjs", installedPackageDirectory], {
      cwd: repoRoot,
      env: process.env,
    });

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
