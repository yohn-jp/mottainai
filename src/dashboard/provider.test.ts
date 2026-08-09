import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  configuredDashboardProvider,
  createDashboardQuery,
  parseDashboardProvider,
} from "./provider.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../semantics/fixtures/typescript");

test("dashboard provider selection defaults to fixture and accepts explicit live configuration", () => {
  assert.equal(parseDashboardProvider(undefined), "fixture");
  assert.equal(configuredDashboardProvider({ MOTTAINAI_DASHBOARD_PROVIDER: "live" }), "live");
  assert.throws(() => parseDashboardProvider("other"), /invalid dashboard provider/);
});

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
