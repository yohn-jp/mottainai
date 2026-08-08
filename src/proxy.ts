import { performance } from "node:perf_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildCapabilityIndex } from "./adaptive/capabilities.js";
import { extractCallerMetadata } from "./adaptive/caller.js";
import type { CallerMetadata } from "./adaptive/caller.js";
import { loadActivePolicy, resolvePlan, resolvePolicyDir } from "./adaptive/policy.js";
import { adaptiveTools, callAdaptiveTool, isAdaptiveTool } from "./adaptive/tools.js";
import type { AdaptiveToolContext } from "./adaptive/tools.js";
import { attachDecisionMetadata } from "./adaptive/decision-metadata.js";
import { createTraceStore } from "./adaptive/trace.js";
import { brokerTools, dispatchBrokerTool, isBrokerTool } from "./broker.js";
import { buildCatalog, profileAllows } from "./catalog.js";
import { riskOf } from "./catalog.js";
import { codeSearchTools, dispatchCodeSearchTool, isCodeSearchTool } from "./code-search.js";
import type { ToolCatalog } from "./catalog.js";
import { isCompressionEnabled, isToolDescriptionCompressionEnabled } from "./compress/config.js";
import { compressToolDefinition } from "./compress/tool-description.js";
import { resolveGatewayConfig } from "./config.js";
import type { ProfileConfig, ResolvedGatewayConfig } from "./config.js";
import { allLocalTools, callLocalTool, localToolsFor } from "./local-tools.js";
import { callWorkflowCommandTool, workflowCommandTools, workflowCommandToolsFor } from "./workflow/commands/mcp-tools.js";
import type { Logger } from "./logging.js";
import { InMemoryArtifactStore } from "./retrieve.js";
import type { ArtifactStore } from "./retrieve.js";
import { createTelemetrySink } from "./telemetry.js";
import type { TelemetrySink } from "./telemetry.js";
import { hasUpstreamDiagnostic, upstreamBaseErrorMessage, upstreamErrorMessage, UpstreamRegistry } from "./upstream.js";
import { callUpstreamTool, RETRIEVE_TOOL_NAME } from "./upstream-call.js";
import { applyExecutionBudget, normalizeExecutionOutcome, providerErrorOutcome } from "./execution.js";
import type { ExecutionOutcome } from "./execution.js";
import type { ToolRisk } from "./catalog.js";

const SEP = "__";

const retrieveTool: Tool = {
  name: RETRIEVE_TOOL_NAME,
  description: "Deprecated alias for mottainai_result_get. Retrieve original text omitted by proxy compression.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Original-result ID from compression metadata." },
      query: { type: "string", description: "Optional literal text; return begins at first matching line." },
      contextLines: { type: "integer", minimum: 0, maximum: 20, description: "Lines before a query match; default 0." },
      startLine: { type: "integer", minimum: 0, description: "Optional zero-based result line." },
      maxLines: { type: "integer", minimum: 1, maximum: 80, description: "Maximum lines; default 80." },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

function prefixedName(upstreamName: string, toolName: string): string {
  return `${upstreamName}${SEP}${toolName}`;
}

function splitPrefixedName(name: string): { upstreamName: string; toolName: string } {
  const idx = name.indexOf(SEP);
  if (idx === -1) throw new Error(`Unrecognized tool name (no upstream prefix): ${name}`);
  return { upstreamName: name.slice(0, idx), toolName: name.slice(idx + SEP.length) };
}

function compressVisibleToolDefinition(tool: Tool): Tool {
  return isCompressionEnabled() && isToolDescriptionCompressionEnabled()
    ? compressToolDefinition(tool)
    : tool;
}

function prepareUpstreamToolDefinition(upstreamName: string, tool: Tool): Tool {
  return { ...compressVisibleToolDefinition(tool), name: prefixedName(upstreamName, tool.name) };
}

function gatewayToolRisk(name: string): ToolRisk {
  const definition = [...allLocalTools, ...workflowCommandTools, ...adaptiveTools, ...brokerTools, ...codeSearchTools, retrieveTool]
    .find((tool) => tool.name === name);
  return riskOf(definition?.annotations);
}

/** local tool は structured output に、upstream 結果は追記 text に request_id を返す。 */
function withRequestId(result: CallToolResult, requestId: string, structured: boolean): CallToolResult {
  if (structured && typeof result.structuredContent === "object" && result.structuredContent !== null) {
    return { ...result, structuredContent: { ...result.structuredContent, request_id: requestId } };
  }
  return {
    ...result,
    content: [...(result.content ?? []), { type: "text" as const, text: `[mottainai trace: request_id=${requestId}]` }],
  };
}

/**
 * Step2: callTool結果の圧縮。Step3: listToolsのdescription機械的圧縮。
 * 併せて、呼び出し側が `_mottainai` で添えたタスク metadata を trace として記録する。
 */
export function registerProxyHandlers(
  server: Server,
  upstreams: UpstreamRegistry,
  logger: Logger,
  artifactStore: ArtifactStore | undefined = undefined,
  gatewayConfig: ResolvedGatewayConfig = resolveGatewayConfig(undefined),
  adaptiveOverrides: Partial<AdaptiveToolContext> = {},
  activeProfile: ProfileConfig | undefined = undefined,
  telemetry: TelemetrySink = createTelemetrySink(),
): void {
  const resolvedArtifactStore = artifactStore ?? new InMemoryArtifactStore({
    ttlMs: gatewayConfig.resultTtlMs,
    maxEntries: gatewayConfig.resultMaxEntries,
  });
  const adaptive: AdaptiveToolContext = {
    traceStore: adaptiveOverrides.traceStore ?? createTraceStore(),
    capabilityIndex: adaptiveOverrides.capabilityIndex
      ?? buildCapabilityIndex(upstreams.configs(), gatewayConfig.capabilityMap),
    // 承認は gateway 外（CLI）で起きる。呼び出しごとに読み直して再起動なしで反映する。
    loadPolicy: adaptiveOverrides.loadPolicy ?? (() => loadActivePolicy()),
    policyDir: adaptiveOverrides.policyDir ?? resolvePolicyDir(),
    artifactStore: adaptiveOverrides.artifactStore ?? resolvedArtifactStore,
  };

  /** ready な upstream から目録を作る。起動に失敗した upstream は目録にも載らない。 */
  async function catalog(): Promise<ToolCatalog> {
    const started = await Promise.allSettled(upstreams.enabledNames().map((name) => upstreams.start(name)));
    const handles = started.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    return buildCatalog(handles, upstreams.configs(), gatewayConfig.capabilityMap, gatewayConfig.toolMetadata);
  }

  const upstreamCall = { upstreams, logger, artifactStore: resolvedArtifactStore, telemetry };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const entries = (await catalog()).tools().filter((entry) => profileAllows(entry, activeProfile));
    const tools = entries.map((entry) => prepareUpstreamToolDefinition(entry.provider, entry.definition));
    // brokered tool は profile に関わらず常に出す。絞り込みは既定の面を減らすためで、到達手段を奪わない。
    const gatewayTools = [...localToolsFor(gatewayConfig), ...workflowCommandToolsFor(gatewayConfig), ...adaptiveTools, ...brokerTools, ...codeSearchTools, retrieveTool]
      .map(compressVisibleToolDefinition);
    return { tools: [...tools, ...gatewayTools] };
  });

  /** metadata 付き呼び出しの trace 開始。request_id 指定時は既存 trace へ足す。 */
  async function openRequest(metadata: CallerMetadata): Promise<string> {
    if (metadata.request_id !== undefined) return metadata.request_id;
    const policy = adaptive.loadPolicy();
    const plan = resolvePlan(policy, metadata.task?.category ?? "unknown", metadata.requested_capabilities);
    const request = await adaptive.traceStore.beginRequest({
      task_category: plan.task_category,
      task_intent: metadata.task?.intent,
      task_confidence: metadata.task?.confidence,
      caller_requested_capabilities: metadata.requested_capabilities,
      planned_capabilities: plan.capabilities,
      added_by_policy: plan.added_by_policy,
      suppressed_by_policy: plan.suppressed,
      policy_version: plan.policy_version,
      unknown_labels: metadata.unknown_labels,
      context: metadata.context,
    });
    return request.request_id;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const { metadata, forwardedArguments } = extractCallerMetadata(request.params.arguments);
    const isLocal = toolName === RETRIEVE_TOOL_NAME || localToolsFor(gatewayConfig).some((tool) => tool.name === toolName);
    const isWorkflowCommand = workflowCommandToolsFor(gatewayConfig).some((tool) => tool.name === toolName);
    const isAdaptive = isAdaptiveTool(toolName);
    const requestId = metadata === undefined ? undefined : await openRequest(metadata);
    const capability = metadata === undefined
      ? undefined
      : adaptive.capabilityIndex.capabilityForCall({ toolName, arguments: forwardedArguments, declared: metadata.capability });
    const startedAt = performance.now();

    async function record(outcome: ExecutionOutcome | undefined): Promise<void> {
      if (requestId === undefined || outcome === undefined) return;
      await adaptive.traceStore.recordExecution({
        request_id: requestId,
        provider: outcome.selectedProvider,
        tool: outcome.selectedTool,
        capability: outcome.capability,
        duration_ms: Math.round(performance.now() - startedAt),
        result_count: outcome.resultCount,
        output_size: outcome.outputSize,
        status: outcome.status,
        attempts: outcome.attempts.length > 0 ? outcome.attempts : undefined,
      });
    }

    await authorize(toolName, isLocal || isWorkflowCommand, isAdaptive);

    let dispatched: ExecutionOutcome;
    try {
      dispatched = await dispatch(toolName, forwardedArguments, isLocal, isWorkflowCommand, isAdaptive, capability);
    } catch (error) {
      const selected = toolName.includes(SEP) ? splitPrefixedName(toolName) : undefined;
      await record(selected === undefined
        ? normalizeExecutionOutcome({
          result: { content: [], isError: true },
          selectedProvider: isBrokerTool(toolName) ? "gateway" : "local",
          selectedTool: toolName,
          capability: capability ?? "unknown",
          risk: gatewayToolRisk(toolName),
          status: "tool_error",
        })
        : providerErrorOutcome({
          selectedProvider: selected.upstreamName,
          selectedTool: selected.toolName,
          capability: capability ?? "unknown",
          risk: "unknown",
          error: upstreamBaseErrorMessage(error),
        }));
      if (!hasUpstreamDiagnostic(error)) throw error;
      const diagnosticMessage = upstreamErrorMessage(error);
      if (error instanceof McpError) {
        const prefix = `MCP error ${error.code}: `;
        const originalMessage = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
        const suffix = diagnosticMessage.startsWith(error.message)
          ? diagnosticMessage.slice(error.message.length).replace(/^; /u, "")
          : diagnosticMessage;
        throw McpError.fromError(error.code, `${originalMessage}; ${suffix}`, error.data);
      }
      throw new Error(diagnosticMessage);
    }
    const budgeted = applyExecutionBudget(
      dispatched,
      toolName,
      capability ?? dispatched.capability,
      gatewayConfig,
      resolvedArtifactStore,
    );
    const finalOutcome = normalizeExecutionOutcome({
      ...budgeted.outcome,
      result: attachDecisionMetadata(budgeted.outcome.result, budgeted.decision === undefined ? {} : {
        budget: budgeted.decision,
      }),
      attempts: budgeted.outcome.attempts,
    });
    await record(finalOutcome);
    // brokered search/describe は structured を返し、brokered call は upstream 結果をそのまま返す。
    return requestId === undefined
      ? finalOutcome.result
      : withRequestId(finalOutcome.result, requestId, isLocal || isWorkflowCommand || isAdaptive || isBrokerTool(toolName) || isCodeSearchTool(toolName));
  });

  async function authorize(toolName: string, isLocal: boolean, isAdaptive: boolean): Promise<void> {
    if (activeProfile === undefined || isBrokerTool(toolName)) return;
    if (isLocal || isAdaptive || isCodeSearchTool(toolName)) {
      const capabilities = isAdaptive ? ["routing"] : isCodeSearchTool(toolName) ? ["code.search"] : ["local"];
      if (!profileAllows({ capabilities, risk: gatewayToolRisk(toolName) }, activeProfile)) {
        throw new Error(`tool denied by active profile: ${toolName}`);
      }
      return;
    }
    const { upstreamName, toolName: upstreamToolName } = splitPrefixedName(toolName);
    const entry = (await catalog()).tools().find((tool) => tool.provider === upstreamName && tool.tool === upstreamToolName);
    if (entry === undefined || !profileAllows(entry, activeProfile)) {
      throw new Error(`tool denied by active profile: ${toolName}`);
    }
  }

  async function dispatch(
    toolName: string,
    args: Record<string, unknown> | undefined,
    isLocal: boolean,
    isWorkflowCommand: boolean,
    isAdaptive: boolean,
    capability: string | undefined,
  ): Promise<ExecutionOutcome> {
    if (toolName === RETRIEVE_TOOL_NAME) {
      const id = typeof args?.id === "string" ? args.id : undefined;
      if (!id) throw new Error("mottainai_retrieve requires string argument: id");
      const retrieved = resolvedArtifactStore.retrieve(id, {
        query: typeof args?.query === "string" ? args.query : undefined,
        contextLines: typeof args?.contextLines === "number" ? args.contextLines : undefined,
        startLine: typeof args?.startLine === "number" ? args.startLine : undefined,
        maxLines: typeof args?.maxLines === "number" ? args.maxLines : undefined,
      });
      if (!retrieved) throw new Error(`Original result unavailable or expired: ${id}`);
      telemetry.recordRetrieval();
      const result = { content: [{ type: "text" as const, text: JSON.stringify(retrieved) }] };
      return normalizeExecutionOutcome({
        result,
        selectedProvider: "local",
        selectedTool: toolName,
        capability: capability ?? "local",
        risk: gatewayToolRisk(toolName),
      });
    }

    if (isAdaptive) {
      const result = await callAdaptiveTool(toolName, args, adaptive);
      return normalizeExecutionOutcome({
        result,
        selectedProvider: "local",
        selectedTool: toolName,
        capability: capability ?? "routing",
        risk: gatewayToolRisk(toolName),
      });
    }

    if (isLocal) {
      const result = await callLocalTool(toolName, args, gatewayConfig, resolvedArtifactStore, upstreams, telemetry);
      return normalizeExecutionOutcome({
        result,
        selectedProvider: "local",
        selectedTool: toolName,
        capability: capability ?? "local",
        risk: gatewayToolRisk(toolName),
      });
    }

    if (isWorkflowCommand) {
      const result = await callWorkflowCommandTool(toolName, args, gatewayConfig);
      return normalizeExecutionOutcome({
        result,
        selectedProvider: "local",
        selectedTool: toolName,
        capability: capability ?? "local",
        risk: gatewayToolRisk(toolName),
      });
    }

    if (isBrokerTool(toolName)) {
      const dispatched = await dispatchBrokerTool(toolName, args, { ...upstreamCall, catalog, activeProfile, gatewayConfig });
      if (dispatched.outcome !== undefined) return dispatched.outcome;
      return normalizeExecutionOutcome({
        result: dispatched.result,
        selectedProvider: dispatched.routing?.provider ?? "gateway",
        selectedTool: dispatched.routing?.tool ?? toolName,
        selectedBackend: dispatched.routing?.backend,
        capability: capability ?? "routing",
        risk: gatewayToolRisk(toolName),
      });
    }

    if (isCodeSearchTool(toolName)) {
      const dispatched = await dispatchCodeSearchTool(toolName, args, {
        ...upstreamCall, catalog, activeProfile, gatewayConfig, capabilityIndex: adaptive.capabilityIndex,
      });
      if (dispatched.outcome !== undefined) return dispatched.outcome;
      return normalizeExecutionOutcome({
        result: dispatched.result,
        selectedProvider: dispatched.routing?.provider ?? "gateway",
        selectedTool: dispatched.routing?.tool ?? toolName,
        selectedBackend: dispatched.routing?.backend,
        capability: capability ?? "unknown",
        risk: gatewayToolRisk(toolName),
      });
    }

    const { upstreamName, toolName: upstreamToolName } = splitPrefixedName(toolName);
    const budgetCapability = adaptive.capabilityIndex.capabilityForCall({ toolName, arguments: args });
    const { result, decision, outcome } = await callUpstreamTool(
      upstreamCall, upstreamName, upstreamToolName, args, { config: gatewayConfig, capability: budgetCapability },
    );
    const finalResult = attachDecisionMetadata(result, decision);
    return normalizeExecutionOutcome({
      result: finalResult,
      selectedProvider: outcome.selectedProvider,
      selectedTool: outcome.selectedTool,
      selectedBackend: outcome.selectedBackend,
      capability: budgetCapability ?? outcome.capability,
      risk: outcome.risk,
      attempts: outcome.attempts,
    });
  }
}
