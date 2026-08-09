import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DASHBOARD_PROVIDER_ENV,
  configuredDashboardProvider,
  parseDashboardProvider,
} from "./provider.js";

test("dashboard provider selection defaults to fixture and accepts explicit live configuration", () => {
  assert.equal(parseDashboardProvider(undefined), "fixture");
  const previous = process.env[DASHBOARD_PROVIDER_ENV];
  try {
    delete process.env[DASHBOARD_PROVIDER_ENV];
    assert.equal(configuredDashboardProvider(), "fixture");
    process.env[DASHBOARD_PROVIDER_ENV] = "live";
    assert.equal(configuredDashboardProvider(), "live");
  } finally {
    if (previous === undefined) delete process.env[DASHBOARD_PROVIDER_ENV];
    else process.env[DASHBOARD_PROVIDER_ENV] = previous;
  }
  assert.equal(configuredDashboardProvider({ MOTTAINAI_DASHBOARD_PROVIDER: "live" }), "live");
  assert.throws(() => parseDashboardProvider("other"), /invalid dashboard provider/);
});
