import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Runtime validation intentionally consumes the schema exposed by the Tool
 * definition.  Keeping this type local avoids introducing a second schema
 * authority while still covering the JSON Schema vocabulary used by MCP
 * tools.
 */
export interface RuntimeToolSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, RuntimeToolSchema>>;
  readonly patternProperties?: Readonly<Record<string, RuntimeToolSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | RuntimeToolSchema;
  readonly items?: RuntimeToolSchema | readonly RuntimeToolSchema[];
  readonly additionalItems?: boolean | RuntimeToolSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number | boolean;
  readonly exclusiveMaximum?: number | boolean;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly anyOf?: readonly RuntimeToolSchema[];
  readonly oneOf?: readonly RuntimeToolSchema[];
  readonly allOf?: readonly RuntimeToolSchema[];
  readonly not?: RuntimeToolSchema;
}

export const TOOL_ARGUMENT_VALIDATION_ERROR_CODE = "invalid_tool_arguments" as const;
export const MAX_TOOL_VALIDATION_ISSUES = 8 as const;
export const MAX_TOOL_VALIDATION_DEPTH = 32 as const;
export const MAX_TOOL_VALIDATION_NODES = 2_048 as const;
export const MAX_TOOL_VALIDATION_PROPERTIES = 512 as const;
export const MAX_TOOL_VALIDATION_ITEMS = 512 as const;
export const MAX_TOOL_VALIDATION_PATH_LENGTH = 256 as const;
export const MAX_TOOL_VALIDATION_MESSAGE_LENGTH = 1_024 as const;

export interface ToolValidationIssue {
  readonly path: string;
  /** JSON Schema keyword or bounded validator guard that failed. */
  readonly keyword: string;
  readonly message: string;
}

export interface ToolValidationResult {
  readonly ok: boolean;
  readonly code: "ok" | typeof TOOL_ARGUMENT_VALIDATION_ERROR_CODE;
  readonly issues: readonly ToolValidationIssue[];
  readonly truncated: boolean;
}

export class ToolInputValidationError extends Error {
  readonly code = TOOL_ARGUMENT_VALIDATION_ERROR_CODE;
  readonly toolName: string;
  readonly issues: readonly ToolValidationIssue[];
  readonly truncated: boolean;

  constructor(toolName: string, validation: ToolValidationResult) {
    const details = validation.issues.map((issue) => `${issue.path} (${issue.keyword}): ${issue.message}`).join("; ");
    const suffix = validation.truncated ? "; further validation issues omitted" : "";
    super(limitText(`invalid arguments for ${toolName}: ${details}${suffix}`, MAX_TOOL_VALIDATION_MESSAGE_LENGTH));
    this.name = "ToolInputValidationError";
    this.toolName = toolName;
    this.issues = validation.issues;
    this.truncated = validation.truncated;
  }
}

interface ValidationState {
  nodes: number;
}

class IssueCollector {
  readonly issues: ToolValidationIssue[] = [];
  truncated = false;

  add(path: string, keyword: string, message: string): void {
    if (this.issues.length >= MAX_TOOL_VALIDATION_ISSUES) {
      this.truncated = true;
      return;
    }
    this.issues.push({
      path: limitText(path, MAX_TOOL_VALIDATION_PATH_LENGTH),
      keyword: limitText(keyword, 64),
      message: limitText(message, 256),
    });
  }
}

const SUPPORTED_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "string", "number", "integer"]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "patternProperties",
  "required",
  "additionalProperties",
  "items",
  "additionalItems",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);

// These are annotations, not assertions. They may be present in an MCP
// schema without changing validation semantics.
const IGNORED_SCHEMA_ANNOTATIONS = new Set([
  "$comment",
  "$id",
  "$schema",
  "$anchor",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

function limitText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SchemaInspectionState {
  nodes: number;
}

function schemaIssue(issues: IssueCollector, path: string, keyword: string, message: string): void {
  issues.add(path, keyword, message);
}

function inspectSchemaMap(
  value: unknown,
  path: string,
  depth: number,
  state: SchemaInspectionState,
  issues: IssueCollector,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    schemaIssue(issues, path, "invalidSchema", "schema map must be an object");
    return;
  }
  for (const [name, child] of Object.entries(value)) {
    inspectSchemaNode(child, pathForProperty(path, name), depth + 1, state, issues);
  }
}

function inspectSchemaList(
  value: unknown,
  path: string,
  depth: number,
  state: SchemaInspectionState,
  issues: IssueCollector,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    schemaIssue(issues, path, "invalidSchema", "schema list must be an array");
    return;
  }
  for (const [index, child] of value.entries()) {
    inspectSchemaNode(child, `${path}[${index}]`, depth + 1, state, issues);
  }
}

function inspectSchemaNode(
  value: unknown,
  path: string,
  depth: number,
  state: SchemaInspectionState,
  issues: IssueCollector,
): void {
  if (issues.issues.length >= MAX_TOOL_VALIDATION_ISSUES) {
    issues.truncated = true;
    return;
  }
  if (!isRecord(value)) {
    schemaIssue(issues, path, "invalidSchema", "schema node must be an object");
    return;
  }
  if (depth > MAX_TOOL_VALIDATION_DEPTH) {
    schemaIssue(issues, path, "boundedValidation", `schema nesting exceeds ${MAX_TOOL_VALIDATION_DEPTH} levels`);
    return;
  }
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_VALIDATION_NODES) {
    schemaIssue(issues, path, "boundedValidation", `schema inspection exceeds ${MAX_TOOL_VALIDATION_NODES} nodes`);
    return;
  }

  for (const key of Object.keys(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key) && !IGNORED_SCHEMA_ANNOTATIONS.has(key)) {
      schemaIssue(issues, path, "unsupportedSchema", `unsupported schema keyword: ${key}`);
    }
  }

  const type = value.type;
  if (type !== undefined) {
    const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : [];
    if (
      types.length === 0
      || types.some((candidate) => typeof candidate !== "string" || !SUPPORTED_SCHEMA_TYPES.has(candidate))
    ) {
      schemaIssue(issues, path, "invalidSchema", "type contains an unsupported value");
    }
  }

  const required = value.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((name) => typeof name !== "string"))) {
    schemaIssue(issues, path, "invalidSchema", "required must be an array of strings");
  }

  for (const key of ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate))) {
      schemaIssue(issues, path, "invalidSchema", `${key} must be a finite number`);
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)) {
      schemaIssue(issues, path, "invalidSchema", `${key} must be a non-negative integer`);
    }
  }
  if (value.multipleOf !== undefined && (typeof value.multipleOf !== "number" || value.multipleOf <= 0)) {
    schemaIssue(issues, path, "invalidSchema", "multipleOf must be greater than zero");
  }
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
    const candidate = value[key];
    if (
      candidate !== undefined
      && (typeof candidate !== "number" && typeof candidate !== "boolean")
    ) {
      schemaIssue(issues, path, "invalidSchema", `${key} must be a number or boolean`);
    } else if (typeof candidate === "number" && !Number.isFinite(candidate)) {
      schemaIssue(issues, path, "invalidSchema", `${key} must be finite`);
    } else if (
      candidate === true
      && typeof value[key === "exclusiveMinimum" ? "minimum" : "maximum"] !== "number"
    ) {
      schemaIssue(issues, path, "invalidSchema", `${key}=true requires its matching bound`);
    }
  }
  if (typeof value.pattern === "string") {
    try {
      new RegExp(value.pattern, "u");
    } catch {
      schemaIssue(issues, path, "invalidSchema", "pattern declares an invalid regular expression");
    }
  } else if (value.pattern !== undefined) {
    schemaIssue(issues, path, "invalidSchema", "pattern must be a string");
  }

  inspectSchemaMap(value.properties, `${path}.properties`, depth, state, issues);
  inspectSchemaMap(value.patternProperties, `${path}.patternProperties`, depth, state, issues);
  if (value.patternProperties !== undefined && isRecord(value.patternProperties)) {
    for (const pattern of Object.keys(value.patternProperties)) {
      try {
        new RegExp(pattern, "u");
      } catch {
        schemaIssue(issues, path, "invalidSchema", "patternProperties declares an invalid regular expression");
      }
    }
  }

  const additionalProperties = value.additionalProperties;
  if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
    inspectSchemaNode(additionalProperties, `${path}.additionalProperties`, depth + 1, state, issues);
  }
  const items = value.items;
  if (Array.isArray(items)) inspectSchemaList(items, `${path}.items`, depth, state, issues);
  else if (items !== undefined) inspectSchemaNode(items, `${path}.items`, depth + 1, state, issues);
  const additionalItems = value.additionalItems;
  if (additionalItems !== undefined && typeof additionalItems !== "boolean") {
    inspectSchemaNode(additionalItems, `${path}.additionalItems`, depth + 1, state, issues);
  }
  inspectSchemaList(value.anyOf, `${path}.anyOf`, depth, state, issues);
  inspectSchemaList(value.oneOf, `${path}.oneOf`, depth, state, issues);
  inspectSchemaList(value.allOf, `${path}.allOf`, depth, state, issues);
  if (value.not !== undefined) inspectSchemaNode(value.not, `${path}.not`, depth + 1, state, issues);
}

function inspectSchema(schema: unknown, issues: IssueCollector): boolean {
  inspectSchemaNode(schema, "schema", 0, { nodes: 0 }, issues);
  return issues.issues.length === 0;
}

function schemaTypes(schema: RuntimeToolSchema): string[] {
  if (schema.type === undefined) return [];
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === "string") : [];
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    default:
      return false;
  }
}

function displayTypes(types: readonly string[]): string {
  if (types.length === 0) return "a valid value";
  if (types.length === 1) return `a ${types[0]}`;
  return oneOfWords(types.map((type) => `a ${type}`));
}

function oneOfWords(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

function pathForProperty(parent: string, property: string): string {
  const path = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(property)
    ? `${parent}.${property}`
    : `${parent}[${JSON.stringify(property)}]`;
  return limitText(path, MAX_TOOL_VALIDATION_PATH_LENGTH);
}

function pathForIndex(parent: string, index: number): string {
  return limitText(`${parent}[${index}]`, MAX_TOOL_VALIDATION_PATH_LENGTH);
}

function jsonEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth >= MAX_TOOL_VALIDATION_DEPTH || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonEqual(item, right[index], depth + 1));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key], depth + 1));
  }
  return false;
}

function addTypeIssue(schema: RuntimeToolSchema, value: unknown, path: string, issues: IssueCollector): boolean {
  const types = schemaTypes(schema);
  if (types.length === 0 || types.some((type) => typeMatches(value, type))) return true;
  issues.add(path, "type", `must be ${displayTypes(types)}`);
  return false;
}

function addScalarConstraints(schema: RuntimeToolSchema, value: unknown, path: string, issues: IssueCollector): void {
  if (schema.enum !== undefined && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    issues.add(path, "enum", "must be one of the allowed values");
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    issues.add(path, "const", "must equal the declared constant");
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.add(path, "minLength", `must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.add(path, "maxLength", `must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined) {
      let matches = false;
      try {
        matches = new RegExp(schema.pattern, "u").test(value);
      } catch {
        issues.add(path, "pattern", "declares an invalid regular expression");
        return;
      }
      if (!matches) issues.add(path, "pattern", "does not match the declared pattern");
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.add(path, "minimum", `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.add(path, "maximum", `must be at most ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      issues.add(path, "exclusiveMinimum", `must be greater than ${schema.exclusiveMinimum}`);
    } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined && value <= schema.minimum) {
      issues.add(path, "exclusiveMinimum", `must be greater than ${schema.minimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      issues.add(path, "exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}`);
    } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined && value >= schema.maximum) {
      issues.add(path, "exclusiveMaximum", `must be less than ${schema.maximum}`);
    }
    if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (!Number.isInteger(quotient)) issues.add(path, "multipleOf", "must be a multiple of the declared value");
    }
  }
}

function validateObject(
  schema: RuntimeToolSchema,
  value: Record<string, unknown>,
  path: string,
  depth: number,
  state: ValidationState,
  issues: IssueCollector,
): void {
  const keys = Object.keys(value);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    issues.add(path, "minProperties", `must contain at least ${schema.minProperties} properties`);
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    issues.add(path, "maxProperties", `must contain at most ${schema.maxProperties} properties`);
  }
  if (keys.length > MAX_TOOL_VALIDATION_PROPERTIES) {
    issues.add(path, "boundedValidation", `contains more than ${MAX_TOOL_VALIDATION_PROPERTIES} properties`);
  }

  const properties = schema.properties ?? {};
  const patternProperties = schema.patternProperties ?? {};
  const keysToVisit = keys.slice(0, MAX_TOOL_VALIDATION_PROPERTIES);
  for (const key of keysToVisit) {
    const childPath = pathForProperty(path, key);
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (propertySchema !== undefined) validateNode(propertySchema, value[key], childPath, depth + 1, state, issues);

    const matchingPatterns = Object.entries(patternProperties).filter(([pattern]) => {
      try {
        return new RegExp(pattern, "u").test(key);
      } catch {
        issues.add(childPath, "patternProperties", "declares an invalid regular expression");
        return false;
      }
    });
    for (const [, patternSchema] of matchingPatterns) {
      validateNode(patternSchema, value[key], childPath, depth + 1, state, issues);
    }

    if (propertySchema !== undefined || matchingPatterns.length > 0) continue;
    if (schema.additionalProperties === false) {
      issues.add(childPath, "additionalProperties", "property is not allowed");
    } else if (isSchema(schema.additionalProperties)) {
      validateNode(schema.additionalProperties, value[key], childPath, depth + 1, state, issues);
    }
  }

  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) {
      issues.add(pathForProperty(path, required), "required", "property is required");
    }
  }
}

function validateArray(
  schema: RuntimeToolSchema,
  value: readonly unknown[],
  path: string,
  depth: number,
  state: ValidationState,
  issues: IssueCollector,
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.add(path, "minItems", `must contain at least ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.add(path, "maxItems", `must contain at most ${schema.maxItems} items`);
  }
  if (value.length > MAX_TOOL_VALIDATION_ITEMS) {
    issues.add(path, "boundedValidation", `contains more than ${MAX_TOOL_VALIDATION_ITEMS} items`);
  }

  const items = schema.items;
  if (Array.isArray(items as unknown[])) {
    const tupleItems = items as readonly RuntimeToolSchema[];
    const itemCount = Math.min(value.length, MAX_TOOL_VALIDATION_ITEMS);
    for (let index = 0; index < itemCount; index += 1) {
      const itemSchema = tupleItems[index];
      if (itemSchema !== undefined)
        validateNode(itemSchema, value[index], pathForIndex(path, index), depth + 1, state, issues);
      else if (schema.additionalItems === false)
        issues.add(pathForIndex(path, index), "additionalItems", "item is not allowed");
      else if (isSchema(schema.additionalItems)) {
        validateNode(schema.additionalItems, value[index], pathForIndex(path, index), depth + 1, state, issues);
      }
    }
    return;
  }
  if (items === undefined) return;
  if (!isSchema(items)) return;
  const itemCount = Math.min(value.length, MAX_TOOL_VALIDATION_ITEMS);
  for (let index = 0; index < itemCount; index += 1) {
    validateNode(items, value[index], pathForIndex(path, index), depth + 1, state, issues);
  }
}

function isSchema(value: unknown): value is RuntimeToolSchema {
  return isRecord(value);
}

function branchIssues(schema: RuntimeToolSchema, value: unknown, path: string, depth: number): ToolValidationIssue[] {
  const branchCollector = new IssueCollector();
  validateNode(schema, value, path, depth, { nodes: 0 }, branchCollector);
  return branchCollector.issues;
}

function validateCombinators(
  schema: RuntimeToolSchema,
  value: unknown,
  path: string,
  depth: number,
  issues: IssueCollector,
): void {
  if (schema.allOf !== undefined) {
    for (const branch of schema.allOf) validateNode(branch, value, path, depth + 1, { nodes: 0 }, issues);
  }
  if (schema.anyOf !== undefined) {
    const validBranches = schema.anyOf.filter((branch) => branchIssues(branch, value, path, depth + 1).length === 0);
    if (validBranches.length === 0) issues.add(path, "anyOf", "must match at least one declared schema");
  }
  if (schema.oneOf !== undefined) {
    const validBranches = schema.oneOf.filter((branch) => branchIssues(branch, value, path, depth + 1).length === 0);
    if (validBranches.length !== 1) issues.add(path, "oneOf", "must match exactly one declared schema");
  }
  if (schema.not !== undefined && branchIssues(schema.not, value, path, depth + 1).length === 0) {
    issues.add(path, "not", "must not match the declared schema");
  }
}

function validateNode(
  schema: RuntimeToolSchema,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
  issues: IssueCollector,
): void {
  if (issues.issues.length >= MAX_TOOL_VALIDATION_ISSUES) {
    issues.truncated = true;
    return;
  }
  if (depth > MAX_TOOL_VALIDATION_DEPTH) {
    issues.add(path, "boundedValidation", `nesting exceeds ${MAX_TOOL_VALIDATION_DEPTH} levels`);
    return;
  }
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_VALIDATION_NODES) {
    issues.add(path, "boundedValidation", `validation exceeds ${MAX_TOOL_VALIDATION_NODES} nodes`);
    return;
  }

  validateCombinators(schema, value, path, depth, issues);
  if (!addTypeIssue(schema, value, path, issues)) return;
  addScalarConstraints(schema, value, path, issues);
  if (isRecord(value)) validateObject(schema, value, path, depth, state, issues);
  else if (Array.isArray(value)) validateArray(schema, value, path, depth, state, issues);
}

/** Validate an MCP tool call using the exact schema advertised by that Tool. */
export function validateToolArguments(
  tool: Pick<Tool, "name" | "inputSchema">,
  arguments_: unknown,
): ToolValidationResult {
  const rawSchema: unknown = tool.inputSchema;
  const issues = new IssueCollector();
  if (!inspectSchema(rawSchema, issues)) {
    return {
      ok: false,
      code: TOOL_ARGUMENT_VALIDATION_ERROR_CODE,
      issues: issues.issues,
      truncated: issues.truncated,
    };
  }
  const schema = rawSchema as RuntimeToolSchema;
  const normalizedValue = arguments_ === undefined && schemaTypes(schema).includes("object") ? {} : arguments_;
  validateNode(schema, normalizedValue, "arguments", 0, { nodes: 0 }, issues);
  return {
    ok: issues.issues.length === 0,
    code: issues.issues.length === 0 ? "ok" : TOOL_ARGUMENT_VALIDATION_ERROR_CODE,
    issues: issues.issues,
    truncated: issues.truncated,
  };
}

/** Throw the stable validation error used at the MCP dispatch boundary. */
export function assertValidToolArguments(tool: Pick<Tool, "name" | "inputSchema">, arguments_: unknown): void {
  const validation = validateToolArguments(tool, arguments_);
  if (!validation.ok) throw new ToolInputValidationError(tool.name, validation);
}
