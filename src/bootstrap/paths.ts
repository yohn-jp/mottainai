import path from "node:path";
import { BOOTSTRAP_STATE_RELATIVE_PATH } from "./state.js";

/**
 * Control-state root Runtime already defines for `mottainai-control`
 * (`stateDir` option, `nix/modules/runtime.nix`, default
 * `/var/lib/mottainai-control`). Not sourced from a running Runtime's
 * reported `stateOwners.system` (src/runtime-contract/contract.ts) because
 * bootstrap must work with no running Runtime to ask — it converges a fresh
 * Appliance toward having one.
 */
export const CONTROL_STATE_ROOT = "/var/lib/mottainai-control" as const;

/**
 * The single fixed production location for bootstrap state — no CLI flag,
 * no environment-variable override. Sibling to #624's
 * `managed-packages/manifest.json` under the same control-state root, not a
 * new state root. Tests override the state path exclusively through
 * `BootstrapDependencies.stateFilePath` dependency injection at the module
 * level (see src/bootstrap/build.ts), never by pointing this constant
 * somewhere else.
 */
export const CANONICAL_BOOTSTRAP_STATE_FILE_PATH = path.join(CONTROL_STATE_ROOT, BOOTSTRAP_STATE_RELATIVE_PATH);
