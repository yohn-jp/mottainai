import type { HookEvent } from "../hooks/types.js";
import type { HookPolicyProvider, HookProviderResult } from "../hooks/providers/types.js";
import type { ProtectedBranchOperation, WorkflowOperation } from "./policy/protected-branch.js";
import { decideProtectedBranchOperation } from "./policy/protected-branch.js";
import { resolveEffectiveWorkflowPolicy } from "./policy/load.js";
import { resolveRepositoryIdentity } from "./domain/identity.js";
import { resolveRepoState } from "./domain/repo-state.js";
import { NawabariExecutionError, NawabariExecutionClient } from "./nawabari.js";

export interface WorkflowHookProviderOptions {
  workspaceRoot: string;
  /** Production hooks pass the authoritative local execution boundary. */
  nawabari?: NawabariExecutionClient;
}
interface WorkflowRequest {
  operation: WorkflowOperation;
  branch?: string;
  rawGitAction?: "redirect" | "deny";
  replacement?: string;
}

const PROTECTED_OPERATIONS = new Set<ProtectedBranchOperation>([
  "sourceWrite",
  "stage",
  "commit",
  "directPush",
  "forcePush",
  "destructiveBranchOp",
]);

function bounded(value: string, maximum = 128): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function commandFor(event: HookEvent): string | undefined {
  if (event.target?.kind !== "command" || event.target.value === undefined) return undefined;
  return event.target.value;
}

function commandAfterGit(command: string, subcommand: string): string | undefined {
  const match = command.match(
    new RegExp(`(?:^|[;&|]\\s*)(?:env\\s+[^;&|]+\\s+|sudo\\s+)?git\\s+${subcommand}\\b([\\s\\S]*)`, "u"),
  );
  return match?.[1]?.trim();
}

const TYPED_WORKFLOW_REPLACEMENTS = {
  commit: "mottainai_workflow_task_commit",
  push: "mottainai_workflow_task_push",
} as const;

/**
 * This is deliberately only an operation classifier.  It must never extract
 * paths, refs, messages, or other authorization claims from shell text.
 */
function gitSubcommands(command: string): string[] {
  return [...command.matchAll(
    /(?:^|[;&|]\s*)(?:env\s+[^;&|]+\s+|sudo\s+)?git\s+(?:-[^\s;&|]+\s+)*([a-z][a-z0-9-]*)\b/giu,
  )].flatMap((match) => (match[1] === undefined ? [] : [match[1].toLowerCase()]));
}

function looksLikeGitInvocation(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:env\s+[^;&|]+\s+|sudo\s+)?git(?:\s|$)/u.test(command);
}

function readOnlyBranchCommand(tail: string): boolean {
  return /^(?:-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--format)(?:\s|$)/u.test(
    tail,
  );
}

function containsShellComposition(command: string): boolean {
  return /[;&|><`$()]/u.test(command);
}

function rawGitRequest(command: string): WorkflowRequest | undefined {
  const subcommands = gitSubcommands(command);
  if (subcommands.length === 0) return undefined;
  if (subcommands.length !== 1) return { operation: "destructiveBranchOp", rawGitAction: "deny" };
  const subcommand = subcommands[0];
  if (subcommand === undefined) return { operation: "destructiveBranchOp", rawGitAction: "deny" };

  if (subcommand === "commit") {
    return {
      operation: "commit",
      rawGitAction: "redirect",
      replacement: TYPED_WORKFLOW_REPLACEMENTS.commit,
    };
  }
  if (subcommand === "push") {
    const tail = commandAfterGit(command, "push") ?? "";
    // Remote ref deletion is not representable by the typed push operation.
    // Do not reinterpret it as an ordinary push.
    if (/(?:^|\s)(?:--delete|-d)(?:\s|$)/u.test(tail)) {
      return { operation: "directPush", rawGitAction: "deny" };
    }
    const force = /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/u.test(tail);
    return {
      operation: force ? "forcePush" : "directPush",
      rawGitAction: "redirect",
      replacement: TYPED_WORKFLOW_REPLACEMENTS.push,
    };
  }

  // `git worktree list` is observational. Mutating worktree subcommands are
  // denied below; no path from the command is treated as an authority claim.
  if (
    subcommand === "worktree" &&
    !containsShellComposition(command) &&
    /^(?:list|help)(?:\s|$)/u.test(commandAfterGit(command, "worktree") ?? "")
  )
    return { operation: "worktreeManagement" };
  if (subcommand === "branch" && readOnlyBranchCommand(commandAfterGit(command, "branch") ?? "")) return undefined;
  if (["status", "diff", "log", "show", "reflog", "rev-parse", "ls-files"].includes(subcommand)) return undefined;

  const operation: WorkflowOperation =
    subcommand === "add"
      ? "stage"
      : subcommand === "fetch" || subcommand === "pull"
        ? "repoSync"
        : subcommand === "worktree"
          ? "worktreeManagement"
          : subcommand === "branch" || subcommand === "reset"
            ? "destructiveBranchOp"
            : "destructiveBranchOp";
  return { operation, rawGitAction: "deny" };
}

function requestFor(event: HookEvent): WorkflowRequest | undefined {
  if (event.operation === "source.write") return { operation: "sourceWrite" };

  const command = commandFor(event);
  if (event.operation === "git.mutate" && command === undefined) {
    const operation = event.metadata?.workflowOperation;
    if (typeof operation === "string" && PROTECTED_OPERATIONS.has(operation as ProtectedBranchOperation)) {
      return { operation: operation as ProtectedBranchOperation };
    }
    if (operation === "repoSync" || operation === "worktreeManagement") return { operation };
    return { operation: "destructiveBranchOp", rawGitAction: "deny" };
  }
  if (command === undefined) return undefined;

  const rawGit = rawGitRequest(command);
  if (rawGit !== undefined) return rawGit;
  if (looksLikeGitInvocation(command)) return { operation: "destructiveBranchOp", rawGitAction: "deny" };
  return undefined;
}

function nawabariOperation(operation: WorkflowOperation): string | undefined {
  switch (operation) {
    case "sourceWrite":
      return "source-write";
    case "stage":
      return "stage";
    case "commit":
      return "commit";
    case "directPush":
    case "forcePush":
      return "push";
    case "destructiveBranchOp":
      return "branch-mutation";
    default:
      return undefined;
  }
}

function requestResources(event: HookEvent): string[] {
  if (event.target?.kind === "path" || event.target?.kind === "resource")
    return event.target.value === undefined ? [] : [event.target.value];
  const metadataResource = event.metadata?.resource;
  return typeof metadataResource === "string" && metadataResource.length > 0 ? [metadataResource] : [];
}

function notApplicable(): HookProviderResult {
  return { provider: "workflow", state: "not_applicable", reason: "unsupported_operation" };
}

/** Thin projection over the current #28 workflow policy and repository-state authorities. */
export function createWorkflowHookProvider(options: WorkflowHookProviderOptions): HookPolicyProvider {
  return {
    provider: "workflow",
    async evaluate(event): Promise<HookProviderResult> {
      const request = requestFor(event);
      if (request === undefined) return notApplicable();

      if (request.rawGitAction === "deny") {
        return {
          provider: "workflow",
          state: "authoritative",
          action: "deny",
          reason: "workflow_git_mutation_unsupported",
          rule: "workflow.git.typed_resource",
          diagnostic: "typed_resource_required",
        };
      }

      if (request.rawGitAction === "redirect") {
        return {
          provider: "workflow",
          state: "authoritative",
          action: "redirect",
          reason: "workflow_typed_operation_required",
          replacement: request.replacement,
          rule: `workflow.git.${request.operation}`,
          diagnostic: "raw_git_requires_typed_workflow",
        };
      }

      const identity = resolveRepositoryIdentity(options.workspaceRoot);
      if (!identity.ok) {
        return {
          provider: "workflow",
          state: "unavailable",
          reason: "workflow_authority_unavailable",
          rule: "repository.identity",
          diagnostic: "identity_unavailable",
        };
      }
      const repoState = await resolveRepoState(options.workspaceRoot);
      if (!repoState.ok) {
        return {
          provider: "workflow",
          state: "unavailable",
          reason: "workflow_authority_unavailable",
          rule: "repository.state",
          diagnostic: "state_unavailable",
        };
      }
      if (!repoState.state.supported) {
        return {
          provider: "workflow",
          state: "unsupported",
          reason: "workflow_unsupported",
          rule: `repository.state.${repoState.state.kind}`,
          diagnostic: "unsupported_repository_state",
        };
      }

      const loaded = resolveEffectiveWorkflowPolicy(identity.identity.canonicalRepositoryRoot);
      if (!loaded.ok) {
        return {
          provider: "workflow",
          state: "unavailable",
          reason: "workflow_authority_unavailable",
          rule: "workflow.policy",
          diagnostic: "policy_unavailable",
        };
      }

      const policyDecision = decideProtectedBranchOperation({
        policy: loaded.document,
        branch: request.branch ?? repoState.state.branch,
        operation: request.operation,
        repository: { isPrimaryCheckout: repoState.state.isPrimaryCheckout },
      });
      if (!policyDecision.allowed) {
        const rule = PROTECTED_OPERATIONS.has(request.operation as ProtectedBranchOperation)
          ? `protectedBranchRule.${request.operation}`
          : `workflow.${request.operation}`;
        const reason =
          policyDecision.reason === "control-plane-source-denied"
            ? "workflow_control_plane"
            : request.operation === "repoSync" || request.operation === "worktreeManagement"
              ? "workflow_worktree"
              : "workflow_protected_branch";
        return {
          provider: "workflow",
          state: "authoritative",
          action: "deny",
          reason,
          rule,
          diagnostic: bounded(`mode=${policyDecision.mode};reason=${policyDecision.reason}`),
        };
      }

      const operation = nawabariOperation(request.operation);
      if (operation !== undefined && options.nawabari === undefined) {
        return {
          provider: "workflow",
          state: "unavailable",
          reason: "workflow_authority_unavailable",
          rule: "nawabari.contract",
          diagnostic: "nawabari=missing_companion",
        };
      }
      if (options.nawabari !== undefined) {
        try {
          const resources = requestResources(event);
          if (operation !== undefined && resources.length === 0) {
            return {
              provider: "workflow",
              state: "authoritative",
              action: "deny",
              reason: "workflow_worktree",
              rule: "nawabari.authorize",
              diagnostic: "nawabari=resource_required",
            };
          }
          const decision =
            operation === undefined
              ? await options.nawabari.guard({ cwd: options.workspaceRoot })
              : await options.nawabari.authorize({ cwd: options.workspaceRoot, operation, resources });
          if (decision.allowed !== true) {
            const code = typeof decision.code === "string" ? decision.code : "OWNERSHIP_MISMATCH";
            return {
              provider: "workflow",
              state: "authoritative",
              action: "deny",
              reason: "workflow_worktree",
              rule: "nawabari.authorize",
              diagnostic: bounded(`nawabari=${code}`),
            };
          }
        } catch (error) {
          const code = error instanceof NawabariExecutionError ? error.code : "nawabari-command-failed";
          return {
            provider: "workflow",
            state: "unavailable",
            reason: "workflow_authority_unavailable",
            rule: "nawabari.contract",
            diagnostic: bounded(`nawabari=${code}`),
          };
        }
      }

      const rule = PROTECTED_OPERATIONS.has(request.operation as ProtectedBranchOperation)
        ? `protectedBranchRule.${request.operation}`
        : `workflow.${request.operation}`;
      const reason =
        policyDecision.reason === "control-plane-source-denied"
          ? "workflow_control_plane"
          : request.operation === "repoSync" || request.operation === "worktreeManagement"
            ? "workflow_worktree"
            : "workflow_protected_branch";
      return {
        provider: "workflow",
        state: "authoritative",
        action: policyDecision.allowed ? (policyDecision.mode === "advisory" ? "warn" : "allow") : "deny",
        reason,
        rule,
        diagnostic: bounded(`mode=${policyDecision.mode};reason=${policyDecision.reason}`),
      };
    },
  };
}
