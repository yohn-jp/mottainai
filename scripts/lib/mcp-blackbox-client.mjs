// Issue #22: black-box stdio MCP client。src/ 内部関数は import せず、実プロセスの
// stdin/stdout のみを介して protocol を検証する。#21 との重複を避けるため scripts/ 配下に
// 局所実装する（#21 マージ後、共通 e2e helper へ統合できる）。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const useShell = process.platform === "win32";

/** npm pack はネットワークを使わず、ローカルの作業木を tar 化するのみ。 */
export function packRepository(repoRoot, destinationDir) {
  const stdout = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", destinationDir],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: useShell },
  );
  const [info] = JSON.parse(stdout);
  return {
    tarballPath: path.join(destinationDir, info.filename),
    packedFiles: info.files.map((entry) => entry.path),
  };
}

/** tar 展開のみで npm/pnpm install は行わない。依存解決のネットワークアクセスを避ける。 */
export function extractTarball(tarballPath, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  execFileSync("tar", ["xzf", tarballPath, "-C", destinationDir], { stdio: ["ignore", "pipe", "pipe"], shell: useShell });
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

const trackedChildren = new Set();
process.once("exit", () => {
  for (const child of trackedChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

/** ndjson JSON-RPC over stdio の最小 black-box client。実プロセスの外側から protocol を検証する。 */
export class McpStdioClient {
  /**
   * POSIX: shebang 経由で bin を直接起動し、shebang 破損・実行権限欠如を検出できる形で実行する。
   * Windows: shebang は解釈されないため node 経由で同じ dist ファイルを起動する。
   */
  static launchPackaged(binPath, options) {
    const command = process.platform === "win32" ? process.execPath : binPath;
    const args = process.platform === "win32" ? [binPath] : [];
    return new McpStdioClient(command, args, options);
  }

  constructor(command, args, options) {
    this.child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    trackedChildren.add(this.child);

    this.stdoutLines = [];
    this.stderrChunks = [];
    this.exited = false;
    this.exitInfo = undefined;
    this._pending = new Map();
    this._nextId = 1;
    this._stdoutBuffer = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.stderrChunks.push(chunk));
    this.child.once("exit", (code, signal) => {
      trackedChildren.delete(this.child);
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const pending of this._pending.values()) {
        pending.reject(new Error(`process exited (code=${code} signal=${signal}) before a response arrived`));
      }
      this._pending.clear();
    });
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this._stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      this.stdoutLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message === "object" && message.id !== undefined && message.id !== null) {
        const pending = this._pending.get(message.id);
        if (pending !== undefined) {
          this._pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }

  _send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /** malformed JSON-RPC 検証用。改行終端の生バイト列をそのまま stdin へ書く。 */
  writeRawLine(raw) {
    this.child.stdin.write(raw.endsWith("\n") ? raw : `${raw}\n`);
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for response to ${method} (id=${id})`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** jsonrpc:"2.0" envelope を欠く、または JSON parse できない stdout 行を違反として返す。 */
  stdoutPurityViolations() {
    return this.stdoutLines.filter((line) => {
      try {
        const parsed = JSON.parse(line);
        return !(parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0");
      } catch {
        return true;
      }
    });
  }

  stderrText() {
    return this.stderrChunks.join("");
  }

  waitForExit(timeoutMs = 10_000) {
    if (this.exited) return Promise.resolve(this.exitInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for process exit`)), timeoutMs);
      this.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  /** client 側から見える唯一の正常終了経路: stdin を閉じて EOF を送る。 */
  async closeGracefully(timeoutMs = 10_000) {
    if (!this.exited) this.child.stdin.end();
    return this.waitForExit(timeoutMs);
  }

  forceKill() {
    if (!this.exited) this.child.kill("SIGKILL");
  }
}
