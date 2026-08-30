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
import { assertValidToolArguments } from "../../mcp-tool-validation.js";

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
const lifecycleSchema = {
  type: ["object", "null"],
  properties: {
    taskState: { type: "string" },
    managerState: { type: ["string", "null"] },
    runtimeState: { type: ["string", "null"] },
    allowedActions: { type: "array", maxItems: 2, items: { type: "string", enum: ["continue", "cancel"] } },
  },
  required: ["taskState", "managerState", "runtimeState", "allowedActions"],
  additionalProperties: false,
} as const;
const evidenceSchema = {
  type: "object",
  properties: {
    latestStatus: { type: "string" },
    latestReceipt: {
      type: "object",
      properties: { code: { type: "string" }, source: { type: "string" }, message: { type: "string" } },
      required: ["code", "source", "message"],
      additionalProperties: false,
    },
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
  required: ["schemaVersion", "operation", "status", "workId", "summary", "lifecycle", "evidence", "artifacts", "truncated"],
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

function parseObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label = "arguments"): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains unsupported field: ${unknown}`);
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function checkVersion(args: Record<string, unknown>): void {
  if (args.schemaVersion !== undefined && args.schemaVersion !== HARNESS_DELEGATION_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version: ${String(args.schemaVersion)}`);
  }
}

function selector(value: unknown, label: string): HarnessSelectorValue {
  if (typeof value === "string") return boundedString(value, label, 2_048);
  const object = parseObject(value, label);
  rejectUnknownKeys(object, ["path", "instanceId"], label);
  const keys = Object.keys(object);
  if (keys.length !== 1) throw new Error(`${label} must contain exactly one selector`);
  if (object.path !== undefined) return { path: boundedString(object.path, `${label}.path`, 2_048) };
  return { instanceId: boundedString(object.instanceId, `${label}.instanceId`, 128) } as HarnessRepositorySelector;
}

function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  return record[key] === undefined ? undefined : boundedString(record[key], `constraints.${key}`, maxLength);
}

function constraints(value: unknown): HarnessWorkConstraints {
  const input = parseObject(value, "constraints");
  rejectUnknownKeys(input, ["taskSlug", "issueRef", "branchType", "agentKind", "launchProfile", "provider", "model", "paths", "claims"], "constraints");
  const paths = input.paths === undefined ? undefined : parsePaths(input.paths);
  const claims = input.claims === undefined ? undefined : parseClaims(input.claims);
  return {
    ...(optionalString(input, "taskSlug", 96) === undefined ? {} : { taskSlug: optionalString(input, "taskSlug", 96) }),
    ...(optionalString(input, "issueRef", 96) === undefined ? {} : { issueRef: optionalString(input, "issueRef", 96) }),
    ...(optionalString(input, "branchType", 32) === undefined ? {} : { branchType: optionalString(input, "branchType", 32) }),
    ...(optionalString(input, "agentKind", 32) === undefined ? {} : { agentKind: optionalString(input, "agentKind", 32) }),
    ...(optionalString(input, "launchProfile", 32) === undefined ? {} : { launchProfile: optionalString(input, "launchProfile", 32) }),
    ...(optionalString(input, "provider", 128) === undefined ? {} : { provider: optionalString(input, "provider", 128) }),
    ...(optionalString(input, "model", 128) === undefined ? {} : { model: optionalString(input, "model", 128) }),
    ...(paths === undefined ? {} : { paths }),
    ...(claims === undefined ? {} : { claims }),
  };
}

function parsePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("constraints.paths must be an array of at most 128 items");
  return value.map((item, index) => boundedString(item, `constraints.paths[${index}]`, 512));
}

function parseClaims(value: unknown): HarnessWorkConstraints["claims"] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("constraints.claims must be an array of at most 128 items");
  return value.map((item, index) => {
    const claim = parseObject(item, `constraints.claims[${index}]`);
    rejectUnknownKeys(claim, ["resource", "mode"], `constraints.claims[${index}]`);
    const resource = boundedString(claim.resource, `constraints.claims[${index}].resource`, 512);
    if (claim.mode !== "read" && claim.mode !== "write" && claim.mode !== "exclusive-write") {
      throw new Error(`constraints.claims[${index}].mode is invalid`);
    }
    return { resource, mode: claim.mode };
  });
}

function delegateArgs(value: unknown): DelegateWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "goal", "workspace", "repository", "constraints", "idempotencyKey"]);
  checkVersion(args);
  if (args.workspace !== undefined && args.repository !== undefined) throw new Error("workspace and repository conflict");
  return {
    goal: boundedString(args.goal, "goal", 65_536),
    ...(args.workspace === undefined ? {} : { workspace: selector(args.workspace, "workspace") }),
    ...(args.repository === undefined ? {} : { repository: selector(args.repository, "repository") }),
    ...(args.constraints === undefined ? {} : { constraints: constraints(args.constraints) }),
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: boundedString(args.idempotencyKey, "idempotencyKey", 128) }),
  };
}

function workIdArgs(value: unknown): { workId: string } {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId"]);
  checkVersion(args);
  return { workId: boundedString(args.workId, "workId", 128) };
}

function continueArgs(value: unknown): ContinueWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId", "followUp"]);
  checkVersion(args);
  return {
    workId: boundedString(args.workId, "workId", 128),
    followUp: boundedString(args.followUp, "followUp", 65_536),
  };
}

function cancelArgs(value: unknown): CancelWorkRequest {
  const args = parseObject(value);
  rejectUnknownKeys(args, ["schemaVersion", "workId", "reason"]);
  checkVersion(args);
  return {
    workId: boundedString(args.workId, "workId", 128),
    ...(args.reason === undefined ? {} : { reason: boundedString(args.reason, "reason", 65_536) }),
  };
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
    const advertisedTool = harnessDelegationTools().find((tool) => tool.name === name);
    if (advertisedTool !== undefined) assertValidToolArguments(advertisedTool, args);
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
