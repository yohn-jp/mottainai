// Issue #22用。networkなしで、gatewayから見れば実MCP upstream subprocessになるfixture。
import fs from "node:fs";

const mode = process.env.MOTTAINAI_FIXTURE_MODE ?? "normal";
const pidFile = process.env.MOTTAINAI_FIXTURE_PID_FILE;
const readyFile = process.env.MOTTAINAI_FIXTURE_READY_FILE;

if (pidFile !== undefined) fs.writeFileSync(pidFile, `${process.pid}\n`);

function markReady() {
  if (readyFile !== undefined) fs.writeFileSync(readyFile, `${process.pid}\n`);
}

function ignoreTermination() {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

if (mode === "hang-startup" || mode === "ignore-termination") ignoreTermination();

if (mode === "large-stderr") {
  const size = Number(process.env.MOTTAINAI_FIXTURE_STDERR_BYTES ?? 512 * 1024);
  process.stderr.write("fixture-large-stderr-start\n");
  const chunk = "x".repeat(64 * 1024);
  for (let remaining = size; remaining > 0; remaining -= chunk.length) {
    process.stderr.write(chunk.slice(0, Math.min(remaining, chunk.length)));
  }
  process.stderr.write("\nfixture-large-stderr-end\n");
}

if (mode === "fail-list-secret") process.stderr.write("SECRET_SHOULD_NOT_LEAK_123\n");

markReady();

if (mode === "exit-immediately") process.exit(23);

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    handleLine(line);
  }
});
process.stdin.on("end", () => {
  if (mode !== "ignore-termination" && mode !== "hang-startup") process.exit(0);
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line) {
  if (mode === "hang-startup") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id === undefined || message?.id === null) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mottainai-test-upstream", version: "0.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    if (mode === "fail-list" || mode === "fail-list-secret") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "fixture listTools failure" } });
    } else if (mode === "malformed-result") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: "fixture malformed result" } });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "fixture_echo",
              description: "Deterministic local black-box fixture tool",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      });
    }
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "fixture echo" }] },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown fixture method: ${message.method}` },
  });
}
