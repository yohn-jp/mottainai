import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOTSTRAP_ERROR_CODES, BootstrapError } from "./errors.js";

test("BOOTSTRAP_ERROR_CODES contains exactly the nine deterministic kinds Issue #626 requires", () => {
  assert.deepEqual(
    [...BOOTSTRAP_ERROR_CODES].sort(),
    [
      "bootstrap_state_corruption",
      "invalid_manifest",
      "malformed_generation_metadata",
      "nix_generation_build_failure",
      "requested_resolved_version_mismatch",
      "source_integrity_mismatch",
      "source_resolution_failure",
      "unavailable_nix_prerequisite",
      "unsupported_managed_package",
    ].sort(),
  );
});

test("BootstrapError carries a stable code, message, and optional bounded details", () => {
  const error = new BootstrapError("source_integrity_mismatch", "sourceSha256 mismatch", { packageId: "mottainai" });
  assert.equal(error.name, "BootstrapError");
  assert.equal(error.code, "source_integrity_mismatch");
  assert.equal(error.message, "sourceSha256 mismatch");
  assert.deepEqual(error.details, { packageId: "mottainai" });
  assert.ok(error instanceof Error);
});

test("BootstrapError details are optional", () => {
  const error = new BootstrapError("invalid_manifest", "manifest is invalid");
  assert.equal(error.details, undefined);
});
