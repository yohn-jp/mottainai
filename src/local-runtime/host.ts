import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LocalRuntimeError, type HostProbeResult, type LocalRuntimeHost, type RuntimeAccelerator } from "./types.js";

function unsupported(platform: string, architecture: string): never {
  throw new LocalRuntimeError(
    "unsupported_host",
    `canonical local Runtime supports Windows x86-64, macOS x86-64/Apple Silicon, or Linux x86-64/arm64; detected ${platform}/${architecture}`,
    { platform, architecture },
  );
}

export function identifyLocalRuntimeHost(
  platform: NodeJS.Platform | string = process.platform,
  architecture: string = process.arch,
): LocalRuntimeHost {
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "linux" && architecture === "arm64") return "linux-arm64";
  if (platform === "darwin" && architecture === "x64") return "macos-x64";
  if (platform === "darwin" && architecture === "arm64") return "macos-arm64";
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  return unsupported(platform, architecture);
}

export function acceleratorForHost(host: LocalRuntimeHost): RuntimeAccelerator {
  if (host.startsWith("linux-")) return "kvm";
  if (host.startsWith("macos-")) return "hvf";
  return "whpx";
}

function failAcceleration(accelerator: RuntimeAccelerator, reason: string): never {
  throw new LocalRuntimeError(
    "hardware_acceleration_unavailable",
    `${accelerator.toUpperCase()} hardware acceleration is unavailable: ${reason}. Mottainai will not fall back to TCG or host-native execution`,
    { accelerator, reason },
  );
}

function probeLinuxKvm(): void {
  if (!existsSync("/dev/kvm"))
    failAcceleration("kvm", "/dev/kvm does not exist; enable the KVM kernel module and grant this user access");
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    failAcceleration("kvm", "/dev/kvm is not readable and writable by this process");
  }
}

function probeMacHvf(): void {
  try {
    const result = execFileSync("sysctl", ["-n", "kern.hv_support"], { encoding: "utf8", timeout: 2_000 }).trim();
    if (result !== "1") failAcceleration("hvf", "sysctl kern.hv_support is not enabled");
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    failAcceleration("hvf", "could not verify sysctl kern.hv_support");
  }
}

function probeWindowsWhpx(): void {
  try {
    const result = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State",
      ],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    if (!/^Enabled$/iu.test(result))
      failAcceleration("whpx", `Windows Hypervisor Platform state is ${result || "unknown"}`);
  } catch (error) {
    if (error instanceof LocalRuntimeError) throw error;
    failAcceleration("whpx", "could not verify the Windows Hypervisor Platform feature");
  }
}

export function probeHostHardware(host: LocalRuntimeHost): HostProbeResult {
  const accelerator = acceleratorForHost(host);
  if (accelerator === "kvm") probeLinuxKvm();
  else if (accelerator === "hvf") probeMacHvf();
  else probeWindowsWhpx();
  return { host, accelerator, architecture: host.endsWith("arm64") ? "arm64" : "x64" };
}
