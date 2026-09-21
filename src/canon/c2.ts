import { canonicalCanonPrefixText } from "./identity.js";
import type { CanonContentEntry, CanonJsonValue, CanonPrefix } from "./identity.js";
import type { GhInariIssueReadResult, GhInariJsonObject, GhInariJsonValue } from "../gh-inari.js";

/** The task facts Mottainai owns and contributes to C2. */
export interface CanonTaskState {
  readonly taskId?: string;
  readonly taskSlug: string;
  readonly issueRef: string;
  readonly lifecycleState: string;
  readonly profile: {
    readonly agentKind: string;
    readonly provider?: string;
    readonly model?: string;
  };
}

/** Explicit repository identity is required; it is never inferred by this module. */
export interface CanonRepositoryIdentity {
  readonly repositoryId: string;
}

/**
 * Governance freshness is deliberately opaque. gh-inari owns the meaning of
 * these values; Mottainai carries them into Canon so a changed generation or
 * provenance necessarily changes prefix identity.
 */
export interface CanonGovernanceEvidence {
  readonly generation?: CanonJsonValue;
  readonly provenance?: CanonJsonValue;
  readonly freshness?: CanonJsonValue;
}

export interface ComposeGovernedIssueC2Input {
  readonly repository: CanonRepositoryIdentity | string;
  readonly task: CanonTaskState;
  /** The typed #411 result. Native Issue Markdown is intentionally absent. */
  readonly issue: GhInariIssueReadResult;
  readonly governance?: CanonGovernanceEvidence;
  /** Compatibility alias for callers that have freshness separately. */
  readonly freshness?: CanonJsonValue;
}

export class CanonC2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonC2Error";
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CanonC2Error(`${label} is required`);
  return value.trim();
}

function repositoryIdOf(value: ComposeGovernedIssueC2Input["repository"]): string {
  return nonEmpty(typeof value === "string" ? value : value.repositoryId, "repository.repositoryId");
}

function issueNumberFromRef(value: string): number | undefined {
  const match = /^#?(\d+)$/u.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function objectValue(value: unknown, label: string): GhInariJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanonC2Error(`${label} is incomplete`);
  }
  return value as GhInariJsonObject;
}

/**
 * Convert the provider's bounded JSON value to the Canon JSON value shape.
 * The provider has already performed its bounded read parsing; this function
 * only keeps the two structural contracts separate at the module boundary.
 */
function canonValue(value: GhInariJsonValue): CanonJsonValue {
  if (value === undefined) throw new CanonC2Error("governed JSON is invalid");
  if (Array.isArray(value)) return value.map(canonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonValue(entry)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new CanonC2Error("governed JSON is invalid");
  return value;
}

function canonObject(value: GhInariJsonObject): CanonJsonValue {
  return canonValue(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new CanonC2Error(`${label} is incomplete`);
  }
  return value.map((item) => item.trim());
}

function provenance(source: string, reference: string): CanonContentEntry["provenance"] {
  return { source, reference, supplied: false };
}

function validateGovernedIssue(input: ComposeGovernedIssueC2Input, repositoryId: string): void {
  const issue = input.issue;
  if (issue.kind !== "issue") throw new CanonC2Error("governed projection is not an Issue result");
  if (issue.valid !== true || issue.projection !== "canonical" || issue.classification !== "valid") {
    throw new CanonC2Error("governed Issue projection is invalid or unavailable");
  }
  if (issue.template === undefined || issue.template.source !== "issue_form") {
    throw new CanonC2Error("governed Issue projection has no canonical Issue template");
  }
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new CanonC2Error("governed Issue projection has invalid artifact identity");
  }
  nonEmpty(issue.url, "governed Issue URL");
  nonEmpty(issue.template.id, "governed Issue template id");
  nonEmpty(issue.template.name, "governed Issue template name");
  nonEmpty(issue.template.path, "governed Issue template path");
  const metadata = objectValue(issue.metadata, "governed Issue metadata");
  if (issue.fields === undefined || Object.keys(objectValue(issue.fields, "governed Issue fields")).length === 0) {
    throw new CanonC2Error("governed Issue projection has incomplete canonical fields");
  }
  nonEmpty(metadata.title, "governed Issue title");
  nonEmpty(metadata.state, "governed Issue state");
  stringArray(metadata.labels, "governed Issue labels");
  stringArray(metadata.assignees, "governed Issue assignees");
  const issueNumber = issueNumberFromRef(nonEmpty(input.task.issueRef, "task.issueRef"));
  if (issueNumber === undefined || issueNumber !== issue.number) {
    throw new CanonC2Error("task Issue reference does not match governed artifact identity");
  }
  if (nonEmpty(issue.repository, "governed Issue repository") !== repositoryId) {
    throw new CanonC2Error("governed Issue repository does not match explicit repository identity");
  }
  nonEmpty(input.task.taskSlug, "task.taskSlug");
  nonEmpty(input.task.lifecycleState, "task.lifecycleState");
  nonEmpty(input.task.profile.agentKind, "task.profile.agentKind");
}

/**
 * Compose the ordered C2 entries for one governed Issue-backed task.
 *
 * The entries contain only the minimum execution contract: artifact identity,
 * governed canonical fields/dependencies, Mottainai task/profile state, and
 * governance freshness/provenance. Canon #409 performs final validation and
 * canonical serialization when these entries are placed in a prefix.
 */
export function composeGovernedIssueC2(input: ComposeGovernedIssueC2Input): CanonContentEntry[] {
  const repositoryId = repositoryIdOf(input.repository);
  validateGovernedIssue(input, repositoryId);
  const issue = input.issue;
  const artifactReference = `issue:${issue.repository}#${issue.number}`;
  const governance = input.governance;
  const task = input.task;

  return [
    {
      contentId: "c2.governed.artifact",
      value: {
        repository: repositoryId,
        artifact: {
          kind: "issue",
          number: issue.number,
          url: issue.url,
          metadata: {
            title: issue.metadata.title,
            state: issue.metadata.state,
            labels: [...issue.metadata.labels],
            assignees: [...issue.metadata.assignees],
          },
        },
      },
      provenance: provenance("gh-inari", artifactReference),
    },
    {
      contentId: "c2.governed.fields",
      value: {
        template: {
          id: issue.template!.id,
          name: issue.template!.name,
          path: issue.template!.path,
          source: issue.template!.source,
        },
        fields: canonObject(issue.fields!),
      },
      provenance: provenance("gh-inari", `${artifactReference}:fields`),
    },
    {
      contentId: "c2.governed.dependencies",
      value: {
        dependencies: issue.dependencies === undefined ? {} : canonObject(issue.dependencies),
      },
      provenance: provenance("gh-inari", `${artifactReference}:dependencies`),
    },
    {
      contentId: "c2.mottainai.task",
      value: {
        ...(task.taskId === undefined ? {} : { taskId: task.taskId }),
        taskSlug: task.taskSlug,
        issueRef: task.issueRef,
        lifecycleState: task.lifecycleState,
        profile: {
          agentKind: task.profile.agentKind,
          ...(task.profile.provider === undefined ? {} : { provider: task.profile.provider }),
          ...(task.profile.model === undefined ? {} : { model: task.profile.model }),
        },
      },
      provenance: provenance("mottainai", `task:${task.taskId ?? task.taskSlug}`),
    },
    {
      contentId: "c2.governance.evidence",
      value: {
        artifactProvenance: issue.provenance === undefined ? {} : canonObject(issue.provenance),
        freshness: input.freshness === undefined ? (governance?.freshness ?? null) : input.freshness,
        ...(governance?.generation === undefined ? {} : { generation: governance.generation }),
        ...(governance?.provenance === undefined ? {} : { governanceProvenance: governance.provenance }),
      },
      provenance: provenance("gh-inari", `${artifactReference}:governance`),
    },
  ];
}

/** Short alias for callers that already establish the governed Issue context. */
export const composeIssueC2 = composeGovernedIssueC2;

/** Place the pure C2 result into an existing Canon prefix without owning C0/C1/C3. */
export function composeGovernedIssuePrefix(prefix: CanonPrefix, input: ComposeGovernedIssueC2Input): CanonPrefix {
  return { ...prefix, c2: composeGovernedIssueC2(input) };
}

/** Stable model-visible instruction fragment; the C2 entries remain structured in the API. */
export function governedIssueC2Instruction(c2: readonly CanonContentEntry[]): string {
  // Delegate ordering and JSON serialization to #409's identity authority.
  // The scaffold sections are discarded after canonicalization; they only
  // provide the existing prefix serializer with its required wire shape.
  const serialized = canonicalCanonPrefixText({
    c0: {
      runtimeContract: { contractId: "mottainai.runtime.v1", schemaVersion: 1 },
      projectContract: { contractId: "mottainai.project.v1", schemaVersion: 1 },
      runtimeInstructions: [],
    },
    c1: {
      repository: { repositoryId: "canon-c2", sourceRevision: "canon-c2", baseRevision: "canon-c2" },
      packageFacts: {},
      workspaceFacts: {},
    },
    c2: [...c2],
    c3: [],
  });
  const sections = (JSON.parse(serialized) as { sections: Array<{ section: string; content: unknown }> }).sections;
  const canonicalC2 = sections.find((section) => section.section === "C2")?.content;
  if (canonicalC2 === undefined) throw new CanonC2Error("Canon C2 serialization is unavailable");
  return `\n\nMottainai Canon C2 (governed Issue projection): ${JSON.stringify(canonicalC2)}`;
}
