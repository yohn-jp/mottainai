import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * mottainai.execution-canon.v1 — the deterministic, forkable knowledge
 * boundary used before model launch.
 *
 * This module deliberately owns only the wire schema, canonical serializer,
 * and identities. It does not inspect Git, repositories, sessions, or
 * providers. Repository/task/artifact authorities populate the prefix in
 * their own boundaries; an execution authority supplies the attachment.
 */
export const CANON_CONTRACT_ID = "mottainai.execution-canon.v1" as const;
export const CANON_SCHEMA_VERSION = 1 as const;
export const CANON_PREFIX_ID_VERSION = 1 as const;
export const CANON_EXECUTION_STATE_ID_VERSION = 1 as const;

const MAX_ID_LENGTH = 512 as const;
const MAX_REVISION_LENGTH = 256 as const;
const MAX_JSON_ARRAY_ENTRIES = 256 as const;
const MAX_JSON_OBJECT_ENTRIES = 256 as const;
const MAX_JSON_NESTING_DEPTH = 32 as const;
const MAX_CONTENT_ENTRIES = 256 as const;
const MAX_INSTRUCTION_ENTRIES = 64 as const;
const MAX_INSTRUCTION_BODY_LENGTH = 16_384 as const;

const identifierSchema = z.string().min(1).max(MAX_ID_LENGTH);
const revisionSchema = z.string().min(1).max(MAX_REVISION_LENGTH);

/** JSON values are used for facts/content and are bounded in both width and depth. */
type JsonPrimitive = null | boolean | number | string;
export type CanonJsonValue = JsonPrimitive | CanonJsonValue[] | { [key: string]: CanonJsonValue };

const jsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);

function boundedJsonRecordSchema(valueSchema: z.ZodType<CanonJsonValue>) {
  return z
    .record(z.string().max(MAX_ID_LENGTH), valueSchema)
    .refine((value) => Object.keys(value).length <= MAX_JSON_OBJECT_ENTRIES, {
      message: `JSON object exceeds ${MAX_JSON_OBJECT_ENTRIES} entries`,
    });
}

/** At the maximum depth, only primitives remain valid children. */
function jsonValueSchemaAtDepth(depth: number): z.ZodType<CanonJsonValue> {
  if (depth >= MAX_JSON_NESTING_DEPTH) return jsonPrimitiveSchema;

  const nestedValueSchema = jsonValueSchemaAtDepth(depth + 1);
  return z.union([
    jsonPrimitiveSchema,
    z.array(nestedValueSchema).max(MAX_JSON_ARRAY_ENTRIES),
    boundedJsonRecordSchema(nestedValueSchema),
  ]);
}

const jsonValueSchema = jsonValueSchemaAtDepth(0);

const contractReferenceSchema = z
  .object({
    contractId: identifierSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict();

/** Provenance points to an authoritative source; it intentionally carries no source body. */
const provenanceSchema = z
  .object({
    source: identifierSchema,
    reference: z.string().min(1).max(MAX_ID_LENGTH),
    supplied: z.boolean(),
  })
  .strict();

export type CanonProvenance = z.infer<typeof provenanceSchema>;

/**
 * An already-supplied instruction is represented by provenance only, so its
 * body is not copied or reinjected. A required instruction must carry its
 * model-visible body; that body is consequently part of prefix identity.
 */
const runtimeInstructionSchema = z.discriminatedUnion("provenance", [
  z
    .object({
      instructionId: identifierSchema,
      provenance: z.literal("already-supplied"),
    })
    .strict(),
  z
    .object({
      instructionId: identifierSchema,
      provenance: z.literal("required"),
      body: z.string().min(1).max(MAX_INSTRUCTION_BODY_LENGTH),
    })
    .strict(),
]);

const canonC0Schema = z
  .object({
    runtimeContract: contractReferenceSchema,
    projectContract: contractReferenceSchema,
    /** IDs/provenance only; instruction bodies are not copied into C0. */
    runtimeInstructions: z.array(runtimeInstructionSchema).max(MAX_INSTRUCTION_ENTRIES),
  })
  .strict();

const canonC1Schema = z
  .object({
    repository: z
      .object({
        repositoryId: identifierSchema,
        /** Immutable source revision and immutable base revision are identity inputs. */
        sourceRevision: revisionSchema,
        baseRevision: revisionSchema,
      })
      .strict(),
    /** Deterministic facts only; no README or full-repository content is implied. */
    packageFacts: boundedJsonRecordSchema(jsonValueSchema),
    workspaceFacts: boundedJsonRecordSchema(jsonValueSchema),
  })
  .strict();

const canonContentEntrySchema = z
  .object({
    contentId: identifierSchema,
    value: jsonValueSchema,
    provenance: provenanceSchema,
  })
  .strict();

/** C2 task content and C3 selected-artifact content are admitted later by their owning boundaries. */
const canonPrefixSchema = z
  .object({
    c0: canonC0Schema,
    c1: canonC1Schema,
    c2: z.array(canonContentEntrySchema).max(MAX_CONTENT_ENTRIES),
    c3: z.array(canonContentEntrySchema).max(MAX_CONTENT_ENTRIES),
  })
  .strict();

/**
 * Physical/session facts are deliberately isolated here. None of these
 * fields participates in prefixIdentityOf; the attachment generation does
 * participate in executionStateIdentityOf.
 */
const canonExecutionAttachmentSchema = z
  .object({
    generation: z.number().int().positive(),
    sessionId: identifierSchema.optional(),
    worktreeId: identifierSchema.optional(),
    branchName: identifierSchema.optional(),
    agentId: identifierSchema.optional(),
    modelId: identifierSchema.optional(),
  })
  .strict();

export const CanonC0Schema = canonC0Schema;
export const CanonC1Schema = canonC1Schema;
export const CanonContentEntrySchema = canonContentEntrySchema;
export const CanonPrefixSchema = canonPrefixSchema;
export const CanonExecutionAttachmentSchema = canonExecutionAttachmentSchema;

export const CanonDocumentSchema = z
  .object({
    contractId: z.literal(CANON_CONTRACT_ID),
    schemaVersion: z.literal(CANON_SCHEMA_VERSION),
    prefix: canonPrefixSchema,
    executionAttachment: canonExecutionAttachmentSchema,
  })
  .strict();

export type CanonC0 = z.infer<typeof canonC0Schema>;
export type CanonC1 = z.infer<typeof canonC1Schema>;
export type CanonContentEntry = z.infer<typeof canonContentEntrySchema>;
export type CanonPrefix = z.infer<typeof canonPrefixSchema>;
export type CanonExecutionAttachment = z.infer<typeof canonExecutionAttachmentSchema>;
export type CanonDocument = z.infer<typeof CanonDocumentSchema>;

export interface CanonIdentities {
  readonly prefix_id: string;
  readonly execution_state_id: string;
}

export class CanonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonError";
  }
}

function parseWithContract<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CanonError(`${label} is invalid`);
  return parsed.data;
}

export function parseCanonC0(value: unknown): CanonC0 {
  return parseWithContract(canonC0Schema, value, "Canon C0");
}

export function parseCanonC1(value: unknown): CanonC1 {
  return parseWithContract(canonC1Schema, value, "Canon C1");
}

export function parseCanonPrefix(value: unknown): CanonPrefix {
  return parseWithContract(canonPrefixSchema, value, "Canon prefix");
}

export function parseCanonExecutionAttachment(value: unknown): CanonExecutionAttachment {
  return parseWithContract(canonExecutionAttachmentSchema, value, "Canon execution attachment");
}

export function parseCanonDocument(value: unknown): CanonDocument {
  return parseWithContract(CanonDocumentSchema, value, "Canon document");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new CanonError("Canon serialization encountered an unsupported value");
}

function stableSort<T>(items: readonly T[], keyOf: (item: T) => unknown): T[] {
  return [...items]
    .map((item) => ({ item, key: stableStringify(keyOf(item)) }))
    .sort((left, right) => compareText(left.key, right.key))
    .map(({ item }) => item);
}

function canonicalizeJson(value: CanonJsonValue): CanonJsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function canonicalizeRecord(value: Record<string, CanonJsonValue>): Record<string, CanonJsonValue> {
  return canonicalizeJson(value) as Record<string, CanonJsonValue>;
}

function canonicalizeC0(c0: CanonC0): CanonC0 {
  return {
    runtimeContract: c0.runtimeContract,
    projectContract: c0.projectContract,
    // Sort on the complete entry, not only instructionId: duplicate IDs with
    // different bodies remain deterministic regardless of insertion order.
    runtimeInstructions: stableSort(c0.runtimeInstructions, (entry) => entry),
  };
}

function canonicalizeC1(c1: CanonC1): CanonC1 {
  return {
    repository: c1.repository,
    packageFacts: canonicalizeRecord(c1.packageFacts),
    workspaceFacts: canonicalizeRecord(c1.workspaceFacts),
  };
}

function canonicalizeContent(entries: readonly CanonContentEntry[]): CanonContentEntry[] {
  // The complete entry is the tie-break, so even duplicate contentId values
  // cannot make identity depend on caller insertion order.
  return stableSort(entries, (entry) => entry).map((entry) => ({
    contentId: entry.contentId,
    value: canonicalizeJson(entry.value),
    provenance: entry.provenance,
  }));
}

/** Canonical prefix projection. C0, C1, C2, C3 are explicit and ordered by the serializer below. */
export function canonicalizeCanonPrefix(prefix: CanonPrefix): CanonPrefix {
  const validated = parseCanonPrefix(prefix);
  return {
    c0: canonicalizeC0(validated.c0),
    c1: canonicalizeC1(validated.c1),
    c2: canonicalizeContent(validated.c2),
    c3: canonicalizeContent(validated.c3),
  };
}

/**
 * Canonical text has an explicit C0 → C1 → C2 → C3 section sequence. The
 * section array prevents object-key ordering from obscuring the prefix order.
 */
export function canonicalCanonPrefixText(prefix: CanonPrefix): string {
  const canonical = canonicalizeCanonPrefix(prefix);
  return stableStringify({
    contractId: CANON_CONTRACT_ID,
    schemaVersion: CANON_SCHEMA_VERSION,
    sections: [
      { section: "C0", content: canonical.c0 },
      { section: "C1", content: canonical.c1 },
      { section: "C2", content: canonical.c2 },
      { section: "C3", content: canonical.c3 },
    ],
  });
}

export function canonicalCanonExecutionAttachmentText(attachment: CanonExecutionAttachment): string {
  return stableStringify(parseCanonExecutionAttachment(attachment));
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable identity of only C0–C3 forkable content; execution facts never enter this hash. */
export function prefixIdentityOf(prefix: CanonPrefix): string {
  return `cp${CANON_PREFIX_ID_VERSION}:${digest(canonicalCanonPrefixText(prefix))}`;
}

/** Alias using the field's contract spelling for callers that prefer identity terminology. */
export const prefixIdOf = prefixIdentityOf;

/**
 * Binds one prefix identity to one complete attachment. Generation is the
 * authoritative attachment revision; opaque session/worktree/branch/agent/
 * model facts distinguish attachments but cannot fragment prefix_id.
 */
export function executionStateIdentityOf(prefixId: string, attachment: CanonExecutionAttachment): string {
  if (!/^cp1:[0-9a-f]{64}$/u.test(prefixId)) throw new CanonError("prefix_id is invalid");
  const canonicalAttachment = canonicalCanonExecutionAttachmentText(attachment);
  return `es${CANON_EXECUTION_STATE_ID_VERSION}:${digest(
    stableStringify({
      version: `execution-state-v${CANON_EXECUTION_STATE_ID_VERSION}`,
      prefix_id: prefixId,
      attachment: JSON.parse(canonicalAttachment) as CanonExecutionAttachment,
    }),
  )}`;
}

export const executionStateIdOf = executionStateIdentityOf;

export function identitiesOf(document: CanonDocument): CanonIdentities {
  const parsed = parseCanonDocument(document);
  const prefix_id = prefixIdentityOf(parsed.prefix);
  return {
    prefix_id,
    execution_state_id: executionStateIdentityOf(prefix_id, parsed.executionAttachment),
  };
}

export function canonicalCanonDocumentText(document: CanonDocument): string {
  const parsed = parseCanonDocument(document);
  return stableStringify({
    contractId: CANON_CONTRACT_ID,
    schemaVersion: CANON_SCHEMA_VERSION,
    // Keep the document wire shape identical to CanonDocumentSchema. The
    // section-array projection belongs to prefix identity serialization only.
    prefix: canonicalizeCanonPrefix(parsed.prefix),
    executionAttachment: JSON.parse(canonicalCanonExecutionAttachmentText(parsed.executionAttachment)) as unknown,
  });
}
