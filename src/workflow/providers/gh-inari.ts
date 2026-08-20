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

  constructor(options: GhInariPullRequestAdapterOptions) {
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
  if (draft.issue !== undefined) fields.issue = draft.issue.reference;
  for (const [heading, value] of Object.entries(draft.sections)) {
    if (value !== undefined) fields[heading] = sectionValue(value);
  }
  if (draft.acceptanceCriteria !== undefined) fields.acceptanceCriteria = [...draft.acceptanceCriteria];
  return fields;
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
