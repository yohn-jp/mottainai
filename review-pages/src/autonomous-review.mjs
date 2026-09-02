/**
 * Execution boundary for one semantic review of one immutable Review Pages
 * revision. Input assembly and the result schema remain separate owners.
 * A provider receives only a bounded structured snapshot; it receives no
 * repository path, Git client, shell, or arbitrary read callback.
 */

export const AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION = "mottainai.autonomous-review.result/v1";
export const AUTONOMOUS_REVIEW_VERDICTS = Object.freeze(["APPROVE", "CHANGES_REQUIRED", "INCONCLUSIVE"]);
export const REVIEW_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_PROVIDER: "INVALID_PROVIDER",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  MALFORMED_MODEL_OUTPUT: "MALFORMED_MODEL_OUTPUT",
  RESULT_CONTRACT_INVALID: "RESULT_CONTRACT_INVALID",
});

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const FINDING_STATUSES = new Set(["new", "open", "resolved", "accepted", "dismissed", "superseded"]);
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;
const MAX_EVIDENCE = 20;
const MAX_INPUT_REFS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** A stable, bounded diagnostic for provider and model-boundary failures. */
export class AutonomousReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AutonomousReviewError";
    this.code = code;
    this.details = boundedDetails(details);
  }
}

/**
 * Construct the only provider surface used by this boundary. `complete`
 * returns a JSON object containing verdict/findings/confidence and optional
 * input/unknown metadata.
 */
export function createReviewProviderAdapter({ complete, provider = "unknown", model = null } = {}) {
  if (typeof complete !== "function") throw makeError("INVALID_PROVIDER", "provider adapter requires complete()", {});
  return Object.freeze({
    provider: optionalText(provider, "provider", 256),
    model: optionalText(model, "model", 256),
    complete,
  });
}

/**
 * Review one exact revision from the bounded #717 input adapter output.
 * `resultContract` is injectable for the independent #716 worktree and is
 * automatically used when its contract module is present after merge.
 */
export async function executeAutonomousReview({
  input,
  reviewInput,
  provider,
  modelAdapter,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resultContract,
} = {}) {
  const suppliedInput = input ?? reviewInput;
  const identity = extractIdentity(suppliedInput);
  const boundedInput = freezeSnapshot(suppliedInput);
  const adapter = resolveProvider(provider ?? modelAdapter);
  const timeout = validateTimeout(timeoutMs);

  let rawOutput;
  try {
    rawOutput = await withTimeout(() => adapter.complete({ input: boundedInput }), timeout);
  } catch (cause) {
    if (cause instanceof AutonomousReviewError) throw cause;
    throw makeError("PROVIDER_FAILURE", "review provider failed", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const normalized = normalizeModelOutput(unwrapResult(rawOutput), suppliedInput);
  const result = {
    schemaVersion: AUTONOMOUS_REVIEW_RESULT_SCHEMA_VERSION,
    identity,
    status: "complete",
    verdict: normalized.verdict,
    findings: normalized.findings,
    confidence: normalized.confidence,
    inputs: normalized.inputs,
    unknowns: normalized.unknowns,
  };

  const candidate = resultContract?.create ? await resultContract.create(result) : result;
  const validation = await validateStableResult(candidate, resultContract);
  if (!validation.valid) {
    throw makeError("RESULT_CONTRACT_INVALID", "review result violates its contract", {
      errors: validation.errors.slice(0, 20),
    });
  }
  return candidate;
}

export const runAutonomousReview = executeAutonomousReview;

function makeError(code, message, details) {
  return new AutonomousReviewError(REVIEW_ERROR_CODES[code] ?? code, message, details);
}

function resolveProvider(provider) {
  if (typeof provider === "function") return createReviewProviderAdapter({ complete: provider });
  if (!provider || typeof provider.complete !== "function") {
    throw makeError("INVALID_PROVIDER", "provider adapter requires complete()", {});
  }
  return provider;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw makeError("INVALID_INPUT", `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`, {});
  }
  return timeoutMs;
}

function withTimeout(operation, timeoutMs) {
  let timer;
  const completion = Promise.resolve().then(operation);
  return Promise.race([
    completion,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(makeError("PROVIDER_TIMEOUT", "review provider timed out", { timeoutMs })),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function extractIdentity(input) {
  if (!record(input)) throw makeError("INVALID_INPUT", "review input must be an object", {});
  const manifest = record(input.manifest) ? input.manifest : null;
  const source = record(input.identity) ? input.identity : {};
  const repository = source.repository ?? manifest?.repository ?? input.repository;
  const pullRequest = source.pullRequest ?? manifest?.pullRequest ?? input.pullRequest;
  const repositoryName = normalizeRepository(repository);
  const number =
    typeof pullRequest === "number" ? pullRequest : (pullRequest?.number ?? source.prNumber ?? input.prNumber);
  const baseSha = source.baseSha ?? pullRequest?.baseSha ?? input.baseSha;
  const headSha = source.headSha ?? pullRequest?.headSha ?? input.headSha;

  if (!Number.isInteger(number) || number < 1)
    throw makeError("INVALID_INPUT", "review input must identify a positive PR number", {});
  if (!sha(baseSha) || !sha(headSha) || baseSha === headSha) {
    throw makeError("INVALID_INPUT", "review input must identify different full base/head SHAs", {});
  }
  return { repository: repositoryName, pullRequest: number, baseSha, headSha };
}

function normalizeRepository(repository) {
  if (typeof repository === "string") {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw makeError("INVALID_INPUT", "repository must be owner/name", {});
    return repository;
  }
  if (!record(repository)) throw makeError("INVALID_INPUT", "review input must identify a repository", {});
  const owner = requiredText(repository.owner, "repository.owner", 256);
  const name = requiredText(repository.name, "repository.name", 256);
  const fullName = requiredText(repository.fullName ?? `${owner}/${name}`, "repository.fullName", 513);
  if (fullName !== `${owner}/${name}`)
    throw makeError("INVALID_INPUT", "repository.fullName must match owner/name", {});
  return fullName;
}

function normalizeModelOutput(output, input) {
  if (!record(output)) throw malformed("model output must be a JSON object");
  if (output.identity !== undefined && !sameIdentity(output.identity, extractIdentity(input))) {
    throw malformed("model output identity does not match the requested revision");
  }
  if (!AUTONOMOUS_REVIEW_VERDICTS.includes(output.verdict)) {
    throw malformed("model output verdict is not in the closed review vocabulary");
  }
  if (!Array.isArray(output.findings) || output.findings.length > MAX_FINDINGS) {
    throw malformed(`model output findings must be an array of at most ${MAX_FINDINGS} items`);
  }

  const findings = output.findings.map((finding, index) => normalizeFinding(finding, index));
  if (
    typeof output.confidence !== "number" ||
    !Number.isFinite(output.confidence) ||
    output.confidence < 0 ||
    output.confidence > 1
  ) {
    throw malformed("model output confidence must be a number from 0 to 1");
  }

  const modelInputs = record(output.inputs) ? output.inputs : {};
  const inputs = {
    inspected: normalizeInspected(
      modelInputs.inspected ?? output.inspectedInputs ?? output.inspected ?? deriveInspected(input),
    ),
    omitted: normalizeOmitted(modelInputs.omitted ?? output.omittedInputs ?? output.omissions ?? deriveOmitted(input)),
  };
  const unknowns = normalizeUnknowns(output.unknowns ?? deriveUnknowns(input));
  const contradictions = normalizeDiagnostics(output.contradictions ?? []);
  const incomplete = contradictions.length > 0 || hasIncompleteInput(input) || unknowns.length > 0;
  const activeBlocking = findings.some(
    (finding) => finding.blocking && !["resolved", "accepted", "dismissed", "superseded"].includes(finding.status),
  );
  let verdict = output.verdict;
  if (incomplete || (verdict === "APPROVE" && activeBlocking) || (verdict === "CHANGES_REQUIRED" && !activeBlocking))
    verdict = "INCONCLUSIVE";
  return { verdict, findings, confidence: output.confidence, inputs, unknowns };
}

function normalizeFinding(value, index) {
  if (!record(value)) throw malformed(`findings[${index}] must be an object`);
  const id = modelRequiredText(value.id, `findings[${index}].id`, 64);
  if (!ID_PATTERN.test(id)) throw malformed(`findings[${index}].id is not stable`);
  const severity = modelRequiredText(value.severity, `findings[${index}].severity`, 32);
  if (!SEVERITIES.has(severity)) throw malformed(`findings[${index}].severity is unsupported`);
  if (typeof value.blocking !== "boolean") throw malformed(`findings[${index}].blocking must be boolean`);
  const title = modelRequiredText(value.title, `findings[${index}].title`, 240);
  const rationale = modelRequiredText(value.rationale, `findings[${index}].rationale`, 4000);
  const evidence = normalizeEvidence(value.evidence, index);
  const status = value.status ?? "open";
  if (typeof status !== "string" || !FINDING_STATUSES.has(status))
    throw malformed(`findings[${index}].status is unsupported`);
  const location = normalizeLocation(value.location ?? value.sourceLocation, index);
  return {
    id,
    severity,
    blocking: value.blocking,
    title,
    rationale,
    evidence,
    ...(location ? { location } : {}),
    status,
  };
}

function normalizeEvidence(value, findingIndex) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE) {
    throw malformed(`findings[${findingIndex}].evidence must contain 1-${MAX_EVIDENCE} references`);
  }
  return value.map((reference, index) => {
    if (typeof reference === "string")
      return { resource: modelRequiredText(reference, "evidence.resource", 128), reference: "$" };
    if (!record(reference)) throw malformed(`findings[${findingIndex}].evidence[${index}] must be an object`);
    const resource = modelRequiredText(reference.resource, "evidence.resource", 128);
    const pointer = reference.reference ?? reference.path;
    const result = { resource, reference: modelRequiredText(pointer, "evidence.reference", 512) };
    if (reference.excerpt !== undefined) result.excerpt = modelText(reference.excerpt, "evidence.excerpt", 600);
    return result;
  });
}

function normalizeLocation(value, index) {
  if (value === undefined || value === null) return null;
  if (!record(value)) throw malformed(`findings[${index}].location must be an object`);
  const path = modelRequiredText(value.path, `findings[${index}].location.path`, 512);
  if (path.startsWith("/") || path.split("/").includes(".."))
    throw malformed(`findings[${index}].location.path must be relative`);
  const start = normalizePosition(
    value.start ?? { line: value.startLine, column: value.startColumn },
    "location.start",
  );
  const end = normalizePosition(
    value.end ?? { line: value.endLine ?? value.startLine, column: value.endColumn ?? value.startColumn },
    "location.end",
  );
  if (start.line > end.line || (start.line === end.line && start.column > end.column))
    throw malformed(`findings[${index}].location.start must not follow end`);
  return { path, start, end };
}

function normalizePosition(value, field) {
  if (!record(value) || !Number.isInteger(value.line) || value.line < 1)
    throw malformed(`${field}.line must be positive`);
  const result = { line: value.line };
  if (value.column !== undefined) {
    if (!Number.isInteger(value.column) || value.column < 1) throw malformed(`${field}.column must be positive`);
    result.column = value.column;
  }
  return result;
}

function deriveInspected(input) {
  const result = [];
  const manifest = input?.provenance?.manifest;
  if (manifest?.state === "present") result.push({ resource: manifest.path ?? "manifest.json" });
  const resources = input?.provenance?.resources ?? input?.resources;
  if (record(resources)) {
    for (const [key, value] of Object.entries(resources)) {
      if (record(value) && value.state !== "present") continue;
      result.push({
        resource: record(value) ? (value.path ?? `${key}.json`) : key.endsWith(".json") ? key : `${key}.json`,
      });
    }
  }
  if (result.length > 0) return result;
  for (const key of ["issue", "diff", "ocr", "checks"])
    if (input?.[key] !== undefined && input[key] !== null) result.push({ resource: `${key}.json` });
  return result.length > 0 ? result : [{ resource: "manifest.json" }];
}

function deriveOmitted(input) {
  const details = Array.isArray(input?.unknownDetails) ? input.unknownDetails : [];
  const result = [];
  for (const state of ["missing", "partial", "unknown"]) {
    for (const resource of array(input?.[state])) {
      if (typeof resource !== "string" || result.some((entry) => entry.resource === resource)) continue;
      const detail = details.find((entry) => entry?.resource === resource);
      result.push({ resource, reason: detail?.reason ?? "resource was incomplete in the bounded input" });
    }
  }
  return result;
}

function deriveUnknowns(input) {
  const values = [...array(input?.unknowns), ...array(input?.unknown)];
  const details = values.length > 0 ? values : array(input?.unknownDetails);
  return details.map((value, index) => {
    const reason =
      typeof value === "string" ? value : (value?.reason ?? value?.message ?? "bounded evidence is unknown");
    const id =
      typeof value === "object" && value?.id
        ? value.id
        : stableId(typeof value === "string" ? value : (value?.resource ?? "unknown"), index);
    return { id, reason };
  });
}

function normalizeInspected(value) {
  if (!Array.isArray(value) || value.length > MAX_INPUT_REFS)
    throw malformed("inputs.inspected must be a bounded array");
  return value.map((entry, index) => {
    if (typeof entry === "string") return { resource: modelRequiredText(entry, `inputs.inspected[${index}]`, 128) };
    if (!record(entry)) throw malformed(`inputs.inspected[${index}] must be an object`);
    const result = {
      resource: modelRequiredText(entry.resource ?? entry.name, `inputs.inspected[${index}].resource`, 128),
    };
    if (entry.references !== undefined) {
      if (!Array.isArray(entry.references) || entry.references.length > 50)
        throw malformed(`inputs.inspected[${index}].references is unbounded`);
      result.references = entry.references.map((reference, refIndex) =>
        modelRequiredText(reference, `inputs.inspected[${index}].references[${refIndex}]`, 512),
      );
    }
    return result;
  });
}

function normalizeOmitted(value) {
  if (!Array.isArray(value) || value.length > MAX_INPUT_REFS) throw malformed("inputs.omitted must be a bounded array");
  return value.map((entry, index) => {
    if (typeof entry === "string")
      return { resource: modelRequiredText(entry, `inputs.omitted[${index}]`, 128), reason: "resource was omitted" };
    if (!record(entry)) throw malformed(`inputs.omitted[${index}] must be an object`);
    return {
      resource: modelRequiredText(entry.resource ?? entry.name, `inputs.omitted[${index}].resource`, 128),
      reason: modelRequiredText(entry.reason ?? entry.message, `inputs.omitted[${index}].reason`, 1000),
    };
  });
}

function normalizeUnknowns(value) {
  if (!Array.isArray(value) || value.length > MAX_INPUT_REFS) throw malformed("unknowns must be a bounded array");
  return value.map((entry, index) => {
    const reason = typeof entry === "string" ? entry : (entry?.reason ?? entry?.message);
    const id =
      typeof entry === "object" && entry?.id
        ? entry.id
        : stableId(typeof entry === "string" ? entry : "unknown", index);
    const normalizedId = modelRequiredText(id, `unknowns[${index}].id`, 64);
    if (!ID_PATTERN.test(normalizedId)) throw malformed(`unknowns[${index}].id is not stable`);
    return { id: normalizedId, reason: modelRequiredText(reason, `unknowns[${index}].reason`, 1000) };
  });
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value) || value.length > MAX_INPUT_REFS) throw malformed("contradictions must be bounded");
  return value.map((entry, index) =>
    modelRequiredText(
      typeof entry === "string" ? entry : (entry?.reason ?? entry?.message),
      `contradictions[${index}]`,
      1000,
    ),
  );
}

function hasIncompleteInput(input) {
  return (
    input?.complete === false ||
    input?.completeness === "incomplete" ||
    input?.evidence?.complete === false ||
    ["missing", "partial", "unknown"].some((key) => array(input?.[key]).length > 0)
  );
}

function sameIdentity(candidate, expected) {
  if (!record(candidate)) return false;
  const repository = candidate.repository;
  const repositoryName =
    typeof repository === "string"
      ? repository
      : (repository?.fullName ??
        (repository?.owner && repository?.name ? `${repository.owner}/${repository.name}` : null));
  const pullRequest =
    typeof candidate.pullRequest === "object"
      ? candidate.pullRequest?.number
      : (candidate.pullRequest ?? candidate.prNumber);
  return (
    repositoryName === expected.repository &&
    pullRequest === expected.pullRequest &&
    (candidate.baseSha ?? candidate.pullRequest?.baseSha) === expected.baseSha &&
    (candidate.headSha ?? candidate.pullRequest?.headSha) === expected.headSha
  );
}

function unwrapResult(value) {
  return record(value) && value.result !== undefined ? value.result : value;
}

async function validateStableResult(result, resultContract) {
  if (typeof resultContract?.validate === "function")
    return validateResult(resultContract.validate(result, { expectedIdentity: result.identity }));
  let contract = null;
  try {
    contract = await import("../review/autonomous-review-result.mjs");
  } catch {
    // #716 is developed independently; use the local envelope preflight until merged.
  }
  if (typeof contract?.validateAutonomousReviewResult === "function")
    return validateResult(contract.validateAutonomousReviewResult(result, { expectedIdentity: result.identity }));
  const keys = ["schemaVersion", "identity", "status", "verdict", "findings", "confidence", "inputs", "unknowns"];
  const errors = keys.filter((key) => !(key in result));
  return { valid: errors.length === 0, errors };
}

function validateResult(value) {
  if (value === true || value === undefined) return { valid: true, errors: [] };
  if (value === false) return { valid: false, errors: ["contract validator rejected result"] };
  return { valid: value?.valid !== false, errors: Array.isArray(value?.errors) ? value.errors.map(String) : [] };
}

function freezeSnapshot(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw makeError("INVALID_INPUT", "review input must be JSON-serializable", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (encoded === undefined) throw makeError("INVALID_INPUT", "review input must be JSON-serializable", {});
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES)
    throw makeError("INVALID_INPUT", "review input exceeds the bounded size", { maxBytes: MAX_INPUT_BYTES });
  let clone;
  try {
    clone = structuredClone(value);
  } catch (cause) {
    throw makeError("INVALID_INPUT", "review input must be structured-cloneable", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function sha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function requiredText(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw makeError("INVALID_INPUT", `${field} must be a bounded string`, {});
  return value;
}

function optionalText(value, field, max) {
  return value === null || value === undefined ? null : requiredText(value, field, max);
}

function modelRequiredText(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw malformed(`${field} must be a bounded string`);
  return value;
}

function modelText(value, field, max) {
  if (typeof value !== "string" || value.length > max) throw malformed(`${field} must be a bounded string`);
  return value;
}

function stableId(value, index) {
  const prefix = String(value)
    .replaceAll(/[^A-Za-z0-9._:-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 56);
  return `${prefix || "unknown"}-${index + 1}`.slice(0, 64);
}

function malformed(message) {
  return makeError("MALFORMED_MODEL_OUTPUT", message, {});
}

function boundedDetails(value) {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= 4096
      ? value
      : { message: "diagnostic details exceeded the bound" };
  } catch {
    return {};
  }
}
