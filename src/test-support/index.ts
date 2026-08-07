/**
 * テスト専用の共有fixture/helperの入口。責務と使い方は docs/testing.md を参照。
 * production コードから import されることはない（architecture-check の
 * testInfrastructure レイヤ、他レイヤから依存されない）。
 */
export { assertEnvelopeShape, assertError, assertOk } from "./assertions.js";
export { buildTestConfig, writeTestConfig } from "./config-fixture.js";
export type { BuildTestConfigOptions } from "./config-fixture.js";
export { DETERMINISTIC_ENV, isolatedHomeDir, withDeterministicEnv, withEnv } from "./env.js";
export { createTempDir } from "./tmp-dir.js";
export { createTempGitRepo, isolatedGitEnvironment, runGit } from "./tmp-git-repo.js";
export type { TempGitRepoOptions } from "./tmp-git-repo.js";
export { resolveTsxLoaderUrl } from "./tsx-loader.js";
export { createWorkflowStore } from "./workflow-store.js";
