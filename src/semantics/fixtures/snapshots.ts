import {
  createClaimId,
  createEffectId,
  createEdgeId,
  createFactId,
  createNodeId,
  createRepositoryId,
  createRevisionId,
  createSymbolId,
} from "../ir/ids.js";
import type {
  Contract,
  PhysicalLocator,
  Provenance,
  ProvenanceKind,
  RepositorySemanticSnapshot,
  SemanticNode,
  SymbolLocator,
} from "../ir/types.js";

const repositoryId = createRepositoryId("yohn-jp/mottainai");
const revisionId = createRevisionId("fixture-v1");
const sourceRevision = { repositoryId, revisionId };

function provenance(kind: ProvenanceKind, options: Partial<Provenance> = {}): Provenance {
  return {
    kind,
    producer: { name: "repository-semantics-fixture", version: "1.0.0" },
    sourceRevision,
    ...options,
  };
}

function repositoryNode(): SemanticNode {
  return {
    kind: "repository",
    identity: { logicalId: repositoryId },
    name: "yohn-jp/mottainai",
    provenance: provenance("declared"),
  };
}

function symbolNode(
  locator: SymbolLocator,
  name: string,
  nodeProvenance: Provenance = provenance("derived"),
  contract?: Contract,
): SemanticNode {
  return {
    kind: "symbol",
    identity: {
      logicalId: createSymbolId(locator),
      locators: [locator],
    },
    name,
    provenance: nodeProvenance,
    ...(contract === undefined ? {} : { contract }),
  };
}

function node(kind: string, localId: string, name: string, nodeProvenance = provenance("declared")): SemanticNode {
  return {
    kind,
    identity: { logicalId: createNodeId(kind, localId) },
    name,
    provenance: nodeProvenance,
  };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    inputs: {
      parameters: [],
      acceptedDomain: [],
      preconditions: [],
      dependencies: [],
      externalResources: [],
      ...overrides.inputs,
    },
    outputs: {
      postconditions: [],
      errors: [],
      stateTransitions: [],
      externalCalls: [],
      externalEvents: [],
      effects: [],
      ...overrides.outputs,
    },
  };
}

function snapshot(
  nodes: SemanticNode[],
  options: Partial<Pick<RepositorySemanticSnapshot, "edges" | "facts" | "claims" | "analysis" | "diagnostics">> = {},
): RepositorySemanticSnapshot {
  return {
    schemaVersion: 1,
    repositoryIdentity: { id: repositoryId, canonicalName: "yohn-jp/mottainai" },
    revisionIdentity: { id: revisionId, revision: "fixture-v1", kind: "fixture" },
    analysis: { completeness: "complete", unknowns: [], ...options.analysis },
    nodes: [repositoryNode(), ...nodes],
    edges: options.edges ?? [],
    facts: options.facts ?? [],
    claims: options.claims ?? [],
    diagnostics: options.diagnostics ?? [],
  };
}

const pureLocator: SymbolLocator = {
  kind: "symbol",
  language: "typescript",
  package: "mottainai",
  file: "src/semantics/fixtures/pure.ts",
  symbol: "normalizeInput",
  signature: "(value: string): string",
  range: { start: { line: 4, column: 1 }, end: { line: 8, column: 2 } },
};

export const pureFunctionFixture = snapshot([
  symbolNode(pureLocator, "normalizeInput", provenance("derived"), contract({
    inputs: {
      parameters: [{ name: "value", type: "string", required: true, domain: "trimmed or whitespace-padded text" }],
      acceptedDomain: [{ expression: "typeof value === string" }],
      preconditions: [{ expression: "value is finite-length text" }],
      dependencies: [],
      externalResources: [],
    },
    outputs: {
      returnValue: "string",
      postconditions: [{ expression: "result === value.trim()" }],
      errors: [],
      stateTransitions: [],
      externalCalls: [],
      externalEvents: [],
      effects: [],
    },
  })),
], {
  facts: [{
    id: createFactId("pure-function"),
    subject: createSymbolId(pureLocator),
    predicate: "semantics.purity",
    value: "pure",
    provenance: provenance("derived", { completeness: "complete" }),
  }],
});

const effectfulLocator: SymbolLocator = {
  kind: "symbol",
  language: "javascript",
  package: "mottainai",
  module: "runtime",
  file: "src/semantics/fixtures/effectful.js",
  symbol: "readConfig",
};

export const effectfulFunctionFixture = snapshot([
  symbolNode(effectfulLocator, "readConfig", provenance("derived"), contract({
    inputs: {
      parameters: [{ name: "path", type: "string", required: true }],
      acceptedDomain: [{ expression: "path is inside workspace root" }],
      preconditions: [{ expression: "filesystem entry exists" }],
      dependencies: [{ name: "filesystem" }],
      externalResources: [{ name: "config-file", kind: "filesystem", access: "read" }],
    },
    outputs: {
      returnValue: "Config",
      postconditions: [{ expression: "result reflects the file contents" }],
      errors: [{ type: "ConfigReadError", condition: "file cannot be read" }],
      stateTransitions: [],
      externalCalls: [{ target: "filesystem", operation: "readFile" }],
      externalEvents: [],
      effects: [createEffectId("filesystem.read"), createEffectId("environment.read")],
    },
  })),
], {
  facts: [{
    id: createFactId("effectful-function"),
    subject: createSymbolId(effectfulLocator),
    predicate: "semantics.effects",
    value: ["filesystem.read", "environment.read"],
    provenance: provenance("derived"),
  }],
});

const componentId = createNodeId("component", "config-loader");
const loaderSymbol = {
  kind: "symbol" as const,
  language: "typescript",
  package: "mottainai",
  file: "src/config.ts",
  symbol: "loadConfig",
};
const loaderConstructor = {
  kind: "symbol" as const,
  language: "typescript",
  package: "mottainai",
  file: "src/config.ts",
  symbol: "ConfigLoader.constructor",
};

export const logicalComponentFixture = snapshot([
  node("component", "config-loader", "Config loader"),
  symbolNode(loaderSymbol, "loadConfig"),
  symbolNode(loaderConstructor, "ConfigLoader.constructor"),
], {
  edges: [
    {
      id: createEdgeId("load-config-implements"),
      kind: "implements",
      from: createSymbolId(loaderSymbol),
      to: componentId,
      provenance: provenance("derived"),
    },
    {
      id: createEdgeId("constructor-implements"),
      kind: "implements",
      from: createSymbolId(loaderConstructor),
      to: componentId,
      provenance: provenance("derived"),
    },
  ],
});

const invariantId = createNodeId("invariant", "startup-side-effect-free");
export const invariantFixture = snapshot([
  node("component", "config-loader", "Config loader"),
  node("invariant", "startup-side-effect-free", "Startup side-effect free"),
], {
  edges: [{
    id: createEdgeId("startup-governs-config-loader"),
    kind: "governs",
    from: invariantId,
    to: componentId,
    provenance: provenance("declared"),
  }],
  facts: [{
    id: createFactId("startup-invariant-statement"),
    subject: invariantId,
    predicate: "invariant.statement",
    value: "startup does not write external state",
    provenance: provenance("declared"),
  }],
});

const testedSymbol = createSymbolId(pureLocator);
const testId = createNodeId("test", "normalize-input-test");
export const testEvidenceFixture = snapshot([
  symbolNode(pureLocator, "normalizeInput"),
  node("test", "normalize-input-test", "normalizeInput test", provenance("declared")),
], {
  edges: [{
    id: createEdgeId("normalize-input-tested"),
    kind: "tests",
    from: testId,
    to: testedSymbol,
    provenance: provenance("observed", {
      evidence: [{ kind: "test", ref: "test-run:fixture-001", target: testId }],
    }),
  }],
  facts: [{
    id: createFactId("normalize-input-observed"),
    subject: testedSymbol,
    predicate: "test.result",
    value: { passed: true, case: "whitespace" },
    provenance: provenance("observed", {
      evidence: [{ kind: "test", ref: "test-run:fixture-001", target: testId }],
    }),
  }],
});

const dynamicCaller = {
  kind: "symbol" as const,
  language: "javascript",
  package: "mottainai",
  file: "src/semantics/fixtures/dynamic.js",
  symbol: "dispatch",
};
const dynamicTargetA = createSymbolId({
  kind: "symbol",
  language: "javascript",
  package: "mottainai",
  file: "src/semantics/fixtures/dynamic.js",
  symbol: "readHandler",
});
const dynamicTargetB = createSymbolId({
  kind: "symbol",
  language: "javascript",
  package: "mottainai",
  file: "src/semantics/fixtures/dynamic.js",
  symbol: "writeHandler",
});
const dynamicComponent = createNodeId("component", "dynamic-handler");

export const ambiguousDynamicCallFixture = snapshot([
  symbolNode(dynamicCaller, "dispatch"),
  node("component", "dynamic-handler", "Dynamic handler"),
], {
  analysis: {
    completeness: "partial",
    unknowns: [{
      code: "dynamic_call_target",
      message: "runtime dispatch prevents a unique static target",
      subjects: [createSymbolId(dynamicCaller)],
    }],
  },
  edges: [{
    id: createEdgeId("dispatch-dynamic-call"),
    kind: "calls",
    from: createSymbolId(dynamicCaller),
    to: dynamicComponent,
    provenance: provenance("inferred", {
      confidence: 0.42,
      completeness: "partial",
      ambiguity: { status: "ambiguous", reason: "dynamic property lookup", candidates: [dynamicTargetB, dynamicTargetA] },
    }),
  }],
});

export const inferredClaimFixture = snapshot([
  symbolNode(effectfulLocator, "readConfig"),
], {
  claims: [{
    id: createClaimId("config-loader-retries"),
    subject: createSymbolId(effectfulLocator),
    statement: "readConfig retries transient filesystem failures",
    status: "uncertain",
    provenance: provenance("inferred", {
      producer: { name: "semantic-heuristic", version: "0.3.0" },
      confidence: 0.35,
      completeness: "unknown",
      ambiguity: { status: "possible", reason: "retry behavior not observed in the fixture" },
    }),
  }],
});

export const allSemanticFixtures = {
  pureFunction: pureFunctionFixture,
  effectfulFunction: effectfulFunctionFixture,
  logicalComponent: logicalComponentFixture,
  invariant: invariantFixture,
  testEvidence: testEvidenceFixture,
  ambiguousDynamicCall: ambiguousDynamicCallFixture,
  inferredClaim: inferredClaimFixture,
} as const;

export const fixtureLocators: PhysicalLocator[] = [pureLocator, effectfulLocator];
