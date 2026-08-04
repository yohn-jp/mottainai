import fs from "node:fs";
import path from "node:path";
import { buildCapabilityIndex } from "../src/adaptive/capabilities.js";
import type { CapabilityIndex } from "../src/adaptive/capabilities.js";
import { loadConfigSnapshot } from "../src/config.js";
import { evaluateRead, DEFAULT_POLICY } from "../src/read-governor/policy.js";
import type { ReadRequest } from "../src/read-governor/policy.js";

/**
 * hook-facing CLI for the Read Governor.
 * Reads one JSON request from stdin, writes one JSON decision to stdout, logs
 * bounded metadata (no file content) to MOTTAINAI_READ_GOVERNOR_LOG_DIR.
 * No network calls; safe to invoke on every relevant PreToolUse call.
 */

/**
 * upstream を起動せず宣言済み capability だけを読む（`UpstreamRegistry` 経由の起動は
 * このCLIの「no network calls」契約を壊すため使わない）。設定が無い/壊れている環境では
 * builtin capability だけの索引にfall backする。
 */
function loadCapabilityIndex(): CapabilityIndex {
  try {
    const { config, gatewayConfig } = loadConfigSnapshot();
    const upstreams = Object.entries(config.mcpServers).map(([name, upstream]) => ({ name, ...upstream }));
    return buildCapabilityIndex(upstreams, gatewayConfig.capabilityMap);
  } catch {
    return buildCapabilityIndex([]);
  }
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function logDecision(request: ReadRequest, decision: ReturnType<typeof evaluateRead>): void {
  const logDir = process.env.MOTTAINAI_READ_GOVERNOR_LOG_DIR ?? path.join(process.cwd(), ".mottainai", "log", "read-governor");
  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const file = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = {
      timestamp: new Date().toISOString(),
      path: request.path,
      estimatedLines: request.estimatedLines,
      bounded: request.bounded === true,
      action: decision.action,
      fileClass: decision.fileClass,
      capability: decision.capability,
      policyCode: decision.policyCode,
      stage: decision.stage,
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // logging is best-effort; never block the decision on a logging failure.
  }
}

function main(): void {
  const raw = readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ action: "allow", policyCode: "NONE", reason: "malformed request; allowing" }));
    return;
  }

  if (typeof parsed !== "object" || parsed === null || typeof (parsed as Record<string, unknown>).path !== "string") {
    process.stdout.write(JSON.stringify({ action: "allow", policyCode: "NONE", reason: "missing path; allowing" }));
    return;
  }

  const record = parsed as Record<string, unknown>;
  const request: ReadRequest = {
    path: record.path as string,
    estimatedLines: typeof record.estimatedLines === "number" ? record.estimatedLines : undefined,
    bounded: record.bounded === true,
  };

  const decision = evaluateRead(request, DEFAULT_POLICY, loadCapabilityIndex());
  logDecision(request, decision);
  process.stdout.write(JSON.stringify(decision));
}

main();
