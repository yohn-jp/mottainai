import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  HARNESS_DELEGATION_SCHEMA_VERSION,
  HARNESS_DELEGATION_STATUSES,
  HARNESS_ERROR_CLASSES,
  HarnessDelegationService,
  MAX_HARNESS_ARTIFACTS,
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

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const mutation = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const schemaVersion = {
  type: "integer",
  enum: [HARNESS_DELEGATION_SCHEMA_VERSION],
  description: "Optional protocol schema version; omitted means version 1.",
} as const;

const selectorSchema = {
  oneOf: [
    { type: "string", minLength: 1, maxLength: 2_048 },
    {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 2_048 },
        instanceId: { type: "string", minLength: 1, maxLength: 128 },
      },
      minProperties: 1,
      maxProperties: 1,
      additionalProperties: false,
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
    provider: { type: "string", minLength: 1, maxLength: 128 },
    model: { type: "string", minLength: 1, maxLength: 128 },
    paths: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 512 },
    },
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

const lifecycleSchema = {
  type: ["object", "null"],
  properties: {
    taskState: { type: "string" },
    managerState: { type: ["string", "null"] },
    runtimeState: { type: ["string", "null"] },
    allowedActions: {
      type: "array",
      maxItems: 2,
      items: { type: "string", enum: ["continue", "cancel"] },
    },
  },
  required: ["taskState", "managerState", "runtimeState", "allowedActions"],
  additionalProperties: false,
} as const;

const receiptSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    source: { type: "string" },
    message: { type: "string" },
  },
  required: ["code", "source", "message"],
  additionalProperties: false,
} as const;

const evidenceSchema = {
  type: "object",
  properties: {
    latestStatus: { type: "string" },
    latestReceipt: receiptSchema,
  },
  additionalProperties: false,
} as const;

const artifactsSchema = {
  type: "array",
  maxItems: MAX_HARNESS_ARTIFACTS,
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["pull_request"] },
      provider: { type: "string" },
      repositoryId: { type: "string" },
      number: { type: "integer" },
      url: { type: "string" },
      state: { type: "string" },
    },
    required: ["kind", "provider", "repositoryId", "number", "url", "state"],
    additionalProperties: false,
  },
} as const;

const errorSchema = {
  type: "object",
  properties: {
    class: { type: "string", enum: [...HARNESS_ERROR_CLASSES] },
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["class", "code", "message"],
  additionalProperties: false,
} as const;

const capabilitiesSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [HARNESS_DELEGATION_SCHEMA_VERSION] },
    protocol: { type: "string", enum: ["mcp"] },
    transport: { type: "string", enum: ["stdio"] },
    tools: { type: "array", items: { type: "string" } },
    statuses: { type: "array", items: { type: "string", enum: [...HARNESS_DELEGATION_STATUSES] } },
    errorClasses: { type: "array", items: { type: "string", enum: [...HARNESS_ERROR_CLASSES] } },
    executable: { type: "string", enum: ["mottainai-mcp"] },
  },
  required: ["schemaVersion", "protocol", "transport", "tools", "statuses", "errorClasses", "executable"],
  additionalProperties: false,
} as const;

const delegationOutputSchema = {
  type: "object" as const,
  properties: {
    schemaVersion: { type: "integer", enum: [HARNESS_DELEGATION_SCHEMA_VERSION] },
    operation: { type: "string" },
    status: { type: "string", enum: [...HARNESS_DELEGATION_STATUSES] },
    workId: { type: ["string", "null"] },
    summary: { type: "string" },
    lifecycle: lifecycleSchema,
    evidence: evidenceSchema,
    artifacts: artifactsSchema,
    truncated: { type: "boolean" },
    reused: { type: "boolean" },
    error: errorSchema,
    capabilities: capabilitiesSchema,
  },
  required: [
    "schemaVersion",
    "operation",
    "status",
    "workId",
    "summary",
    "lifecycle",
    "evidence",
    "artifacts",
    "truncated",
  ],
  additionalProperties: false,
};

const delegateWorkTool: Tool = {
  name: "mottainai_delegate_work",
  description: "Delegate one bounded goal through Mottainai's existing governed harness lifecycle.",
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion,
      goal: { type: "string", minLength: 1, maxLength: 65_536 },
      workspace: selectorSchema,
      repository: selectorSchema,
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
  description: "Inspect one delegated work item by its stable workId.",
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
  description: "Continue an eligible work item through its existing Manager session.",
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion,
      workId: { type: "string", minLength: 1, maxLength: 128 },
      followUp: { type: "string", minLength: 1, maxLength: 65_536 },
    },
    required: ["workId", "followUp"],
    additionalProperties: false,
  },
  outputSchema: delegationOutputSchema,
  annotations: mutation,
};

const cancelWorkTool: Tool = {
  name: "mottainai_cancel_work",
  description: "Cancel one work item through existing task and Manager lifecycle authority.",
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
  description: "Describe the versioned packaged stdio harness-delegation surface.",
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

function parseObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("arguments must be an object");
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`unsupported argument: ${unknown}`);
}

function checkVersion(args: Record<string, unknown>): void {
  if (args.schemaVersion !== undefined && args.schemaVersion !== HARNESS_DELEGATION_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version: ${String(args.schemaVersion)}`);
  }
}

function selector(value: unknown, label: string): HarnessSelectorValue {
  if (typeof value === "string") return value;
  const object = parseObject(value);
  rejectUnknownKeys(object, ["path", "instanceId"]);
  return object as HarnessRepositorySelector;
}

function delegateArgs(value: unknown): DelegateWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "goal", "workspace", "repository", "constraints", "idempotencyKey"]);
  checkVersion(args);
  if (typeof args.goal !== "string") throw new Error("goal must be a string");
  if (args.workspace !== undefined && args.repository !== undefined) {
    throw new Error("workspace and repository conflict");
  }
  if (args.constraints !== undefined && !isRecord(args.constraints)) throw new Error("constraints must be an object");
  if (args.idempotencyKey !== undefined && typeof args.idempotencyKey !== "string") {
    throw new Error("idempotencyKey must be a string");
  }
  return {
    goal: args.goal,
    ...(args.workspace === undefined ? {} : { workspace: selector(args.workspace, "workspace") }),
    ...(args.repository === undefined ? {} : { repository: selector(args.repository, "repository") }),
    ...(args.constraints === undefined ? {} : { constraints: args.constraints as HarnessWorkConstraints }),
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
  };
}

function workIdArgs(value: unknown): { workId: string } {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId"]);
  checkVersion(args);
  if (typeof args.workId !== "string") throw new Error("workId must be a string");
  return { workId: args.workId };
}

function continueArgs(value: unknown): ContinueWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId", "followUp"]);
  checkVersion(args);
  if (typeof args.workId !== "string") throw new Error("workId must be a string");
  if (typeof args.followUp !== "string") throw new Error("followUp must be a string");
  return { workId: args.workId, followUp: args.followUp };
}

function cancelArgs(value: unknown): CancelWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId", "reason"]);
  checkVersion(args);
  if (typeof args.workId !== "string") throw new Error("workId must be a string");
  if (args.reason !== undefined && typeof args.reason !== "string") throw new Error("reason must be a string");
  return { workId: args.workId, ...(args.reason === undefined ? {} : { reason: args.reason }) };
}

function resultFor(operation: string, result: HarnessOperationResult): CallToolResult {
  const work = result.work;
  const summary = work?.summary ?? result.error?.message ?? `work ${result.status}`;
  const structuredContent = {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    operation,
    status: result.status,
    workId: work?.workId ?? null,
    summary,
    lifecycle: work?.lifecycle ?? null,
    evidence: work?.evidence ?? {},
    artifacts: work?.artifacts ?? [],
    truncated: work?.truncated ?? false,
    ...(result.reused === undefined ? {} : { reused: result.reused }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
    ...(result.ok ? {} : { isError: true }),
  };
}

function capabilitiesResult(): CallToolResult {
  const capabilities = {
    schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
    protocol: "mcp",
    transport: "stdio",
    tools: [...HARNESS_DELEGATION_TOOL_NAMES],
    statuses: [...HARNESS_DELEGATION_STATUSES],
    errorClasses: [...HARNESS_ERROR_CLASSES],
    executable: "mottainai-mcp",
  };
  return {
    content: [{ type: "text", text: "native harness-delegation MCP capability metadata" }],
    structuredContent: {
      schemaVersion: HARNESS_DELEGATION_SCHEMA_VERSION,
      operation: HARNESS_CAPABILITIES_TOOL_NAME,
      status: "completed",
      workId: null,
      summary: "native harness-delegation MCP capability metadata",
      lifecycle: null,
      evidence: {},
      artifacts: [],
      truncated: false,
      capabilities,
    },
  };
}

export async function callHarnessDelegationTool(
  name: string,
  args: Record<string, unknown> | undefined,
  service: HarnessDelegationService | undefined,
): Promise<CallToolResult> {
  try {
    if (name === HARNESS_CAPABILITIES_TOOL_NAME) {
      const parsed = args ?? {};
      rejectUnknownKeys(parsed, ["schemaVersion"]);
      checkVersion(parsed);
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
    if (name === "mottainai_delegate_work") return resultFor(name, await service.delegate(delegateArgs(args)));
    if (name === "mottainai_inspect_work") return resultFor(name, await service.inspect(workIdArgs(args).workId));
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
