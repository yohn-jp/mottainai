import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

/**
 * The immutable release-level identity graph described by ADR-0003/#755.
 *
 * This is deliberately a small contract, rather than a package index. URLs
 * and tags are locators only; every Mottainai-owned payload has a content
 * digest and is tied to the release source revision. Provider artifacts are
 * external dependencies and therefore carry their own explicit, verified
 * profile instead of being folded into Mottainai's artifact ownership.
 */
export const DEPLOYMENT_DESCRIPTOR_CONTRACT_ID = "mottainai.deployment.v1" as const;
export const DEPLOYMENT_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const DEPLOYMENT_DESCRIPTOR_PROFILE_ID = "linux-x86_64" as const;
export const DEPLOYMENT_DESCRIPTOR_ARCHITECTURE = "x86_64-linux" as const;

const HEX_SHA256 = /^[0-9a-f]{64}$/iu;
const GIT_SHA = /^[0-9a-f]{40}$/iu;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/iu;
const sha256 = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.string().regex(HEX_SHA256),
);
const sourceRevision = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.string().regex(GIT_SHA),
);
const version = z.string().regex(SEMVER).max(128);
const boundedUrl = z.string().url().max(4096);

const releaseSchema = z
  .object({
    version,
    tag: z.string().min(1).max(128),
    sourceRevision,
  })
  .strict();

const route1Schema = z
  .object({
    payload: z
      .object({
        packageName: z.literal("mottainai"),
        version,
        sourceRevision,
        filename: z.string().min(1).max(256),
        sha256,
        /** npm's canonical integrity string for the packed tarball. */
        integrity: z
          .string()
          .regex(/^sha(?:256|512)-[A-Za-z0-9+/=]+$/u)
          .max(256),
        locator: boundedUrl.optional(),
      })
      .strict(),
  })
  .strict();

const managedPackageSchema = z
  .object({
    packageId: z.string().min(1).max(128),
    version,
    flakeRef: z.string().min(1).max(4096),
    sourceSha256: sha256,
  })
  .strict();

const route2Schema = z
  .object({
    managedGeneration: z
      .object({
        contractId: z.literal("mottainai.managed-generation.v1"),
        schemaVersion: z.literal(1),
        version,
        sourceRevision,
        identity: sha256,
        flakeLockSha256: sha256,
        /** Exact Route 1 payload consumed/proven by the Nix projection. */
        applicationPayloadSha256: sha256,
        packages: z.array(managedPackageSchema).min(1).max(64),
      })
      .strict(),
  })
  .strict();

const route3Schema = z
  .object({
    appliance: z
      .object({
        contractId: z.literal("mottainai.linux-runtime-appliance.v1"),
        schemaVersion: z.literal(1),
        architecture: z.literal(DEPLOYMENT_DESCRIPTOR_ARCHITECTURE),
        version,
        sourceRevision,
        registry: z.string().min(1).max(255),
        repository: z.string().min(1).max(255),
        /** OCI descriptor digest; mutable tags are intentionally not accepted. */
        digest: z.preprocess(
          (value) => (typeof value === "string" ? value.toLowerCase() : value),
          z.string().regex(OCI_DIGEST),
        ),
        rawSha256: sha256,
        rawSizeBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024 * 1024),
        manifestSha256: sha256,
        locator: boundedUrl.optional(),
      })
      .strict(),
    managedGenerationIdentity: sha256,
  })
  .strict();

const providerArtifactSchema = z
  .object({
    version,
    architecture: z.literal("x86_64"),
    filename: z.string().min(1).max(256),
    sha256,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .optional(),
    locator: boundedUrl,
  })
  .strict();

const route4Schema = z
  .object({
    mottainaiInit: z
      .object({
        version,
        sourceRevision,
        architecture: z.literal(DEPLOYMENT_DESCRIPTOR_ARCHITECTURE),
        filename: z.string().min(1).max(256),
        sha256,
        locator: boundedUrl,
      })
      .strict(),
    provider: z
      .object({
        profileId: z.literal(DEPLOYMENT_DESCRIPTOR_PROFILE_ID),
        architecture: z.literal(DEPLOYMENT_DESCRIPTOR_ARCHITECTURE),
        provisioning: z
          .object({
            strategy: z.enum(["pinned-verified-archives", "explicit-adoption"]),
            contractVersion: z.literal(1),
            stateDirectory: z.string().min(1).max(4096),
          })
          .strict(),
        lima: providerArtifactSchema,
        qemu: z
          .object({
            version,
            architecture: z.literal("x86_64"),
            /**
             * Identity of the reviewed external QEMU compatibility profile.
             * When the profile distributes an archive, the optional binary
             * entries add the acquired bytes' digests; explicit adoption
             * profiles still require the consumer to attest those binaries
             * before use.
             */
            identity: sha256,
            identityKind: z.enum(["compatibility-profile", "executable-digest"]),
            systemBinary: providerArtifactSchema.optional(),
            imageBinary: providerArtifactSchema.optional(),
            minimumVersion: version,
          })
          .strict(),
        compatibility: z
          .object({
            limaMajor: z.number().int().min(1).max(99),
            qemuMajor: z.number().int().min(1).max(99),
            requiresKvm: z.literal(true),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const contractVersionsSchema = z
  .object({
    descriptor: z.literal(DEPLOYMENT_DESCRIPTOR_CONTRACT_ID),
    application: z.literal("mottainai.npm-payload.v1"),
    managedGeneration: z.literal("mottainai.managed-generation.v1"),
    appliance: z.literal("mottainai.linux-runtime-appliance.v1"),
    provider: z.literal("mottainai.route4-provider-profile.v1"),
  })
  .strict();

/** Canonical, bounded deployment descriptor wire schema. */
export const DeploymentDescriptorSchema = z
  .object({
    contractId: z.literal(DEPLOYMENT_DESCRIPTOR_CONTRACT_ID),
    schemaVersion: z.literal(DEPLOYMENT_DESCRIPTOR_SCHEMA_VERSION),
    release: releaseSchema,
    profile: z.literal(DEPLOYMENT_DESCRIPTOR_PROFILE_ID),
    architecture: z.literal(DEPLOYMENT_DESCRIPTOR_ARCHITECTURE),
    contracts: contractVersionsSchema,
    route1: route1Schema,
    route2: route2Schema,
    route3: route3Schema,
    route4: route4Schema,
  })
  .strict()
  .superRefine((descriptor, context) => {
    const fail = (path: readonly (string | number)[], message: string): void =>
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message });
    const releaseVersion = descriptor.release.version;
    const revision = descriptor.release.sourceRevision;
    if (descriptor.release.tag !== `v${releaseVersion}`) {
      fail(["release", "tag"], "release tag must be v${release.version}");
    }
    const owned = [
      [descriptor.route1.payload.version, descriptor.route1.payload.sourceRevision, ["route1", "payload"]],
      [
        descriptor.route2.managedGeneration.version,
        descriptor.route2.managedGeneration.sourceRevision,
        ["route2", "managedGeneration"],
      ],
      [descriptor.route3.appliance.version, descriptor.route3.appliance.sourceRevision, ["route3", "appliance"]],
      [
        descriptor.route4.mottainaiInit.version,
        descriptor.route4.mottainaiInit.sourceRevision,
        ["route4", "mottainaiInit"],
      ],
    ] as const;
    for (const [versionValue, revisionValue, path] of owned) {
      if (versionValue !== releaseVersion)
        fail(path, "Mottainai-owned artifact version does not match release.version");
      if (revisionValue !== revision)
        fail(path, "Mottainai-owned artifact sourceRevision does not match release.sourceRevision");
    }
    if (descriptor.route2.managedGeneration.identity !== descriptor.route3.managedGenerationIdentity) {
      fail(["route3", "managedGenerationIdentity"], "Route 3 must consume Route 2's exact managed-generation identity");
    }
    if (descriptor.route2.managedGeneration.applicationPayloadSha256 !== descriptor.route1.payload.sha256) {
      fail(
        ["route2", "managedGeneration", "applicationPayloadSha256"],
        "Route 2 must consume the exact Route 1 payload identity",
      );
    }
    const mottainaiPackage = descriptor.route2.managedGeneration.packages.find(
      (entry) => entry.packageId === "mottainai",
    );
    if (mottainaiPackage === undefined || mottainaiPackage.version !== releaseVersion) {
      fail(
        ["route2", "managedGeneration", "packages"],
        "Route 2 must include the release's exact mottainai package identity",
      );
    }
    const qemu = descriptor.route4.provider.qemu;
    if (
      qemu.identityKind === "executable-digest" &&
      (qemu.systemBinary === undefined || qemu.imageBinary === undefined)
    ) {
      fail(["route4", "provider", "qemu"], "executable-digest QEMU profiles must bind both executable artifacts");
    }
    if (qemu.minimumVersion.split(".")[0] !== qemu.version.split(".")[0]) {
      fail(
        ["route4", "provider", "qemu", "minimumVersion"],
        "QEMU minimumVersion must be compatible with the selected QEMU major",
      );
    }
    if (
      descriptor.route4.provider.provisioning.strategy === "explicit-adoption" &&
      descriptor.route4.provider.provisioning.stateDirectory.trim() === ""
    ) {
      fail(
        ["route4", "provider", "provisioning", "stateDirectory"],
        "provider stateDirectory is required for explicit adoption",
      );
    }
  });

export type DeploymentDescriptor = z.infer<typeof DeploymentDescriptorSchema>;

export class DeploymentDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentDescriptorError";
  }
}

export function parseDeploymentDescriptor(value: unknown): DeploymentDescriptor {
  const result = DeploymentDescriptorSchema.safeParse(value);
  if (!result.success) {
    throw new DeploymentDescriptorError(
      `deployment descriptor is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function readDeploymentDescriptor(filePath: string): DeploymentDescriptor {
  try {
    return parseDeploymentDescriptor(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error instanceof DeploymentDescriptorError) throw error;
    throw new DeploymentDescriptorError(
      `deployment descriptor cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  throw new DeploymentDescriptorError("deployment descriptor contains an unsupported canonicalization value");
}

/** Returns the lossless canonical JSON projection used for publication. */
export function canonicalizeDeploymentDescriptor(descriptor: DeploymentDescriptor): DeploymentDescriptor {
  return {
    ...descriptor,
    // Arrays are semantically sets of package identities; sort them so CI
    // ordering or Nix evaluation order cannot change the descriptor identity.
    route2: {
      managedGeneration: {
        ...descriptor.route2.managedGeneration,
        packages: [...descriptor.route2.managedGeneration.packages].sort((left, right) =>
          compareText(left.packageId, right.packageId),
        ),
      },
    },
  };
}

export function canonicalDeploymentDescriptorText(descriptor: DeploymentDescriptor): string {
  return stableStringify(canonicalizeDeploymentDescriptor(descriptor));
}

/** SHA-256 of canonical descriptor bytes; suitable for a durable sidecar. */
export function deploymentDescriptorIdentityOf(descriptor: DeploymentDescriptor): string {
  return createHash("sha256").update(canonicalDeploymentDescriptorText(descriptor), "utf8").digest("hex");
}

export function assertDeploymentDescriptorIdentity(descriptor: DeploymentDescriptor, expectedSha256: string): void {
  const expected = expectedSha256.toLowerCase();
  if (!HEX_SHA256.test(expected) || deploymentDescriptorIdentityOf(descriptor) !== expected) {
    throw new DeploymentDescriptorError(
      `deployment descriptor identity mismatch; expected ${expectedSha256}, got ${deploymentDescriptorIdentityOf(descriptor)}`,
    );
  }
}
