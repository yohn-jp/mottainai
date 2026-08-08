// Issue #22: black-box stdio MCP client。src/ 内部関数は import せず、実プロセスの
// stdin/stdout のみを介して protocol を検証する。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const npmInvocation = process.platform === "win32"
  ? {
      command: process.execPath,
      prefixArgs: [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
    }
  : { command: "npm", prefixArgs: [] };
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";
export const MAX_TRANSCRIPT_BYTES = 32 * 1024;
export const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_UNFRAMED_STDOUT_BYTES = 32 * 1024;
const MAX_STDIN_ERROR_BYTES = 1_024;
const WINDOWS_KILL_TIMEOUT_MS = 2_000;

/** 既存の dist を pack する。build は CI/local の明示的な Build stage で先に行う。 */
export function packRepository(repoRoot, destinationDir) {
  const stdout = execFileSync(npmInvocation.command, [
    ...npmInvocation.prefixArgs,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    destinationDir,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const [info] = JSON.parse(stdout);
  return {
    tarballPath: path.join(destinationDir, info.filename),
    packedFiles: info.files.map((entry) => entry.path),
  };
}

/** tar 展開のみで npm/pnpm install は行わない。依存解決のネットワークアクセスを避ける。 */
export function extractTarball(tarballPath, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  execFileSync(tarCommand, ["xzf", tarballPath, "-C", destinationDir], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return path.join(destinationDir, "package");
}

/**
 * tarball は "files" allowlist により node_modules を含まない。実インストールは依存解決で
 * network が必要になるため、black-box suite ではこのリポジトリ自身が既に解決済みの
 * node_modules（`repoRoot` 側、package.json の依存関係と同一）をそのまま再利用する。
 */
export function linkDependencies(extractedPackageDir, repoRoot) {
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(extractedPackageDir, "node_modules"), "junction");
}

/**
 * package.json の bin エントリを解決し、shebang とファイル実在を検証する。
 * npm/pnpm install が行う「宣言済み bin ターゲットへの実行権限付与」だけを同じ意味で再現する
 * （install 自体は依存解決のネットワークが必要なため black-box test では行わない）。
 */
export function resolvePackagedBin(extractedPackageDir, binName = "mottainai") {
  const packageJsonPath = path.join(extractedPackageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const binField = packageJson.bin;
  const binRelative = typeof binField === "string" ? binField : binField?.[binName];
  if (typeof binRelative !== "string") {
    throw new Error(`packed package.json has no "${binName}" bin entry`);
  }
  const binPath = path.join(extractedPackageDir, binRelative);
  if (!fs.existsSync(binPath)) {
    throw new Error(`packed bin target missing on disk: ${binPath}`);
  }
  const firstLine = fs.readFileSync(binPath, "utf8").split("\n", 1)[0];
  if (firstLine !== "#!/usr/bin/env node") {
    throw new Error(`packed bin target has unexpected shebang: ${JSON.stringify(firstLine)}`);
  }
  if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * POSIX: shebang 経由で bin を直接起動する。
 * Windows: shebang は解釈されないため node 経由で同じ dist ファイルを起動する。
 * spawn する呼び出し元（McpStdioClient.launchPackaged や CLI サブコマンドの black-box test）が
 * このプラットフォーム分岐を共有するための単一の解決点。
 */
export function resolvePackagedCommand(binPath) {
  const command = process.platform === "win32" ? process.execPath : binPath;
  const args = process.platform === "win32" ? [binPath] : [];
  return { command, args };
}

function boundedText(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(-maxBytes).toString("utf8");
}

function appendTail(values, value, maxBytes) {
  values.push(boundedText(value, maxBytes));
  let bytes = values.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
  while (bytes > maxBytes && values.length > 0) {
    bytes -= Buffer.byteLength(values.shift());
  }
}

function killChild(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    // cleanup は best effort。元のテストエラーを隠さない。
  }
}

export function killProcessTree(child, options = {}) {
  if (child?.pid === undefined || child.pid === null) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const timeoutMs = options.timeoutMs ?? WINDOWS_KILL_TIMEOUT_MS;
    const spawnTaskkill = options.spawnTaskkill ?? ((pid) => spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    }));
    let taskkill;
    try {
      taskkill = spawnTaskkill(child.pid);
    } catch {
      killChild(child);
      return;
    }
    let completed = false;
    let timeout;
    const finish = (succeeded) => {
      if (completed) return;
      completed = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (!succeeded) {
        try {
          taskkill.kill();
        } catch {
          // taskkill 自体が終了不能でも対象 child の停止を続ける。
        }
        killChild(child);
      }
    };
    taskkill.once("error", () => finish(false));
    taskkill.once("close", (code) => finish(code === 0));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    return;
  }
  if (platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // process group が既に消えている場合は個別 kill へ進む。
    }
  }
  killChild(child);
}

const trackedChildren = new Set();
process.once("exit", () => {
  for (const child of trackedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      // exit eventでは非同期taskkillを待てないため、Windowsは直接killでbounded cleanupする。
      if (process.platform === "win32") killChild(child);
      else killProcessTree(child);
    }
  }
});

/** ndjson JSON-RPC over stdio の最小 black-box client。実プロセスの外側から protocol を検証する。 */
export class McpStdioClient {
  /** dist ファイルを node で起動する。shebang には依存しない built-artifact 経路。 */
  static launchNode(entryPath, options = {}) {
    return new McpStdioClient(process.execPath, [entryPath], options);
  }

  /**
   * POSIX: shebang 経由で bin を直接起動し、shebang 破損・実行権限欠如を検出できる形で実行する。
   * Windows: shebang は解釈されないため node 経由で同じ dist ファイルを起動する。
   */
  static launchPackaged(binPath, options = {}) {
    const { command, args } = resolvePackagedCommand(binPath);
    return new McpStdioClient(command, args, options);
  }

  constructor(command, args, options = {}) {
    this.stdoutLines = [];
    this.stderrChunks = [];
    this.stdoutLineCount = 0;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.stdinError = undefined;
    this.startupError = undefined;
    this.exited = false;
    this.exitInfo = undefined;
    this.closed = false;
    this.closeInfo = undefined;
    this._pending = new Map();
    this._nextId = 1;
    this._stdoutBuffer = "";
    this._stdoutBufferOverflowed = false;
    this._stdoutViolations = [];
    this._stdoutViolationCount = 0;

    try {
      this.child = spawn(command, args, {
        ...options,
        detached: options.detached ?? process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.startupError = error;
      this.exited = true;
      this.closed = true;
      this.closeInfo = { code: null, signal: null };
      this._closePromise = Promise.resolve(this.closeInfo);
      return;
    }
    trackedChildren.add(this.child);

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    // 子終了後の書き込みで stdin が発する error を runner の未処理例外にしない。
    this.child.stdin.on("error", (error) => {
      this.stdinError = error;
    });
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      appendTail(this.stderrChunks, chunk, MAX_STDERR_TAIL_BYTES);
    });
    this.child.once("error", (error) => {
      this.startupError = error;
      for (const pending of this._pending.values()) {
        pending.reject(this._diagnosticError(pending.method, pending.id, error.message));
      }
      this._pending.clear();
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
    });
    // "exit" 後も stdout/stderr が届き得るため、捕捉済み出力の確定は全 stdio が閉じる "close" を待つ。
    this._closePromise = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this._flushStdoutBuffer();
        this.closed = true;
        this.closeInfo = { code, signal };
        const finalCode = this.exitInfo?.code ?? code;
        const finalSignal = this.exitInfo?.signal ?? signal;
        for (const pending of this._pending.values()) {
          pending.reject(
            this._diagnosticError(
              pending.method,
              pending.id,
              `process exited (code=${finalCode} signal=${finalSignal}) before a response arrived`,
            ),
          );
        }
        this._pending.clear();
        trackedChildren.delete(this.child);
        resolve(this.closeInfo);
      }),
    );
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this._stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);
      this._recordStdoutLine(line);
    }
    if (Buffer.byteLength(this._stdoutBuffer) > MAX_UNFRAMED_STDOUT_BYTES) {
      this._stdoutBuffer = boundedText(this._stdoutBuffer, MAX_UNFRAMED_STDOUT_BYTES);
      this._stdoutBufferOverflowed = true;
    }
  }

  _recordStdoutLine(line, forcedViolation = false) {
    this.stdoutLineCount += 1;
    this.stdoutBytes += Buffer.byteLength(line) + 1;
    // 空行も記録する。捨てると誤った console.log() 等の空行出力が purity 検証をすり抜ける。
    appendTail(this.stdoutLines, line, MAX_TRANSCRIPT_BYTES);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }
    const validProtocolMessage = message && typeof message === "object" && message.jsonrpc === "2.0";
    if (forcedViolation || !validProtocolMessage) {
      this._stdoutViolationCount += 1;
      appendTail(this._stdoutViolations, line, MAX_TRANSCRIPT_BYTES);
    }
    if (message && typeof message === "object" && message.id !== undefined && message.id !== null) {
      const pending = this._pending.get(message.id);
      if (pending !== undefined) {
        this._pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  _flushStdoutBuffer() {
    if (this._stdoutBuffer.length === 0) return;
    const line = this._stdoutBuffer;
    this._stdoutBuffer = "";
    this._recordStdoutLine(line, this._stdoutBufferOverflowed);
    this._stdoutBufferOverflowed = false;
  }

  _diagnosticError(method, id, reason) {
    const stdinError = this.stdinError === undefined
      ? "none"
      : boundedText(this.stdinError instanceof Error ? this.stdinError.message : String(this.stdinError), MAX_STDIN_ERROR_BYTES);
    const processState = [
      `pid=${this.child?.pid ?? "none"}`,
      `exited=${this.exited}`,
      `closed=${this.closed}`,
      `exit_code=${this.exitInfo?.code ?? "none"}`,
      `exit_signal=${this.exitInfo?.signal ?? "none"}`,
      `stdin_error=${JSON.stringify(stdinError)}`,
    ].join(" ");
    return new Error(
      `${reason}; operation=${method} method=${method} request_id=${id}; ${processState}` +
        `; stderr_tail=${JSON.stringify(this.stderrText())}` +
        `; stdout_transcript=${JSON.stringify(this.stdoutLines.join("\n"))}`,
    );
  }

  _send(message) {
    if (this.child === undefined || this.child.stdin.destroyed) {
      throw this._diagnosticError(message.method ?? "notification", message.id ?? "none", "stdin is closed");
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw this._diagnosticError(
        message.method ?? "notification",
        message.id ?? "none",
        `stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** malformed JSON-RPC 検証用。改行終端の生バイト列をそのまま stdin へ書く。 */
  writeRawLine(raw) {
    return this.writeRaw(raw.endsWith("\n") ? raw : `${raw}\n`);
  }

  /** 改行を付けず、生の文字列/バイト列を stdin へ送る。partial JSON 検証に使う。 */
  writeRaw(raw) {
    if (this.child === undefined || this.child.stdin.destroyed) {
      throw this._diagnosticError("raw", "none", "stdin is closed");
    }
    return new Promise((resolve, reject) => {
      const onWrite = (error) => {
        if (error !== undefined && error !== null) {
          reject(this._diagnosticError("raw", "none", `stdin write failed: ${error.message ?? String(error)}`));
        } else resolve();
      };
      try {
        this.child.stdin.write(raw, onWrite);
      } catch (error) {
        onWrite(error);
      }
    });
  }

  prepareRequest(method, params, timeoutMs = 10_000) {
    const id = this._nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    if (this.exited || this.closed || this.startupError !== undefined) {
      rejectResponse(this._diagnosticError(method, id, "process is unavailable before request"));
      return { id, message, response };
    }
    const timer = setTimeout(() => {
      this._pending.delete(id);
      rejectResponse(this._diagnosticError(method, id, `timed out after ${timeoutMs}ms waiting for response`));
    }, timeoutMs);
    this._pending.set(id, {
      id,
      method,
      resolve: (value) => {
        clearTimeout(timer);
        resolveResponse(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectResponse(error);
      },
    });
    return { id, message, response };
  }

  request(method, params, timeoutMs = 10_000) {
    const prepared = this.prepareRequest(method, params, timeoutMs);
    try {
      this._send(prepared.message);
    } catch (error) {
      const pending = this._pending.get(prepared.id);
      this._pending.delete(prepared.id);
      pending?.reject(error);
    }
    return prepared.response;
  }

  /** jsonrpc:"2.0" envelope を欠く、または JSON parse できない stdout 行を違反として返す。 */
  stdoutPurityViolations() {
    const omitted = this._stdoutViolationCount - this._stdoutViolations.length;
    return omitted > 0
      ? [`⋯ omitted=${omitted} stdout protocol violations ⋯`, ...this._stdoutViolations]
      : [...this._stdoutViolations];
  }

  stderrText() {
    return this.stderrChunks.join("");
  }

  /** "close"（全 stdio 終了後）で解決するため、この後の stdout/stderr/stdoutLines 読み取りは確定済み。 */
  waitForExit(timeoutMs = 10_000) {
    if (this.closed) return Promise.resolve(this.closeInfo);
    return Promise.race([
      this._closePromise,
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              this._diagnosticError(
                "process.close",
                "none",
                `timed out after ${timeoutMs}ms waiting for process close`,
              ),
            ),
          timeoutMs,
        );
        this._closePromise.then((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    ]);
  }

  /** client 側から見える正常終了経路: stdin を閉じて EOF を送る。timeout 時は tree cleanup。 */
  async closeGracefully(timeoutMs = 10_000) {
    if (!this.exited && !this.closed) this.endInput();
    try {
      return await this.waitForExit(timeoutMs);
    } catch (error) {
      this.forceKill();
      try {
        return await this.waitForExit(Math.min(2_000, Math.max(250, timeoutMs)));
      } catch (forcedError) {
        throw new Error(`${error.message}; forced cleanup failed: ${forcedError.message}`);
      }
    }
  }

  endInput() {
    if (this.child?.stdin !== undefined && !this.child.stdin.destroyed) this.child.stdin.end();
  }

  /** client disconnect を stdin破棄として再現する。 */
  disconnect() {
    if (this.child?.stdin !== undefined && !this.child.stdin.destroyed) this.child.stdin.destroy();
  }

  forceKill() {
    if (!this.exited && !this.closed) killProcessTree(this.child);
  }
}
