import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { adapterForClient, hookAdapters } from "./adapters/index.js";
import type { HookClientAdapter, HookProjection } from "./adapters/types.js";
import { deriveTrustedHookContext } from "./context.js";
import { capabilityRegistryFromRuntime } from "./capabilities.js";
import { dispatchHookDetailed } from "./dispatcher.js";
import { createHookPolicyProviders } from "./providers/index.js";
import { recordHookExplanation, readHookExplanation } from "./explain.js";
import {
  applyHookLifecycle,
  discoverHookClients,
  isDispatcherPathAvailable,
  type HookClientReport,
  type HookLifecycleContext,
} from "./install/lifecycle.js";
import {
  DEFAULT_HOOK_MAX_OUTPUT_BYTES,
  DEFAULT_HOOK_POLICY,
  DEFAULT_HOOK_TIMEOUT_MS,
  loadHookPolicy,
  validateHookPolicy,
  writeHookPolicy,
} from "./policy.js";
import { loadConfigSnapshot } from "../config.js";
import { createTelemetrySink } from "../telemetry.js";
import type { ManagedCapabilityIdentity } from "./capabilities.js";
import type { TelemetrySink } from "../telemetry.js";
import type { ReadGovernorPolicy } from "../context-runtime/read-policy.js";
import type { HookPolicyProvider } from "./providers/types.js";
import { boundHookDecision, boundHookText } from "./types.js";
import type { HookDecision, HookEvent, HookFailureMode, HookOperation, HookRolloutMode } from "./types.js";

export interface HookCommandContext {
  workspaceRoot: string;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  dispatcherCommand?: string;
  dispatcherArguments?: readonly string[];
  exposedTools?: ReadonlySet<string>;
  /** Verified by the caller from the effective client registration. */
  managedCapability?: ManagedCapabilityIdentity;
  configPath?: string;
  readPolicy?: ReadGovernorPolicy;
  workflowProvider?: HookPolicyProvider;
  telemetry?: Pick<TelemetrySink, "recordHookDecision" | "flush">;
}

export interface HookCommandResult {
  ok: boolean;
  action: string;
  [key: string]: unknown;
}

export interface HookDispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: HookDecision;
  event?: HookEvent;
}

function resolveCommand(command: string, environment: NodeJS.ProcessEnv): string | undefined {
  if (command.includes(path.sep) || command.startsWith(".")) {
    const candidate = path.resolve(command);
    return executableFile(candidate) ? candidate : undefined;
  }
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (executableFile(candidate)) return candidate;
  }
  return undefined;
}

function executableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    // Native Windows is unsupported by the hook installer; on POSIX systems
    // the generated hook must not point at a file lacking any execute bit.
    return stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
  } catch {
    // PATH entries may disappear during a status check.
    return false;
  }
}

function probeVersion(executable: string, environment: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 1_000, env: environment });
  if (result.status !== 0) return undefined;
  const output = `${result.stdout ?? ""}`.trim().replace(/\s+/gu, " ");
  return output.length > 0 && output.length <= 160 ? output : undefined;
}

function lifecycleContext(context: HookCommandContext): HookLifecycleContext {
  const dispatcherCommand = context.dispatcherCommand ?? "mottainai";
  const loadedPolicy = loadHookPolicy(context.workspaceRoot);
  return {
    workspaceRoot: context.workspaceRoot,
    homeDirectory: context.homeDirectory,
    resolveCommand: (command) => resolveCommand(command, context.environment),
    probeVersion: (executable) => probeVersion(executable, context.environment),
    dispatcherCommand,
    dispatcherArguments: context.dispatcherArguments,
    hookTimeoutMs: loadedPolicy.ok ? loadedPolicy.policy.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS,
  };
}

function selectedClient(args: string[]): string | undefined {
  const index = args.indexOf("--client");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value !== "claude" && value !== "codex" && value !== "all") throw new Error("--client must be claude, codex, or all");
  return value;
}

function selectedMode(args: string[]): HookRolloutMode | undefined {
  const index = args.indexOf("--mode");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value !== "observe" && value !== "warn" && value !== "enforce") throw new Error("--mode must be observe, warn, or enforce");
  return value;
}

function shortProjection(value: string, maximum: number): string {
  return boundHookText(value, maximum);
}

/** Bound stdout+stderr together; client processes observe both streams. */
function boundedProjection(projection: HookProjection, maximum: number): HookProjection {
  const limit = Math.max(0, maximum);
  const stdout = shortProjection(projection.stdout, limit);
  const remaining = Math.max(0, limit - Buffer.byteLength(stdout, "utf8"));
  return {
    exitCode: projection.exitCode,
    stdout,
    stderr: shortProjection(projection.stderr, remaining),
  };
}

function fallbackEvent(client: "claude" | "codex", context: HookCommandContext): HookEvent {
  const trusted = deriveTrustedHookContext({ workspaceRoot: context.workspaceRoot });
  return {
    version: 1,
    client,
    clientEvent: "PreToolUse",
    operation: "other",
    ...(trusted.repository === undefined ? {} : { repository: trusted.repository }),
    ...(trusted.worktree === undefined ? {} : { worktree: trusted.worktree }),
  };
}

function malformedDecision(policyResult: ReturnType<typeof loadHookPolicy>, client: "claude" | "codex"): HookDecision {
  const closed = policyResult.ok && policyResult.policy.failureModes.other === "closed";
  return boundHookDecision({
    version: 1,
    decision: closed ? "deny" : "allow",
    reason: "malformed_client_event",
    diagnostic: closed ? "failure_mode=closed" : "failure_mode=open",
  });
}

function readPolicyFor(context: HookCommandContext): ReadGovernorPolicy | undefined {
  if (context.readPolicy !== undefined) return context.readPolicy;
  try {
    return loadConfigSnapshot(context.configPath, context.workspaceRoot).gatewayConfig.readGovernor;
  } catch {
    return undefined;
  }
}

function recordHookTrace(telemetry: Pick<TelemetrySink, "recordHookDecision">, trace: Awaited<ReturnType<typeof dispatchHookDetailed>>): void {
  telemetry.recordHookDecision({
    provider: "generic",
    state: "authoritative",
    decision: trace.baseline.decision,
    reason: trace.baseline.reason,
  });
  for (const result of trace.providers) {
    telemetry.recordHookDecision({
      provider: result.provider,
      state: result.state,
      decision: result.action ?? "allow",
      reason: result.reason,
    });
  }
}

async function flushHookTelemetry(telemetry: Pick<TelemetrySink, "flush">): Promise<void> {
  try {
    await telemetry.flush?.();
  } catch {
    // Telemetry is diagnostic-only and must not alter hook protocol behavior.
  }
}

export async function dispatchClientHook(
  client: string,
  payload: unknown,
  context: HookCommandContext,
): Promise<HookDispatchResult> {
  const adapter = adapterForClient(client);
  if (adapter === undefined) {
    return { exitCode: 0, stdout: "", stderr: "", decision: { version: 1, decision: "allow", reason: "adapter_unsupported" } };
  }
  const telemetry = context.telemetry ?? createTelemetrySink(context.environment);
  const policyResult = loadHookPolicy(context.workspaceRoot);
  const trusted = deriveTrustedHookContext({ workspaceRoot: context.workspaceRoot });
  const normalized = adapter.normalize(payload, {
    workspaceRoot: context.workspaceRoot,
    ...trusted,
    ...(context.managedCapability === undefined ? {} : { managedCapability: context.managedCapability }),
  });
  if (!normalized.ok) {
    const decision = malformedDecision(policyResult, adapter.client);
    const projection = boundedProjection(
      adapter.project(decision, fallbackEvent(adapter.client, context)),
      policyResult.ok ? policyResult.policy.maxOutputBytes : DEFAULT_HOOK_MAX_OUTPUT_BYTES,
    );
    telemetry.recordHookDecision({ provider: "generic", state: "unavailable", decision: decision.decision, reason: decision.reason });
    await flushHookTelemetry(telemetry);
    return { ...projection, decision };
  }
  if (!policyResult.ok) {
    const closed = DEFAULT_HOOK_POLICY.failureModes[normalized.event.operation] === "closed";
    const decision = boundHookDecision({
      version: 1,
      decision: closed ? "deny" : "allow",
      reason: "policy_invalid",
      diagnostic: closed ? "failure_mode=closed" : "failure_mode=open",
    });
    const projection = boundedProjection(adapter.project(decision, normalized.event), DEFAULT_HOOK_MAX_OUTPUT_BYTES);
    telemetry.recordHookDecision({ provider: "generic", state: "unavailable", decision: decision.decision, reason: decision.reason });
    await flushHookTelemetry(telemetry);
    return { ...projection, decision, event: normalized.event };
  }
  const event = normalized.event;
  const dispatcherAvailable = isDispatcherPathAvailable(
    context.dispatcherCommand ?? "mottainai",
    (command) => resolveCommand(command, context.environment),
    context.workspaceRoot,
  );
  // Core policy never assumes that a replacement exists. The CLI supplies the
  // live local-tool surface at the runtime boundary; direct embedders must do so
  // explicitly so the configured fail-open/fail-closed mode can be applied.
  const exposedTools = context.exposedTools ?? new Set<string>();
  const capabilities = capabilityRegistryFromRuntime({
    dispatcherAvailable,
    exposedTools,
    managedCapability: context.managedCapability,
  });
  const trace = await dispatchHookDetailed(event, {
    policy: policyResult.policy,
    capabilities,
    providers: createHookPolicyProviders({
      workspaceRoot: context.workspaceRoot,
      readPolicy: readPolicyFor(context),
      workflowProvider: context.workflowProvider,
    }),
  });
  const decision = trace.decision;
  try {
    recordHookExplanation(context.workspaceRoot, event, decision, policyResult.policy, capabilities, trace.providers);
  } catch {
    // Explanation persistence is diagnostic-only. It must not turn an already
    // bounded policy decision into an unbounded hook error.
  }
  recordHookTrace(telemetry, trace);
  const projection = boundedProjection(adapter.project(decision, event), policyResult.policy.maxOutputBytes);
  await flushHookTelemetry(telemetry);
  return {
    exitCode: projection.exitCode,
    stdout: projection.stdout,
    stderr: projection.stderr,
    decision,
    event,
  };
}

function validateClient(value: string | undefined): HookClientAdapter | undefined {
  if (value === undefined || value === "all") return undefined;
  const adapter = adapterForClient(value);
  if (adapter === undefined) throw new Error(`unsupported hook client: ${value}`);
  return adapter;
}

function policyWithMode(context: HookCommandContext, mode: HookRolloutMode | undefined) {
  const loaded = loadHookPolicy(context.workspaceRoot);
  if (!loaded.ok) throw new Error(`invalid hooks policy: ${loaded.reason}`);
  if (mode === undefined) return loaded;
  return { ...loaded, policy: validateHookPolicy({ ...loaded.policy, mode }) };
}

function diagnostics(reports: readonly HookClientReport[], policyError: string | undefined, dispatcher: boolean): string[] {
  const result = policyError === undefined ? [] : [`policy: ${policyError}`];
  if (!dispatcher) result.push("dispatcher command is not resolvable");
  for (const report of reports) {
    if (report.state === "unsupported" || report.state === "incompatible") result.push(`${report.client}: ${report.reason ?? report.state}`);
    if (report.state === "installed" && report.managedEntry !== "healthy") result.push(`${report.client}: managed entry ${report.managedEntry}`);
  }
  return result;
}

export function runManagedHooksCommand(action: string, args: string[], context: HookCommandContext): HookCommandResult {
  const selected = selectedClient(args);
  const adapter = validateClient(selected);
  const lifecycle = lifecycleContext(context);
  if (action === "status") {
    const policy = loadHookPolicy(context.workspaceRoot);
    const dispatcherAvailable = isDispatcherPathAvailable(context.dispatcherCommand ?? "mottainai", lifecycle.resolveCommand, context.workspaceRoot);
    const reports = discoverHookClients(hookAdapters, lifecycle).map((report) => ({
      ...report,
      effectiveMode: policy.ok ? policy.policy.mode : undefined,
    }));
    const lifecycleHealthy = reports.every((report) => {
      if (report.state === "unsupported" || report.state === "incompatible") return false;
      return report.managedEntry !== "drifted" && report.managedEntry !== "unsupported";
    });
    const dispatcherRequired = reports.some((report) => report.managedEntry !== "missing");
    return {
      ok: policy.ok && lifecycleHealthy && (!dispatcherRequired || dispatcherAvailable),
      action,
      workspace: context.workspaceRoot,
      dispatcherAvailable,
      policy: policy.ok ? policy.policy : undefined,
      clients: reports,
    };
  }
  if (action === "install" || action === "repair" || action === "uninstall") {
    const selectedModeValue = selectedMode(args);
    if (action === "repair" && !loadHookPolicy(context.workspaceRoot).ok) {
      writeHookPolicy(context.workspaceRoot, DEFAULT_HOOK_POLICY);
    }
    if (selectedModeValue !== undefined) {
      const policy = policyWithMode(context, selectedModeValue);
      writeHookPolicy(context.workspaceRoot, policy.policy);
    } else if (action === "install" && !loadHookPolicy(context.workspaceRoot).ok) {
      throw new Error("invalid hooks policy; repair it before install");
    }
    const reports = applyHookLifecycle(action, hookAdapters, lifecycle, adapter?.client ?? selected);
    return { ok: reports.every((report) => report.error === undefined), action, workspace: context.workspaceRoot, clients: reports };
  }
  if (action === "doctor") {
    const policy = loadHookPolicy(context.workspaceRoot);
    const reports = discoverHookClients(hookAdapters, lifecycle).map((report) => ({
      ...report,
      effectiveMode: policy.ok ? policy.policy.mode : undefined,
    }));
  const dispatcher = isDispatcherPathAvailable(context.dispatcherCommand ?? "mottainai", lifecycle.resolveCommand, context.workspaceRoot);
    const problems = diagnostics(reports, policy.ok ? undefined : policy.reason, dispatcher);
    return { ok: problems.length === 0, action, workspace: context.workspaceRoot, clients: reports, problems };
  }
  if (action === "explain") {
    const decisionId = args.find((value) => /^hd_[a-f0-9]{16}$/u.test(value));
    if (decisionId === undefined) throw new Error("hooks explain requires a decision id");
    const explanation = readHookExplanation(context.workspaceRoot, decisionId);
    return explanation === undefined
      ? { ok: false, action, decision_id: decisionId, error: "decision explanation not found" }
      : { ok: true, action, explanation };
  }
  throw new Error("hooks command must be install, status, doctor, repair, uninstall, or explain");
}
