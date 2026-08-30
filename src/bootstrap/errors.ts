/**
 * Stable, deterministic error taxonomy for the bootstrap component (Issue
 * #626). Every failure the bootstrap `build`/`status`/`verify` pipeline can
 * produce is re-thrown as one of these nine codes before it reaches a
 * caller — internal error classes from #624 (`ManagedPackageManifestError`),
 * #625 (`ManagedGenerationError`, `ManagedGenerationBuildError`), or this
 * module's own `BootstrapStateError` are wrapped at the point they surface
 * in `src/bootstrap/build.ts`, never leaked directly, so a caller of the
 * bootstrap CLI/module only ever needs to know this one taxonomy.
 */
export const BOOTSTRAP_ERROR_CODES = [
  "invalid_manifest",
  "unsupported_managed_package",
  "source_resolution_failure",
  "source_integrity_mismatch",
  "requested_resolved_version_mismatch",
  "unavailable_nix_prerequisite",
  "nix_generation_build_failure",
  "malformed_generation_metadata",
  "bootstrap_state_corruption",
] as const;

export type BootstrapErrorCode = (typeof BOOTSTRAP_ERROR_CODES)[number];

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  readonly details?: Readonly<Record<string, string>>;

  constructor(code: BootstrapErrorCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    this.details = details;
  }
}
