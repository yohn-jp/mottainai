import { runProgram as defaultRunProgram } from "../../subprocess.js";
import type { RunResult } from "../../subprocess.js";
import { renderPullRequestBody, type PullRequestBodyDraft, type PullRequestRenderPolicy } from "../domain/pr-render.js";
import { transitionTask } from "../domain/task.js";
import { validateTransition } from "../domain/lifecycle.js";
import type { WorkflowPolicyDocument } from "../policy/schema.js";
import type {
  Issue,
  IssueState,
  PullRequest,
  PullRequestLifecycleState,
  PullRequestState,
  RepositoryIdentity,
  RevisionIdentity,
} from "./model.js";
import type {
  PullRequestRecord,
  RecordPullRequestInput,
  TaskId,
  TaskRecord,
  WorkflowStateStore,
} from "../state/store.js";

const GITHUB_PROVIDER = "github";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_ATTEMPTS = 2;

export type RunProgramFunction = (
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env?: NodeJS.ProcessEnv,
) => Promise<RunResult>;

export type GithubFailureCode =
  | "invalid-input"
  | "spawn-failed"
  | "timed-out"
  | "output-limit"
  | "provider-failed"
  | "malformed-json"
  | "invalid-response"
  | "ambiguous-provider-result";

export interface GithubFailure {
  provider: typeof GITHUB_PROVIDER;
  operation: string;
  code: GithubFailureCode;
  message: string;
  retryable: boolean;
  attempts: number;
}

export type GithubResult<Value> = { ok: true; value: Value; attempts: number } | { ok: false; error: GithubFailure };

export interface GithubAdapterOptions {
  workspaceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  runProgram?: RunProgramFunction;
  sleep?: (delayMs: number) => Promise<void>;
  repository?: RepositoryIdentity;
}

interface JsonRecord {
  [key: string]: unknown;
}

export interface GithubCreatePullRequestInput {
  repository: RepositoryIdentity;
  title: string;
  head: RevisionIdentity;
  base: RevisionIdentity;
  draft: PullRequestBodyDraft;
  policy?: PullRequestRenderPolicy | WorkflowPolicyDocument["pullRequest"];
  providerDraft?: boolean;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeIssueState(value: string): IssueState {
  const normalized = value.toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "closed") return "closed";
  return "unknown";
}

function normalizePullRequestState(value: string, merged: boolean): PullRequestState {
  if (merged) return "merged";
  const normalized = value.toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "closed") return "closed";
  return "unknown";
}

function normalizePullRequestLifecycle(value: string, draft: boolean, merged: boolean): PullRequestLifecycleState {
  if (merged) return "merged";
  if (draft) return "draft";
  const normalized = value.toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "closed") return "closed";
  return "unknown";
}

function parseJson(
  stdout: string,
):
  | { ok: true; value: JsonRecord }
  | { ok: false; reason: "unparsable JSON output" | "missing required fields in output" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "unparsable JSON output" };
  }
  const record = asRecord(parsed);
  return record === undefined
    ? { ok: false, reason: "missing required fields in output" }
    : { ok: true, value: record };
}

function repositoryFromGithub(value: unknown): RepositoryIdentity | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const nameWithOwner = stringValue(record.nameWithOwner);
  const name = stringValue(record.name);
  const owner = asRecord(record.owner);
  const namespace = stringValue(record.ownerLogin) ?? stringValue(owner?.login) ?? nameWithOwner?.split("/")[0];
  const idValue = record.id;
  const id =
    nameWithOwner ??
    (typeof idValue === "string" ? idValue : typeof idValue === "number" ? String(idValue) : undefined);
  if (id === undefined) return undefined;
  return {
    provider: GITHUB_PROVIDER,
    id,
    namespace,
    name: name ?? nameWithOwner?.split("/").pop(),
    url: stringValue(record.url),
  };
}

function fallbackRepository(value: RepositoryIdentity | undefined): RepositoryIdentity {
  return value ?? { provider: GITHUB_PROVIDER, id: "unknown" };
}

function metadataValues(record: JsonRecord): Readonly<Record<string, string | number | boolean | null>> {
  const state = stringValue(record.state);
  return state === undefined ? {} : { state };
}

function labelsFromGithub(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => stringValue(asRecord(label)?.name))
    .filter((label): label is string => label !== undefined);
}

function assigneesFromGithub(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((assignee) => {
      const record = asRecord(assignee);
      return stringValue(record?.login) ?? stringValue(record?.name);
    })
    .filter((assignee): assignee is string => assignee !== undefined);
}

export function parseGithubIssueOutput(
  stdout: string,
  defaultRepository?: RepositoryIdentity,
): { ok: true; issue: Issue } | { ok: false; reason: string } {
  const parsed = parseJson(stdout);
  if (!parsed.ok) return parsed;
  const number = numberValue(parsed.value.number);
  const title = stringValue(parsed.value.title);
  const state = stringValue(parsed.value.state);
  const url = stringValue(parsed.value.url);
  if (number === undefined || title === undefined || state === undefined || url === undefined) {
    return { ok: false, reason: "missing required fields in output" };
  }
  const repository = repositoryFromGithub(parsed.value.repository) ?? fallbackRepository(defaultRepository);
  const identityValue = parsed.value.id;
  const identity =
    typeof identityValue === "string" || typeof identityValue === "number" ? String(identityValue) : `issue:${number}`;
  const milestone = stringValue(asRecord(parsed.value.milestone)?.title) ?? stringValue(parsed.value.milestone);
  return {
    ok: true,
    issue: {
      identity: { provider: GITHUB_PROVIDER, id: identity },
      reference: `#${number}`,
      number,
      title,
      state: normalizeIssueState(state),
      url,
      repository,
      metadata: {
        labels: labelsFromGithub(parsed.value.labels),
        assignees: assigneesFromGithub(parsed.value.assignees),
        milestone,
        values: metadataValues(parsed.value),
      },
    },
  };
}

function parseGithubPullRequestRecord(
  record: JsonRecord,
  defaultRepository: RepositoryIdentity,
  fallbackHead?: RevisionIdentity,
  fallbackBase?: RevisionIdentity,
): { ok: true; pullRequest: PullRequest } | { ok: false; reason: string } {
  const number = numberValue(record.number);
  const state = stringValue(record.state);
  const url = stringValue(record.url);
  const headRecord = asRecord(record.head);
  const baseRecord = asRecord(record.base);
  const headName = stringValue(record.headRefName) ?? stringValue(headRecord?.refName) ?? fallbackHead?.name;
  const headRevision = stringValue(record.headRefOid) ?? stringValue(headRecord?.oid) ?? fallbackHead?.revision;
  const baseName = stringValue(record.baseRefName) ?? stringValue(baseRecord?.refName) ?? fallbackBase?.name;
  const baseRevision = stringValue(record.baseRefOid) ?? stringValue(baseRecord?.oid) ?? fallbackBase?.revision;
  if (
    number === undefined ||
    state === undefined ||
    url === undefined ||
    headName === undefined ||
    baseName === undefined
  ) {
    return { ok: false, reason: "missing required fields in output" };
  }
  const merged = record.mergedAt !== null && record.mergedAt !== undefined;
  const draft = record.isDraft === true;
  const identityValue = record.id;
  return {
    ok: true,
    pullRequest: {
      identity: {
        provider: GITHUB_PROVIDER,
        id:
          typeof identityValue === "string" || typeof identityValue === "number"
            ? String(identityValue)
            : `pull-request:${number}`,
      },
      reference: `#${number}`,
      number,
      state: normalizePullRequestState(state, merged),
      lifecycleState: normalizePullRequestLifecycle(state, draft, merged),
      url,
      repository: repositoryFromGithub(record.repository) ?? defaultRepository,
      head: { name: headName, revision: headRevision },
      base: { name: baseName, revision: baseRevision },
    },
  };
}

function parseCreatePullRequestOutput(
  stdout: string,
  input: GithubCreatePullRequestInput,
): { ok: true; pullRequest: PullRequest } | { ok: false; reason: string } {
  const trimmed = stdout.trim();
  const parsedJson = parseJson(trimmed);
  if (parsedJson.ok) {
    const parsed = parseGithubPullRequestRecord(parsedJson.value, input.repository, input.head, input.base);
    if (parsed.ok) return parsed;
    const number = numberValue(parsedJson.value.number);
    const url = stringValue(parsedJson.value.url);
    if (number !== undefined && url !== undefined) {
      return {
        ok: true,
        pullRequest: {
          identity: { provider: GITHUB_PROVIDER, id: `pull-request:${number}` },
          reference: `#${number}`,
          number,
          state: "open",
          lifecycleState: input.providerDraft === true ? "draft" : "open",
          url,
          repository: input.repository,
          head: input.head,
          base: input.base,
        },
      };
    }
    return parsed;
  }
  const match = trimmed.match(/(https?:\/\/[^\s]+\/pull\/(\d+))/i);
  if (match === null) return { ok: false, reason: "missing pull request URL in provider output" };
  const url = match[1]?.replace(/[),.;]+$/, "");
  const number = Number(match[2]);
  if (url === undefined || !Number.isInteger(number) || number < 1)
    return { ok: false, reason: "invalid pull request URL in provider output" };
  return {
    ok: true,
    pullRequest: {
      identity: { provider: GITHUB_PROVIDER, id: `pull-request:${number}` },
      reference: `#${number}`,
      number,
      state: "open",
      lifecycleState: input.providerDraft === true ? "draft" : "open",
      url,
      repository: input.repository,
      head: input.head,
      base: input.base,
    },
  };
}

function repositoryArgument(repository: RepositoryIdentity): string | undefined {
  if (repository.provider !== GITHUB_PROVIDER) return undefined;
  if (repository.namespace !== undefined && repository.name !== undefined)
    return `${repository.namespace}/${repository.name}`;
  return repository.id.includes("/") ? repository.id : undefined;
}

function classifyFailure(operation: string, result: RunResult, attempts: number): GithubFailure {
  if (result.spawnError !== undefined) {
    return {
      provider: GITHUB_PROVIDER,
      operation,
      code: "spawn-failed",
      message: result.spawnError,
      retryable: !/enoent|not found/i.test(result.spawnError),
      attempts,
    };
  }
  if (result.timedOut) {
    return {
      provider: GITHUB_PROVIDER,
      operation,
      code: "timed-out",
      message: "gh command timed out",
      retryable: true,
      attempts,
    };
  }
  if (result.outputLimit) {
    return {
      provider: GITHUB_PROVIDER,
      operation,
      code: "output-limit",
      message: "gh output exceeded the configured limit",
      retryable: true,
      attempts,
    };
  }
  const detail =
    (result.stderr || result.stdout).trim().split(/\r?\n/, 1)[0] ||
    `gh exited with code ${result.exitCode ?? "unknown"}`;
  const retryable =
    /temporar|timeout|timed out|rate limit|connection|network|unavailable|\b(?:429|502|503|504)\b/i.test(detail);
  return { provider: GITHUB_PROVIDER, operation, code: "provider-failed", message: detail, retryable, attempts };
}

interface CommandSuccess {
  ok: true;
  stdout: string;
  attempts: number;
}

type CommandResult = CommandSuccess | { ok: false; error: GithubFailure };

export class GithubAdapter {
  private readonly workspaceRoot: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly execute: RunProgramFunction;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly defaultRepository: RepositoryIdentity | undefined;

  constructor(options: GithubAdapterOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.execute = options.runProgram ?? defaultRunProgram;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.defaultRepository = options.repository;
  }

  private async runGh(args: string[], operation: string, allowRetry: boolean): Promise<CommandResult> {
    let attempts = 0;
    let lastFailure: GithubFailure | undefined;
    const limit = allowRetry ? this.maxAttempts : 1;
    while (attempts < limit) {
      attempts += 1;
      let result: RunResult;
      try {
        result = await this.execute("gh", args, this.workspaceRoot, this.timeoutMs, this.maxOutputBytes);
      } catch (error) {
        lastFailure = {
          provider: GITHUB_PROVIDER,
          operation,
          code: "spawn-failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          attempts,
        };
      }
      if (
        lastFailure === undefined &&
        result!.exitCode === 0 &&
        !result!.timedOut &&
        !result!.outputLimit &&
        result!.spawnError === undefined
      ) {
        return { ok: true, stdout: result!.stdout, attempts };
      }
      if (lastFailure === undefined) lastFailure = classifyFailure(operation, result!, attempts);
      const shouldRetry = allowRetry && lastFailure.retryable && attempts < limit;
      if (!shouldRetry) return { ok: false, error: lastFailure };
      lastFailure = undefined;
      if (this.retryDelayMs > 0) await this.sleep(this.retryDelayMs);
    }
    return {
      ok: false,
      error: lastFailure ?? {
        provider: GITHUB_PROVIDER,
        operation,
        code: "ambiguous-provider-result",
        message: "gh command did not return a result",
        retryable: true,
        attempts,
      },
    };
  }

  async viewIssue(reference: string | number, repository?: RepositoryIdentity): Promise<GithubResult<Issue>> {
    const normalizedReference = String(reference).trim();
    if (normalizedReference.length === 0) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "issue-view",
          code: "invalid-input",
          message: "issue reference must not be empty",
          retryable: false,
          attempts: 0,
        },
      };
    }
    const selectedRepository = repository ?? this.defaultRepository;
    const args = [
      "issue",
      "view",
      normalizedReference,
      "--json",
      "number,title,state,labels,url,repository,assignees,milestone",
    ];
    const repositoryFlag = selectedRepository === undefined ? undefined : repositoryArgument(selectedRepository);
    if (repositoryFlag !== undefined) args.push("--repo", repositoryFlag);
    const command = await this.runGh(args, "issue-view", true);
    if (!command.ok) return command;
    const parsed = parseGithubIssueOutput(command.stdout, selectedRepository);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "issue-view",
          code: parsed.reason === "unparsable JSON output" ? "malformed-json" : "invalid-response",
          message: parsed.reason,
          retryable: false,
          attempts: command.attempts,
        },
      };
    }
    return { ok: true, value: parsed.issue, attempts: command.attempts };
  }

  async getIssue(reference: string | number, repository?: RepositoryIdentity): Promise<GithubResult<Issue>> {
    return this.viewIssue(reference, repository);
  }

  async viewPullRequest(
    reference: string | number,
    repository?: RepositoryIdentity,
  ): Promise<GithubResult<PullRequest>> {
    const normalizedReference = String(reference).trim();
    if (normalizedReference.length === 0) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-view",
          code: "invalid-input",
          message: "pull request reference must not be empty",
          retryable: false,
          attempts: 0,
        },
      };
    }
    const selectedRepository = repository ?? this.defaultRepository ?? { provider: GITHUB_PROVIDER, id: "unknown" };
    const args = [
      "pr",
      "view",
      normalizedReference,
      "--json",
      "number,state,isDraft,mergedAt,url,headRefName,headRefOid,baseRefName,baseRefOid,repository",
    ];
    const repositoryFlag = repositoryArgument(selectedRepository);
    if (repositoryFlag !== undefined) args.push("--repo", repositoryFlag);
    const command = await this.runGh(args, "pull-request-view", true);
    if (!command.ok) return command;
    const parsedJson = parseJson(command.stdout);
    if (!parsedJson.ok) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-view",
          code: parsedJson.reason === "unparsable JSON output" ? "malformed-json" : "invalid-response",
          message: parsedJson.reason,
          retryable: false,
          attempts: command.attempts,
        },
      };
    }
    const parsed = parseGithubPullRequestRecord(parsedJson.value, selectedRepository);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-view",
          code: "invalid-response",
          message: parsed.reason,
          retryable: false,
          attempts: command.attempts,
        },
      };
    }
    return { ok: true, value: parsed.pullRequest, attempts: command.attempts };
  }

  async openPullRequest(input: GithubCreatePullRequestInput): Promise<GithubResult<PullRequest>> {
    if (input.repository.provider !== GITHUB_PROVIDER || input.repository.id.length === 0) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-input",
          message: "a GitHub repository identity is required",
          retryable: false,
          attempts: 0,
        },
      };
    }
    if (input.title.trim().length === 0) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-input",
          message: "title must not be empty",
          retryable: false,
          attempts: 0,
        },
      };
    }
    if (input.head.name.trim().length === 0 || input.base.name.trim().length === 0) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-input",
          message: "head and base names must not be empty",
          retryable: false,
          attempts: 0,
        },
      };
    }
    const repositoryFlag = repositoryArgument(input.repository);
    if (repositoryFlag === undefined) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-input",
          message:
            "repository identity must resolve to an explicit owner/name; refusing to fall back to the cwd repository for a mutation",
          retryable: false,
          attempts: 0,
        },
      };
    }
    const rendered = renderPullRequestBody(input.draft, input.policy);
    if (!rendered.ok) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-input",
          message: rendered.errors.join("; "),
          retryable: false,
          attempts: 0,
        },
      };
    }
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      rendered.body,
      "--head",
      input.head.name,
      "--base",
      input.base.name,
      "--repo",
      repositoryFlag,
    ];
    if (input.providerDraft === true) args.push("--draft");
    // 作成は自動 retry しない。timeout 後に provider 側で作成済みの可能性があり、
    // 同じ mutation の再試行は duplicate PR を作るため、reconciliation 用の query を優先する。
    const command = await this.runGh(args, "pull-request-create", false);
    if (!command.ok) return command;
    const parsed = parseCreatePullRequestOutput(command.stdout, input);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          provider: GITHUB_PROVIDER,
          operation: "pull-request-create",
          code: "invalid-response",
          message: parsed.reason,
          retryable: false,
          attempts: command.attempts,
        },
      };
    }
    return { ok: true, value: parsed.pullRequest, attempts: command.attempts };
  }
}

export type WorkflowPullRequestFailureReason =
  | "task-not-found"
  | "lifecycle-blocked"
  | "render-rejected"
  | "head-sha-required"
  | "provider-failed"
  | "local-state-write-failed";

export type WorkflowPullRequestResult =
  | {
      ok: true;
      pullRequest: PullRequest;
      record: PullRequestRecord;
      task: TaskRecord;
      renderedBody: string;
      reused: boolean;
    }
  | {
      ok: false;
      reason: WorkflowPullRequestFailureReason;
      detail: string;
      provider?: GithubFailure;
      validationErrors?: string[];
      providerCreated?: boolean;
    };

export interface OpenWorkflowPullRequestInput {
  adapter: GithubAdapter;
  store: WorkflowStateStore;
  taskId: TaskId;
  policy: WorkflowPolicyDocument;
  repository: RepositoryIdentity;
  title: string;
  head: RevisionIdentity;
  base: RevisionIdentity;
  draft: PullRequestBodyDraft;
  providerDraft?: boolean;
}

function pullRequestFromRecord(
  record: PullRequestRecord,
  repository: RepositoryIdentity,
  head: RevisionIdentity,
  base: RevisionIdentity,
): PullRequest {
  const lifecycleState = record.lifecycleState as PullRequestLifecycleState;
  const state: PullRequestState =
    lifecycleState === "merged"
      ? "merged"
      : lifecycleState === "closed"
        ? "closed"
        : lifecycleState === "open" || lifecycleState === "draft"
          ? "open"
          : "unknown";
  return {
    identity: { provider: record.provider, id: `${record.provider}:${record.repositoryId}:${record.prNumber}` },
    reference: `#${record.prNumber}`,
    number: record.prNumber,
    state,
    lifecycleState,
    url: record.url,
    repository,
    head: { ...head, revision: record.headSha },
    base,
  };
}

export async function openWorkflowPullRequest(input: OpenWorkflowPullRequestInput): Promise<WorkflowPullRequestResult> {
  const task = input.store.getTask(input.taskId);
  if (task === undefined) return { ok: false, reason: "task-not-found", detail: `task not found: ${input.taskId}` };

  const existingRecords = input.store.listPullRequestRecordsForTask(input.taskId);
  const existing = existingRecords[0];
  if (existing !== undefined) {
    if (
      (existing.instanceId !== undefined && existing.instanceId !== task.instanceId) ||
      existing.provider !== GITHUB_PROVIDER ||
      existing.repositoryId !== input.repository.id
    ) {
      return {
        ok: false,
        reason: "local-state-write-failed",
        detail: "existing pull-request record does not match the requested repository identity",
      };
    }
    let reconciledTask = task;
    if (task.lifecycleState === "pushed") {
      const reconciled = transitionTask(input.store, input.taskId, "pull-request-open");
      if (reconciled.ok) reconciledTask = reconciled.task;
    }
    return {
      ok: true,
      pullRequest: pullRequestFromRecord(existing, input.repository, input.head, input.base),
      record: existing,
      task: reconciledTask,
      renderedBody: "",
      reused: true,
    };
  }

  const transition = validateTransition(task.lifecycleState, "pull-request-open");
  if (!transition.allowed) {
    return { ok: false, reason: "lifecycle-blocked", detail: transition.blocked.blockingRule };
  }
  const rendered = renderPullRequestBody(input.draft, input.policy.pullRequest);
  if (!rendered.ok)
    return {
      ok: false,
      reason: "render-rejected",
      detail: rendered.errors.join("; "),
      validationErrors: rendered.errors,
    };
  if (input.head.revision === undefined || input.head.revision.trim().length === 0) {
    return {
      ok: false,
      reason: "head-sha-required",
      detail: "head revision is required before opening a pull request",
    };
  }

  const provider = await input.adapter.openPullRequest({
    repository: input.repository,
    title: input.title,
    head: input.head,
    base: input.base,
    draft: input.draft,
    policy: input.policy.pullRequest,
    providerDraft: input.providerDraft,
  });
  if (!provider.ok) {
    return { ok: false, reason: "provider-failed", detail: provider.error.message, provider: provider.error };
  }
  if (provider.value.head.revision === undefined) {
    return {
      ok: false,
      reason: "local-state-write-failed",
      detail: "provider succeeded without the metadata required for local state",
      providerCreated: true,
    };
  }

  const recordInput: RecordPullRequestInput = {
    taskId: input.taskId,
    instanceId: task.instanceId,
    provider: provider.value.identity.provider,
    repositoryId: provider.value.repository.id,
    prNumber: provider.value.number,
    url: provider.value.url,
    headSha: provider.value.head.revision,
    lifecycleState: provider.value.lifecycleState,
  };
  let record: PullRequestRecord;
  try {
    record = input.store.recordPullRequest(recordInput);
  } catch (error) {
    return {
      ok: false,
      reason: "local-state-write-failed",
      detail: error instanceof Error ? error.message : String(error),
      providerCreated: true,
    };
  }

  const transitioned = transitionTask(input.store, input.taskId, "pull-request-open");
  if (!transitioned.ok) {
    return {
      ok: false,
      reason: "local-state-write-failed",
      detail: transitioned.blocked.blockingRule,
      providerCreated: true,
    };
  }
  return {
    ok: true,
    pullRequest: provider.value,
    record,
    task: transitioned.task,
    renderedBody: rendered.body,
    reused: false,
  };
}
