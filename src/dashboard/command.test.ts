import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDashboardOptions } from "./command.js";

test("dashboard parser supports no-open and explicit ports", () => {
  assert.deepEqual(parseDashboardOptions(["--no-open", "--port", "4321"]), { noOpen: true, port: 4321 });
  assert.throws(() => parseDashboardOptions(["--port"]), /missing value/);
  assert.throws(() => parseDashboardOptions(["--port", "70000"]), /invalid dashboard port/);
  assert.throws(() => parseDashboardOptions(["--unexpected"]), /unknown dashboard option/);
});

test("dashboard parser selects the live provider without changing the query contract", () => {
  assert.deepEqual(parseDashboardOptions(["--provider", "live"]), { noOpen: false, port: 4317, provider: "live" });
});
