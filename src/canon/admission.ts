import type { CanonC3Candidate } from "./candidates.js";
import type { CanonContentEntry, CanonJsonValue } from "./identity.js";
import type {
  SuzukuriComponentIdentity,
  SuzukuriProjectionRequest,
  SuzukuriProjectionResult,
  SuzukuriResult,
  SuzukuriSourceIdentity,
} from "../suzukuri.js";

/** The explicit projection choice supplied by policy/configuration. */
export type CanonC3ProjectionIntent = Omit<SuzukuriProjectionRequest, "source" | "sourceIdentity">;

/** Source content is resolved by the source authority; this boundary never reconstructs it. */
export type CanonC3Source =
  | string
  | Uint8Array
  | {
      readonly content: string | Uint8Array;
      readonly identity?: SuzukuriSourceIdentity | string;
      readonly mediaType?: string;
    };

export type CanonC3SourceResolver = (candidate: CanonC3Candidate) => CanonC3Source | Promise<CanonC3Source>;
export type CanonC3IntentResolver =
  | CanonC3ProjectionIntent
  | ((candidate: CanonC3Candidate) => CanonC3ProjectionIntent | Promise<CanonC3ProjectionIntent>);

/** The only companion surface consumed by C3 admission. */
export interface CanonC3SuzukuriCompanion {
  project(request: SuzukuriProjectionRequest): Promise<SuzukuriResult<SuzukuriProjectionResult>>;
}

export type CanonC3AdmissionDiagnosticCode =
  | "missing-companion"
  | "missing-source"
  | "missing-projection-intent"
  | "invalid-candidate"
  | "invalid-source"
  | "invalid-projection-intent"
  | "duplicate-candidate"
  | "projection-failed"
  | "source-identity-mismatch"
  | "projection-identity-mismatch"
  | "projection-incomplete"
  | "entry-too-large";

export interface CanonC3AdmissionDiagnostic {
  readonly code: CanonC3AdmissionDiagnosticCode;
  readonly candidateId?: string;
  readonly message: string;
  readonly error?: unknown;
}

export interface AdmitCanonC3CandidatesInput {
  readonly candidates: readonly CanonC3Candidate[];
  readonly sourceForCandidate: CanonC3SourceResolver;
  readonly projectionIntent: CanonC3IntentResolver;
  readonly companion: CanonC3SuzukuriCompanion;
}

export interface CanonC3AdmissionSuccess {
  readonly ok: true;
  readonly entries: readonly CanonContentEntry[];
  readonly candidates: readonly CanonC3Candidate[];
  readonly diagnostics: readonly CanonC3AdmissionDiagnostic[];
  readonly completeness: "complete";
}

export interface CanonC3AdmissionFailure {
  readonly ok: false;
  readonly entries: readonly [];
  readonly candidates: readonly CanonC3Candidate[];
  readonly diagnostics: readonly CanonC3AdmissionDiagnostic[];
  readonly completeness: "incomplete";
}

export type CanonC3AdmissionResult = CanonC3AdmissionSuccess | CanonC3AdmissionFailure;

const MAX_ADMISSION_ENTRIES = 256;
const MAX_JSON_ENTRIES = 256;
const MAX_JSON_DEPTH = 32;
const MAX_TEXT_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameIdentity(left: SuzukuriSourceIdentity, right: SuzukuriSourceIdentity): boolean {
  return (
    left.id === right.id && left.path === right.path && left.revision === right.revision && left.digest === right.digest
  );
}

function sourceIdentity(value: unknown): SuzukuriSourceIdentity | undefined {
  if (typeof value === "string") return nonEmpty(value) ? { id: value.trim() } : undefined;
  if (!isRecord(value) || !nonEmpty(value.id)) return undefined;
  const identity: { id: string; path?: string; revision?: string; digest?: string } = { id: value.id.trim() };
  for (const key of ["path", "revision", "digest"] as const) {
    if (value[key] !== undefined) {
      if (!nonEmpty(value[key])) return undefined;
      identity[key] = value[key].trim();
    }
  }
  return identity;
}

function expectedSourceIdentity(candidate: CanonC3Candidate): SuzukuriSourceIdentity {
  return { id: candidate.source.identity, revision: candidate.source.generation };
}

function jsonValue(value: unknown, depth = 0): CanonJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, 509)}...`;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[bounded]";
  if (depth >= MAX_JSON_DEPTH) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_ENTRIES).map((item) => jsonValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_JSON_ENTRIES)
        .map(([key, item]) => [key.slice(0, MAX_TEXT_LENGTH), jsonValue(item, depth + 1)]),
    );
  }
  return "[bounded]";
}

function component(value: SuzukuriComponentIdentity): CanonJsonValue {
  return { id: value.id, version: value.version };
}

function componentIdentity(value: unknown): value is SuzukuriComponentIdentity {
  return isRecord(value) && nonEmpty(value.id) && nonEmpty(value.version);
}

function referenceIdentity(reference: string, actual: SuzukuriComponentIdentity): SuzukuriComponentIdentity {
  const at = reference.lastIndexOf("@");
  return {
    id: at > 0 ? reference.slice(0, at) : reference,
    version: at > 0 ? reference.slice(at + 1) : actual.version,
  };
}

function componentMatches(reference: string | undefined, actual: SuzukuriComponentIdentity): boolean {
  if (reference === undefined) return true;
  const expected = referenceIdentity(reference, actual);
  return expected.id === actual.id && expected.version === actual.version;
}

function candidateValid(candidate: CanonC3Candidate): boolean {
  return (
    isRecord(candidate) &&
    nonEmpty(candidate.candidateId) &&
    isRecord(candidate.source) &&
    nonEmpty(candidate.source.identity) &&
    nonEmpty(candidate.source.generation) &&
    isRecord(candidate.selector) &&
    nonEmpty(candidate.selector.type) &&
    nonEmpty(candidate.selector.value) &&
    nonEmpty(candidate.selectionReason) &&
    isRecord(candidate.semanticProvenance) &&
    nonEmpty(candidate.semanticProvenance.reference) &&
    nonEmpty(candidate.semanticProvenance.entityId) &&
    nonEmpty(candidate.semanticProvenance.entityKind) &&
    isRecord(candidate.semanticProvenance.producer) &&
    nonEmpty(candidate.semanticProvenance.authority) &&
    nonEmpty(candidate.semanticProvenance.producer.name) &&
    nonEmpty(candidate.semanticProvenance.producer.version)
  );
}

function intentValid(intent: CanonC3ProjectionIntent): boolean {
  return (
    isRecord(intent) &&
    nonEmpty(intent.adapter) &&
    nonEmpty(intent.view) &&
    nonEmpty(intent.renderer) &&
    Number.isSafeInteger(intent.budget) &&
    intent.budget > 0 &&
    (intent.contract === undefined || nonEmpty(intent.contract)) &&
    (intent.profile === undefined || nonEmpty(intent.profile))
  );
}

function projectionSourceIdentity(result: SuzukuriProjectionResult): SuzukuriSourceIdentity | undefined {
  const source = sourceIdentity(result.source);
  const sourceIdentityValue = sourceIdentity(result.sourceIdentity);
  if (source === undefined || sourceIdentityValue === undefined || !sameIdentity(source, sourceIdentityValue))
    return undefined;
  return source;
}

function projectionValid(
  result: SuzukuriProjectionResult,
  intent: CanonC3ProjectionIntent,
  expectedSource: SuzukuriSourceIdentity,
): CanonC3AdmissionDiagnosticCode | undefined {
  const returnedSource = projectionSourceIdentity(result);
  if (returnedSource === undefined || !sameIdentity(returnedSource, expectedSource)) return "source-identity-mismatch";
  if (
    !componentIdentity(result.adapter) ||
    !componentIdentity(result.contract) ||
    !componentIdentity(result.semanticContract) ||
    !componentIdentity(result.view) ||
    !componentIdentity(result.renderer) ||
    !isRecord(result.components) ||
    !componentIdentity(result.components.adapter) ||
    !componentIdentity(result.components.semanticContract) ||
    !componentIdentity(result.components.view) ||
    !componentIdentity(result.components.renderer) ||
    !isRecord(result.provenance) ||
    !componentIdentity(result.provenance.core) ||
    !componentIdentity(result.provenance.adapter) ||
    !componentIdentity(result.provenance.semanticContract) ||
    !componentIdentity(result.provenance.view) ||
    !componentIdentity(result.provenance.renderer) ||
    !isRecord(result.loss) ||
    (result.loss.state !== "none" && result.loss.state !== "partial" && result.loss.state !== "total") ||
    typeof result.output !== "string" ||
    !Number.isSafeInteger(result.outputSize) ||
    result.outputSize < 0 ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0 ||
    result.outputSize < Buffer.byteLength(result.output, "utf8") ||
    result.byteLength !== result.outputSize ||
    !Array.isArray(result.loss.discarded)
  ) {
    return "projection-identity-mismatch";
  }
  if (
    result.budget !== intent.budget ||
    !componentMatches(intent.adapter, result.adapter) ||
    !componentMatches(intent.view, result.view) ||
    !componentMatches(intent.renderer, result.renderer) ||
    !componentMatches(intent.contract, result.contract) ||
    !sameComponent(result.components.adapter, result.adapter) ||
    !sameComponent(result.components.semanticContract, result.semanticContract) ||
    !sameComponent(result.components.view, result.view) ||
    !sameComponent(result.components.renderer, result.renderer) ||
    !sameComponent(result.provenance.adapter, result.adapter) ||
    !sameComponent(result.provenance.semanticContract, result.semanticContract) ||
    !sameComponent(result.provenance.view, result.view) ||
    !sameComponent(result.provenance.renderer, result.renderer) ||
    result.provenance.core.id !== "suzukuri-projection-core" ||
    result.provenance.core.version !== result.coreVersion ||
    !/^[0-9a-f]{64}$/u.test(result.projectionDigest) ||
    !nonEmpty(result.suzukuriVersion) ||
    !nonEmpty(result.coreVersion) ||
    (intent.profile === undefined ? result.profile !== undefined : result.profile !== intent.profile) ||
    (result.provenance.source?.identity !== undefined && result.provenance.source.identity !== expectedSource.id)
  ) {
    return "projection-identity-mismatch";
  }
  if (result.completeness !== "complete" || result.loss.state === "total") return "projection-incomplete";
  return undefined;
}

function sameComponent(left: SuzukuriComponentIdentity, right: SuzukuriComponentIdentity): boolean {
  return left.id === right.id && left.version === right.version;
}

function entryFor(
  candidate: CanonC3Candidate,
  ordinal: number,
  intent: CanonC3ProjectionIntent,
  result: SuzukuriProjectionResult,
): CanonContentEntry {
  const projection: Record<string, CanonJsonValue> = {
    source: jsonValue(result.source),
    sourceIdentity: jsonValue(result.sourceIdentity),
    budget: result.budget,
    suzukuriVersion: result.suzukuriVersion,
    coreVersion: result.coreVersion,
    adapter: component(result.adapter),
    contract: component(result.contract),
    semanticContract: component(result.semanticContract),
    view: component(result.view),
    renderer: component(result.renderer),
    components: jsonValue(result.components),
    provenance: jsonValue(result.provenance),
    projectionDigest: result.projectionDigest,
    completeness: result.completeness,
    loss: jsonValue(result.loss),
    diagnostics: jsonValue(result.diagnostics),
    output: result.output,
    intent: jsonValue(intent),
  };
  if (result.profile !== undefined) projection.profile = result.profile;
  return {
    contentId: candidate.candidateId,
    value: {
      ordinal,
      candidate: jsonValue(candidate),
      projection,
    },
    provenance: {
      source: "suzukuri",
      reference: `${candidate.candidateId}:${result.projectionDigest}`,
      supplied: false,
    },
  };
}

function failure(
  candidates: readonly CanonC3Candidate[],
  diagnostics: readonly CanonC3AdmissionDiagnostic[],
): CanonC3AdmissionResult {
  return { ok: false, entries: [], candidates, diagnostics, completeness: "incomplete" };
}

/**
 * Admit selected candidates through the managed Suzukuri companion.
 *
 * This function consumes candidates in their supplied order. It never invokes
 * selection and never interprets/reduces the returned semantic projection.
 */
export async function admitCanonC3Candidates(input: AdmitCanonC3CandidatesInput): Promise<CanonC3AdmissionResult> {
  const candidates = input.candidates;
  const diagnostics: CanonC3AdmissionDiagnostic[] = [];
  if (!isRecord(input.companion) || typeof input.companion.project !== "function") {
    diagnostics.push({ code: "missing-companion", message: "C3 admission requires the managed Suzukuri companion." });
  }
  if (typeof input.sourceForCandidate !== "function") {
    diagnostics.push({ code: "missing-source", message: "C3 admission requires an explicit source resolver." });
  }
  if (input.projectionIntent === undefined || input.projectionIntent === null) {
    diagnostics.push({
      code: "missing-projection-intent",
      message: "C3 admission requires an explicit projection intent.",
    });
  }
  if (diagnostics.length > 0) return failure(candidates, diagnostics);
  if (candidates.length > MAX_ADMISSION_ENTRIES) {
    return failure(candidates, [{ code: "entry-too-large", message: "C3 admission exceeds the bounded entry limit." }]);
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidateValid(candidate))
      diagnostics.push({
        code: "invalid-candidate",
        candidateId: candidate?.candidateId,
        message: "C3 candidate is incomplete.",
      });
    else if (seen.has(candidate.candidateId))
      diagnostics.push({
        code: "duplicate-candidate",
        candidateId: candidate.candidateId,
        message: "C3 candidate identity is duplicated.",
      });
    else seen.add(candidate.candidateId);
  }
  if (diagnostics.length > 0) return failure(candidates, diagnostics);

  const entries: CanonContentEntry[] = [];
  for (const [ordinal, candidate] of candidates.entries()) {
    let intent: CanonC3ProjectionIntent;
    try {
      intent =
        typeof input.projectionIntent === "function" ? await input.projectionIntent(candidate) : input.projectionIntent;
    } catch (error) {
      diagnostics.push({
        code: "invalid-projection-intent",
        candidateId: candidate.candidateId,
        message: "Projection intent resolution failed.",
        error,
      });
      continue;
    }
    if (!intentValid(intent)) {
      diagnostics.push({
        code: "invalid-projection-intent",
        candidateId: candidate.candidateId,
        message: "Projection intent must explicitly name supported components and a positive budget.",
      });
      continue;
    }

    let source: CanonC3Source;
    try {
      source = await input.sourceForCandidate(candidate);
    } catch (error) {
      diagnostics.push({
        code: "invalid-source",
        candidateId: candidate.candidateId,
        message: "Source resolution failed.",
        error,
      });
      continue;
    }
    const sourceRecord = typeof source === "string" || source instanceof Uint8Array ? undefined : source;
    const content = sourceRecord === undefined ? source : sourceRecord?.content;
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      diagnostics.push({
        code: "invalid-source",
        candidateId: candidate.candidateId,
        message: "Source content must be a string or byte array.",
      });
      continue;
    }
    const expectedSource = expectedSourceIdentity(candidate);
    if (sourceRecord?.identity !== undefined) {
      const suppliedIdentity = sourceIdentity(sourceRecord.identity);
      if (
        suppliedIdentity === undefined ||
        suppliedIdentity.id !== expectedSource.id ||
        (suppliedIdentity.revision !== undefined && suppliedIdentity.revision !== expectedSource.revision)
      ) {
        diagnostics.push({
          code: "source-identity-mismatch",
          candidateId: candidate.candidateId,
          message: "Resolved source identity does not match the selected candidate.",
        });
        continue;
      }
    }
    const request: SuzukuriProjectionRequest = {
      ...intent,
      source: {
        content,
        identity: expectedSource,
        ...(sourceRecord?.mediaType === undefined ? {} : { mediaType: sourceRecord.mediaType }),
      },
      sourceIdentity: expectedSource,
    };
    let projected: SuzukuriResult<SuzukuriProjectionResult>;
    try {
      projected = await input.companion.project(request);
    } catch (error) {
      diagnostics.push({
        code: "projection-failed",
        candidateId: candidate.candidateId,
        message: "Suzukuri projection invocation failed.",
        error,
      });
      continue;
    }
    if (!projected.ok) {
      diagnostics.push({
        code: "projection-failed",
        candidateId: candidate.candidateId,
        message: projected.error.message,
        error: projected.error,
      });
      continue;
    }
    const invalid = projectionValid(projected.value, intent, expectedSource);
    if (invalid !== undefined) {
      diagnostics.push({
        code: invalid,
        candidateId: candidate.candidateId,
        message: "Suzukuri returned an invalid or insufficient projection.",
      });
      continue;
    }
    entries.push(entryFor(candidate, ordinal, intent, projected.value));
  }
  return diagnostics.length > 0
    ? failure(candidates, diagnostics)
    : { ok: true, entries, candidates, diagnostics: [], completeness: "complete" };
}

/** Stable alias for callers that already use the shorter C3 vocabulary. */
export const admitC3Candidates = admitCanonC3Candidates;
