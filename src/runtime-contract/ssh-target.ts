import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { replaceFileAtomically } from "../atomic-file.js";
import { DIRECT_BOUNDARIES } from "../boundary.js";
import type { BoundaryOperations } from "../boundary.js";
import { runProgram } from "../subprocess.js";
import type { RunResult } from "../subprocess.js";
import { parseRuntimeCapabilityResult } from "./contract.js";
import type { RuntimeCapabilityResult } from "./contract.js";

/**
 * Durable SSH transport authority for Issue #298.
 *
 * This state deliberately records transport coordinates and host-key trust,
 * but never private keys, agent secrets, tokens, command output, or a
 * Runtime's semantic state. `targetId` is the operator's stable logical
 * target; `connectionId` identifies the currently trusted transport binding.
 * A changed address or host key therefore cannot silently inherit a Runtime
 * identity. The persisted public host key is cryptographically checked against
 * its SHA-256 fingerprint and is materialized into an ephemeral known_hosts
 * file for each real SSH process; caller-supplied fingerprints are only an
 * optional preflight check, never the process trust authority.
 */
export const SSH_TARGET_CONTRACT_ID = "mottainai.ssh-target-registry.v1" as const;
export const SSH_TARGET_SCHEMA_VERSION = 1 as const;
export const SSH_TARGET_REGISTRY_RELATIVE_PATH = "ssh-targets/registry.json" as const;
export const SSH_TARGET_CONTROL_STATE_ROOT = "/var/lib/mottainai-control" as const;
export const SSH_TARGET_REGISTRY_FILE_PATH = path.join(
  SSH_TARGET_CONTROL_STATE_ROOT,
  SSH_TARGET_REGISTRY_RELATIVE_PATH,
);

const MAX_TARGETS = 128 as const;
const MAX_ID_LENGTH = 256 as const;
const MAX_HOSTNAME_LENGTH = 255 as const;
const MAX_USER_LENGTH = 128 as const;
const MAX_FINGERPRINT_LENGTH = 256 as const;
const MAX_HOST_KEY_MATERIAL_LENGTH = 8_192 as const;
const MAX_ALGORITHM_LENGTH = 64 as const;
const MAX_COMMAND_ARGUMENTS = 128 as const;
const MAX_ARGUMENT_LENGTH = 4_096 as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

export const SSH_TRUST_PROVENANCES = ["operator-explicit", "operator-reverified"] as const;
export type SshTrustProvenance = (typeof SSH_TRUST_PROVENANCES)[number];

// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const idSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const hostnameSchema = z
  .string()
  .min(1)
  .max(MAX_HOSTNAME_LENGTH)
  // Hostnames, IPv4, and colon-separated IPv6 literals are accepted. Shell
  // syntax, whitespace, and NUL are intentionally not part of this model.
  .regex(/^[A-Za-z0-9_.:[\]-]+$/u);
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const userSchema = z
  .string()
  .min(1)
  .max(MAX_USER_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/u);
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const fingerprintSchema = z
  .string()
  .min(1)
  .max(MAX_FINGERPRINT_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f\s]/u.test(value), "host-key fingerprint must not contain whitespace");
// architecture-check allow: import-time-side-effect -- zod schema construction is declarative validation metadata
const algorithmSchema = z
  .string()
  .min(1)
  .max(MAX_ALGORITHM_LENGTH)
  .regex(/^[A-Za-z0-9@._+-]+$/u);
const timestampSchema = z.string().datetime({ offset: true });
const hostKeyMaterialSchema = z
  .string()
  .min(1)
  .max(MAX_HOST_KEY_MATERIAL_LENGTH)
  .refine(
    (value) => !/[\u0000-\u001f\u007f\t\r\n]/u.test(value) && value.trim() === value,
    "host-key material must be one compact public-key line",
  );

const sshTargetRecordSchema = z
  .object({
    targetId: idSchema,
    connectionId: idSchema,
    hostname: hostnameSchema,
    port: z.number().int().min(1).max(65_535),
    user: userSchema,
    hostKeyFingerprint: fingerprintSchema,
    hostKeyAlgorithm: algorithmSchema,
    hostKeyMaterial: hostKeyMaterialSchema,
    trustProvenance: z.enum(SSH_TRUST_PROVENANCES),
    trustedAt: timestampSchema,
    runtimeIdentity: z.string().min(1).max(MAX_ID_LENGTH).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    try {
      const hostKey = inspectHostKeyMaterial(record.hostKeyMaterial);
      if (hostKey.algorithm !== record.hostKeyAlgorithm) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hostKeyAlgorithm"],
          message: "host-key algorithm does not match public-key material",
        });
      }
      if (hostKey.fingerprint !== record.hostKeyFingerprint) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hostKeyFingerprint"],
          message: "host-key fingerprint does not match public-key material",
        });
      }
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hostKeyMaterial"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const SshTargetRecordSchema = sshTargetRecordSchema;
export type SshTargetRecord = z.infer<typeof sshTargetRecordSchema>;

export const SshTargetRegistrySchema = z
  .object({
    contractId: z.literal(SSH_TARGET_CONTRACT_ID),
    schemaVersion: z.literal(SSH_TARGET_SCHEMA_VERSION),
    targets: z
      .array(sshTargetRecordSchema)
      .max(MAX_TARGETS)
      .superRefine((targets, context) => {
        const targetIds = new Set<string>();
        const connectionIds = new Set<string>();
        targets.forEach((target, index) => {
          if (targetIds.has(target.targetId)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "targetId"], message: "duplicate targetId" });
          }
          if (connectionIds.has(target.connectionId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "connectionId"],
              message: "duplicate connectionId",
            });
          }
          targetIds.add(target.targetId);
          connectionIds.add(target.connectionId);
        });
      }),
  })
  .strict();
export type SshTargetRegistryState = z.infer<typeof SshTargetRegistrySchema>;

export type SshTargetErrorCode =
  | "state_corrupt"
  | "target_exists"
  | "target_not_found"
  | "trust_required"
  | "host-key-mismatch"
  | "runtime-identity-mismatch"
  | "rebind-verification-required"
  | "unsupported-transport-state";

export class SshTargetError extends Error {
  constructor(
    readonly code: SshTargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SshTargetError";
  }
}

export type SshTransportErrorCode =
  | "unreachable"
  | "authentication"
  | "host-key-mismatch"
  | "runtime-identity-mismatch"
  | "unsupported-transport-state"
  | "timeout"
  | "output-limit";

export class SshTransportError extends Error {
  constructor(
    readonly code: SshTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SshTransportError";
  }
}

export interface CreateSshTargetInput {
  readonly targetId: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  /** Supplying this is an explicit operator trust action; no TOFU default exists. */
  readonly hostKeyFingerprint: string;
  /** OpenSSH public-key material (`algorithm base64`), never a private key. */
  readonly hostKeyMaterial: string;
  readonly hostKeyAlgorithm?: string;
  readonly trustAction: "explicit";
}

export interface RebindSshTargetInput {
  readonly targetId: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint: string;
  /** OpenSSH public-key material (`algorithm base64`), never a private key. */
  readonly hostKeyMaterial: string;
  readonly hostKeyAlgorithm?: string;
  readonly trustAction: "explicit";
  /** Parsed through RuntimeCapabilityResultSchema before a binding is changed. */
  readonly runtimeCapability: unknown;
}

export interface SshConnectionEvidence {
  readonly observedHostKeyFingerprint?: string;
  readonly observedHostKeyAlgorithm?: string;
  /** Parsed by the existing Runtime capability authority; raw identity strings are not accepted. */
  readonly observedRuntimeCapability?: unknown;
}

export interface SshTargetStatus {
  readonly targetId: string;
  readonly connectionId: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyFingerprint: string;
  readonly hostKeyAlgorithm: string;
  readonly trustProvenance: SshTrustProvenance;
  readonly trustedAt: string;
  readonly runtimeIdentity?: string;
}

export interface SshTargetRegistryOptions {
  readonly filePath?: string;
  readonly boundaries?: BoundaryOperations;
  readonly now?: () => Date;
}

function normalizeDate(now: () => Date): string {
  const value = now();
  if (Number.isNaN(value.getTime()))
    throw new SshTargetError("unsupported-transport-state", "clock returned an invalid date");
  return value.toISOString();
}

function newConnectionId(): string {
  return crypto.randomUUID();
}

interface HostKeyDetails {
  readonly algorithm: string;
  readonly material: string;
  readonly fingerprint: string;
}

/**
 * Decode the OpenSSH public-key blob and derive the standard SHA256:
 * fingerprint. The first SSH wire field is the algorithm name; checking it
 * prevents a record from pairing one algorithm label with another key blob.
 */
function inspectHostKeyMaterial(material: string): HostKeyDetails {
  const parts = material.trim().split(/\s+/u);
  if (parts.length !== 2 || !/^[A-Za-z0-9@._+-]+$/u.test(parts[0] ?? "")) {
    throw new SshTargetError("state_corrupt", "host-key material must contain exactly algorithm and public-key blob");
  }
  const algorithm = parts[0]!;
  const encoded = parts[1]!;
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, "base64");
  } catch {
    throw new SshTargetError("state_corrupt", "host-key material is not valid base64");
  }
  const canonicalInput = encoded.replace(/=+$/u, "");
  const canonicalBlob = blob.toString("base64").replace(/=+$/u, "");
  if (blob.length < 4 || canonicalInput !== canonicalBlob) {
    throw new SshTargetError("state_corrupt", "host-key material has a malformed public-key blob");
  }
  const algorithmLength = blob.readUInt32BE(0);
  const embeddedAlgorithm = blob.subarray(4, 4 + algorithmLength).toString("utf8");
  if (
    4 + algorithmLength > blob.length ||
    embeddedAlgorithm !== algorithm ||
    !/^[\x20-\x7e]+$/u.test(embeddedAlgorithm)
  ) {
    throw new SshTargetError("state_corrupt", "host-key material algorithm does not match its public-key blob");
  }
  const fingerprint = `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
  return { algorithm, material: `${algorithm} ${canonicalBlob}`, fingerprint };
}

function validateHostKeyBinding(record: SshTargetRecord): SshTargetRecord {
  const details = inspectHostKeyMaterial(record.hostKeyMaterial);
  if (details.algorithm !== record.hostKeyAlgorithm || details.fingerprint !== record.hostKeyFingerprint) {
    throw new SshTargetError(
      "state_corrupt",
      `host-key fingerprint/algorithm does not match persisted public-key material for target ${record.targetId}`,
    );
  }
  return { ...record, hostKeyMaterial: details.material };
}

function parseState(value: unknown): SshTargetRegistryState {
  const result = SshTargetRegistrySchema.safeParse(value);
  if (!result.success) {
    throw new SshTargetError(
      "state_corrupt",
      `SSH target registry is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  try {
    return { ...result.data, targets: result.data.targets.map(validateHostKeyBinding) };
  } catch (error) {
    if (error instanceof SshTargetError) throw error;
    throw new SshTargetError("state_corrupt", `host-key material is invalid: ${String(error)}`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  throw new SshTargetError("state_corrupt", "SSH target registry contains an unsupported value");
}

export function parseSshTargetRegistry(value: unknown): SshTargetRegistryState {
  return parseState(value);
}

export function canonicalSshTargetRegistryText(state: SshTargetRegistryState): string {
  return stableStringify(parseState(state));
}

export function readSshTargetRegistry(
  filePath: string = SSH_TARGET_REGISTRY_FILE_PATH,
): SshTargetRegistryState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SshTargetError(
      "state_corrupt",
      `SSH target registry cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new SshTargetError(
      "state_corrupt",
      `SSH target registry is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseState(value);
}

export function writeSshTargetRegistry(
  filePath: string,
  state: SshTargetRegistryState,
  boundaries: BoundaryOperations = DIRECT_BOUNDARIES,
): void {
  const validated = parseState(state);
  replaceFileAtomically(
    filePath,
    `${canonicalSshTargetRegistryText(validated)}\n`,
    boundaries,
    "ssh-target-registry-write",
    { mode: 0o600 },
  );
}

function validateTrustAction(action: string): asserts action is "explicit" {
  if (action !== "explicit") {
    throw new SshTargetError("trust_required", "first-use host-key trust requires an explicit operator action");
  }
}

function findTarget(state: SshTargetRegistryState, targetId: string): SshTargetRecord {
  const target = state.targets.find((candidate) => candidate.targetId === targetId);
  if (target === undefined) throw new SshTargetError("target_not_found", `SSH target is not registered: ${targetId}`);
  return target;
}

function parseRuntimeIdentityEvidence(
  evidence: unknown,
  errorCode: "runtime-identity-mismatch" | "rebind-verification-required",
): RuntimeCapabilityResult {
  try {
    return parseRuntimeCapabilityResult(evidence);
  } catch (error) {
    throw new SshTargetError(
      errorCode,
      `independent Runtime capability evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Registry operations are intentionally explicit. In particular, no method
 * updates a fingerprint from an observed connection and no address-only
 * lookup returns a Runtime identity.
 */
export class SshTargetRegistry {
  private readonly filePath: string;
  private readonly boundaries: BoundaryOperations;
  private readonly now: () => Date;
  private state: SshTargetRegistryState;

  constructor(options: SshTargetRegistryOptions = {}) {
    this.filePath = options.filePath ?? SSH_TARGET_REGISTRY_FILE_PATH;
    this.boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
    this.now = options.now ?? (() => new Date());
    this.state =
      readSshTargetRegistry(this.filePath) ??
      ({
        contractId: SSH_TARGET_CONTRACT_ID,
        schemaVersion: SSH_TARGET_SCHEMA_VERSION,
        targets: [],
      } satisfies SshTargetRegistryState);
  }

  reload(): void {
    this.state =
      readSshTargetRegistry(this.filePath) ??
      ({
        contractId: SSH_TARGET_CONTRACT_ID,
        schemaVersion: SSH_TARGET_SCHEMA_VERSION,
        targets: [],
      } satisfies SshTargetRegistryState);
  }

  snapshot(): SshTargetRegistryState {
    return parseState(this.state);
  }

  list(): readonly SshTargetRecord[] {
    return this.state.targets.map((target) => ({ ...target }));
  }

  status(): readonly SshTargetStatus[] {
    return this.state.targets.map((target) => ({
      targetId: target.targetId,
      connectionId: target.connectionId,
      hostname: target.hostname,
      port: target.port,
      user: target.user,
      hostKeyFingerprint: target.hostKeyFingerprint,
      hostKeyAlgorithm: target.hostKeyAlgorithm,
      trustProvenance: target.trustProvenance,
      trustedAt: target.trustedAt,
      ...(target.runtimeIdentity === undefined ? {} : { runtimeIdentity: target.runtimeIdentity }),
    }));
  }

  register(input: CreateSshTargetInput): SshTargetRecord {
    validateTrustAction(input.trustAction);
    if (this.state.targets.some((target) => target.targetId === input.targetId)) {
      throw new SshTargetError("target_exists", `SSH target is already registered: ${input.targetId}`);
    }
    const hostKey = inspectHostKeyMaterial(input.hostKeyMaterial);
    if (
      hostKey.fingerprint !== input.hostKeyFingerprint ||
      (input.hostKeyAlgorithm !== undefined && hostKey.algorithm !== input.hostKeyAlgorithm)
    ) {
      throw new SshTargetError(
        "trust_required",
        "host-key fingerprint and algorithm must match the supplied public-key material",
      );
    }
    const now = normalizeDate(this.now);
    const target: SshTargetRecord = {
      targetId: input.targetId,
      connectionId: newConnectionId(),
      hostname: input.hostname,
      port: input.port,
      user: input.user,
      hostKeyFingerprint: input.hostKeyFingerprint,
      hostKeyAlgorithm: hostKey.algorithm,
      hostKeyMaterial: hostKey.material,
      trustProvenance: "operator-explicit",
      trustedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const validated = parseState({ ...this.state, targets: [...this.state.targets, target] });
    this.persist(validated);
    return target;
  }

  /** Binds a Runtime only from the existing, structured Runtime capability authority. */
  bindRuntimeIdentity(targetId: string, evidence: unknown): SshTargetRecord {
    const capability = parseRuntimeIdentityEvidence(evidence, "rebind-verification-required");
    const runtimeIdentity = capability.runtimeIdentity;
    const target = findTarget(this.state, targetId);
    if (target.runtimeIdentity !== undefined && target.runtimeIdentity !== runtimeIdentity) {
      throw new SshTargetError("runtime-identity-mismatch", "target is already bound to a different Runtime identity");
    }
    const updated: SshTargetRecord = { ...target, runtimeIdentity, updatedAt: normalizeDate(this.now) };
    this.replaceTarget(updated);
    return updated;
  }

  verifyConnection(targetId: string, evidence: SshConnectionEvidence): SshTargetRecord {
    const target = findTarget(this.state, targetId);
    if (
      evidence.observedHostKeyFingerprint !== undefined &&
      evidence.observedHostKeyFingerprint !== target.hostKeyFingerprint
    ) {
      throw new SshTargetError(
        "host-key-mismatch",
        `SSH host key mismatch for target ${targetId}; explicit re-trust and rebind are required`,
      );
    }
    if (
      evidence.observedHostKeyAlgorithm !== undefined &&
      evidence.observedHostKeyAlgorithm !== target.hostKeyAlgorithm
    ) {
      throw new SshTargetError(
        "host-key-mismatch",
        `SSH host-key algorithm mismatch for target ${targetId}; explicit re-trust and rebind are required`,
      );
    }
    if (target.runtimeIdentity !== undefined) {
      if (evidence.observedRuntimeCapability === undefined) {
        throw new SshTargetError(
          "runtime-identity-mismatch",
          `Runtime identity mismatch for target ${targetId}; address reuse cannot prove continuity`,
        );
      }
      const capability = parseRuntimeIdentityEvidence(evidence.observedRuntimeCapability, "runtime-identity-mismatch");
      if (capability.runtimeIdentity !== target.runtimeIdentity) {
        throw new SshTargetError(
          "runtime-identity-mismatch",
          `Runtime identity mismatch for target ${targetId}; address reuse cannot prove continuity`,
        );
      }
    }
    return { ...target };
  }

  rebind(input: RebindSshTargetInput): SshTargetRecord {
    validateTrustAction(input.trustAction);
    const capability = parseRuntimeIdentityEvidence(input.runtimeCapability, "rebind-verification-required");
    const target = findTarget(this.state, input.targetId);
    if (target.runtimeIdentity === undefined || capability.runtimeIdentity !== target.runtimeIdentity) {
      throw new SshTargetError(
        "runtime-identity-mismatch",
        "transport rebind requires independently verified continuity with the stored Runtime identity",
      );
    }
    const hostKey = inspectHostKeyMaterial(input.hostKeyMaterial);
    if (
      hostKey.fingerprint !== input.hostKeyFingerprint ||
      (input.hostKeyAlgorithm !== undefined && hostKey.algorithm !== input.hostKeyAlgorithm)
    ) {
      throw new SshTargetError(
        "trust_required",
        "host-key fingerprint and algorithm must match the supplied public-key material",
      );
    }
    const updated: SshTargetRecord = {
      ...target,
      connectionId: newConnectionId(),
      hostname: input.hostname,
      port: input.port,
      user: input.user,
      hostKeyFingerprint: hostKey.fingerprint,
      hostKeyAlgorithm: hostKey.algorithm,
      hostKeyMaterial: hostKey.material,
      trustProvenance: "operator-reverified",
      trustedAt: normalizeDate(this.now),
      updatedAt: normalizeDate(this.now),
    };
    this.replaceTarget(updated);
    return updated;
  }

  private replaceTarget(updated: SshTargetRecord): void {
    const targets = this.state.targets.map((target) => (target.targetId === updated.targetId ? updated : target));
    const validated = parseState({ ...this.state, targets });
    this.persist(validated);
  }

  private persist(next: SshTargetRegistryState): void {
    writeSshTargetRegistry(this.filePath, next, this.boundaries);
    this.state = next;
  }
}

export interface SshCommandRequest {
  readonly targetId: string;
  readonly command: readonly string[];
  readonly observedHostKeyFingerprint?: string;
  readonly observedHostKeyAlgorithm?: string;
  readonly observedRuntimeCapability?: unknown;
}

export interface SshCommandResult {
  readonly targetId: string;
  readonly connectionId: string;
  readonly hostKeyVerified: true;
  readonly runtimeIdentityVerified: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SshCommandRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<RunResult>;

export interface SshAdapterOptions {
  readonly registry: SshTargetRegistry;
  readonly cwd: string;
  readonly boundaries?: BoundaryOperations;
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly run?: SshCommandRunner;
}

function validateCommand(command: readonly string[]): void {
  if (command.length === 0 || command.length > MAX_COMMAND_ARGUMENTS) {
    throw new SshTransportError(
      "unsupported-transport-state",
      "SSH command argument count is outside the supported bound",
    );
  }
  for (const argument of command) {
    if (argument.length > MAX_ARGUMENT_LENGTH || /\u0000/u.test(argument)) {
      throw new SshTransportError("unsupported-transport-state", "SSH command contains an invalid argument");
    }
  }
}

/** A remote command is one argv element because OpenSSH invokes a remote shell. */
function quoteRemoteArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function createEphemeralKnownHosts(
  target: SshTargetRecord,
  boundaries: BoundaryOperations,
): { directory: string; filePath: string } {
  const directory = boundaries.file("ssh.known-hosts.directory.create", () =>
    fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-ssh-known-hosts-")),
  );
  const filePath = path.join(directory, "known_hosts");
  boundaries.file("ssh.known-hosts.write", () => {
    fs.writeFileSync(filePath, `${target.hostname} ${target.hostKeyMaterial}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  });
  return { directory, filePath };
}

function cleanupEphemeralKnownHosts(directory: string, boundaries: BoundaryOperations): void {
  try {
    boundaries.file("ssh.known-hosts.directory.cleanup", () => fs.rmSync(directory, { recursive: true, force: true }));
  } catch {
    // The known_hosts file contains only public material; a cleanup failure
    // must not hide the primary SSH result, while the next invocation uses a
    // fresh directory and never trusts this path implicitly.
  }
}

function classifyFailure(result: RunResult): SshTransportError {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) return new SshTransportError("timeout", "SSH connection timed out");
  if (result.outputLimit) return new SshTransportError("output-limit", "SSH output exceeded the bounded limit");
  if (/(?:permission denied|authentication failed|publickey|too many authentication failures)/iu.test(text)) {
    return new SshTransportError("authentication", "SSH authentication failed");
  }
  if (/(?:host key|hostkey|man-in-the-middle|REMOTE HOST IDENTIFICATION)/iu.test(text)) {
    return new SshTransportError("host-key-mismatch", "SSH host-key verification failed");
  }
  return new SshTransportError("unreachable", "SSH target is unreachable");
}

/** Thin argv-safe SSH adapter. It never invokes a shell or accepts a command string. */
export class SshCommandAdapter {
  private readonly registry: SshTargetRegistry;
  private readonly cwd: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly run: SshCommandRunner;
  private readonly boundaries: BoundaryOperations;

  constructor(options: SshAdapterOptions) {
    this.registry = options.registry;
    this.cwd = options.cwd;
    this.boundaries = options.boundaries ?? DIRECT_BOUNDARIES;
    this.binary = options.binary ?? "ssh";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = Math.min(options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new SshTransportError("unsupported-transport-state", "SSH timeout must be a positive finite integer");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new SshTransportError("unsupported-transport-state", "SSH output bound must be a positive finite integer");
    }
    this.run =
      options.run ??
      ((args, cwd, timeoutMs, maxOutputBytes) =>
        runProgram(this.binary, [...args], cwd, timeoutMs, maxOutputBytes, undefined, this.boundaries));
  }

  async execute(request: SshCommandRequest): Promise<SshCommandResult> {
    validateCommand(request.command);
    const target = this.registry.verifyConnection(request.targetId, {
      observedHostKeyFingerprint: request.observedHostKeyFingerprint,
      observedHostKeyAlgorithm: request.observedHostKeyAlgorithm,
      ...(request.observedRuntimeCapability === undefined
        ? {}
        : { observedRuntimeCapability: request.observedRuntimeCapability }),
    });
    const destination = `${target.user}@${target.hostname}`;
    const knownHosts = createEphemeralKnownHosts(target, this.boundaries);
    const args: string[] = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      `UserKnownHostsFile=${knownHosts.filePath}`,
      "-o",
      "CheckHostIP=no",
      "-p",
      String(target.port),
      "--",
      destination,
      request.command.map(quoteRemoteArgument).join(" "),
    ];
    let result: RunResult;
    try {
      result = await this.run(args, this.cwd, this.timeoutMs, this.maxOutputBytes);
    } finally {
      cleanupEphemeralKnownHosts(knownHosts.directory, this.boundaries);
    }
    if (result.spawnError !== undefined || result.timedOut || result.outputLimit || result.exitCode !== 0) {
      throw classifyFailure(result);
    }
    return {
      targetId: target.targetId,
      connectionId: target.connectionId,
      hostKeyVerified: true,
      runtimeIdentityVerified: target.runtimeIdentity !== undefined && request.observedRuntimeCapability !== undefined,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
    };
  }
}
