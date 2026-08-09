import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboardQuery } from "./provider.js";

const fixtureRoot = join(process.cwd(), "src/semantics/fixtures/typescript");

test("live dashboard provider exposes derived facts through RepositorySemanticQuery", async () => {
  const query = createDashboardQuery("live", fixtureRoot);
  const project = await query.getProject();
  assert.equal(project.provenance.provider, "live-repository-model");
  assert.ok(project.counts.file > 0);
  assert.ok(project.counts.symbol > 0);
  assert.ok(project.counts.package > 0);
  assert.equal((await query.listComponents()).length, 0);
  assert.ok(project.health.modelGaps > 0);
});
