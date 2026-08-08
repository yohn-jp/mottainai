import type { ArtifactStore } from "../retrieve.js";
import { createProjectionIdentity, createResultIdentity, isIdentityHint, makeResultIdentity } from "./identity.js";
import type { IdentityAdapter, IdentityHint, ResultIdentity } from "./identity.js";
import type { ProjectionBudget, ProjectedField, ProjectedResult } from "./types.js";

const MAX_SESSION_ENTRIES = 256;
const NAVIGATION_FIELDS = new Set([
  "path",
  "mode",
  "requested_mode",
  "startLine",
  "endLine",
  "stream",
  "query",
  "totalLines",
  "returnedStartLine",
  "returnedEndLine",
  "omittedLines",
  "matchLine",
  "file_line_count",
  "file_bytes",
  "next_command",
  "raw_artifact",
]);

interface SeenIdentity {
  identity_id: string;
  content_id: string;
  projection_id: string;
  result_id: string;
  source_key: string;
}

export interface IdentityObservation {
  identity_id: string;
  content_id: string;
  projection_id: string;
  result_id: string;
  source_key: string;
  if_changed_from?: string;
}

export interface IdentityMatch {
  hit: boolean;
  collision: boolean;
  backing_result_id?: string;
  previous_id?: string;
}

/**
 * Connection-local identity memory. It stores opaque IDs and retrieval metadata only;
 * source text and tool output remain in the ArtifactStore or the filesystem.
 */
export class IdentitySession {
  private readonly entries = new Map<string, SeenIdentity>();
  private readonly latestBySource = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_SESSION_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("identity session maxEntries must be positive");
    this.maxEntries = maxEntries;
  }

  lookup(input: IdentityObservation): IdentityMatch {
    const existing = this.entries.get(input.identity_id);
    if (existing !== undefined) {
      if (existing.content_id !== input.content_id || existing.projection_id !== input.projection_id) {
        return { hit: false, collision: true, previous_id: this.latestBySource.get(input.source_key) };
      }
      this.touch(existing.identity_id, existing);
      return { hit: true, collision: false, backing_result_id: existing.result_id };
    }

    const previousId = this.latestBySource.get(input.source_key);
    if (input.if_changed_from === input.identity_id) {
      return { hit: true, collision: false, previous_id: previousId };
    }
    return { hit: false, collision: false, previous_id: previousId };
  }

  remember(input: IdentityObservation): boolean {
    const existing = this.entries.get(input.identity_id);
    if (existing !== undefined) {
      if (existing.content_id !== input.content_id || existing.projection_id !== input.projection_id) return false;
      existing.result_id = input.result_id;
      existing.source_key = input.source_key;
      this.touch(existing.identity_id, existing);
      this.latestBySource.set(input.source_key, input.identity_id);
      return true;
    }

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (removed !== undefined && this.latestBySource.get(removed.source_key) === oldest) {
        this.latestBySource.delete(removed.source_key);
      }
    }
    const entry: SeenIdentity = {
      identity_id: input.identity_id,
      content_id: input.content_id,
      projection_id: input.projection_id,
      result_id: input.result_id,
      source_key: input.source_key,
    };
    this.entries.set(input.identity_id, entry);
    this.latestBySource.set(input.source_key, input.identity_id);
    return true;
  }

  reset(): void {
    this.entries.clear();
    this.latestBySource.clear();
  }

  dispose(): void {
    this.reset();
  }

  get size(): number {
    return this.entries.size;
  }

  private touch(key: string, value: SeenIdentity): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }
}

export interface DedupeContext {
  session: IdentitySession;
  adapter: IdentityAdapter;
}

export interface DedupeResult {
  result: ProjectedResult;
  eligible: boolean;
  hit: boolean;
  collision: boolean;
}

function navigationFields(fields: ProjectedField[]): ProjectedField[] {
  return fields
    .filter((field) => NAVIGATION_FIELDS.has(field.key))
    .map((field) => {
      if (typeof field.value !== "string") return field;
      const value = Buffer.byteLength(field.value, "utf8") <= 512
        ? field.value
        : `${Array.from(field.value).slice(0, 509).join("")}...`;
      return { ...field, value };
    });
}

function compactUnchangedResult(
  projected: ProjectedResult,
  identity: ResultIdentity,
  backingResultId: string,
): ProjectedResult {
  const compact: ProjectedResult = {
    ...projected,
    status: "unchanged",
    summary: `unchanged ${projected.summary}`.slice(0, 256),
    facts: [],
    diagnostics: [],
    metrics: {},
    resultId: backingResultId,
    truncated: true,
    fields: navigationFields(projected.fields),
    omissions: [{ field: "content", reason: "unchanged_dedupe", retrievalAvailable: true }],
    content: [],
    identity,
  };
  delete compact.testResults;
  delete compact.isError;
  delete compact.meta;
  return compact;
}

function identityHintFor(projected: ProjectedResult, adapter: IdentityAdapter): IdentityHint | undefined {
  const hint = projected.identity;
  if (!isIdentityHint(hint) || hint.adapter !== adapter || hint.content_id.length === 0 || hint.source_key.length === 0) {
    return undefined;
  }
  return hint;
}

/** Apply conservative session-local deduplication after projection and burst reduction. */
export function dedupeProjectedResult(
  projected: ProjectedResult,
  budget: ProjectionBudget,
  store: ArtifactStore,
  context: DedupeContext,
): DedupeResult {
  const hint = identityHintFor(projected, context.adapter);
  if (hint === undefined || projected.resultId.length === 0) {
    return { result: { ...projected, identity: undefined }, eligible: false, hit: false, collision: false };
  }

  let projectionId: string;
  try {
    projectionId = createProjectionIdentity({ hint, budget, projected });
  } catch {
    return { result: { ...projected, identity: undefined }, eligible: false, hit: false, collision: false };
  }

  const identityId = createResultIdentity(hint.content_id, projectionId);
  const observation: IdentityObservation = {
    identity_id: identityId,
    content_id: hint.content_id,
    projection_id: projectionId,
    result_id: projected.resultId,
    source_key: hint.source_key,
    ...(hint.if_changed_from === undefined ? {} : { if_changed_from: hint.if_changed_from }),
  };
  const match = context.session.lookup(observation);
  const candidateResultId = match.backing_result_id ?? projected.resultId;
  const backingAvailable = store.retrieve(candidateResultId, { maxLines: 1 }) !== undefined;

  if (match.hit && backingAvailable) {
    const identity = makeResultIdentity({
      content_id: hint.content_id,
      projection_id: projectionId,
      changed: false,
    });
    context.session.remember({ ...observation, result_id: candidateResultId });
    return {
      result: compactUnchangedResult(projected, identity, candidateResultId),
      eligible: true,
      hit: true,
      collision: match.collision,
    };
  }

  const identity = makeResultIdentity({
    content_id: hint.content_id,
    projection_id: projectionId,
    changed: true,
    ...(match.previous_id === undefined ? {} : { previous_id: match.previous_id }),
  });
  context.session.remember(observation);
  return {
    result: { ...projected, identity },
    eligible: true,
    hit: false,
    collision: match.collision,
  };
}
