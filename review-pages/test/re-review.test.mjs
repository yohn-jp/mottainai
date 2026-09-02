import assert from "node:assert/strict";
import test from "node:test";
import { FINDING_CARRY_OVER_STATES, REREVIEW_SCHEMA_VERSION, prepareRereview } from "../src/re-review.mjs";

const BASE_SHA = "a".repeat(40);
const OLD_HEAD_SHA = "b".repeat(40);
const NEW_HEAD_SHA = "c".repeat(40);

function identity(headSha) {
  return {
    repository: "yohn-jp/mottainai",
    pullRequestNumber: 719,
    baseSha: BASE_SHA,
    headSha,
  };
}

function priorResult({ findingId = "finding-1", path = "src/a.js", hunk, verdict = "CHANGES_REQUIRED" } = {}) {
  return {
    schemaVersion: "mottainai.autonomous-review.result/v1",
    identity: identity(OLD_HEAD_SHA),
    verdict,
    findings: [
      {
        id: findingId,
        severity: "high",
        blocking: true,
        title: "Input is not validated",
        rationale: "The value reaches the parser without a guard.",
        status: "open",
        evidence: [
          {
            resource: "diff.json",
            path,
            ...(hunk === undefined ? {} : { hunk }),
          },
        ],
      },
    ],
  };
}

function reviewInput(files, overrides = {}) {
  return {
    schemaVersion: "mottainai.autonomous-review.input/v1",
    identity: identity(NEW_HEAD_SHA),
    diff: {
      schemaVersion: "mottainai.review-pages.diff/v1",
      baseSha: BASE_SHA,
      headSha: NEW_HEAD_SHA,
      files,
    },
    ...overrides,
  };
}

test("unchanged evidence is carried with old/new head provenance and verdict is invalidated", () => {
  const hunk = { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 };
  const result = prepareRereview({
    priorResult: priorResult({ hunk }),
    newReviewInput: reviewInput([
      { path: "src/a.js", status: "modified", hunks: [hunk] },
      { path: "README.md", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] },
    ]),
  });

  assert.equal(result.schemaVersion, REREVIEW_SCHEMA_VERSION);
  assert.equal(result.verdict, null);
  assert.deepEqual(result.priorVerdict, { invalidated: true });
  assert.equal(result.headRollover.from, OLD_HEAD_SHA);
  assert.equal(result.headRollover.to, NEW_HEAD_SHA);
  assert.equal(result.findings[0].state, FINDING_CARRY_OVER_STATES.UNCHANGED);
  assert.equal(result.findings[0].carryOver.allowed, true);
  assert.equal(result.findings[0].carryOver.evidence[0].sourceHeadSha, OLD_HEAD_SHA);
  assert.equal(result.findings[0].carryOver.evidence[0].targetHeadSha, NEW_HEAD_SHA);
  assert.deepEqual(result.review.freshScope.paths, ["README.md"]);
  assert.equal(result.review.mode, "incremental");
});

test("a prior diff scope absent from the complete new PR diff is resolved without reusing stale evidence", () => {
  const result = prepareRereview({
    priorResult: priorResult({ findingId: "resolved-finding", hunk: undefined }),
    newReviewInput: reviewInput([]),
  });

  assert.equal(result.findings[0].state, FINDING_CARRY_OVER_STATES.RESOLVED);
  assert.equal(result.findings[0].carryOver.allowed, false);
  assert.deepEqual(result.findings[0].carryOver.evidence, []);
  assert.equal(result.findings[0].carryOver.discardedEvidence[0].sourceHeadSha, OLD_HEAD_SHA);
  assert.equal(result.review.mode, "incremental");
});

test("a removed evidence file becomes obsolete and its evidence is discarded", () => {
  const result = prepareRereview({
    priorResult: priorResult({ path: "src/removed.js", hunk: { oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 } }),
    newReviewInput: reviewInput([
      { path: "src/removed.js", status: "removed", hunks: [{ oldStart: 4, oldLines: 1, newStart: 0, newLines: 0 }] },
    ]),
  });

  assert.equal(result.findings[0].state, FINDING_CARRY_OVER_STATES.OBSOLETE);
  assert.equal(result.findings[0].carryOver.evidenceReused, false);
  assert.equal(result.findings[0].carryOver.discardedEvidence.length, 1);
  assert.equal(result.review.mode, "incremental");
});

test("an unrelated new file remains in the fresh review scope", () => {
  const hunk = { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 };
  const result = prepareRereview({
    priorResult: priorResult({ hunk }),
    newReviewInput: reviewInput([
      { path: "src/a.js", status: "modified", hunks: [hunk] },
      { path: "src/new.js", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }] },
    ]),
  });

  assert.equal(result.findings[0].state, FINDING_CARRY_OVER_STATES.UNCHANGED);
  assert.deepEqual(result.review.freshScope.paths, ["src/new.js"]);
  assert.equal(result.review.fallback, false);
});

test("an overlapping scope change requires re-evaluation and full review fallback", () => {
  const oldHunk = { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2 };
  const result = prepareRereview({
    priorResult: priorResult({ hunk: oldHunk }),
    newReviewInput: reviewInput([
      { path: "src/a.js", status: "modified", hunks: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 }] },
    ]),
  });

  assert.equal(result.findings[0].state, FINDING_CARRY_OVER_STATES.REEVALUATE_REQUIRED);
  assert.equal(result.findings[0].carryOver.allowed, false);
  assert.equal(result.review.mode, "full");
  assert.equal(result.review.fallback, true);
  assert.ok(result.review.reasons.some((reason) => reason.includes("scope-ambiguous")));
});

test("explicit resolution and re-evaluation hints are deterministic boundary inputs", () => {
  const first = prepareRereview({
    priorResult: priorResult({ findingId: "hinted", hunk: undefined }),
    newReviewInput: reviewInput([{ path: "src/a.js", status: "modified", hunks: [] }], {
      reReviewHints: { hinted: { state: "resolved", reason: "fix commit removed the guard violation" } },
    }),
  });
  const second = prepareRereview({
    priorResult: priorResult({ findingId: "hinted", hunk: undefined }),
    newReviewInput: reviewInput([{ path: "src/a.js", status: "modified", hunks: [] }], {
      reReviewHints: { hinted: { state: "resolved", reason: "fix commit removed the guard violation" } },
    }),
  });

  assert.deepEqual(first, second);
  assert.equal(first.findings[0].state, FINDING_CARRY_OVER_STATES.RESOLVED);
  assert.equal(first.findings[0].carryOver.reason, "fix commit removed the guard violation");
});

test("ambiguous identity and incomplete diff fail closed to a full review", () => {
  const result = prepareRereview({
    priorResult: priorResult(),
    newReviewInput: reviewInput([], {
      identity: { ...identity(NEW_HEAD_SHA), baseSha: "d".repeat(40) },
      diff: { baseSha: BASE_SHA, headSha: NEW_HEAD_SHA, complete: false, files: [] },
    }),
  });

  assert.equal(result.review.mode, "full");
  assert.equal(result.review.fallback, true);
  assert.ok(result.review.reasons.includes("base-revision-mismatch"));
  assert.ok(result.review.reasons.includes("diff-scope-incomplete"));
});
