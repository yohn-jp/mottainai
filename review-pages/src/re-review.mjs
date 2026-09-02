/**
 * Deterministic preparation for reviewing a later PR revision.
 *
 * This is an adapter between the structured autonomous-review result and the
 * bounded Review Pages input. It has no I/O, provider calls, or verdict
 * authority. A caller must run a new reviewer for the returned input.
 */

export const REREVIEW_SCHEMA_VERSION = "mottainai.autonomous-review.rereview/v1";

export const FINDING_CARRY_OVER_STATES = Object.freeze({
  UNCHANGED: "unchanged",
  RESOLVED: "resolved",
  OBSOLETE: "obsolete",
  REEVALUATE_REQUIRED: "re-evaluate-required",
});

const FULL_SHA = /^[0-9a-f]{40}$/u;
const MAX_FINDINGS = 256;
const MAX_EVIDENCE = 32;
const MAX_FILES = 4096;
const MAX_HUNKS_PER_FILE = 256;
const MAX_TEXT = 4000;
const DIFF_RESOURCES = new Set(["diff", "diff.json"]);

export class ReReviewContractError extends TypeError {}

/**
 * Compare a prior result with one exact new Review Pages input.
 *
 * Preferred form: `prepareRereview({ priorResult, newReviewInput })`.
 * The two-argument form is equivalent and useful for fixture callers.
 */
export function prepareRereview(argument, secondArgument) {
  const { priorResult, newReviewInput } =
    arguments.length > 1 ? { priorResult: argument, newReviewInput: secondArgument } : (argument ?? {});

  const current = identityOf(newReviewInput);
  if (current.value === null) {
    throw new ReReviewContractError(
      `new review input must contain an exact revision identity: ${current.errors.join("; ") || "missing identity"}`,
    );
  }

  const prior = identityOf(priorResult);
  const diff = readDiff(newReviewInput);
  const priorFindings = readFindings(priorResult);
  const reasons = [...prior.errors.map((error) => `prior-${error}`), ...diff.errors, ...priorFindings.errors];

  if (prior.value !== null) {
    if (prior.value.repository !== current.value.repository) reasons.push("repository-identity-mismatch");
    if (prior.value.pullRequestNumber !== current.value.pullRequestNumber)
      reasons.push("pull-request-identity-mismatch");
    if (prior.value.baseSha !== current.value.baseSha) reasons.push("base-revision-mismatch");
    if (prior.value.headSha === current.value.headSha) reasons.push("head-did-not-roll-over");
  }
  if (diff.value !== null) {
    if (diff.value.baseSha !== null && diff.value.baseSha !== current.value.baseSha)
      reasons.push("diff-base-revision-mismatch");
    if (diff.value.headSha !== null && diff.value.headSha !== current.value.headSha)
      reasons.push("diff-head-revision-mismatch");
    if (!diff.value.complete) reasons.push("diff-scope-incomplete");
  }

  const prepared = [];
  const coveredPaths = new Set();
  if (prior.value !== null && diff.value !== null && priorFindings.value !== null) {
    for (const [index, finding] of priorFindings.value.entries()) {
      const item = classifyFinding({
        finding,
        index,
        input: newReviewInput,
        diff: diff.value,
        sourceHeadSha: prior.value.headSha,
        targetHeadSha: current.value.headSha,
      });
      prepared.push(item.output);
      for (const path of item.coveredPaths) coveredPaths.add(path);
      if (item.state === FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED)
        reasons.push(`finding-${item.output.id ?? index}-scope-ambiguous`);
    }
  }

  const finalReasons = unique(reasons);
  const fallback = finalReasons.length > 0;
  const files = diff.value?.files ?? [];
  const freshFiles = files.filter((file) => !coveredPaths.has(file.path));

  return {
    schemaVersion: REREVIEW_SCHEMA_VERSION,
    // A prior verdict is never copied. `null` is intentional and forces the
    // reviewer execution boundary to produce a result for the new head.
    verdict: null,
    reviewStatus: "requires-new-result",
    priorVerdict: { invalidated: true },
    priorRevision: prior.value,
    newRevision: current.value,
    headRollover: {
      from: prior.value?.headSha ?? null,
      to: current.value.headSha,
    },
    findings: prepared,
    review: {
      mode: fallback ? "full" : "incremental",
      fallback,
      reasons: finalReasons,
      freshScope: {
        paths: freshFiles.map((file) => file.path).sort(compareStrings),
        files: freshFiles.map(boundFile),
      },
    },
  };
}

// Keep one implementation/authority while accommodating normal spelling
// differences at call sites.
export const prepareReReview = prepareRereview;
export const prepareReReviewInput = prepareRereview;

function classifyFinding({ finding, index, input, diff, sourceHeadSha, targetHeadSha }) {
  const id = stringValue(finding.id ?? finding.findingId);
  const evidence = readEvidence(finding);
  const hint = stateHint(input, id);
  let state;
  let reason;
  let reusable = false;
  let coveredPaths = [];

  if (evidence.length > MAX_EVIDENCE) {
    state = FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED;
    reason = "finding-evidence-too-large";
  } else if (hint?.state === FINDING_CARRY_OVER_STATES.RESOLVED) {
    state = hint.state;
    reason = hint.reason ?? "new-input-explicitly-resolved";
  } else if (hint?.state === FINDING_CARRY_OVER_STATES.OBSOLETE) {
    state = hint.state;
    reason = hint.reason ?? "new-input-explicitly-obsolete";
  } else if (hint?.state === FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED) {
    state = hint.state;
    reason = hint.reason ?? "new-input-requires-re-evaluation";
  } else {
    const classified = classifyScope({ evidence, input, diff, hint });
    state = classified.state;
    reason = classified.reason;
    reusable = classified.reusable;
    coveredPaths = classified.coveredPaths;
  }

  // An unchanged hint is not trusted on its own; it must still be proven by
  // the exact new diff. This prevents a stale hint from becoming authority.
  if (hint?.state === FINDING_CARRY_OVER_STATES.UNCHANGED) {
    const classified = classifyScope({ evidence, input, diff, hint });
    if (classified.reusable) {
      state = classified.state;
      reason = hint.reason ?? classified.reason;
      reusable = true;
      coveredPaths = classified.coveredPaths;
    } else {
      state = FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED;
      reason = "unchanged-hint-lacks-verifiable-evidence";
      reusable = false;
      coveredPaths = [];
    }
  }

  const provenance = evidence.map((reference) => ({
    resource: reference.resource,
    path: reference.path,
    ...(reference.range === null ? {} : { range: reference.range }),
    ...(reference.hunk === null ? {} : { hunk: reference.hunk }),
    ...(reference.fingerprint === null ? {} : { fingerprint: reference.fingerprint }),
    sourceHeadSha,
    targetHeadSha,
  }));

  return {
    state,
    coveredPaths,
    output: {
      id,
      priorIndex: index,
      state,
      status: state,
      lifecycle: state === FINDING_CARRY_OVER_STATES.UNCHANGED ? "current" : state,
      severity: scalar(finding.severity),
      blocking: typeof finding.blocking === "boolean" ? finding.blocking : null,
      title: boundedText(finding.title),
      rationale: boundedText(finding.rationale),
      priorStatus: scalar(finding.status),
      carryOver: {
        allowed: reusable,
        evidenceReused: reusable,
        evidence: reusable ? provenance : [],
        discardedEvidence: reusable ? [] : provenance,
        reason,
        sourceHeadSha,
        targetHeadSha,
      },
    },
  };
}

function classifyScope({ evidence, input, diff, hint }) {
  if (evidence.length === 0)
    return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "finding-has-no-bounded-evidence-scope");

  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  const byPreviousPath = new Map(
    diff.files.filter((file) => file.previousPath !== null).map((file) => [file.previousPath, file]),
  );
  const presentPaths = presentPathSet(input);
  const coveredPaths = [];

  for (const reference of evidence) {
    if (!DIFF_RESOURCES.has(reference.resource))
      return result(
        FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED,
        `evidence-resource-not-reusable:${reference.resource ?? "unknown"}`,
      );
    if (reference.path === null)
      return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "evidence-has-no-file-scope");

    const file = byPath.get(reference.path);
    const renamed = byPreviousPath.get(reference.path);
    if (renamed !== undefined && renamed.path !== reference.path)
      return result(FINDING_CARRY_OVER_STATES.OBSOLETE, "evidence-file-was-renamed");
    if (file?.status === "removed") return result(FINDING_CARRY_OVER_STATES.OBSOLETE, "evidence-file-was-removed");
    if (file === undefined) {
      if (presentPaths.has(reference.path) || diff.complete)
        return result(FINDING_CARRY_OVER_STATES.RESOLVED, "evidence-scope-is-no-longer-in-the-pr-diff");
      if (hint?.state === FINDING_CARRY_OVER_STATES.RESOLVED)
        return result(FINDING_CARRY_OVER_STATES.RESOLVED, hint.reason ?? "new-input-explicitly-resolved");
      return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "evidence-file-is-not-present-in-new-diff");
    }

    if (file.status === "unknown")
      return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "new-diff-file-status-unavailable");
    if (reference.fingerprint !== null && file.fingerprint !== null) {
      if (reference.fingerprint !== file.fingerprint)
        return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "evidence-file-fingerprint-changed");
      coveredPaths.push(file.path);
      continue;
    }
    if (reference.hunk !== null) {
      if (file.hunks === null)
        return result(FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED, "new-diff-hunk-scope-unavailable");
      if (file.hunks.some((hunk) => sameHunk(reference.hunk, hunk))) {
        // If another hunk exists in this file, it remains in the fresh scope;
        // the exact match proves only this finding's hunk, not the file.
        if (file.hunks.length === 1) coveredPaths.push(file.path);
        continue;
      }
    }
    if (reference.range !== null && file.hunks !== null) {
      if (!file.hunks.some((hunk) => overlaps(reference.range, hunkRange(hunk)))) {
        continue;
      }
    }
    return result(
      FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED,
      reference.range === null ? "path-only-evidence-scope-is-ambiguous" : "evidence-range-changed",
    );
  }
  return { ...result(FINDING_CARRY_OVER_STATES.UNCHANGED, "evidence-scope-unchanged"), reusable: true, coveredPaths };
}

function result(state, reason) {
  return { state, reason, reusable: false, coveredPaths: [] };
}

function identityOf(input) {
  if (!object(input)) return { value: null, errors: ["identity-unavailable"] };
  const layers = [];
  const add = (value) => {
    if (!object(value)) return;
    layers.push(value);
    add(value.identity);
    add(value.review);
    add(value.result);
    add(value.manifest);
    add(value.revision);
    add(value.pullRequest);
  };
  add(input);

  const errors = [];
  const repository = consistent(
    layers.flatMap((layer) => [layer.repository, layer.repositoryFullName, layer.fullName]),
    repositoryValue,
    "repository",
    errors,
  );
  const pullRequestNumber = consistent(
    layers.flatMap((layer) => [
      layer.pullRequestNumber,
      layer.prNumber,
      layer.number,
      Number.isInteger(layer.pullRequest) ? layer.pullRequest : null,
    ]),
    (value) => (Number.isInteger(value) && value > 0 ? value : null),
    "pull request number",
    errors,
  );
  const baseSha = consistent(
    layers.flatMap((layer) => [layer.baseSha, layer.base_sha]),
    shaValue,
    "base SHA",
    errors,
  );
  const headSha = consistent(
    layers.flatMap((layer) => [layer.headSha, layer.head_sha, layer.id]),
    shaValue,
    "head SHA",
    errors,
  );

  if (repository === null) errors.push("repository-missing");
  if (pullRequestNumber === null) errors.push("pull-request-number-missing");
  if (baseSha === null) errors.push("base-sha-missing");
  if (headSha === null) errors.push("head-sha-missing");
  return errors.length > 0
    ? { value: null, errors: unique(errors) }
    : { value: { repository, pullRequestNumber, baseSha, headSha }, errors: [] };
}

function readDiff(input) {
  if (!object(input)) return { value: null, errors: ["review-input-invalid"] };
  const diff = input.diff ?? input.resources?.diff ?? input.resources?.["diff.json"];
  if (!object(diff)) return { value: null, errors: ["new-review-input-diff-unavailable"] };
  if (!Array.isArray(diff.files)) return { value: null, errors: ["new-review-input-diff-files-unavailable"] };
  if (diff.files.length > MAX_FILES) return { value: null, errors: ["new-review-input-diff-too-large"] };

  const errors = [];
  const seen = new Set();
  const files = [];
  for (const file of diff.files) {
    if (!object(file) || typeof file.path !== "string" || file.path.length === 0) {
      errors.push("new-review-input-diff-has-invalid-file");
      continue;
    }
    if (seen.has(file.path)) {
      errors.push(`new-review-input-diff-duplicates-file:${file.path}`);
      continue;
    }
    seen.add(file.path);
    if (Array.isArray(file.hunks) && file.hunks.length > MAX_HUNKS_PER_FILE)
      errors.push(`new-review-input-diff-hunks-too-large:${file.path}`);
    files.push({
      path: file.path,
      previousPath: typeof file.previousPath === "string" ? file.previousPath : null,
      status: fileStatus(file.status),
      fingerprint: firstString(file.fingerprint, file.changeFingerprint, file.patchFingerprint),
      hunks: Array.isArray(file.hunks)
        ? file.hunks
            .slice(0, MAX_HUNKS_PER_FILE)
            .map(normalizeHunk)
            .filter((hunk) => hunk !== null)
        : null,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    value: {
      baseSha: firstString(diff.baseSha, diff.base_sha),
      headSha: firstString(diff.headSha, diff.head_sha),
      complete: diff.complete !== false && input.scope?.complete !== false,
      files,
    },
    errors: unique(errors),
  };
}

function readFindings(resultValue) {
  if (!object(resultValue)) return { value: null, errors: ["prior-result-invalid"] };
  const findings = resultValue.findings ?? resultValue.review?.findings ?? resultValue.result?.findings;
  if (!Array.isArray(findings)) return { value: null, errors: ["prior-result-findings-unavailable"] };
  if (findings.length > MAX_FINDINGS) return { value: null, errors: ["prior-result-findings-too-large"] };
  const errors = [];
  const ids = new Set();
  for (const [index, finding] of findings.entries()) {
    const id = object(finding) ? stringValue(finding.id ?? finding.findingId) : null;
    if (id === null) errors.push(`prior-result-finding-${index}-has-no-stable-id`);
    else if (ids.has(id)) errors.push(`prior-result-duplicate-finding-id:${id}`);
    else ids.add(id);
  }
  return { value: findings.filter(object), errors: unique(errors) };
}

function readEvidence(finding) {
  let raw = finding.evidence ?? finding.evidenceRefs ?? finding.evidenceReferences;
  if (raw === undefined && object(finding.location)) raw = [{ ...finding.location, resource: "diff.json" }];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(normalizeEvidence).filter((reference) => reference !== null);
}

function normalizeEvidence(value) {
  if (!object(value)) return null;
  const location = object(value.location) ? value.location : {};
  return {
    resource: resourceValue(firstString(value.resource, value.source, value.resourceName)),
    path: firstString(value.path, value.file, location.path, location.file),
    range: normalizeRange(value.range ?? value.lines ?? value.lineRange ?? location),
    hunk: normalizeHunk(value.hunk ?? value.hunkPosition),
    fingerprint: firstString(value.fingerprint, value.scopeFingerprint, value.changeFingerprint),
  };
}

function stateHint(input, findingId) {
  if (!object(input) || findingId === null) return null;
  const containers = [
    input.reReviewHints,
    input.rereviewHints,
    input.reReview,
    input.rereview,
    input.findingUpdates,
    input.findingStates,
    input.resolutions,
    input.diff?.findingStates,
  ];
  for (const container of containers) {
    const value = Array.isArray(container)
      ? container.find((candidate) => object(candidate) && (candidate.id ?? candidate.findingId) === findingId)
      : object(container?.[findingId])
        ? container[findingId]
        : null;
    if (!object(value)) continue;
    const state = stateValue(value.state ?? value.status ?? value.carryOverState);
    if (state !== null) return { state, reason: boundedText(value.reason) };
  }
  return null;
}

function presentPathSet(input) {
  const paths = new Set();
  for (const values of [input?.presentPaths, input?.sourceFiles, input?.repositoryFiles, input?.filesPresent]) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const path = typeof value === "string" ? value : object(value) ? value.path : null;
      if (typeof path === "string" && path.length > 0) paths.add(path);
    }
  }
  return paths;
}

function normalizeRange(value) {
  if (!object(value)) return null;
  const start = integer(value.start, value.startLine, value.lineStart, value.newStart);
  const end = integer(value.end, value.endLine, value.lineEnd, value.newEnd);
  if (start === null && end === null) return null;
  const low = start ?? end;
  const high = end ?? start;
  return { start: Math.min(low, high), end: Math.max(low, high) };
}

function normalizeHunk(value) {
  if (!object(value)) return null;
  const oldStart = integer(value.oldStart, value.old_start);
  const oldLines = integer(value.oldLines, value.old_lines);
  const newStart = integer(value.newStart, value.new_start);
  const newLines = integer(value.newLines, value.new_lines);
  const fingerprint = firstString(value.fingerprint, value.scopeFingerprint);
  if (oldStart === null && newStart === null && fingerprint === null) return null;
  return { oldStart, oldLines, newStart, newLines, fingerprint };
}

function sameHunk(left, right) {
  if (!object(left) || !object(right)) return false;
  if (left.fingerprint !== null && right.fingerprint !== null) return left.fingerprint === right.fingerprint;
  return (
    left.oldStart !== null &&
    left.oldLines !== null &&
    left.newStart !== null &&
    left.newLines !== null &&
    left.oldStart === right.oldStart &&
    left.oldLines === right.oldLines &&
    left.newStart === right.newStart &&
    left.newLines === right.newLines
  );
}

function hunkRange(hunk) {
  if (!object(hunk)) return null;
  const start = hunk.newStart ?? hunk.oldStart;
  if (!Number.isInteger(start)) return null;
  const lines = hunk.newLines ?? hunk.oldLines ?? 1;
  return { start, end: Math.max(start, start + Math.max(lines, 1) - 1) };
}

function overlaps(left, right) {
  return right !== null && left.start <= right.end && right.start <= left.end;
}

function stateValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "current" || normalized === "unchanged") return FINDING_CARRY_OVER_STATES.UNCHANGED;
  if (normalized === "resolved") return FINDING_CARRY_OVER_STATES.RESOLVED;
  if (normalized === "obsolete" || normalized === "stale") return FINDING_CARRY_OVER_STATES.OBSOLETE;
  if (["re-evaluate-required", "reevaluate-required", "re-evaluate"].includes(normalized))
    return FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED;
  return null;
}

function boundFile(file) {
  return {
    path: file.path,
    status: file.status,
    ...(file.previousPath === null ? {} : { previousPath: file.previousPath }),
    ...(file.fingerprint === null ? {} : { fingerprint: file.fingerprint }),
    ...(file.hunks === null ? {} : { hunks: file.hunks }),
  };
}

function repositoryValue(value) {
  if (typeof value === "string") return value.trim() || null;
  if (!object(value)) return null;
  if (typeof value.fullName === "string" && value.fullName.trim()) return value.fullName.trim();
  if (typeof value.owner === "string" && typeof value.name === "string" && value.owner.trim() && value.name.trim())
    return `${value.owner.trim()}/${value.name.trim()}`;
  return null;
}

function shaValue(value) {
  return typeof value === "string" && FULL_SHA.test(value) ? value : null;
}

function consistent(values, normalize, label, errors) {
  const normalized = unique(values.map(normalize).filter((value) => value !== null));
  if (normalized.length > 1) errors.push(`${label}-ambiguous`);
  return normalized[0] ?? null;
}

function resourceValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "diff" || normalized.endsWith("/diff.json")) return "diff.json";
  return normalized || null;
}

function fileStatus(value) {
  if (typeof value !== "string" || value.trim() === "") return "unknown";
  return value.trim().toLowerCase() === "deleted" ? "removed" : value.trim().toLowerCase();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function integer(...values) {
  return values.find((value) => Number.isInteger(value)) ?? null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function scalar(value) {
  if (typeof value === "string") return boundedText(value);
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : null;
}

function unique(values) {
  return [...new Set(values)];
}

function compareStrings(left, right) {
  return left.localeCompare(right);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
