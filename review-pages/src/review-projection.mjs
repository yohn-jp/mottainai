// Projection-only helpers for a structured autonomous-review result.
// The review-result JSON remains the authority; these functions only select
// bounded fields for static HTML and a GitHub Check payload.

export const REVIEW_CHECK_NAME = "Mottainai / Autonomous review";

export const REVIEW_VERDICTS = Object.freeze(["APPROVE", "CHANGES_REQUIRED", "INCONCLUSIVE"]);

const CHECK_CONCLUSIONS = Object.freeze({
  APPROVE: "success",
  CHANGES_REQUIRED: "failure",
  INCONCLUSIVE: "neutral",
});

const MAX_FINDINGS = 50;
const MAX_LIST_ITEMS = 50;
const MAX_TEXT_LENGTH = 2_000;
const MAX_CHECK_TEXT_LENGTH = 60_000;

export class ReviewProjectionError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function formatInputValues(value, kind) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).map((item) => {
    if (typeof item === "string") return boundedText(item);
    if (!isObject(item)) return boundedText(item);
    if (kind === "inspected") {
      const references = Array.isArray(item.references)
        ? item.references.slice(0, 10).map((ref) => boundedText(ref, 500))
        : [];
      return boundedText(
        `${item.resource ?? item.name ?? item.id ?? "unknown"}${references.length ? ` (${references.join(", ")})` : ""}`,
      );
    }
    if (kind === "omitted") {
      return boundedText(
        `${item.resource ?? item.name ?? item.id ?? "unknown"}: ${item.reason ?? "reason not reported"}`,
      );
    }
    return boundedText(
      `${item.id ?? item.name ?? item.resource ?? "unknown"}: ${item.reason ?? "reason not reported"}`,
    );
  });
}

function normalizeRepository(repository) {
  if (typeof repository === "string") return repository;
  if (!isObject(repository)) return "";
  if (typeof repository.fullName === "string") return repository.fullName;
  if (repository.owner && repository.name) return `${repository.owner}/${repository.name}`;
  return "";
}

function normalizePullRequestNumber(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (isObject(value) && Number.isInteger(value.number) && value.number > 0) return value.number;
  return null;
}

// #716 owns the result schema. This deliberately only extracts the stable
// identity needed by a projection. The full result validator remains the
// authority; this boundary only rejects identity/verdict values it cannot
// safely project.
export function reviewResultIdentity(reviewResult) {
  if (!isObject(reviewResult) || !isObject(reviewResult.identity)) {
    throw new ReviewProjectionError("review result must include an identity object");
  }

  const { identity } = reviewResult;
  const repository = identity.repository;
  const number = identity.pullRequest;
  const baseSha = identity.baseSha;
  const headSha = identity.headSha;

  if (
    typeof repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/u.test(repository) ||
    !Number.isInteger(number) ||
    number < 1 ||
    typeof baseSha !== "string" ||
    typeof headSha !== "string"
  ) {
    throw new ReviewProjectionError("review result is missing repository/PR/base/head identity");
  }
  if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new ReviewProjectionError("review result identity must use full lowercase SHA values");
  }
  if (baseSha === headSha) {
    throw new ReviewProjectionError("review result identity must distinguish base and head SHA values");
  }

  return Object.freeze({ repository, pullRequestNumber: number, baseSha, headSha });
}

function reviewVerdict(reviewResult) {
  const verdict = reviewResult.verdict;
  if (!REVIEW_VERDICTS.includes(verdict)) {
    throw new ReviewProjectionError(`unsupported review verdict: ${String(verdict)}`);
  }
  return verdict;
}

function reviewFindings(reviewResult) {
  const findings = reviewResult.findings;
  if (!Array.isArray(findings)) return [];
  return findings.slice(0, MAX_FINDINGS).filter((finding) => isObject(finding));
}

function confidenceValue(reviewResult) {
  const value = reviewResult.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) throw new ReviewProjectionError("review result confidence must be between 0 and 1");
  return value;
}

function inputLists(reviewResult) {
  const inputs = isObject(reviewResult.inputs) ? reviewResult.inputs : {};
  return {
    inspected: formatInputValues(inputs.inspected, "inspected"),
    omitted: formatInputValues(inputs.omitted, "omitted"),
    unknowns: formatInputValues(reviewResult.unknowns, "unknown"),
  };
}

function findingEvidence(finding) {
  const values = finding.evidenceRefs ?? finding.evidence ?? [];
  if (!Array.isArray(values)) return [];
  return values.slice(0, 10).map((value) => {
    if (typeof value === "string") return boundedText(value, 500);
    if (!isObject(value)) return boundedText(value, 500);
    const resource = value.resource ?? value.name ?? "evidence";
    const reference = value.reference ?? value.ref ?? value.path;
    return boundedText(reference ? `${resource}#${reference}` : resource, 500);
  });
}

function findingLocation(finding) {
  const location = finding.location ?? finding.sourceLocation ?? finding.fileRange;
  if (!isObject(location) || typeof location.path !== "string") return "";
  const start = location.startLine ?? location.start?.line;
  const end = location.endLine ?? location.end?.line ?? start;
  if (Number.isInteger(start) && Number.isInteger(end)) return `${location.path}:${start}-${end}`;
  if (Number.isInteger(start)) return `${location.path}:${start}`;
  return location.path;
}

function findingIsBlocking(finding) {
  return finding.blocking === true;
}

function findingStatus(finding) {
  return boundedText(finding.status ?? "open", 80);
}

function projectedFinding(finding) {
  return {
    id: boundedText(finding.id ?? "unnamed-finding", 160),
    severity: boundedText(finding.severity ?? "unknown", 80),
    blocking: findingIsBlocking(finding),
    title: boundedText(finding.title ?? "Untitled finding"),
    rationale: boundedText(finding.rationale ?? ""),
    evidence: findingEvidence(finding),
    location: findingLocation(finding),
    status: findingStatus(finding),
  };
}

function assertExpectedHead(identity, expectedHeadSha) {
  if (expectedHeadSha !== undefined && expectedHeadSha !== identity.headSha) {
    throw new ReviewProjectionError(
      `review result head ${identity.headSha} does not match expected head ${expectedHeadSha}`,
    );
  }
}

function assertExpectedIdentity(identity, expectedIdentity) {
  if (!isObject(expectedIdentity)) return;
  const expectedPullRequest = normalizePullRequestNumber(
    expectedIdentity.pullRequest ?? expectedIdentity.pullRequestNumber,
  );
  const mismatches = [
    [identity.repository, normalizeRepository(expectedIdentity.repository)],
    [identity.pullRequestNumber, expectedPullRequest],
    [identity.baseSha, expectedIdentity.baseSha],
    [identity.headSha, expectedIdentity.headSha],
  ]
    .filter(([, expected]) => expected !== undefined && expected !== null && expected !== "")
    .filter(([actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    throw new ReviewProjectionError("review result identity does not match the displayed revision");
  }
}

function manifestIdentity(manifest) {
  if (!isObject(manifest)) return undefined;
  const pullRequest = isObject(manifest.pullRequest) ? manifest.pullRequest : {};
  const repository = normalizeRepository(manifest.repository);
  const pullRequestNumber = normalizePullRequestNumber(pullRequest.number);
  const baseSha = pullRequest.baseSha;
  const headSha = manifest.revision?.id ?? pullRequest.headSha;
  if (!repository || !pullRequestNumber || typeof baseSha !== "string" || typeof headSha !== "string") return undefined;
  return { repository, pullRequest: pullRequestNumber, baseSha, headSha };
}

export function projectReviewResult(reviewResult, { expectedHeadSha, expectedIdentity } = {}) {
  const identity = reviewResultIdentity(reviewResult);
  assertExpectedHead(identity, expectedHeadSha);
  assertExpectedIdentity(identity, expectedIdentity);
  const verdict = reviewVerdict(reviewResult);
  const findings = reviewFindings(reviewResult).map(projectedFinding);
  const inputs = inputLists(reviewResult);
  const confidence = confidenceValue(reviewResult);

  return Object.freeze({
    identity,
    status: boundedText(reviewResult.status ?? "complete", 80),
    verdict,
    confidence,
    findings: Object.freeze(findings),
    blockingFindings: Object.freeze(findings.filter((finding) => finding.blocking)),
    inspectedInputs: Object.freeze(inputs.inspected),
    omittedInputs: Object.freeze(inputs.omitted),
    unknowns: Object.freeze(inputs.unknowns),
  });
}

function listMarkup(values, emptyText = "none reported") {
  if (values.length === 0) return `<p class="review-empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("\n")}</ul>`;
}

function findingMarkup(finding) {
  const labels = [finding.severity, finding.status, finding.blocking ? "blocking" : "non-blocking"]
    .filter(Boolean)
    .map((value) => `<code>${escapeHtml(value)}</code>`)
    .join(" ");
  const location = finding.location ? `<p>Location: <code>${escapeHtml(finding.location)}</code></p>` : "";
  const evidence = finding.evidence.length
    ? `<p>Evidence: ${finding.evidence.map((value) => `<code>${escapeHtml(value)}</code>`).join(", ")}</p>`
    : "<p>Evidence: none reported</p>";
  const rationale = finding.rationale ? `<p>${escapeHtml(finding.rationale)}</p>` : "";
  return (
    `<li><strong>${escapeHtml(finding.title)}</strong> ${labels} ` +
    `<small>(<code>${escapeHtml(finding.id)}</code>)</small>${location}${rationale}${evidence}</li>`
  );
}

function confidenceMarkup(confidence) {
  return confidence === null ? "unknown" : `${Math.round(confidence * 100)}%`;
}

function staleState({ identity, manifest, latestHeadSha }) {
  const expected = manifestIdentity(manifest);
  const revisionHeadSha = expected?.headSha ?? manifest?.revision?.id ?? manifest?.pullRequest?.headSha;
  const latest = latestHeadSha ?? null;
  if (
    expected &&
    (identity.repository !== expected.repository ||
      identity.pullRequestNumber !== expected.pullRequest ||
      identity.baseSha !== expected.baseSha ||
      identity.headSha !== expected.headSha)
  ) {
    return { kind: "mismatched", resultHeadSha: identity.headSha, revisionHeadSha, latestHeadSha: latest };
  }
  if (latest && revisionHeadSha && latest !== revisionHeadSha) {
    return { kind: "stale", revisionHeadSha, latestHeadSha: latest };
  }
  return { kind: "current", revisionHeadSha, latestHeadSha: latest };
}

function stateMarkup(state) {
  if (state.kind === "mismatched") {
    return (
      `<p class="review-status review-status-invalid"><strong>INVALID / HEAD OR IDENTITY MISMATCH</strong> — ` +
      `result head <code>${escapeHtml(state.resultHeadSha)}</code> does not match displayed revision head ` +
      `<code>${escapeHtml(state.revisionHeadSha ?? "unknown")}</code>; it is not authoritative ` +
      "for this revision.</p>"
    );
  }
  if (state.kind === "stale") {
    return (
      `<p class="review-status review-status-stale"><strong>STALE / SUPERSEDED</strong> — ` +
      `a newer Review Pages revision exists at head <code>${escapeHtml(state.latestHeadSha)}</code>.</p>`
    );
  }
  return (
    `<p class="review-status review-status-current"><strong>CURRENT REVISION</strong> — ` +
    "this result is scoped to the displayed head SHA.</p>"
  );
}

// Render only bounded, contract-level result fields. In particular, raw
// transcript/private-reasoning fields are intentionally never traversed.
export function renderReviewResult({
  reviewResult,
  manifest,
  latestHeadSha,
  latestRevision,
  prIndex,
  reviewResultHref = "review-result.json",
}) {
  const projected = projectReviewResult(reviewResult, { expectedHeadSha: undefined });
  const state = staleState({
    identity: projected.identity,
    manifest,
    latestHeadSha: latestHeadSha ?? latestRevision?.headSha ?? prIndex?.latest?.headSha,
  });
  const blocking = projected.blockingFindings;
  const resultHref = reviewResultHref ? `<a href="${escapeHtml(reviewResultHref)}">review-result.json</a>` : "";
  const findingSection = blocking.length
    ? `<ol>${blocking.map(findingMarkup).join("\n")}</ol>`
    : '<p class="review-empty">No blocking findings.</p>';

  return `<section id="autonomous-review" aria-labelledby="autonomous-review-heading">
<h2 id="autonomous-review-heading">Autonomous review</h2>
${stateMarkup(state)}
<p>Verdict: <strong data-review-verdict="${escapeHtml(projected.verdict)}">${escapeHtml(projected.verdict)}</strong></p>
<p>Status: <code>${escapeHtml(projected.status)}</code> · Confidence: <strong>${escapeHtml(confidenceMarkup(projected.confidence))}</strong></p>
<p>Reviewed head: <code>${escapeHtml(projected.identity.headSha)}</code></p>
${resultHref ? `<p>Structured result: ${resultHref}</p>` : ""}
<h3>Blocking findings (${blocking.length})</h3>
${findingSection}
<h3>Inspected inputs</h3>
${listMarkup(projected.inspectedInputs)}
<h3>Omitted inputs</h3>
${listMarkup(projected.omittedInputs)}
<h3>Unknowns</h3>
${listMarkup(projected.unknowns)}
</section>`;
}

function checkSummary(projected, stale) {
  const blockerCount = projected.blockingFindings.length;
  const suffix = stale ? " The result is superseded by a newer Review Pages revision." : "";
  if (projected.verdict === "APPROVE") {
    return `Autonomous review APPROVE: no blocking findings.${suffix}`;
  }
  if (projected.verdict === "CHANGES_REQUIRED") {
    return `Autonomous review CHANGES_REQUIRED: ${blockerCount} blocking finding(s).${suffix}`;
  }
  return `Autonomous review INCONCLUSIVE: evidence is insufficient for a safe decision.${suffix}`;
}

function checkText(projected) {
  const lines = [
    `Verdict: ${projected.verdict}`,
    `Confidence: ${confidenceMarkup(projected.confidence)}`,
    `Blocking findings: ${projected.blockingFindings.length}`,
  ];
  if (projected.blockingFindings.length) {
    lines.push("", "Blocking findings:");
    for (const finding of projected.blockingFindings) {
      lines.push(`- [${finding.severity}] ${finding.title}${finding.location ? ` (${finding.location})` : ""}`);
    }
  }
  lines.push("", `Inspected inputs: ${projected.inspectedInputs.join(", ") || "none reported"}`);
  lines.push(`Unknowns: ${projected.unknowns.join(", ") || "none reported"}`);
  return boundedText(lines.join("\n"), MAX_CHECK_TEXT_LENGTH);
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl) {
    throw new ReviewProjectionError("review Pages base URL is required");
  }
  return baseUrl.replace(/\/+$/u, "");
}

export function reviewPagesRevisionUrl({ reviewPagesBaseUrl, repository, pullRequestNumber, headSha }) {
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new ReviewProjectionError("review Pages URL requires a full lowercase head SHA");
  }
  const repoName = normalizeRepository(repository);
  const number = normalizePullRequestNumber(pullRequestNumber);
  if (!repoName || !number) throw new ReviewProjectionError("review Pages URL requires repository and PR number");
  const baseUrl = normalizeBaseUrl(reviewPagesBaseUrl);
  return `${baseUrl}/reviews/pr/${number}/${headSha}/index.html`;
}

// Build the GitHub Checks REST create/update payload. It is deliberately a
// pure projection: callers decide when and with which token to POST it.
export function buildReviewCheck({ reviewResult, manifest, reviewPagesUrl, reviewPagesBaseUrl, latestHeadSha }) {
  const expectedManifestIdentity = manifestIdentity(manifest);
  const projected = projectReviewResult(reviewResult, {
    ...(expectedManifestIdentity
      ? { expectedIdentity: expectedManifestIdentity }
      : { expectedHeadSha: manifest?.revision?.id ?? manifest?.pullRequest?.headSha }),
  });
  const identity = projected.identity;
  const state = staleState({ identity, manifest, latestHeadSha });
  const detailsUrl =
    reviewPagesUrl ??
    reviewPagesRevisionUrl({
      reviewPagesBaseUrl,
      repository: identity.repository,
      pullRequestNumber: identity.pullRequestNumber,
      headSha: identity.headSha,
    });
  if (typeof detailsUrl !== "string" || !detailsUrl.includes(identity.headSha)) {
    throw new ReviewProjectionError("GitHub Check details URL must identify the full reviewed head SHA");
  }
  const stale = state.kind === "stale";
  const inProgress = projected.status === "pending";
  const conclusion = inProgress ? null : stale ? "stale" : CHECK_CONCLUSIONS[projected.verdict];
  const summary = checkSummary(projected, stale);

  return {
    name: REVIEW_CHECK_NAME,
    head_sha: identity.headSha,
    external_id: `${identity.repository}:pr-${identity.pullRequestNumber}:${identity.baseSha}:${identity.headSha}`,
    status: inProgress ? "in_progress" : "completed",
    conclusion,
    details_url: detailsUrl,
    output: {
      title: stale ? `Autonomous review ${projected.verdict} (superseded)` : `Autonomous review ${projected.verdict}`,
      summary,
      text: checkText(projected),
    },
  };
}
