import fs from "node:fs";
import { z } from "zod";
import type { BoundaryOperations } from "../boundary.js";
import { replaceFileAtomically } from "../atomic-file.js";
import { BOOTSTRAP_ERROR_CODES } from "./errors.js";

/**
 * mottainai.bootstrap-state.v1 — bounded, persisted evidence of the
 * bootstrap component's most recent `build` attempt and its most recent
 * successful build (Issue #626). Distinct from #624's
 * mottainai.managed-package-manifest.v1 (desired state) and #625's
 * mottainai.managed-generation.v1 (a single build's metadata): this is
 * bootstrap's own bounded control-state record, persisted under the same
 * Runtime control-state root as the manifest (see paths.ts), never under
 * user/workspace state.
 *
 * `lastAttempt` and `lastSuccessfulBuild` are deliberately separate fields,
 * not one merged record: a failed attempt (including the very first attempt
 * ever, before any manifest has successfully parsed) must always be
 * persistable, and a later failed attempt must never erase previously
 * recorded known-good build evidence. See src/bootstrap/build.ts for the
 * merge logic that keeps these two fields independently up to date.
 */
export const BOOTSTRAP_STATE_CONTRACT_ID = "mottainai.bootstrap-state.v1" as const;
export const BOOTSTRAP_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Sibling to #624's MANAGED_PACKAGE_MANIFEST_RELATIVE_PATH
 * ("managed-packages/manifest.json") under the same control-state root —
 * not a new state root. Absolute path is
 * `${CONTROL_STATE_ROOT}/${BOOTSTRAP_STATE_RELATIVE_PATH}` (paths.ts).
 */
export const BOOTSTRAP_STATE_RELATIVE_PATH = "bootstrap/state.json" as const;

const MAX_IDENTITY_LENGTH = 256 as const;
const MAX_ERROR_MESSAGE_LENGTH = 2048 as const;
const MAX_STORE_PATH_LENGTH = 4096 as const;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * Records the outcome of the most recent `build` invocation regardless of
 * how far it got. `desiredManifestSemanticIdentity` is present only once
 * manifest parsing has succeeded far enough to compute #624's
 * `semanticIdentityOf` — a malformed-JSON or schema-invalid manifest never
 * produces one, since no identity exists yet at that point.
 * `errorCode`/`message` are present exactly when `outcome` is `"failure"`.
 */
const lastAttemptSchema = z
  .object({
    completedAt: z.string().datetime(),
    outcome: z.enum(["success", "failure"]),
    desiredManifestSemanticIdentity: sha256HexSchema.optional(),
    errorCode: z.enum(BOOTSTRAP_ERROR_CODES).optional(),
    message: z.string().max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  })
  .strict()
  .refine((attempt) => (attempt.outcome === "failure") === (attempt.errorCode !== undefined), {
    message: "errorCode is required exactly when outcome is failure",
  })
  .refine((attempt) => (attempt.outcome === "failure") === (attempt.message !== undefined), {
    message: "message is required exactly when outcome is failure",
  });

export type BootstrapLastAttempt = z.infer<typeof lastAttemptSchema>;

/**
 * Only ever advances on an actual successful build; a later failed attempt
 * leaves this field untouched. Preserves exactly the identities Issue #626
 * requires: desired manifest semantic identity, resolved Mottainai source
 * identity/version, and the resulting managed-generation identity/store
 * path.
 */
const lastSuccessfulBuildSchema = z
  .object({
    completedAt: z.string().datetime(),
    desiredManifestSemanticIdentity: sha256HexSchema,
    // Optional: present only when the manifest actually had a `mottainai`
    // entry that was resolved. A Nawabari-only manifest (no `mottainai`
    // entry) has nothing to record here — build.ts omits this key entirely
    // rather than writing empty-string placeholders, which would otherwise
    // fail this schema's own non-empty/hex-length constraints (PR review
    // finding P1-5).
    resolvedMottainaiSource: z
      .object({
        version: z.string().min(1).max(MAX_IDENTITY_LENGTH),
        narHashSha256: sha256HexSchema,
      })
      .strict()
      .optional(),
    generationIdentity: sha256HexSchema,
    generationStorePath: z.string().min(1).max(MAX_STORE_PATH_LENGTH),
  })
  .strict();

export type BootstrapLastSuccessfulBuild = z.infer<typeof lastSuccessfulBuildSchema>;

export const BootstrapStateSchema = z
  .object({
    contractId: z.literal(BOOTSTRAP_STATE_CONTRACT_ID),
    schemaVersion: z.literal(BOOTSTRAP_STATE_SCHEMA_VERSION),
    lastAttempt: lastAttemptSchema,
    lastSuccessfulBuild: lastSuccessfulBuildSchema.optional(),
  })
  .strict();

export type BootstrapState = z.infer<typeof BootstrapStateSchema>;

export class BootstrapStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapStateError";
  }
}

/** Fails closed: any field outside this bounded shape is rejected, never coerced. */
export function parseBootstrapState(value: unknown): BootstrapState {
  const result = BootstrapStateSchema.safeParse(value);
  if (!result.success) {
    throw new BootstrapStateError(`bootstrap state is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic canonical JSON: object keys sorted, no whitespace. Mirrors
 * managed-package-manifest.ts's stableStringify; duplicated rather than
 * imported since these are distinct contract modules that must not depend
 * on one another's internals for canonicalization.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new BootstrapStateError("bootstrap state contains an unsupported value for canonicalization");
}

/** Canonical JSON text: writing this to disk and reading it back reproduces the same state. */
export function canonicalBootstrapStateText(state: BootstrapState): string {
  return stableStringify(state);
}

/**
 * `undefined` means bootstrap has never been attempted at this path — a
 * legitimate, non-error initial condition. A file that exists but fails to
 * parse as JSON or fails schema validation throws `BootstrapStateError`
 * (fails closed) rather than being treated the same as "never attempted".
 */
export function readBootstrapState(filePath: string): BootstrapState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BootstrapStateError(
      `bootstrap state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new BootstrapStateError(
      `bootstrap state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBootstrapState(value);
}

/**
 * Validates `state` against `BootstrapStateSchema` immediately before
 * atomic persistence — a second line of defense beyond callers truncating
 * bounded fields (e.g. `lastAttempt.message`) themselves. If `state` is
 * ever schema-invalid here, that is a genuine bug in the caller's own
 * construction logic (not an expected runtime condition), so this fails
 * closed rather than silently writing an invalid file that a later
 * `readBootstrapState` call would then reject.
 */
export function writeBootstrapState(filePath: string, state: BootstrapState, boundaries: BoundaryOperations): void {
  const validated = parseBootstrapState(state);
  replaceFileAtomically(filePath, canonicalBootstrapStateText(validated), boundaries, "bootstrap-state-write");
}
