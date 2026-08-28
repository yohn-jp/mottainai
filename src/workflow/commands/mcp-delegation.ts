import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  HARNESS_DELEGATION_SCHEMA_VERSION,
  HARNESS_DELEGATION_STATUSES,
  HARNESS_ERROR_CLASSES,
  HarnessDelegationService,
  type CancelWorkRequest,
  type ContinueWorkRequest,
  type DelegateWorkRequest,
  type HarnessOperationResult,
  type HarnessRepositorySelector,
  type HarnessSelectorValue,
  type HarnessWorkConstraints,
} from "../domain/harness-delegation.js";

export const HARNESS_DELEGATION_TOOL_NAMES = [
  "mottainai_delegate_work",
  "mottainai_inspect_work",
  "mottainai_continue_work",
  "mottainai_cancel_work",
] as const;
export type HarnessDelegationToolName = (typeof HARNESS_DELEGATION_TOOL_NAMES)[number];
export const HARNESS_CAPABILITIES_TOOL_NAME = "mottainai_harness_capabilities" as const;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const schemaVersion = {
  type: "integer",
  enum: [HARNESS_DELEGATION_SCHEMA_VERSION],
  description: "Optional protocol schema version; omitted means version 1.",
} as const;

const selectorSchema = {
  oneOf: [
    { type: "string", minLength: 1, maxLength: 2_048, description: "Explicit workspace path." },
    {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 2_048 },
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
      },
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
    },
  ],
} as const;

const constraintsSchema = {
  type: "object",
  properties: {
    taskSlug: { type: "string", minLength: 1, maxLength: 96 },
    issueRef: { type: "string", minLength: 1, maxLength: 96 },
    branchType: { type: "string", minLength: 1, maxLength: 32 },
    agentKind: { type: "string", minLength: 1, maxLength: 32 },
    launchProfile: { type: "string", minLength: 1, maxLength: 32 },
    provider: { type: "string", minLength: 1, maxLength: 128 },
    model: { type: "string", minLength: 1, maxLength: 128 },
    paths: { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 512 } },
    claims: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          resource: { type: "string", minLength: 1, maxLength: 512 },
          mode: { type: "string", enum: ["read", "write", "exclusive-write"] },
        },
        required: ["resource", "mode"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

const delegationOutputSchema = {
  type: "object" as const,
  properties: {
    schemaVersion: { type: "integer", enum: [HARNESS_DELEGATION_SCHEMA_VERSION] },
    operation: { type: "string" },
    status: { type: "string", enum: [...HARNESS_DELEGATION_STATUSES] },
    summary: { type: "string" },
    facts: { type: "array", maxItems: 16 },
    diagnostics: { type: "array", maxItems: 8 },
    metrics: { type: "object" },
    result_id: { type: "string" },
    truncated: { type: "boolean" },
    workId: { type: ["string", "null"] },
    lifecycle: { type: ["object", "null"] },
    identity: { type: ["object", "null"] },
    outcome: { type: "object" },
    evidence: { type: "object" },
    artifacts: { type: "array", maxItems: 16 },
    capabilities: { type: "object" },
    reused: { type: "boolean" },
    error: { type: "object" },
  },
  required: [
    "schemaVersion",
    "operation",
    "status",
    "summary",
    "facts",
    "diagnostics",
    "metrics",
    "result_id",
    "truncated",
    "workId",
    "lifecycle",
    "identity",
    "outcome",
    "evidence",
    "artifacts",
  ],
  additionalProperties: false,
};

const delegateWorkTool: Tool = {
  name: "mottainai_delegate_work",
  description:
    "Delegate one bounded goal to Mottainai's existing governed task/session/workflow lifecycle. Returns a stable opaque workId; workspace and repository selectors are explicit and never inferred from the goal or caller cwd.",
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion,
      goal: { type: "string", minLength: 1, maxLength: 65_536 },
      workspace: selectorSchema,
      repository: selectorSchema,
      workspaceSelector: selectorSchema,
      constraints: constraintsSchema,
      idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["goal"],
    additionalProperties: false,
  },
  outputSchema: delegationOutputSchema,
  annotations: mutation,
};

const inspectWorkTool: Tool = {
  name: "mottainai_inspect_work",
  description:
    "Read a bounded, deterministic projection of one delegated work item. workId is the only selector; no cwd or prose-based fallback is used.",
  inputSchema: {
    type: "object",
    properties: { schemaVersion, workId: { type: "string", minLength: 1, maxLength: 128 } },
    required: ["workId"],
    additionalProperties: false,
  },
  outputSchema: delegationOutputSchema,
  annotations: readOnly,
};

const continueWorkTool: Tool = {
  name: "mottainai_continue_work",
  description:
    "Apply one bounded follow-up to an eligible existing delegated work item and relaunch its existing managed execution context. Terminal or ambiguous lifecycle states are rejected deterministically; no new work item is created.",
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion,
      workId: { type: "string", minLength: 1, maxLength: 128 },
      followUp: { type: "string", minLength: 1, maxLength: 65_536 },
      instruction: { type: "string", minLength: 1, maxLength: 65_536, description: "Compatibility alias for followUp." },
    },
    required: ["workId"],
    anyOf: [{ required: ["followUp"] }, { required: ["instruction"] }],
    additionalProperties: false,
  },
  outputSchema: delegationOutputSchema,
  annotations: mutation,
};

const cancelWorkTool: Tool = {
  name: "mottainai_cancel_work",
  description:
    "Cancel one delegated work item through the existing task lifecycle and identity-gated Manager stop authority. It never kills an unrelated process or session.",
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion,
      workId: { type: "string", minLength: 1, maxLength: 128 },
      reason: { type: "string", minLength: 1, maxLength: 65_536 },
    },
    required: ["workId"],
    additionalProperties: false,
  },
  outputSchema: delegationOutputSchema,
  annotations: mutation,
};

const capabilitiesTool: Tool = {
  name: HARNESS_CAPABILITIES_TOOL_NAME,
  description:
    "Describe the versioned native harness-delegation surface, bounded statuses/errors, and its packaged stdio launch contract. This metadata is sufficient for a future optional gateway discovery layer; no gateway dependency is required.",
  inputSchema: { type: "object", properties: { schemaVersion }, additionalProperties: false },
  outputSchema: delegationOutputSchema,
  annotations: readOnly,
};

export function harnessDelegationTools(): Tool[] {
  return [delegateWorkTool, inspectWorkTool, continueWorkTool, cancelWorkTool, capabilitiesTool];
}

export function isHarnessDelegationTool(name: string): name is HarnessDelegationToolName {
  return (HARNESS_DELEGATION_TOOL_NAMES as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains unsupported field: ${unknown}`);
}

function versionArg(args: Record<string, unknown>): void {
  if (args.schemaVersion !== undefined && args.schemaVersion !== HARNESS_DELEGATION_SCHEMA_VERSION)
    throw new Error(`unsupported harness delegation schema version: ${String(args.schemaVersion)}`);
}

function selectorArg(value: unknown, label: string): HarnessSelectorValue {
  if (typeof value === "string") return value;
  if (!isRecord(value)) throw new Error(`${label} must be a string or selector object`);
  rejectUnknownKeys(value, ["path", "instanceId"], label);
  if (value.path !== undefined && typeof value.path !== "string") throw new Error(`${label}.path must be a string`);
  if (value.instanceId !== undefined && typeof value.instanceId !== "string")
    throw new Error(`${label}.instanceId must be a string`);
  return {
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
  } as HarnessRepositorySelector;
}

function optionalSelector(args: Record<string, unknown>, key: string): HarnessSelectorValue | undefined {
  const value = args[key];
  return value === undefined ? undefined : selectorArg(value, key);
}

function constraintsArg(value: unknown): HarnessWorkConstraints | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("constraints must be an object");
  rejectUnknownKeys(
    value,
    ["taskSlug", "issueRef", "branchType", "agentKind", "launchProfile", "provider", "model", "paths", "claims"],
    "constraints",
  );
  return value as HarnessWorkConstraints;
}

function delegateArgs(value: unknown): DelegateWorkRequest {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  rejectUnknownKeys(value, ["schemaVersion", "goal", "workspace", "repository", "workspaceSelector", "constraints", "idempotencyKey"], "arguments");
  versionArg(value);
  if (typeof value.goal !== "string") throw new Error("goal must be a string");
  const selectors = [value.workspace, value.repository, value.workspaceSelector].filter((item) => item !== undefined);
  if (selectors.length > 1) throw new Error("supply only one of workspace, repository, or workspaceSelector");
  return {
    goal: value.goal,
    ...(value.workspace === undefined ? {} : { workspace: optionalSelector(value, "workspace") }),
    ...(value.repository === undefined ? {} : { repository: optionalSelector(value, "repository") }),
    ...(value.workspaceSelector === undefined ? {} : { workspaceSelector: optionalSelector(value, "workspaceSelector") }),
    ...(value.constraints === undefined ? {} : { constraints: constraintsArg(value.constraints) }),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey as string }),
  };
}

function workIdArgs(value: unknown, label: string): { workId: string } {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  rejectUnknownKeys(value, ["schemaVersion", "workId"], "arguments");
  versionArg(value);
  if (typeof value.workId !== "string") throw new Error("workId must be a string");
  return { workId: value.workId };
}

function continueArgs(value: unknown): ContinueWorkRequest {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  rejectUnknownKeys(value, ["schemaVersion", "workId", "followUp", "instruction"], "arguments");
  versionArg(value);
  if (typeof value.workId !== "string") throw new Error("workId must be a string");
  if (value.followUp !== undefined && typeof value.followUp !== "string") throw new Error("followUp must be a string");
  if (value.instruction !== undefined && typeof value.instruction !== "string") throw new Error("instruction must be a string");
  if (value.followUp === undefined && value.instruction === undefined) throw new Error("followUp is required");
  if (value.followUp !== undefined && value.instruction !== undefined && value.followUp !== value.instruction)
    throw new Error("followUp and instruction conflict");
  return { workId: value.workId, followUp: (value.followUp ?? value.instruction) as string };
}

function cancelArgs(value: unknown): CancelWorkRequest {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  rejectUnknownKeys(value, ["schemaVersion", "workId", "reason"], "arguments");
  versionArg(value);
  if (typeof value.workId !== "string") throw new Error("workId must be a string");
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("reason must be a string");
  return { workId: value.workId, ...(value.reason === undefined ? {} : { reason: value.reason }) };
}

function capabilitiesResult(): CallToolResult {
  const metadata = {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    protocol: "mcp",
    transport: "stdio",
    tools: [...HARNESS_DELEGATION_TOOL_NAMES],
    statuses: [...HARNESS_DELEGATION_STATUSES],
    errorClasses: [...HARNESS_ERROR_CLASSES],
    workIdentity: "opaque stable workId; use it for inspect/continue/cancel",
    launch: {
      executable: "mottainai-mcp",
      args: ["--config", "<absolute-config-path>"],
      environment: "MOTTAINAI_CONFIG",
      discovery: "tools/list plus this capability tool; no source-tree or gateway import required",
    },
    futureGateway: "optional discovery consumer; Majiwari is not a runtime dependency",
  };
  const structuredContent = {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    operation: HARNESS_CAPABILITIES_TOOL_NAME,
    status: "completed",
    summary: "native harness-delegation MCP capability metadata",
    facts: [metadata],
    diagnostics: [],
    metrics: { bounded: true, schema_version: HARNESS_DELEGATION_SCHEMA_VERSION },
    result_id: "",
    truncated: false,
    workId: null,
    lifecycle: null,
    identity: null,
    outcome: { semanticState: "capabilities", summary: "native harness-delegation MCP capability metadata" },
    evidence: { receipts: [] },
    artifacts: [],
    capabilities: metadata,
  };
  return {
    content: [{ type: "text", text: structuredContent.summary }],
    structuredContent,
  };
}

function resultFor(operation: string, result: HarnessOperationResult): CallToolResult {
  const work = result.work;
  const summary = work?.outcome.summary ?? result.error?.message ?? `work operation ${result.status}`;
  const structuredContent = {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    operation,
    status: result.status,
    summary,
    facts: work === undefined
      ? []
      : [{ workId: work.workId, status: work.status, taskState: work.lifecycle.taskState }],
    diagnostics: result.error === undefined
      ? []
      : [{ severity: "error", class: result.error.class, code: result.error.code, message: result.error.message }],
    metrics: {
      bounded: true,
      schema_version: HARNESS_DELEGATION_SCHEMA_VERSION,
      artifact_count: work?.artifacts.length ?? 0,
      receipt_count: work?.evidence.receipts.length ?? 0,
    },
    result_id: "",
    truncated: work?.truncated ?? false,
    workId: work?.workId ?? null,
    lifecycle: work?.lifecycle ?? null,
    identity: work?.identity ?? null,
    outcome: work?.outcome ?? { semanticState: result.status, summary },
    evidence: work?.evidence ?? { receipts: [] },
    artifacts: work?.artifacts ?? [],
    ...(result.reused === undefined ? {} : { reused: result.reused }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
    ...(result.ok ? {} : { isError: true }),
  };
}

export async function callHarnessDelegationTool(
  name: string,
  args: Record<string, unknown> | undefined,
  service: HarnessDelegationService | undefined,
): Promise<CallToolResult> {
  if (name === HARNESS_CAPABILITIES_TOOL_NAME) {
    if (args !== undefined) {
      if (!isRecord(args)) return resultFor(name, { ok: false, status: "failed", error: { class: "invalid_input", code: "invalid_input", message: "arguments must be an object" } });
      rejectUnknownKeys(args, ["schemaVersion"], "arguments");
      versionArg(args);
    }
    return capabilitiesResult();
  }
  if (!isHarnessDelegationTool(name)) throw new Error(`unknown harness delegation tool: ${name}`);
  if (service === undefined) {
    return resultFor(name, {
      ok: false,
      status: "failed",
      error: {
        class: "unavailable_capability",
        code: "native_delegation_unavailable",
        message: "native harness delegation is unavailable in this runtime",
      },
    });
  }
  try {
    if (name === "mottainai_delegate_work") return resultFor(name, await service.delegate(delegateArgs(args)));
    if (name === "mottainai_inspect_work") return resultFor(name, await service.inspect(workIdArgs(args, name).workId));
    if (name === "mottainai_continue_work") return resultFor(name, await service.continueWork(continueArgs(args)));
    return resultFor(name, await service.cancelWork(cancelArgs(args)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return resultFor(name, {
      ok: false,
      status: "failed",
      error: { class: "invalid_input", code: "invalid_input", message: message.slice(0, 512) },
    });
  }
}
