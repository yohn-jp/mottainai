import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDashboard, parseDashboardOptions, startDashboard } from "./command.js";
import { DASHBOARD_PROVIDER_ENV } from "./provider.js";

test("dashboard parser supports no-open and explicit ports", () => {
  assert.deepEqual(parseDashboardOptions(["--no-open", "--port", "4321"]), { noOpen: true, port: 4321 });
  assert.throws(() => parseDashboardOptions(["--port"]), /missing value/);
  assert.throws(() => parseDashboardOptions(["--port", "70000"]), /invalid dashboard port/);
  assert.throws(() => parseDashboardOptions(["--unexpected"]), /unknown dashboard option/);
});

test("dashboard parser selects the live provider without changing the query contract", () => {
  assert.deepEqual(parseDashboardOptions(["--provider", "live"]), { noOpen: false, port: 4317, provider: "live" });
});

test("dashboard startup gives an explicit provider precedence over the process environment", async () => {
  const previous = process.env[DASHBOARD_PROVIDER_ENV];
  try {
    process.env[DASHBOARD_PROVIDER_ENV] = "fixture";
    const cliOptions = parseDashboardOptions(["--no-open", "--port", "0", "--provider", "live"]);
    const cliHandle = await startDashboard({ ...cliOptions, viewerHtml: "" });
    try {
      const cliProject = (await fetch(`${cliHandle.url}api/v1/project`).then((response) => response.json())) as {
        provenance: { provider: string };
      };
      assert.equal(cliProject.provenance.provider, "live-repository-model");
    } finally {
      await closeDashboard();
    }
  } finally {
    if (previous === undefined) delete process.env[DASHBOARD_PROVIDER_ENV];
    else process.env[DASHBOARD_PROVIDER_ENV] = previous;
  }
});
