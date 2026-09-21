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
  /** True only for an identity explicitly seeded from content already delivered at startup. */
  seeded?: boolean;
  /** Whether the result_id is known to be retrievable from the artifact authority. */
  reference_available?: boolean;
}

export interface IdentityObservation {
  identity_id: string;
  content_id: string;
  projection_id: string;
  result_id: string;
  source_key: string;
  if_changed_from?: string;
  /** A seed may supply an existing compact reference without a local artifact. */
  seeded?: boolean;
  reference_available?: boolean;
}

export interface IdentityMatch {
  hit: boolean;
  collision: boolean;
  backing_result_id?: string;
  previous_id?: string;
  seeded?: boolean;
  reference_available?: boolean;
}

/**
 * Identity supplied by the Canon/Suzukuri boundary for one exact C3
 * projection. Context Runtime stores and compares these fields as opaque
 * values; it does not inspect projection output or component semantics.
 */
export interface CanonC3ProjectionIdentity {
  readonly content_id: string;
  readonly source_key: string;
  readonly source_generation: string;
  readonly projection_digest: string;
  readonly projection_version: string;
  readonly component_identity: string;
}

/** A startup delivery marker for a Canon C3 projection. */
export interface CanonC3ProjectionSeed extends CanonC3ProjectionIdentity {
  readonly kind: "canon-c3-projection";
  readonly delivered: true;
  readonly result_id?: string;
  /** True only when the supplied result reference is backed by ArtifactStore. */
  readonly reference_available?: boolean;
}

/**
 * Runtime instructions (including AGENTS guidance) may be seeded only from
 * the explicit Canon already-supplied provenance marker. No body is accepted
 * or retained here.
 */
export interface RuntimeInstructionSeed {
  readonly kind: "runtime-instruction";
  readonly instruction_id: string;
  readonly provenance: "already-supplied";
  readonly delivered: true;
  readonly result_id?: string;
  readonly reference_available?: boolean;
}

export type DeliveredIdentitySeed = CanonC3ProjectionSeed | RuntimeInstructionSeed;

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
      return {
        hit: true,
        collision: false,
        backing_result_id: existing.result_id,
        ...(existing.seeded === true ? { seeded: true } : {}),
        ...(existing.reference_available === true ? { reference_available: true } : {}),
      };
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
      if (input.seeded === true) existing.seeded = true;
      if (input.reference_available === true) existing.reference_available = true;
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
      ...(input.seeded === true ? { seeded: true } : {}),
      ...(input.reference_available === true ? { reference_available: true } : {}),
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

  /** Seed only an explicitly delivered Canon/runtime identity. */
  seedDelivered(input: DeliveredIdentitySeed): boolean {
    if (!isRecord(input)) return false;
    if (input.kind === "runtime-instruction") return this.seedRuntimeInstruction(input);
    if (input.kind === "canon-c3-projection") return this.seedCanonProjection(input);
    return false;
  }

  seedRuntimeInstruction(input: RuntimeInstructionSeed): boolean {
    if (
      !isRecord(input) ||
      input.kind !== "runtime-instruction" ||
      input.provenance !== "already-supplied" ||
      input.delivered !== true ||
      !boundedIdentityPart(input.instruction_id) ||
      (input.result_id !== undefined && !boundedIdentityPart(input.result_id))
    )
      return false;

    const source_key = `runtime-instruction:${input.instruction_id}`;
    const content_id = `runtime-instruction:${input.instruction_id}`;
    const observation: IdentityObservation = {
      identity_id: createResultIdentity(content_id, RUNTIME_INSTRUCTION_PROJECTION_ID),
      content_id,
      projection_id: RUNTIME_INSTRUCTION_PROJECTION_ID,
      result_id: input.result_id ?? compactReferenceId("runtime-instruction", input.instruction_id),
      source_key,
      seeded: true,
      ...(input.reference_available === true ? { reference_available: true } : {}),
    };
    return this.remember(observation);
  }

  lookupRuntimeInstruction(instructionId: string): IdentityMatch {
    if (!boundedIdentityPart(instructionId)) return { hit: false, collision: false };
    const content_id = `runtime-instruction:${instructionId}`;
    return this.lookup({
      identity_id: createResultIdentity(content_id, RUNTIME_INSTRUCTION_PROJECTION_ID),
      content_id,
      projection_id: RUNTIME_INSTRUCTION_PROJECTION_ID,
      result_id: compactReferenceId("runtime-instruction", instructionId),
      source_key: `runtime-instruction:${instructionId}`,
    });
  }

  seedCanonProjection(input: CanonC3ProjectionSeed): boolean {
    if (
      !isRecord(input) ||
      input.kind !== "canon-c3-projection" ||
      input.delivered !== true ||
      (input.result_id !== undefined && !boundedIdentityPart(input.result_id)) ||
      !validProjectionIdentity(input)
    )
      return false;
    const observation = canonProjectionObservation(
      input,
      input.result_id ?? compactReferenceId("canon-c3", input.content_id),
    );
    return this.remember({
      ...observation,
      seeded: true,
      ...(input.reference_available === true ? { reference_available: true } : {}),
    });
  }

  lookupCanonProjection(input: CanonC3ProjectionIdentity): IdentityMatch {
    if (!validProjectionIdentity(input)) return { hit: false, collision: false };
    return this.lookup(canonProjectionObservation(input, compactReferenceId("canon-c3", input.content_id)));
  }

  private touch(key: string, value: SeenIdentity): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }
}

const RUNTIME_INSTRUCTION_PROJECTION_ID = "runtime-instruction-v1";
const MAX_OPAQUE_ID_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedIdentityPart(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OPAQUE_ID_LENGTH;
}

function validProjectionIdentity(input: CanonC3ProjectionIdentity): boolean {
  return (
    isRecord(input) &&
    boundedIdentityPart(input.content_id) &&
    boundedIdentityPart(input.source_key) &&
    boundedIdentityPart(input.source_generation) &&
    boundedIdentityPart(input.projection_digest) &&
    boundedIdentityPart(input.projection_version) &&
    boundedIdentityPart(input.component_identity)
  );
}

function canonProjectionId(input: CanonC3ProjectionIdentity): string {
  // Delimiters are length-prefixed so opaque producer values cannot collide.
  const parts = [input.source_generation, input.projection_digest, input.projection_version, input.component_identity];
  return `canon-c3-projection-v1:${parts.map((part) => `${part.length}:${part}`).join("")}`;
}

function compactReferenceId(kind: string, value: string): string {
  const identity = createResultIdentity(`${kind}:${value}`, `${kind}-reference-v1`);
  return `ref:${identity.slice(-64)}`;
}

function canonProjectionObservation(input: CanonC3ProjectionIdentity, result_id: string): IdentityObservation {
  const projection_id = canonProjectionId(input);
  return {
    identity_id: createResultIdentity(input.content_id, projection_id),
    content_id: input.content_id,
    projection_id,
    result_id,
    source_key: input.source_key,
  };
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
  referenceAvailable = true,
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
    omissions: [{ field: "content", reason: "unchanged_dedupe", retrievalAvailable: referenceAvailable }],
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
  return dedupeWithObservation(projected, store, context, observation);
}

/** Apply the same compact delivery behavior to an opaque Canon C3 identity. */
export function dedupeCanonProjectionResult(
  projected: ProjectedResult,
  store: ArtifactStore,
  context: DedupeContext,
  identity: CanonC3ProjectionIdentity,
): DedupeResult {
  if (!validProjectionIdentity(identity) || projected.resultId.length === 0) {
    return { result: { ...projected, identity: undefined }, eligible: false, hit: false, collision: false };
  }
  return dedupeWithObservation(projected, store, context, canonProjectionObservation(identity, projected.resultId));
}

/** Apply compact delivery behavior to an explicitly already-supplied instruction. */
export function dedupeRuntimeInstructionResult(
  projected: ProjectedResult,
  store: ArtifactStore,
  context: DedupeContext,
  instructionId: string,
): DedupeResult {
  if (!boundedIdentityPart(instructionId) || projected.resultId.length === 0) {
    return { result: { ...projected, identity: undefined }, eligible: false, hit: false, collision: false };
  }
  const content_id = `runtime-instruction:${instructionId}`;
  const projection_id = RUNTIME_INSTRUCTION_PROJECTION_ID;
  return dedupeWithObservation(projected, store, context, {
    identity_id: createResultIdentity(content_id, projection_id),
    content_id,
    projection_id,
    result_id: projected.resultId,
    source_key: `runtime-instruction:${instructionId}`,
  });
}

function dedupeWithObservation(
  projected: ProjectedResult,
  store: ArtifactStore,
  context: DedupeContext,
  observation: IdentityObservation,
): DedupeResult {
  const match = context.session.lookup(observation);
  const candidateResultId = match.backing_result_id ?? projected.resultId;
  const backingAvailable = match.seeded === true || store.retrieve(candidateResultId, { maxLines: 1 }) !== undefined;

  if (match.hit && backingAvailable) {
    const identity = makeResultIdentity({
      content_id: observation.content_id,
      projection_id: observation.projection_id,
      changed: false,
    });
    context.session.remember({
      ...observation,
      result_id: candidateResultId,
      ...(match.seeded === true ? { seeded: true } : {}),
      ...(match.reference_available === true ? { reference_available: true } : {}),
    });
    return {
      result: compactUnchangedResult(
        projected,
        identity,
        candidateResultId,
        match.reference_available === true || !match.seeded,
      ),
      eligible: true,
      hit: true,
      collision: match.collision,
    };
  }

  const identity = makeResultIdentity({
    content_id: observation.content_id,
    projection_id: observation.projection_id,
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
