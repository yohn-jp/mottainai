import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ProjectBody {
  apiVersion: string;
  project: { id: string; name: string };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  return port;
}

async function responseBody<T>(url: string): Promise<{ response: Response; body: T }> {
  const response = await fetch(url);
  return { response, body: (await response.json()) as T };
}

test("dashboard CLI starts without browser opening and shuts down on SIGTERM", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "dashboard", "--no-open", "--port", String(port)], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = stdout.match(/Mottainai dashboard listening at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match?.[1] !== undefined) resolve(match[1]);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`dashboard exited before ready: ${code}\n${stderr}`)));
  });
  try {
    const url = await ready;
    const project = await responseBody<ProjectBody>(`${url}api/v1/project`);
    assert.equal(project.response.status, 200);
    assert.equal(project.body.project.id, "project:mottainai");
    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // Windows has no SIGTERM delivery: the child is terminated directly and
    // reports { code: null, signal: "SIGTERM" } instead of a clean exit.
    if (process.platform === "win32") {
      assert.equal(exit.code, null);
      assert.equal(exit.signal, "SIGTERM");
    } else {
      assert.equal(exit.code, 0);
      assert.equal(exit.signal, null);
    }
  } finally {
    if (!child.killed) child.kill("SIGTERM");
  }
});
