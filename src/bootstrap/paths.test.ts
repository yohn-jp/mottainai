import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICAL_BOOTSTRAP_STATE_FILE_PATH, CONTROL_STATE_ROOT } from "./paths.js";
import { BOOTSTRAP_STATE_RELATIVE_PATH } from "./state.js";

test("CONTROL_STATE_ROOT matches Runtime's mottainai-control stateDir default", () => {
  assert.equal(CONTROL_STATE_ROOT, "/var/lib/mottainai-control");
});

test("CANONICAL_BOOTSTRAP_STATE_FILE_PATH is rooted under the control-state root, not a workspace path", () => {
  assert.equal(CANONICAL_BOOTSTRAP_STATE_FILE_PATH, `${CONTROL_STATE_ROOT}/${BOOTSTRAP_STATE_RELATIVE_PATH}`);
  assert.ok(CANONICAL_BOOTSTRAP_STATE_FILE_PATH.startsWith("/var/lib/mottainai-control/"));
});
