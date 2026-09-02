import { ISSUE_SCHEMA_VERSION } from "./build-issue.mjs";
import { DIFF_SCHEMA_VERSION } from "./build-diff.mjs";
import { OCR_SCHEMA_VERSION } from "./build-ocr.mjs";
import { CHECKS_SCHEMA_VERSION } from "./build-checks.mjs";
import { MANIFEST_SCHEMA_VERSION } from "./generate-review-package.mjs";

export const REVIEW_INPUT_SCHEMA_VERSION = "mottainai.review-pages.review-input/v1";

const RESOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "issue", file: "issue.json", schemaVersion: ISSUE_SCHEMA_VERSION }),
  Object.freeze({ key: "diff", file: "diff.json", schemaVersion: DIFF_SCHEMA_VERSION }),
  Object.freeze({ key: "ocr", file: "ocr.json", schemaVersion: OCR_SCHEMA_VERSION }),
  Object.freeze({ key: "checks", file: "checks.json", schemaVersion: CHECKS_SCHEMA_VERSION }),
]);

const MANIFEST_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "generator",
  "repository",
  "pullRequest",
  "revision",
  "resources",
  "volatile",
]);

const RESOURCE_REQUIRED_FIELDS = Object.freeze({
  issue: Object.freeze(["schemaVersion", "linked", "issue", "acceptanceCriteria"]),
  diff: Object.freeze(["schemaVersion", "baseSha", "headSha", "files", "stats"]),
  ocr: Object.freeze(["schemaVersion", "provider", "baseSha", "headSha", "preview", "rule"]),
  checks: Object.freeze(["schemaVersion", "headSha", "available", "checkRuns"]),
});

// These fields are intentionally excluded even if a malformed or future
// package happens to carry them. Review Pages resources own metadata and
// review preparation; this adapter must never turn into a source or log
// transport. `text` is not excluded because it is the bounded Issue
// acceptance-criteria field produced by build-issue.mjs.
const RAW_RESOURCE_KEYS = new Set([
  "body",
  "content",
  "diffText",
  "log",
  "logs",
  "patch",
  "raw",
  "rawContent",
  "rawDiff",
  "rawLog",
  "stderr",
  "stdout",
]);

const NORMALIZED_RAW_RESOURCE_KEYS = new Set(
  [...RAW_RESOURCE_KEYS].map((key) => key.replaceAll(/[-_]/gu, "").toLowerCase()),
);

const MAX_RESOURCE_NESTING = 32;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key);
}

function keyIsRawResourceContent(key) {
  if (RAW_RESOURCE_KEYS.has(key)) return true;
  return NORMALIZED_RAW_RESOURCE_KEYS.has(key.replaceAll(/[-_]/gu, "").toLowerCase());
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function pushUnknownDetail(details, resource, path, reason) {
  details.push({ resource, path, reason });
}

// Clone JSON-shaped values while preserving resource-owned fields. The small
// deny-list prevents an accidental raw body/log/diff from crossing the
// adapter boundary, and every omission is surfaced to the caller.
function cloneBounded(value, { resource, path, unknownDetails }, depth = 0, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value === undefined) {
    pushUnknownDetail(unknownDetails, resource, path, "undefined value omitted");
    return undefined;
  }

  if (typeof value !== "object") {
    pushUnknownDetail(unknownDetails, resource, path, `unsupported JSON value type: ${typeof value}`);
    return undefined;
  }

  if (depth >= MAX_RESOURCE_NESTING) {
    pushUnknownDetail(unknownDetails, resource, path, "resource nesting exceeds bounded limit");
    return undefined;
  }

  if (ancestors.has(value)) {
    pushUnknownDetail(unknownDetails, resource, path, "cyclic resource value omitted");
    return undefined;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .map((item, index) =>
          cloneBounded(item, { resource, path: `${path}[${index}]`, unknownDetails }, depth + 1, ancestors),
        )
        .filter((item) => item !== undefined);
    }

    const cloned = {};
    for (const key of Object.keys(value).sort()) {
      const childPath = path ? `${path}.${key}` : key;
      if (keyIsRawResourceContent(key)) {
        pushUnknownDetail(unknownDetails, resource, childPath, "raw source or log content is excluded");
        continue;
      }
      const child = cloneBounded(value[key], { resource, path: childPath, unknownDetails }, depth + 1, ancestors);
      if (child !== undefined) cloned[key] = child;
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function cloneIdentity(value, path, unknownDetails) {
  if (value === undefined) return null;
  return cloneBounded(value, { resource: "manifest.json", path, unknownDetails }) ?? null;
}

function resourceArgument({ packageInput, resources, key, file }) {
  if (hasOwn(packageInput, key)) return { present: packageInput[key] !== undefined, value: packageInput[key] };
  if (hasOwn(resources, key)) return { present: resources[key] !== undefined, value: resources[key] };
  if (hasOwn(resources, file)) return { present: resources[file], value: resources[file] };
  return { present: false, value: undefined };
}

function expectedResourcePath(manifest, key, file, unknownDetails) {
  if (!isRecord(manifest?.resources)) {
    return file;
  }
  if (!hasOwn(manifest.resources, key)) {
    pushUnknownDetail(
      unknownDetails,
      "manifest.json",
      `resources.${key}`,
      `resource reference is missing; expected ${file}`,
    );
    return file;
  }
  const declaredPath = manifest.resources[key];
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    pushUnknownDetail(
      unknownDetails,
      "manifest.json",
      `resources.${key}`,
      "resource reference must be a non-empty string",
    );
    return file;
  }
  return declaredPath;
}

function manifestState(manifest, unknownDetails) {
  if (manifest === undefined) return "missing";
  if (!isRecord(manifest)) {
    pushUnknownDetail(unknownDetails, "manifest.json", "", "manifest must be a JSON object");
    return "unknown";
  }

  let partial = false;
  let unknown = false;
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!hasOwn(manifest, field)) {
      pushUnknownDetail(unknownDetails, "manifest.json", field, "required manifest field is missing");
      partial = true;
    }
  }
  for (const [field, label] of [
    ["repository", "repository identity"],
    ["pullRequest", "pull request identity"],
    ["revision", "revision identity"],
  ]) {
    if (hasOwn(manifest, field) && !isRecord(manifest[field])) {
      pushUnknownDetail(unknownDetails, "manifest.json", field, `${label} must be a JSON object`);
      unknown = true;
    }
  }
  if (isRecord(manifest.pullRequest) && isRecord(manifest.revision)) {
    if (
      manifest.revision.id !== undefined &&
      manifest.pullRequest.headSha !== undefined &&
      manifest.revision.id !== manifest.pullRequest.headSha
    ) {
      pushUnknownDetail(
        unknownDetails,
        "manifest.json",
        "revision.id",
        "revision id does not match pullRequest.headSha",
      );
      unknown = true;
    }
  }
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    pushUnknownDetail(
      unknownDetails,
      "manifest.json",
      "schemaVersion",
      `unsupported schema version: ${String(manifest.schemaVersion)}`,
    );
    return "unknown";
  }
  if (unknown) return "unknown";
  if (partial || unknownDetails.some((detail) => detail.resource === "manifest.json")) return "partial";
  return "present";
}

function resourceIdentityMismatch(key, resource, pullRequest) {
  if (!isRecord(resource) || !isRecord(pullRequest)) return null;
  if (key === "diff" || key === "ocr") {
    if (resource.baseSha !== undefined && resource.baseSha !== pullRequest.baseSha)
      return "baseSha does not match manifest.pullRequest.baseSha";
    if (resource.headSha !== undefined && resource.headSha !== pullRequest.headSha)
      return "headSha does not match manifest.pullRequest.headSha";
  }
  if (key === "checks" && resource.headSha !== undefined && resource.headSha !== pullRequest.headSha) {
    return "headSha does not match manifest.pullRequest.headSha";
  }
  return null;
}

function resourceState({ definition, value, pullRequest, unknownDetails }) {
  if (value === undefined) return "missing";
  if (!isRecord(value)) {
    pushUnknownDetail(unknownDetails, definition.file, "", "resource must be a JSON object");
    return "unknown";
  }

  let state = "present";
  for (const field of RESOURCE_REQUIRED_FIELDS[definition.key]) {
    if (!hasOwn(value, field)) {
      pushUnknownDetail(unknownDetails, definition.file, field, "required resource field is missing");
      state = "partial";
    }
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== definition.schemaVersion) {
    pushUnknownDetail(
      unknownDetails,
      definition.file,
      "schemaVersion",
      `unsupported schema version: ${String(value.schemaVersion)}`,
    );
    state = "unknown";
  }
  const mismatch = resourceIdentityMismatch(definition.key, value, pullRequest);
  if (mismatch !== null) {
    pushUnknownDetail(unknownDetails, definition.file, "", mismatch);
    state = "unknown";
  }
  return state;
}

function hasUnsafeResourceDetail(details) {
  return details.some((detail) =>
    [
      "raw source or log content is excluded",
      "undefined value omitted",
      "unsupported JSON value type:",
      "resource nesting exceeds bounded limit",
      "cyclic resource value omitted",
    ].some((reason) => detail.reason.startsWith(reason)),
  );
}

function readResources(packageInput) {
  const resources = isRecord(packageInput.resources) ? packageInput.resources : {};
  return Object.fromEntries(
    RESOURCE_DEFINITIONS.map(({ key, file }) => [key, resourceArgument({ packageInput, resources, key, file }).value]),
  );
}

function manifestResourcePaths(manifest, unknownDetails) {
  return Object.fromEntries(
    RESOURCE_DEFINITIONS.map(({ key, file }) => [key, expectedResourcePath(manifest, key, file, unknownDetails)]),
  );
}

/**
 * Assemble one bounded AI-review input from one generated/published revision.
 *
 * The adapter is deliberately a pure projection: it consumes already-built
 * resources and never invokes Git, GitHub, OCR, an LLM, or a repository scan.
 * `packageInput` may use the generated shape (`{ manifest, resources }`) or
 * provide the four resources directly (`{ manifest, issue, diff, ocr, checks }`).
 */
export function assembleReviewInput(packageInput = {}) {
  const input = isRecord(packageInput) ? packageInput : {};
  const manifest = input.manifest;
  const unknownDetails = [];
  const missing = [];
  const partial = [];
  const unknown = [];

  const sourceResources = readResources(input);
  const paths = manifestResourcePaths(manifest, unknownDetails);
  const manifestStatus = manifestState(manifest, unknownDetails);
  if (manifestStatus === "missing") pushUnique(missing, "manifest.json");
  if (manifestStatus === "unknown") pushUnique(unknown, "manifest.json");
  if (manifestStatus === "partial") pushUnique(partial, "manifest.json");

  const identity = {
    repository: cloneIdentity(manifest?.repository, "repository", unknownDetails),
    pullRequest: cloneIdentity(manifest?.pullRequest, "pullRequest", unknownDetails),
    revision: cloneIdentity(manifest?.revision, "revision", unknownDetails),
  };
  identity.baseSha = identity.pullRequest?.baseSha ?? null;
  identity.headSha = identity.pullRequest?.headSha ?? null;

  const projectedResources = {};
  const provenanceResources = {};

  for (const definition of RESOURCE_DEFINITIONS) {
    const value = sourceResources[definition.key];
    let state = resourceState({
      definition,
      value,
      pullRequest: manifest?.pullRequest,
      unknownDetails,
    });
    const resourceDetailStart = unknownDetails.length;

    projectedResources[definition.key] =
      value === undefined
        ? null
        : (cloneBounded(value, { resource: definition.file, path: "", unknownDetails }) ?? null);
    if (hasUnsafeResourceDetail(unknownDetails.slice(resourceDetailStart))) state = "unknown";
    if (state === "missing") pushUnique(missing, paths[definition.key]);
    if (state === "partial") pushUnique(partial, paths[definition.key]);
    if (state === "unknown") pushUnique(unknown, paths[definition.key]);
    provenanceResources[definition.key] = {
      path: paths[definition.key],
      schemaVersion: isRecord(value) && typeof value.schemaVersion === "string" ? value.schemaVersion : null,
      state,
    };
  }

  // `unknownDetails` is generated in stable resource/field order above. Keep
  // details in that order and expose only de-duplicated resource names in the
  // compact status arrays.
  const manifestSchemaVersion =
    isRecord(manifest) && typeof manifest.schemaVersion === "string" ? manifest.schemaVersion : null;
  const manifestResourceReferences = cloneIdentity(manifest?.resources, "resources", unknownDetails);
  return {
    schemaVersion: REVIEW_INPUT_SCHEMA_VERSION,
    identity,
    provenance: {
      manifest: {
        path: "manifest.json",
        schemaVersion: manifestSchemaVersion,
        resources: manifestResourceReferences,
        state: manifestStatus,
      },
      resources: provenanceResources,
    },
    issue: projectedResources.issue,
    diff: projectedResources.diff,
    ocr: projectedResources.ocr,
    checks: projectedResources.checks,
    missing,
    partial,
    unknown,
    unknownDetails,
  };
}

// Name follows the existing build-* modules and gives downstream reviewer
// execution a stable import without making either name an execution surface.
export const buildReviewInput = assembleReviewInput;
