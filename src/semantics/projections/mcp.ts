import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createFixtureQuery } from "../fixtures/dashboard-fixture.js";
import { createLiveRepositoryQuery } from "../model/index.js";
import { SemanticQueryError, type RepositorySemanticQuery } from "../query.js";
import { output, OUTPUT_SCHEMA } from "../../envelope.js";
import { createSemanticProjectionQuery } from "./query.js";
import type { AgentProjectionOptions, JsdocProjectionOptions, ReviewProjectionOptions } from "./types.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const providerProperty = { type: "string", enum: ["live", "fixture"], default: "live" } as const;
const budgetProperties = {
  softTokens: { type: "integer", minimum: 128 },
  hardTokens: { type: "integer", minimum: 256 },
  hardBytes: { type: "integer", minimum: 1_024 },
  maxFacts: { type: "integer", minimum: 1 },
  maxRelations: { type: "integer", minimum: 1 },
  maxSymbols: { type: "integer", minimum: 1 },
  maxSourceReads: { type: "integer", minimum: 1 },
  maxEvidence: { type: "integer", minimum: 1 },
  maxChanges: { type: "integer", minimum: 1 },
  maxImpactPaths: { type: "integer", minimum: 1 },
  maxRationales: { type: "integer", minimum: 1 },
  maxGuidance: { type: "integer", minimum: 1 },
} as const;

export const semanticProjectionTools: Tool[] = [
  { name: "mottainai_semantic_project", description: "Query the bounded Project view from the Repository Semantic Model.", inputSchema: { type: "object", properties: { provider: providerProperty }, additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
  { name: "mottainai_semantic_entity", description: "Query one bounded semantic Entity view without source bodies.", inputSchema: { type: "object", properties: { provider: providerProperty, id: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
  { name: "mottainai_semantic_context", description: "Project bounded Agent context for a Symbol or Component; source bodies stay excluded.", inputSchema: { type: "object", properties: { provider: providerProperty, id: { type: "string" }, targetTask: { type: "string" }, includeRationale: { type: "boolean" }, includeReviewGuidance: { type: "boolean" }, ...budgetProperties }, required: ["id"], additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
  { name: "mottainai_semantic_impact", description: "Query the canonical #54 semantic change and impact view used by the Dashboard.", inputSchema: { type: "object", properties: { provider: providerProperty }, additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
  { name: "mottainai_semantic_review", description: "Project canonical #54 L0-L3 review data without reclassification.", inputSchema: { type: "object", properties: { provider: providerProperty, ...budgetProperties }, additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
  { name: "mottainai_semantic_jsdoc", description: "Generate disposable English JSDoc compatibility output from declarations and exact signatures.", inputSchema: { type: "object", properties: { provider: providerProperty, id: { type: "string" }, locale: { type: "string" }, ...budgetProperties }, required: ["id"], additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, annotations: readOnly },
];

export const semanticProjectionToolNames = new Set(semanticProjectionTools.map((item) => item.name));

function record(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return args ?? {};
}

function provider(args: Record<string, unknown>): "live" | "fixture" {
  const value = args.provider;
  if (value === undefined) return "live";
  if (value === "live" || value === "fixture") return value;
  throw new Error("provider must be live or fixture");
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function projectionOptions<T>(args: Record<string, unknown>): T {
  const keys = Object.keys(budgetProperties);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = optionalInteger(args, key);
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

function queryFor(kind: "live" | "fixture", rootDir: string): RepositorySemanticQuery {
  return kind === "fixture" ? createFixtureQuery() : createLiveRepositoryQuery({ rootDir });
}

function projectionResult(operation: string, value: object): CallToolResult {
  const recordValue = value as Record<string, unknown>;
  const model = recordValue.model as { status?: string } | undefined;
  const status = model?.status === undefined || model.status === "fresh" ? "success" : "partial";
  const budget = recordValue.budget as { projectedBytes?: number; projectedTokens?: number; truncated?: boolean } | undefined;
  return output(operation, status, `${operation} semantic projection`, "", {
    facts: [value],
    metrics: {
      ...(budget?.projectedBytes === undefined ? {} : { projected_bytes: budget.projectedBytes }),
      ...(budget?.projectedTokens === undefined ? {} : { projected_tokens: budget.projectedTokens }),
    },
    truncated: budget?.truncated === true,
  });
}

export async function callSemanticProjectionTool(
  name: string,
  args: Record<string, unknown> | undefined,
  rootDir: string,
): Promise<CallToolResult> {
  if (!semanticProjectionToolNames.has(name)) throw new Error(`Unknown semantic projection tool: ${name}`);
  const input = record(args);
  const query = queryFor(provider(input), rootDir);
  const projections = createSemanticProjectionQuery(query);
  switch (name) {
    case "mottainai_semantic_project": {
      const value = await query.getProject();
      return output("semantic_project", "success", "Repository Semantic Model project view", "", { facts: [value] });
    }
    case "mottainai_semantic_entity": {
      const value = await query.getEntity(String(input.id));
      if (value === undefined) throw new SemanticQueryError("not_found", `unknown semantic entity: ${String(input.id)}`);
      return output("semantic_entity", "success", `semantic entity ${value.id}`, "", { facts: [value] });
    }
    case "mottainai_semantic_context":
      return projectionResult(
        "semantic_agent",
        await projections.getAgentContext(String(input.id), {
          ...projectionOptions<AgentProjectionOptions>(input),
          ...(typeof input.targetTask === "string" ? { targetTask: input.targetTask } : {}),
          ...(typeof input.includeRationale === "boolean" ? { includeRationale: input.includeRationale } : {}),
          ...(typeof input.includeReviewGuidance === "boolean" ? { includeReviewGuidance: input.includeReviewGuidance } : {}),
        }),
      );
    case "mottainai_semantic_impact": {
      const value = await query.getChangeSet();
      return output("semantic_impact", value.provenance.status === "unavailable" ? "partial" : "success", "canonical semantic change and impact view", "", { facts: [value] });
    }
    case "mottainai_semantic_review":
      return projectionResult("semantic_review", await projections.getReviewProjection(projectionOptions<ReviewProjectionOptions>(input)));
    case "mottainai_semantic_jsdoc":
      return projectionResult("semantic_jsdoc", await projections.getJsdocProjection(String(input.id), {
        ...projectionOptions<JsdocProjectionOptions>(input),
        ...(typeof input.locale === "string" ? { locale: input.locale } : {}),
      }));
  }
  throw new Error(`Unknown semantic projection tool: ${name}`);
}
