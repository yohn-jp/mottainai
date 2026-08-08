import type { IdentityHint, ResultIdentity } from "./identity.js";

export interface ProjectionBudgetConfig {
  softTokens?: number;
  hardTokens?: number;
  hardBytes?: number;
}

export interface ProjectionBudget {
  softTokens: number;
  hardTokens: number;
  hardBytes: number;
}

export type ProjectionFieldPriority = "actionable" | "test" | "retrieval" | "metric" | "excerpt" | "verbose";

export interface Omission {
  field: string;
  reason: string;
  retrievalAvailable: boolean;
}

export interface ProjectedField {
  key: string;
  value: unknown;
  priority: ProjectionFieldPriority;
}

export interface ProjectionInput {
  structuredContent: Record<string, unknown>;
  content: unknown[];
  isError?: boolean;
  meta?: unknown;
}

export interface ProjectedResult {
  operation: string;
  status: string;
  summary: string;
  facts: unknown[];
  diagnostics: unknown[];
  metrics: Record<string, unknown>;
  testResults?: Record<string, unknown>;
  resultId: string;
  truncated: boolean;
  fields: ProjectedField[];
  omissions: Omission[];
  content: unknown[];
  identity?: IdentityHint | ResultIdentity;
  isError?: boolean;
  meta?: unknown;
}

export interface ProjectionMetadata {
  version: 1;
  omissions: Omission[];
}

export interface SerializedProjection {
  content: unknown[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  meta?: unknown;
}

export interface ProjectionStats {
  rawBytes: number;
  storedBytes: number;
  returnedBytes: number;
  omittedBytes: number;
  estimatedProjectedTokens: number;
}
