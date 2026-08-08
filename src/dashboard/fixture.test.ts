import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeterministicFixtureQuery,
} from "./fixture.js";
import {
  QUERY_API_VERSION,
  SEMANTIC_DELTA_KINDS,
  SemanticQueryError,
} from "./query.js";

test("fixture provider is deterministic and exposes one query boundary", () => {
  const first = createDeterministicFixtureQuery();
  const second = createDeterministicFixtureQuery();
  assert.equal(JSON.stringify(first.getProject()), JSON.stringify(second.getProject()));
  assert.equal(JSON.stringify(first.getGraph({ limit: 100 })), JSON.stringify(second.getGraph({ limit: 100 })));
  assert.equal(first.getProject().apiVersion, QUERY_API_VERSION);
});

test("component inventory keeps explicit ownership and bounded graph queries", () => {
  const query = createDeterministicFixtureQuery();
  const components = query.listComponents();
  assert.deepEqual(components.map((component) => component.name), [
    "Context Runtime",
    "Read Authorization",
    "Workflow Runtime",
    "Semantic Core",
  ]);
  assert.deepEqual(components[1]?.ownedSymbolIds, ["symbol:decide-read", "symbol:inspect-read-file"]);
  const graph = query.getGraph({ componentId: "component:read-authorization", limit: 3 });
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.truncated, true);
  assert.throws(() => query.getGraph({ limit: 101 }), SemanticQueryError);
});

test("entity, dependency, change, knowledge and agent projections are queryable", () => {
  const query = createDeterministicFixtureQuery();
  const entity = query.getEntity("symbol:inspect-read-file");
  assert.equal(entity?.kind, "symbol");
  assert.equal(entity?.agentProjection.source.available, false);
  assert.ok(entity?.agentProjection.recommendedReads.some((read) => read.path.includes("inspect")));
  assert.equal(query.getEntity("symbol:missing"), undefined);

  const dependencies = query.getDependencies({ componentId: "component:semantic-core" });
  assert.ok(dependencies.items.some((item) => item.to.name === "zod"));
  assert.ok(dependencies.packageUsage.some((item) => item.package.name === "tree-sitter"));

  const changes = query.getChangeSet();
  assert.deepEqual([...new Set(changes.entries.map((entry) => entry.kind))].sort(), [...SEMANTIC_DELTA_KINDS].sort());
  assert.ok(changes.entries.some((entry) => entry.reviewLevel === "L3"));

  const knowledge = query.getKnowledge();
  assert.equal(knowledge.counts.decision, 2);
  assert.ok(knowledge.entries.some((entry) => entry.status === "protected"));
  assert.equal(entity?.agentProjection.source.available, false);
  assert.ok((entity?.agentProjection.source.reason.length ?? 0) > 0);
  for (const fact of entity?.agentProjection.facts ?? []) {
    assert.equal(fact.name === "source" || fact.name === "body", false);
  }
});
