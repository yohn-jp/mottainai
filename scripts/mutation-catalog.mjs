export const MUTATION_SCHEMA_VERSION = 1;

export const MUTATION_POLICY = Object.freeze({
  schemaVersion: MUTATION_SCHEMA_VERSION,
  seed: 240824,
  propertyRuns: 48,
  timeoutMs: 15_000,
  minimumScore: 1,
  equivalentMutants: Object.freeze({
    exclusion: "requires descriptor equivalence.status=equivalent and a non-empty rationale",
  }),
  generatedCode: "ignored by scope because only the listed hand-written source files are mutated",
  timeout: "fail closed; a timed-out mutant is not killed and fails the command",
  scoreRegression: Object.freeze({
    baselinePath: "docs/mutation-baseline.json",
    comparison: "current score must be at least the committed baseline score",
  }),
});

export function mutationExpectation(mutation) {
  return mutation.equivalence?.status === "equivalent" ? "equivalent" : "non-equivalent";
}

export function validateMutationCatalog(mutations = MUTATIONS) {
  if (!Array.isArray(mutations) || mutations.length === 0) throw new Error("mutation catalog must not be empty");
  const ids = new Set();
  for (const mutation of mutations) {
    if (mutation === null || typeof mutation !== "object") throw new Error("mutation descriptor must be an object");
    if (typeof mutation.id !== "string" || mutation.id.length === 0 || ids.has(mutation.id)) {
      throw new Error(`mutation catalog has an invalid or duplicate id: ${mutation.id ?? "<missing>"}`);
    }
    ids.add(mutation.id);
    for (const field of ["file", "operator", "search", "replacement"]) {
      if (typeof mutation[field] !== "string" || mutation[field].length === 0) {
        throw new Error(`${mutation.id}: ${field} must be a non-empty string`);
      }
    }
    if (mutation.equivalence === undefined) continue;
    if (
      mutation.equivalence === null ||
      mutation.equivalence.status !== "equivalent" ||
      typeof mutation.equivalence.rationale !== "string" ||
      mutation.equivalence.rationale.trim().length === 0
    ) {
      throw new Error(`${mutation.id}: equivalent mutants require a non-empty equivalence rationale`);
    }
  }
  return mutations;
}

export const MUTATIONS = Object.freeze([
  {
    id: "config-default-path-nullish",
    file: "src/config.ts",
    operator: "nullish-to-or",
    search: 'configPath ?? process.env.MOTTAINAI_CONFIG ?? "mottainai.config.json"',
    replacement: 'configPath || process.env.MOTTAINAI_CONFIG || "mottainai.config.json"',
  },
  {
    id: "config-http-url-protocol",
    file: "src/config.ts",
    operator: "protocol-or-to-and",
    search: 'url.protocol === "http:" || url.protocol === "https:"',
    replacement: 'url.protocol === "http:" && url.protocol === "https:"',
  },
  {
    id: "config-version-normalization",
    file: "src/config.ts",
    operator: "version-branch-swap",
    search: "value.version === 2 ? 2 : 1",
    replacement: "value.version === 2 ? 1 : 2",
  },
  {
    id: "path-lexical-containment",
    file: "src/local-tools.ts",
    operator: "containment-negation",
    search: "candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)",
    replacement: "candidate !== rootReal && candidate.startsWith(`${rootReal}${path.sep}`)",
  },
  {
    id: "path-realpath-containment",
    file: "src/local-tools.ts",
    operator: "realpath-containment-negation",
    search: "resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)",
    replacement: "resolved !== rootReal && resolved.startsWith(`${rootReal}${path.sep}`)",
  },
  {
    id: "search-order-sort",
    file: "src/local-tools.ts",
    operator: "stable-order-to-sort",
    search: "return order.map((key) => {",
    replacement: "return [...order].sort().map((key) => {",
  },
  {
    id: "compression-token-budget-sign",
    file: "src/compress/budget.ts",
    operator: "budget-subtraction-to-addition",
    search: "const targetBytes = (targetTokens - 256) * 4;",
    replacement: "const targetBytes = (targetTokens + 256) * 4;",
  },
  {
    id: "compression-exact-budget-boundary",
    file: "src/compress/budget.ts",
    operator: "inclusive-to-exclusive-boundary",
    search: "if (Buffer.byteLength(text) <= budget) return text;",
    replacement: "if (Buffer.byteLength(text) < budget) return text;",
  },
  {
    id: "compression-head-ratio",
    file: "src/compress/budget.ts",
    operator: "floor-to-ceil",
    search: "const headBudget = Math.floor(contentBudget * 0.6);",
    replacement: "const headBudget = Math.ceil(contentBudget * 0.6);",
  },
  {
    id: "json-array-boundary",
    file: "src/compress/json.ts",
    operator: "inclusive-to-exclusive-array-boundary",
    search: "if (value.length <= options.maxArrayItems) {",
    replacement: "if (value.length < options.maxArrayItems) {",
  },
  {
    id: "json-tail-cap",
    file: "src/compress/json.ts",
    operator: "tail-cap-off-by-one",
    search: "options.maxArrayItems - 1",
    replacement: "options.maxArrayItems - 2",
  },
  {
    id: "json-depth-boundary",
    file: "src/compress/json.ts",
    operator: "depth-inclusive-to-exclusive",
    search: "if (depth > options.maxDepth) return DEPTH_TRUNCATED_MARKER;",
    replacement: "if (depth >= options.maxDepth) return DEPTH_TRUNCATED_MARKER;",
  },
  {
    id: "lines-exact-limit",
    file: "src/compress/lines.ts",
    operator: "inclusive-to-exclusive-line-boundary",
    search: "if (lines.length <= maxTotalLines) return input;",
    replacement: "if (lines.length < maxTotalLines) return input;",
  },
  {
    id: "envelope-facts-type-guard",
    file: "src/envelope.ts",
    operator: "array-guard-removal",
    search: "const facts = Array.isArray(details.facts) ? details.facts : [];",
    replacement: "const facts = details.facts ?? [];",
  },
  {
    id: "envelope-reserved-field-filter",
    file: "src/envelope.ts",
    operator: "reserved-field-filter-inversion",
    search: "Object.entries(details).filter(([key]) => !RESERVED_OUTPUT_FIELDS.has(key)),",
    replacement: "Object.entries(details).filter(([key]) => RESERVED_OUTPUT_FIELDS.has(key)),",
  },
  {
    id: "execution-budget-inclusive",
    file: "src/execution.ts",
    operator: "inclusive-to-exclusive-byte-boundary",
    search: 'return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= targetBytes;',
    replacement: 'return Buffer.byteLength(JSON.stringify(candidate), "utf8") < targetBytes;',
  },
  {
    id: "execution-token-byte-conversion",
    file: "src/execution.ts",
    operator: "token-byte-multiplier",
    search: "const targetBytes = targetTokens * 4;",
    replacement: "const targetBytes = targetTokens / 4;",
  },
  {
    id: "retention-ttl-boundary",
    file: "src/retrieve.ts",
    operator: "ttl-inclusive-to-exclusive",
    search: "if (entry.expiresAt <= this.now()) {",
    replacement: "if (entry.expiresAt < this.now()) {",
  },
  {
    id: "retention-lru-cap",
    file: "src/retrieve.ts",
    operator: "lru-cap-exclusive",
    search: "while (this.entries.size >= this.maxEntries) {",
    replacement: "while (this.entries.size > this.maxEntries) {",
  },
  {
    id: "sanitizer-protocol-guard",
    file: "src/init.ts",
    operator: "protocol-or-to-and",
    search: 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;',
    replacement: 'if (parsed.protocol !== "http:" || parsed.protocol !== "https:") return false;',
  },
  {
    id: "sanitizer-fragment-guard",
    file: "src/init.ts",
    operator: "fragment-comparison-inversion",
    search: 'if (parsed.hash !== "") return false;',
    replacement: 'if (parsed.hash === "") return false;',
  },
  {
    id: "sanitizer-any-secret",
    file: "src/init.ts",
    operator: "some-to-every",
    search: "const rejected = original.some((argument) => containsSecret(argument));",
    replacement: "const rejected = original.every((argument) => containsSecret(argument));",
  },
  {
    id: "sanitizer-secret-or-chain",
    file: "src/init.ts",
    operator: "secret-or-to-and",
    search:
      "return sensitiveArgument(argument) || /^Bearer\\s+/i.test(argument) || /^(?:token|secret|password)=/i.test(argument);",
    replacement:
      "return sensitiveArgument(argument) && /^Bearer\\s+/i.test(argument) && /^(?:token|secret|password)=/i.test(argument);",
  },
]);
