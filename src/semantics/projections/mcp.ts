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
  {
    name: "mottainai_semantic_project",
    description: "Query the bounded Project view from the Repository Semantic Model.",
    inputSchema: { type: "object", properties: { provider: providerProperty }, additionalProperties: false },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_semantic_entity",
    description: "Query one bounded semantic Entity view without source bodies.",
    inputSchema: {
      type: "object",
      properties: { provider: providerProperty, id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_semantic_context",
    description: "Project bounded Agent context for a Symbol or Component; source bodies stay excluded.",
    inputSchema: {
      type: "object",
      properties: {
        provider: providerProperty,
        id: { type: "string" },
        targetTask: { type: "string" },
        includeRationale: { type: "boolean" },
        includeReviewGuidance: { type: "boolean" },
        ...budgetProperties,
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_semantic_impact",
    description: "Query the canonical #54 semantic change and impact view used by the Dashboard.",
    inputSchema: { type: "object", properties: { provider: providerProperty }, additionalProperties: false },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_semantic_review",
    description: "Project canonical #54 L0-L3 review data without reclassification.",
    inputSchema: {
      type: "object",
      properties: { provider: providerProperty, ...budgetProperties },
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
  {
    name: "mottainai_semantic_jsdoc",
    description: "Generate disposable English JSDoc compatibility output from declarations and exact signatures.",
    inputSchema: {
      type: "object",
      properties: {
        provider: providerProperty,
        id: { type: "string" },
        locale: { type: "string" },
        ...budgetProperties,
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: readOnly,
  },
];

export const semanticProjectionToolNames = new Set(semanticProjectionTools.map((item) => item.name));

interface ProjectionSchemaProperty {
  type?: "string" | "boolean" | "integer";
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
}

interface ProjectionInputSchema {
  type?: "object";
  properties?: Record<string, ProjectionSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

function record(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (args === undefined) return {};
  if (typeof args !== "object" || args === null || Array.isArray(args))
    throw new Error("projection input must be an object");
  return args;
}

function validateProjectionInput(name: string, input: Record<string, unknown>): void {
  const tool = semanticProjectionTools.find((item) => item.name === name);
  if (tool === undefined) throw new Error(`Unknown semantic projection tool: ${name}`);
  const schema = tool.inputSchema as ProjectionInputSchema;
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(input, key)) throw new Error(`${key} is required for ${name}`);
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(input).find((key) => !Object.hasOwn(properties, key));
    if (unknown !== undefined) throw new Error(`unknown projection input property: ${unknown}`);
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (property === undefined) continue;
    if (property.type === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (property.type === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    if (property.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value)))
      throw new Error(`${key} must be an integer`);
    if (typeof value === "number" && property.minimum !== undefined && value < property.minimum)
      throw new Error(`${key} must be at least ${property.minimum}`);
    if (typeof value === "number" && property.maximum !== undefined && value > property.maximum)
      throw new Error(`${key} must be at most ${property.maximum}`);
    if (property.enum !== undefined && !property.enum.includes(value))
      throw new Error(`${key} must be one of ${property.enum.join(", ")}`);
  }
}

function provider(args: Record<string, unknown>): "live" | "fixture" {
  const value = args.provider;
  if (value === undefined) return "live";
  if (value === "live" || value === "fixture") return value;
  throw new Error("provider must be live or fixture");
}

function projectionOptions<T>(args: Record<string, unknown>): T {
  const keys = Object.keys(budgetProperties);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(args, key)) result[key] = args[key];
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
  const budget = recordValue.budget as
    | { projectedBytes?: number; projectedTokens?: number; truncated?: boolean }
    | undefined;
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
  validateProjectionInput(name, input);
  const query = queryFor(provider(input), rootDir);
  const projections = createSemanticProjectionQuery(query);
  switch (name) {
    case "mottainai_semantic_project": {
      const value = await query.getProject();
      return output("semantic_project", "success", "Repository Semantic Model project view", "", { facts: [value] });
    }
    case "mottainai_semantic_entity": {
      const id = input.id as string;
      const value = await query.getEntity(id);
      if (value === undefined) throw new SemanticQueryError("not_found", `unknown semantic entity: ${id}`);
      return output("semantic_entity", "success", `semantic entity ${value.id}`, "", { facts: [value] });
    }
    case "mottainai_semantic_context":
      return projectionResult(
        "semantic_agent",
        await projections.getAgentContext(input.id as string, {
          ...projectionOptions<AgentProjectionOptions>(input),
          ...(typeof input.targetTask === "string" ? { targetTask: input.targetTask } : {}),
          ...(typeof input.includeRationale === "boolean" ? { includeRationale: input.includeRationale } : {}),
          ...(typeof input.includeReviewGuidance === "boolean"
            ? { includeReviewGuidance: input.includeReviewGuidance }
            : {}),
        }),
      );
    case "mottainai_semantic_impact": {
      const value = await query.getChangeSet();
      return output(
        "semantic_impact",
        value.provenance.status === "unavailable" ? "partial" : "success",
        "canonical semantic change and impact view",
        "",
        { facts: [value] },
      );
    }
    case "mottainai_semantic_review":
      return projectionResult(
        "semantic_review",
        await projections.getReviewProjection(projectionOptions<ReviewProjectionOptions>(input)),
      );
    case "mottainai_semantic_jsdoc":
      return projectionResult(
        "semantic_jsdoc",
        await projections.getJsdocProjection(input.id as string, {
          ...projectionOptions<JsdocProjectionOptions>(input),
          ...(typeof input.locale === "string" ? { locale: input.locale } : {}),
        }),
      );
  }
  throw new Error(`Unknown semantic projection tool: ${name}`);
}
