import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  LocalRuntimeError,
  LOCAL_RUNTIME_PROFILE,
  type LocalRuntimePaths,
  type RuntimeAccelerator,
  type RuntimeImageIdentity,
  type QemuArtifactIdentity,
} from "./types.js";

interface QmpReply {
  readonly return?: unknown;
  readonly error?: { readonly class?: string; readonly desc?: string };
  readonly id?: number;
}

function qmpEndpointArgument(endpoint: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `pipe:${endpoint}` : `unix:${endpoint},server=on,wait=off`;
}

class QmpLineReader {
  private buffer = "";
  private readonly lines: string[] = [];
  private waiter:
    | { resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    | undefined;
  private terminalError: Error | undefined;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        this.lines.push(this.buffer.slice(0, newline).trim());
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
      }
      this.flush();
    });
    socket.on("error", (error) => {
      this.terminalError = error;
      this.flush();
    });
    socket.on("close", () => {
      if (this.terminalError === undefined) this.terminalError = new Error("QMP socket closed before a response");
      this.flush();
    });
  }

  private flush(): void {
    if (this.waiter === undefined) return;
    if (this.lines.length > 0) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(this.lines.shift() ?? "");
      return;
    }
    if (this.terminalError !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(this.terminalError);
    }
  }

  async next(timeoutMs: number): Promise<string> {
    if (this.lines.length > 0) return this.lines.shift() ?? "";
    if (this.terminalError !== undefined) throw this.terminalError;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error("QMP response timed out"));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.flush();
    });
  }

  close(): void {
    if (this.waiter !== undefined) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error("QMP reader closed"));
      this.waiter = undefined;
    }
  }
}

async function sendJson(socket: net.Socket, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(value)}\r\n`, (error) => (error === undefined ? resolve() : reject(error)));
  });
}

export class PrivateQmpClient {
  constructor(
    private readonly endpoint: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timeoutMs = 2_000,
  ) {}

  private async execute(command: string, argumentsValue?: Record<string, unknown>): Promise<unknown> {
    const socket = net.createConnection({ path: this.endpoint });
    const reader = new QmpLineReader(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("QMP connection timed out")), this.timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      JSON.parse(await reader.next(this.timeoutMs));
      await sendJson(socket, { execute: "qmp_capabilities", id: 1 });
      const capabilities = await this.readReply(reader, 1);
      if (capabilities.error !== undefined) throw new Error(capabilities.error.desc ?? "QMP capabilities failed");
      await sendJson(socket, { execute: command, arguments: argumentsValue ?? {}, id: 2 });
      const reply = await this.readReply(reader, 2);
      if (reply.error !== undefined) throw new Error(reply.error.desc ?? reply.error.class ?? "QMP command failed");
      return reply.return;
    } catch (error) {
      throw new LocalRuntimeError(
        "runtime_boot_failed",
        `private QMP command ${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reader.close();
      socket.destroy();
    }
  }

  private async readReply(reader: QmpLineReader, id: number): Promise<QmpReply> {
    while (true) {
      const value: unknown = JSON.parse(await reader.next(this.timeoutMs));
      if (typeof value === "object" && value !== null && (value as QmpReply).id === id) {
        return value as QmpReply;
      }
    }
  }

  async queryStatus(): Promise<{ readonly status: string; readonly singlestep?: boolean; readonly running?: boolean }> {
    const value = await this.execute("query-status");
    if (typeof value !== "object" || value === null || typeof (value as { status?: unknown }).status !== "string") {
      throw new LocalRuntimeError("runtime_boot_failed", "QMP query-status returned an invalid response");
    }
    return value as { status: string; singlestep?: boolean; running?: boolean };
  }

  async quit(): Promise<void> {
    await this.execute("quit");
  }

  async powerdown(): Promise<void> {
    await this.execute("system_powerdown");
  }
}

export interface QemuMachineOptions {
  readonly artifact: QemuArtifactIdentity;
  readonly image: RuntimeImageIdentity;
  readonly paths: LocalRuntimePaths;
  readonly accelerator: RuntimeAccelerator;
  readonly platform?: NodeJS.Platform;
  readonly qmpTimeoutMs?: number;
}

export function buildCanonicalQemuArguments(options: QemuMachineOptions): string[] {
  const platform = options.platform ?? process.platform;
  const cpu = options.accelerator === "whpx" ? "max" : "host";
  const qmp = qmpEndpointArgument(options.paths.qmpSocket, platform);
  return [
    "-nodefaults",
    "-machine",
    LOCAL_RUNTIME_PROFILE.machineType,
    "-name",
    LOCAL_RUNTIME_PROFILE.machineId,
    "-uuid",
    LOCAL_RUNTIME_PROFILE.machineUuid,
    "-accel",
    options.accelerator,
    "-cpu",
    cpu,
    "-smp",
    String(LOCAL_RUNTIME_PROFILE.cpuCount),
    "-m",
    `${LOCAL_RUNTIME_PROFILE.memoryMiB}M`,
    "-kernel",
    options.paths.kernelImage,
    "-initrd",
    options.paths.initrdImage,
    "-append",
    "console=ttyS0 root=/dev/vda systemd.unit=multi-user.target",
    "-drive",
    `file=${options.paths.diskImage},if=virtio,format=raw,cache=none`,
    "-netdev",
    `user,id=mottainai-net,hostfwd=tcp:${LOCAL_RUNTIME_PROFILE.sshHost}:${LOCAL_RUNTIME_PROFILE.sshPort}-:22`,
    "-device",
    "virtio-net-pci,netdev=mottainai-net",
    "-qmp",
    qmp,
    "-display",
    "none",
    "-serial",
    "null",
    "-no-reboot",
  ];
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type MachineObservation = "absent" | "stopped" | "starting" | "running" | "failed";

export class QemuRuntimeMachine {
  private readonly qmp: PrivateQmpClient;

  constructor(private readonly options: QemuMachineOptions) {
    this.qmp = new PrivateQmpClient(options.paths.qmpSocket, options.platform, options.qmpTimeoutMs ?? 2_000);
  }

  get arguments(): string[] {
    return buildCanonicalQemuArguments(this.options);
  }

  async inspect(pid?: number): Promise<MachineObservation> {
    if (!processIsAlive(pid)) {
      if (pid === undefined && fs.existsSync(this.options.paths.qmpSocket)) {
        try {
          const status = await this.qmp.queryStatus();
          return status.running === false || status.status === "shutdown" ? "stopped" : "running";
        } catch {
          return "stopped";
        }
      }
      return pid === undefined ? "absent" : "stopped";
    }
    try {
      const status = await this.qmp.queryStatus();
      return status.running === false || status.status === "shutdown" ? "stopped" : "running";
    } catch {
      return "starting";
    }
  }

  async start(): Promise<number> {
    const existing = await this.inspect();
    if (existing === "running" || existing === "starting") {
      throw new LocalRuntimeError(
        "runtime_boot_failed",
        "QEMU process is already running but its managed PID is unavailable",
      );
    }
    fs.mkdirSync(this.options.paths.stateDirectory, { recursive: true, mode: 0o700 });
    if (this.options.platform !== "win32" && fs.existsSync(this.options.paths.qmpSocket)) {
      const socketStat = fs.lstatSync(this.options.paths.qmpSocket);
      if (!socketStat.isSocket()) {
        throw new LocalRuntimeError(
          "runtime_boot_failed",
          "managed QMP endpoint is not a socket; refusing to overwrite it",
        );
      }
      fs.unlinkSync(this.options.paths.qmpSocket);
    }
    try {
      const libraryDirectory = this.options.artifact.runtimeLibraryDirectory;
      const platform = this.options.platform ?? process.platform;
      const environment =
        libraryDirectory === undefined
          ? process.env
          : {
              ...process.env,
              ...(platform === "win32"
                ? { PATH: `${libraryDirectory};${process.env.PATH ?? ""}` }
                : platform === "darwin"
                  ? { DYLD_LIBRARY_PATH: `${libraryDirectory}:${process.env.DYLD_LIBRARY_PATH ?? ""}` }
                  : { LD_LIBRARY_PATH: `${libraryDirectory}:${process.env.LD_LIBRARY_PATH ?? ""}` }),
            };
      const child = spawn(this.options.artifact.executablePath, this.arguments, {
        cwd: this.options.paths.stateDirectory,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: environment,
      });
      child.unref();
      if (child.pid === undefined) throw new Error("QEMU did not return a process id");
      return child.pid;
    } catch (error) {
      throw new LocalRuntimeError(
        "runtime_boot_failed",
        `managed QEMU could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(pid?: number): Promise<void> {
    if (!processIsAlive(pid)) return;
    try {
      await this.qmp.quit();
    } catch {
      // Only terminate a PID previously recorded by this machine state.  No
      // process discovery or host-wide kill is permitted.
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // It exited between QMP and the bounded recovery attempt.
        }
      }
    }
  }

  async powerdown(): Promise<void> {
    await this.qmp.powerdown();
  }
}
