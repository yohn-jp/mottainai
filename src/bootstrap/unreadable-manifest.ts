/**
 * Sentinel value the CLI boundary (src/bootstrap/cli.ts) passes as
 * `runBootstrapBuild`'s `manifestValue` argument when the manifest file
 * itself could not be read or does not parse as JSON — i.e. the failure
 * happened before there was any JSON value to hand to
 * `parseManagedPackageManifest`.
 *
 * This is not a manifest-shaped object because `runBootstrapBuild` must
 * still reach `parseManagedPackageManifest`'s fail-closed rejection path
 * for it (any non-strict-schema value is rejected), keeping this failure on
 * the exact same `lastAttempt`-persisting path every other invalid-manifest
 * case already uses (PR review finding P1-4: previously the CLI returned
 * before `runBootstrapBuild` was ever called for this specific case, so no
 * `lastAttempt` was persisted — including on a first-ever attempt, before
 * any bootstrap state exists). `toBootstrapError` (build.ts) recognizes
 * this sentinel and preserves the original read/parse failure message
 * rather than reporting a generic schema-validation message.
 */
export class UnreadableManifest {
  constructor(readonly reason: string) {}
}
