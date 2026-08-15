import { generateKeyPairSync, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { LocalRuntimeError, LOCAL_RUNTIME_PROFILE, type LocalRuntimePaths } from "./types.js";
import { hostKeyLineForLocalRuntime } from "./image.js";
import type { RuntimeCapabilityResult } from "../runtime-contract/contract.js";
import { parseRuntimeCapabilityResult } from "../runtime-contract/contract.js";

function uint32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value, 0);
  return output;
}

function sshPublicKey(publicKeyDer: Buffer): string {
  const raw = publicKeyDer.subarray(-32);
  const type = Buffer.from("ssh-ed25519", "ascii");
  const wire = Buffer.concat([uint32(type.length), type, uint32(raw.length), raw]);
  return `ssh-ed25519 ${wire.toString("base64")} mottainai-control`;
}

export interface SshIdentity {
  readonly publicKey: string;
  readonly fingerprint: string;
}

export function ensureSshIdentity(paths: LocalRuntimePaths): SshIdentity {
  fs.mkdirSync(paths.sshDirectory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.sshPrivateKey)) {
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" });
    const publicKey = sshPublicKey(pair.publicKey.export({ format: "der", type: "spki" }));
    fs.writeFileSync(paths.sshPrivateKey, privateKey, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(`${paths.sshPrivateKey}.pub`, `${publicKey}\n`, { encoding: "utf8", mode: 0o600 });
  }
  try {
    fs.chmodSync(paths.sshPrivateKey, 0o600);
  } catch {
    // Windows private application directories are protected by their ACL.
  }
  const publicPath = `${paths.sshPrivateKey}.pub`;
  if (!fs.existsSync(publicPath)) {
    throw new LocalRuntimeError("runtime_ssh_failed", "managed SSH private key exists without its public key");
  }
  const publicKey = fs.readFileSync(publicPath, "utf8").trim();
  if (!/^ssh-ed25519\s+\S+(?:\s+\S+)?$/u.test(publicKey)) {
    throw new LocalRuntimeError("runtime_ssh_failed", "managed SSH public key is malformed");
  }
  try {
    const privateKey = createPrivateKey(fs.readFileSync(paths.sshPrivateKey, "utf8"));
    const derived = sshPublicKey(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
    if (derived.split(" ", 2).join(" ") !== publicKey.split(" ", 2).join(" ")) {
      throw new LocalRuntimeError("runtime_ssh_failed", "managed SSH private/public key pair does not match");
    }
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    throw new LocalRuntimeError("runtime_ssh_failed", "managed SSH private key is malformed");
  }
  const fingerprint = createHash("sha256").update(publicKey).digest("hex");
  return { publicKey, fingerprint };
}

export function ensureKnownHost(paths: LocalRuntimePaths, hostKey: string): void {
  const line = hostKeyLineForLocalRuntime(hostKey);
  if (fs.existsSync(paths.sshKnownHosts)) {
    const existing = fs.readFileSync(paths.sshKnownHosts, "utf8").trim();
    if (existing !== line) {
      throw new LocalRuntimeError(
        "runtime_ssh_failed",
        "managed Runtime SSH host identity changed; refusing to connect to a possibly unrelated machine",
      );
    }
    return;
  }
  fs.mkdirSync(paths.sshDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.sshKnownHosts, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export interface RuntimeGuest {
  health(): Promise<RuntimeCapabilityResult>;
  reconcile(): Promise<RuntimeCapabilityResult>;
}

export interface SshGuestOptions {
  readonly paths: LocalRuntimePaths;
  readonly hostKey: string;
  readonly timeoutMs: number;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly sshExecutable?: string;
}

export function buildSshArguments(
  options: Pick<SshGuestOptions, "paths" | "host" | "port" | "user" | "sshExecutable">,
  remoteCommand: "health" | "reconcile",
): string[] {
  const command =
    remoteCommand === "health"
      ? "mottainai-runtime-health"
      : "sudo -n mottainai-runtime-reconcile && mottainai-runtime-health";
  return [
    "-BatchMode",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.paths.sshKnownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=5",
    "-i",
    options.paths.sshPrivateKey,
    "-p",
    String(options.port),
    `${options.user}@${options.host}`,
    command,
  ];
}

export class SshRuntimeGuest implements RuntimeGuest {
  private readonly options: Required<Pick<SshGuestOptions, "host" | "port" | "user" | "sshExecutable">> &
    SshGuestOptions;

  constructor(options: SshGuestOptions) {
    ensureKnownHost(options.paths, options.hostKey);
    this.options = {
      ...options,
      host: options.host ?? LOCAL_RUNTIME_PROFILE.sshHost,
      port: options.port ?? LOCAL_RUNTIME_PROFILE.sshPort,
      user: options.user ?? LOCAL_RUNTIME_PROFILE.sshUser,
      sshExecutable: options.sshExecutable ?? "ssh",
    };
  }

  private async command(remoteCommand: "health" | "reconcile"): Promise<string> {
    const args = buildSshArguments(this.options, remoteCommand);
    try {
      const result = await promisify(execFile)(this.options.sshExecutable, args, {
        encoding: "utf8",
        timeout: this.options.timeoutMs,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      });
      return result.stdout.trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new LocalRuntimeError("runtime_ssh_failed", `SSH Runtime command failed: ${detail}`);
    }
  }

  private parseHealth(output: string): RuntimeCapabilityResult {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new LocalRuntimeError("runtime_health_failed", "Runtime health command did not return JSON");
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "contractId" in value &&
      (value as { contractId?: unknown }).contractId !== "mottainai.linux-runtime.v1"
    ) {
      throw new LocalRuntimeError("runtime_incompatible", "Runtime reported an incompatible contract id");
    }
    try {
      return parseRuntimeCapabilityResult(value);
    } catch {
      throw new LocalRuntimeError("runtime_health_failed", "Runtime health response did not match the #231 contract");
    }
  }

  async health(): Promise<RuntimeCapabilityResult> {
    return this.parseHealth(await this.command("health"));
  }

  async reconcile(): Promise<RuntimeCapabilityResult> {
    return this.parseHealth(await this.command("reconcile"));
  }
}

export async function waitForRuntimeSsh(
  guest: RuntimeGuest,
  timeoutMs: number,
  intervalMs = 250,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RuntimeCapabilityResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await guest.health();
    } catch (error) {
      lastError = error;
      await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }
  }
  throw new LocalRuntimeError(
    "runtime_ssh_failed",
    `Runtime SSH did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
