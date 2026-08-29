import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

/**
 * mottainai.linux-runtime-appliance.v1 — the bounded manifest published
 * alongside the canonical Runtime Appliance disk artifact built by
 * .github/workflows/ci.yml (Issue #601). Distinct from
 * mottainai.linux-runtime.v1 (contract.ts): that contract is the live
 * health/capability result an already-running Runtime reports; this one is
 * the build-time provenance record for a downloadable, not-yet-booted disk.
 */
export const RUNTIME_APPLIANCE_CONTRACT_ID = "mottainai.linux-runtime-appliance.v1" as const;
export const RUNTIME_APPLIANCE_SCHEMA_VERSION = 1 as const;

export const RUNTIME_APPLIANCE_ARCHITECTURES = ["x86_64-linux", "aarch64-linux"] as const;
export type RuntimeApplianceArchitecture = (typeof RUNTIME_APPLIANCE_ARCHITECTURES)[number];

export const RuntimeApplianceManifestSchema = z
  .object({
    contractId: z.literal(RUNTIME_APPLIANCE_CONTRACT_ID),
    schemaVersion: z.literal(RUNTIME_APPLIANCE_SCHEMA_VERSION),
    architecture: z.enum(RUNTIME_APPLIANCE_ARCHITECTURES),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/iu),
    nixSystemClosure: z.string().min(1).max(4_096),
    mottainaiVersion: z.string().min(1).max(128),
    nawabariVersion: z.string().min(1).max(128),
    image: z
      .object({
        filename: z.string().min(1).max(256),
        format: z.literal("raw"),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
      })
      .strict(),
    canonicalSource: z
      .object({
        flake: z.string().min(1).max(4_096),
        output: z.string().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();

export type RuntimeApplianceManifest = z.infer<typeof RuntimeApplianceManifestSchema>;

export class RuntimeApplianceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeApplianceManifestError";
  }
}

export function parseRuntimeApplianceManifest(value: unknown): RuntimeApplianceManifest {
  const parsed = RuntimeApplianceManifestSchema.safeParse(value);
  if (!parsed.success) throw new RuntimeApplianceManifestError("canonical Runtime Appliance manifest is invalid");
  return parsed.data;
}

export function readRuntimeApplianceManifest(filePath: string): RuntimeApplianceManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new RuntimeApplianceManifestError(
      `canonical Runtime Appliance manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRuntimeApplianceManifest(value);
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * Fails closed before an artifact is uploaded/distributed: recomputes the
 * disk's size and SHA-256 rather than trusting the manifest that shipped
 * beside it (Issue #601 "Artifact verification recomputes and checks image
 * digest/manifest consistency before upload").
 */
export function verifyRuntimeApplianceManifest(manifest: RuntimeApplianceManifest, diskPath: string): void {
  if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
    throw new RuntimeApplianceManifestError(`canonical Runtime Appliance disk is missing: ${diskPath}`);
  }
  const stat = fs.statSync(diskPath);
  if (stat.size !== manifest.image.sizeBytes) {
    throw new RuntimeApplianceManifestError(
      `canonical Runtime Appliance disk size mismatch; expected ${manifest.image.sizeBytes}, got ${stat.size}`,
    );
  }
  const actual = sha256File(diskPath);
  if (actual !== manifest.image.sha256) {
    throw new RuntimeApplianceManifestError(
      `canonical Runtime Appliance disk SHA-256 mismatch; expected ${manifest.image.sha256}, got ${actual}`,
    );
  }
}
