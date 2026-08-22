import fs from "node:fs";
import path from "node:path";
import { GhInariClient, type GhInariError, type GhInariJsonObject, type GhInariJsonValue } from "../../gh-inari.js";
import { type PullRequestBodyDraft, type PullRequestSectionValue } from "../domain/pr-intent.js";
import {
  GithubAdapter,
  type GithubFailure,
  type GithubResult,
  type PullRequestCreateAdapter,
  type PullRequestCreateInput,
  type PullRequestLookupInput,
} from "./github.js";
import type { PullRequest, RepositoryIdentity } from "./model.js";

export interface GhInariPullRequestAdapterOptions {
  workspaceRoot: string;
  client?: GhInariClient;
  /** Read-only reconciliation remains the provider-neutral #196 contract. */
  lookupAdapter?: Pick<PullRequestCreateAdapter, "findPullRequests">;
}

/**
 * Production PR mutation boundary for Mottainai.
 *
 * Inari receives typed field intent and owns repository governance, validation,
 * rendering, and the remote mutation. The GitHub adapter is used only for the
 * existing read-only reconciliation query; it is never used to create a PR.
 */
export class GhInariPullRequestAdapter implements PullRequestCreateAdapter {
  readonly client: GhInariClient;
  private readonly lookupAdapter: Pick<PullRequestCreateAdapter, "findPullRequests">;
  private readonly workspaceRoot: string;

  constructor(options: GhInariPullRequestAdapterOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.client = options.client ?? new GhInariClient({ cwd: options.workspaceRoot });
    this.lookupAdapter = options.lookupAdapter ?? new GithubAdapter({ workspaceRoot: options.workspaceRoot });
  }

  findPullRequests(input: PullRequestLookupInput): Promise<GithubResult<PullRequest[]>> {
    return this.lookupAdapter.findPullRequests(input);
  }

  async openPullRequest(input: PullRequestCreateInput): Promise<GithubResult<PullRequest>> {
    const repository = ghInariRepository(input.repository);
    if (repository === undefined) {
      return {
        ok: false,
        error: inariFailure({
          code: "INARI_INVALID_REQUEST",
          phase: "input",
          operation: "pr.create",
          message: "a GitHub repository owner/name identity is required",
          retryable: false,
          details: { field: "repository" },
        }),
      };
    }

    if (input.draft.issue !== undefined) {
      const fieldIds = compiledPullRequestFieldIds(this.workspaceRoot, "default");
      if (fieldIds !== undefined && !fieldIds.has("linked_issue")) {
        return {
          ok: false,
          error: inariFailure({
            code: "INARI_INVALID_REQUEST",
            phase: "input",
            operation: "pr.create",
            message:
              'the compiled PR contract cannot represent --issue-reference because template "default" does not declare a linked_issue field',
            retryable: false,
            details: { field: "linked_issue", template: "default" },
          }),
        };
      }
    }

    const result = await this.client.createPullRequest({
      repository,
      template: "default",
      input: {
        fields: pullRequestFieldsForGhInari(input.draft),
        title: input.title,
        head: input.head.name,
        base: input.base.name,
        ...(input.providerDraft === undefined ? {} : { draft: input.providerDraft }),
      },
    });
    if (!result.ok) return { ok: false, error: inariFailure(result.error) };

    if (result.value.head !== undefined && result.value.head !== input.head.name) {
      return {
        ok: false,
        error: {
          provider: "github",
          operation: "pull-request-create",
          code: "ambiguous-provider-result",
          message: "gh-inari returned a pull request for a different head branch",
          retryable: false,
          attempts: 1,
          authority: "gh-inari",
        },
      };
    }
    if (result.value.base !== undefined && result.value.base !== input.base.name) {
      return {
        ok: false,
        error: {
          provider: "github",
          operation: "pull-request-create",
          code: "ambiguous-provider-result",
          message: "gh-inari returned a pull request for a different base branch",
          retryable: false,
          attempts: 1,
          authority: "gh-inari",
        },
      };
    }

    const state = pullRequestState(result.value.state);
    const lifecycleState = pullRequestLifecycleState(state, result.value.draft ?? input.providerDraft === true);
    return {
      ok: true,
      value: {
        identity: { provider: "github", id: `pull-request:${result.value.number}` },
        reference: `#${result.value.number}`,
        number: result.value.number,
        url: result.value.url,
        state,
        lifecycleState,
        repository: input.repository,
        head: input.head,
        base: input.base,
      },
      attempts: 1,
    };
  }
}

/** Convert Mottainai's typed PR intent into Inari's semantic fields document. */
export function pullRequestFieldsForGhInari(draft: PullRequestBodyDraft): GhInariJsonObject {
  const fields: Record<string, GhInariJsonValue> = {};
  for (const [heading, value] of Object.entries(draft.sections)) {
    if (value !== undefined) fields[heading] = sectionValue(value);
  }
  if (draft.issue !== undefined) fields.linked_issue = linkedIssueValue(draft.issue.reference);
  if (draft.acceptanceCriteria !== undefined) fields.acceptanceCriteria = [...draft.acceptanceCriteria];
  return fields;
}

function linkedIssueValue(reference: string): string {
  const normalized = reference.trim();
  const localNumber = /^#?(\d+)$/u.exec(normalized);
  if (localNumber?.[1] !== undefined) return `Closes #${localNumber[1]}`;
  return `Closes ${normalized}`;
}

function compiledPullRequestFieldIds(workspaceRoot: string, template: string): Set<string> | undefined {
  const contractPath = path.join(workspaceRoot, ".github", "inari", "pull-requests", `${template}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(contractPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { sections?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed.sections)) return undefined;
    return new Set(
      parsed.sections
        .map((section) => section?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  } catch {
    return undefined;
  }
}

function sectionValue(value: PullRequestSectionValue): GhInariJsonValue {
  return typeof value === "string" ? value : [...value];
}

function ghInariRepository(repository: RepositoryIdentity): { owner: string; name: string } | undefined {
  if (repository.provider !== "github") return undefined;
  const owner = repository.namespace?.trim();
  const name = repository.name?.trim();
  if (owner !== undefined && owner.length > 0 && name !== undefined && name.length > 0) return { owner, name };

  const parts = repository.id.trim().split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return undefined;
  const [fallbackOwner, fallbackName] = parts;
  if (fallbackOwner === undefined || fallbackName === undefined) return undefined;
  return { owner: fallbackOwner, name: fallbackName };
}

function inariFailure(error: GhInariError): GithubFailure {
  return {
    provider: "github",
    operation: "pull-request-create",
    code: "provider-failed",
    message: error.message,
    retryable: error.retryable,
    attempts: 1,
    authority: "gh-inari",
    inari: error,
  };
}

function pullRequestState(value: string | undefined): PullRequest["state"] {
  switch (value?.toLowerCase()) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    case "open":
      return "open";
    default:
      return "open";
  }
}

function pullRequestLifecycleState(state: PullRequest["state"], draft: boolean): PullRequest["lifecycleState"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return draft ? "draft" : "open";
}
