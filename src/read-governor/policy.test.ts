import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCapabilityIndex } from "../adaptive/capabilities.js";
import { assertSupportedRolloutStage, evaluateRead, DEFAULT_POLICY, NO_CAPABILITY, SUPPORTED_ROLLOUT_STAGES } from "./policy.js";
import type { RolloutStage } from "./policy.js";

test("observe stage always allows, even for a large source file", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 });
  assert.equal(decision.action, "allow");
  assert.equal(decision.stage, "observe");
});

test("observe stage reports the policy code a later stage would apply to an unbounded source read", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 });
  assert.equal(decision.fileClass, "source");
  assert.equal(decision.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
  assert.ok(decision.suggestedTools.length > 0);
});

test("small files are exempt regardless of file class", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/small.ts", estimatedLines: 40 });
  assert.equal(decision.policyCode, "NONE");
  assert.deepEqual(decision.suggestedTools, []);
});

test("bounded reads (already localized) report no policy concern", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900, bounded: true });
  assert.equal(decision.policyCode, "NONE");
});

test("document, structured-config, log, and lockfile classes each get distinct policy codes", () => {
  assert.equal(evaluateRead({ path: "docs/architecture.md", estimatedLines: 900 }).policyCode, "DOCUMENT_SEARCH_PROVIDER_REQUIRED");
  assert.equal(evaluateRead({ path: "config/values.yaml", estimatedLines: 900 }).policyCode, "STRUCTURED_QUERY_REQUIRED");
  assert.equal(evaluateRead({ path: "var/log/app.log", estimatedLines: 900 }).policyCode, "STRUCTURED_QUERY_REQUIRED");
  assert.equal(evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900 }).policyCode, "GENERATED_FILE_DENIED");
});

test("generated/vendor files get GENERATED_FILE_DENIED regardless of size", () => {
  const decision = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 10 });
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
});

test("unknown file classes never trigger a policy code", () => {
  const decision = evaluateRead({ path: "assets/logo.png", estimatedLines: 900 });
  assert.equal(decision.policyCode, "NONE");
});

test("missing estimatedLines skips the small-file exemption but still evaluates the class", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts" });
  assert.equal(decision.fileClass, "source");
  assert.equal(decision.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
});

test("default policy stage is observe", () => {
  assert.equal(DEFAULT_POLICY.stage, "observe");
});

// --- provider routing (capability field + suggestedTools derived from CapabilityIndex) ---

test("source files recommend the code.symbol capability", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 });
  assert.equal(decision.capability, "code.symbol");
});

test("markdown files recommend the document.heading capability", () => {
  const decision = evaluateRead({ path: "docs/architecture.md", estimatedLines: 900 });
  assert.equal(decision.capability, "document.heading");
});

test("json/yaml/toml files recommend the structured.query capability", () => {
  assert.equal(evaluateRead({ path: "package.json", estimatedLines: 900 }).capability, "structured.query");
  assert.equal(evaluateRead({ path: "config/values.yaml", estimatedLines: 900 }).capability, "structured.query");
  assert.equal(evaluateRead({ path: "Cargo.toml", estimatedLines: 900 }).capability, "structured.query");
});

test("log files recommend the log.search capability", () => {
  const decision = evaluateRead({ path: "var/log/app.log", estimatedLines: 900 });
  assert.equal(decision.capability, "log.search");
});

test("generated files recommend deny with no suggested tools", () => {
  const decision = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 10 });
  assert.equal(decision.capability, "deny");
  assert.deepEqual(decision.suggestedTools, []);
});

test("lockfiles recommend deny with no suggested tools", () => {
  const decision = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900 });
  assert.equal(decision.capability, "deny");
  assert.deepEqual(decision.suggestedTools, []);
});

test("classes with no policy concern report NO_CAPABILITY", () => {
  assert.equal(evaluateRead({ path: "assets/logo.png", estimatedLines: 900 }).capability, NO_CAPABILITY);
  assert.equal(evaluateRead({ path: "apps/gateway/src/small.ts", estimatedLines: 40 }).capability, NO_CAPABILITY);
  assert.equal(evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900, bounded: true }).capability, NO_CAPABILITY);
});

test("suggestedTools stay provider-neutral by default (local fallback only)", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 });
  assert.deepEqual(decision.suggestedTools, ["mottainai_search"]);
});

test("suggestedTools resolve through the CapabilityIndex without Read Governor naming the provider", () => {
  const capabilityIndex = buildCapabilityIndex([
    { name: "codegraph", command: "codegraph", capabilities: ["code.symbol"] },
  ]);
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }, DEFAULT_POLICY, capabilityIndex);
  assert.deepEqual(decision.suggestedTools, ["codegraph", "mottainai_search"]);
});

test("each routed fileClass resolves its own registered capability", () => {
  const capabilityIndex = buildCapabilityIndex([
    { name: "docs-provider", command: "docs-provider", capabilities: ["document.heading"] },
    { name: "config-provider", command: "config-provider", capabilities: ["structured.query"] },
    { name: "log-provider", command: "log-provider", capabilities: ["log.search"] },
  ]);
  assert.deepEqual(
    evaluateRead({ path: "docs/architecture.md", estimatedLines: 900 }, DEFAULT_POLICY, capabilityIndex).suggestedTools,
    ["docs-provider", "mottainai_search"],
  );
  assert.deepEqual(
    evaluateRead({ path: "config/values.yaml", estimatedLines: 900 }, DEFAULT_POLICY, capabilityIndex).suggestedTools,
    ["config-provider", "mottainai_search"],
  );
  assert.deepEqual(
    evaluateRead({ path: "var/log/app.log", estimatedLines: 900 }, DEFAULT_POLICY, capabilityIndex).suggestedTools,
    ["log-provider", "mottainai_search"],
  );
  // an unrelated capability registration must not leak into another fileClass's suggestions.
  assert.deepEqual(
    evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900 }, DEFAULT_POLICY, capabilityIndex).suggestedTools,
    [],
  );
});

// --- warn stage (issue #64) ---

const WARN_POLICY = { ...DEFAULT_POLICY, stage: "warn" as const };

test("warn stage rewrites an unbounded whole source-file read and suggests tools", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }, WARN_POLICY);
  assert.equal(decision.action, "rewrite");
  assert.equal(decision.stage, "warn");
  assert.equal(decision.fileClass, "source");
  assert.equal(decision.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
  assert.ok(decision.suggestedTools.length > 0);
});

test("warn stage rewrites an unbounded whole Markdown read and recommends the document.heading capability", () => {
  const decision = evaluateRead({ path: "docs/architecture.md", estimatedLines: 900 }, WARN_POLICY);
  assert.equal(decision.action, "rewrite");
  assert.equal(decision.fileClass, "document");
  assert.equal(decision.capability, "document.heading");
  assert.equal(decision.policyCode, "DOCUMENT_SEARCH_PROVIDER_REQUIRED");
  assert.ok(decision.suggestedTools.length > 0);
});

test("warn stage rewrites an unbounded structured-config read and suggests a structured query", () => {
  const decision = evaluateRead({ path: "config/values.yaml", estimatedLines: 900 }, WARN_POLICY);
  assert.equal(decision.action, "rewrite");
  assert.equal(decision.fileClass, "structured-config");
  assert.equal(decision.policyCode, "STRUCTURED_QUERY_REQUIRED");
  assert.ok(decision.suggestedTools.length > 0);
});

test("warn stage rewrites an oversized bounded range read even though it is already localized", () => {
  const decision = evaluateRead(
    { path: "apps/gateway/src/big.ts", estimatedLines: 900, rangeLines: WARN_POLICY.warnMaxRangeLines + 50, bounded: true },
    WARN_POLICY,
  );
  assert.equal(decision.action, "rewrite");
  assert.equal(decision.policyCode, "FULL_READ_REQUIRES_LOCALIZATION");
});

test("warn stage allows a bounded read within the oversized-range threshold", () => {
  const decision = evaluateRead(
    { path: "apps/gateway/src/big.ts", estimatedLines: 900, rangeLines: WARN_POLICY.warnMaxRangeLines, bounded: true },
    WARN_POLICY,
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
});

// --- L: estimatedLines (file size) must not be reused as rangeLines (requested range size) ---

test("a small bounded range in a large file is not treated as an oversized range (#88)", () => {
  // file is estimated at 900 lines (large), but the bounded request only reads 10 lines.
  const decision = evaluateRead(
    { path: "apps/gateway/src/big.ts", estimatedLines: 900, rangeLines: 10, bounded: true },
    WARN_POLICY,
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
});

test("estimatedLines still controls the small-file exemption independently of rangeLines", () => {
  // small file (40 lines), regardless of what rangeLines says, stays exempt.
  const decision = evaluateRead(
    { path: "apps/gateway/src/small.ts", estimatedLines: 40, rangeLines: 900, bounded: true },
    WARN_POLICY,
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
});

test("a bounded range is oversized only when rangeLines itself exceeds warnMaxRangeLines, not estimatedLines alone", () => {
  // large file, but rangeLines is missing entirely: must not be treated as oversized.
  const decision = evaluateRead(
    { path: "apps/gateway/src/big.ts", estimatedLines: 900, bounded: true },
    WARN_POLICY,
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
});

test("warn stage never denies generated/vendor files; it still reports the future policy concern", () => {
  const decision = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900 }, WARN_POLICY);
  assert.notEqual(decision.action, "deny");
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
});

test("warn stage never denies lockfile reads; it still reports the future policy concern", () => {
  const decision = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900 }, WARN_POLICY);
  assert.notEqual(decision.action, "deny");
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
});

test("warn stage still exempts small files regardless of file class", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/small.ts", estimatedLines: 40 }, WARN_POLICY);
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
});

// --- K: unsupported rollout stages must be rejected, never silently fall through to allow (#87) ---

test("every implemented rollout stage has explicit, deliberate behavior (exhaustive)", () => {
  assert.deepEqual([...SUPPORTED_ROLLOUT_STAGES].sort(), ["observe", "warn"]);
  for (const stage of SUPPORTED_ROLLOUT_STAGES) {
    assert.doesNotThrow(() => assertSupportedRolloutStage(stage));
    assert.doesNotThrow(() => evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }, { ...DEFAULT_POLICY, stage }));
  }
});

test("assertSupportedRolloutStage rejects every unsupported/unimplemented stage, including enforce and tighten", () => {
  for (const stage of ["enforce", "tighten", "", "OBSERVE", "warn ", "block", "audit"]) {
    assert.throws(() => assertSupportedRolloutStage(stage), /unsupported read governor rollout stage/);
  }
});

test("evaluateRead rejects a configured enforce/tighten stage instead of silently allowing (regression)", () => {
  for (const stage of ["enforce", "tighten"] as const) {
    const policy = { ...DEFAULT_POLICY, stage: stage as unknown as RolloutStage };
    assert.throws(
      () => evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }, policy),
      /unsupported read governor rollout stage/,
    );
  }
});

test("evaluateRead rejects any other unimplemented stage string the same way", () => {
  for (const stage of ["block", "audit", ""] as const) {
    const policy = { ...DEFAULT_POLICY, stage: stage as unknown as RolloutStage };
    assert.throws(() => evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900 }, policy));
  }
});

// --- M: deny-only classes (generated/lockfile) must keep reporting the denial concern even when bounded ---

test("observe stage reports the deny concern for an unbounded generated file read", () => {
  const decision = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900 });
  assert.equal(decision.action, "allow");
  assert.equal(decision.capability, "deny");
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
});

test("observe stage still reports the deny concern for a BOUNDED generated file read (regression: bounded must not erase it)", () => {
  const decision = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900, rangeLines: 5, bounded: true });
  assert.equal(decision.action, "allow");
  assert.equal(decision.capability, "deny");
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
  assert.deepEqual(decision.suggestedTools, []);
});

test("observe stage still reports the deny concern for a BOUNDED lockfile read (regression: bounded must not erase it)", () => {
  const decision = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900, rangeLines: 5, bounded: true });
  assert.equal(decision.action, "allow");
  assert.equal(decision.capability, "deny");
  assert.equal(decision.policyCode, "GENERATED_FILE_DENIED");
  assert.deepEqual(decision.suggestedTools, []);
});

test("warn stage still reports the deny concern for a BOUNDED generated/lockfile read", () => {
  const generated = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900, rangeLines: 5, bounded: true }, WARN_POLICY);
  assert.equal(generated.action, "allow");
  assert.equal(generated.policyCode, "GENERATED_FILE_DENIED");

  const lockfile = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900, rangeLines: 5, bounded: true }, WARN_POLICY);
  assert.equal(lockfile.action, "allow");
  assert.equal(lockfile.policyCode, "GENERATED_FILE_DENIED");
});

test("bounded and unbounded generated/lockfile reads report the same denial concern (deny-only classes ignore bounded)", () => {
  const unboundedGenerated = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900 });
  const boundedGenerated = evaluateRead({ path: "node_modules/foo/index.js", estimatedLines: 900, rangeLines: 5, bounded: true });
  assert.equal(unboundedGenerated.policyCode, boundedGenerated.policyCode);
  assert.equal(unboundedGenerated.capability, boundedGenerated.capability);

  const unboundedLockfile = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900 });
  const boundedLockfile = evaluateRead({ path: "pnpm-lock.yaml", estimatedLines: 900, rangeLines: 5, bounded: true });
  assert.equal(unboundedLockfile.policyCode, boundedLockfile.policyCode);
  assert.equal(unboundedLockfile.capability, boundedLockfile.capability);
});

test("bounded, in-range reads of non-deny-only classes still report no concern (deny-only carve-out does not leak)", () => {
  const decision = evaluateRead({ path: "apps/gateway/src/big.ts", estimatedLines: 900, rangeLines: 10, bounded: true });
  assert.equal(decision.action, "allow");
  assert.equal(decision.policyCode, "NONE");
  assert.equal(decision.capability, NO_CAPABILITY);
});
