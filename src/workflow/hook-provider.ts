import type { HookEvent } from "../hooks/types.js";
import type { HookPolicyProvider, HookProviderResult } from "../hooks/providers/types.js";
import type { ProtectedBranchOperation, WorkflowOperation } from "./policy/protected-branch.js";
import { decideProtectedBranchOperation } from "./policy/protected-branch.js";
import { resolveEffectiveWorkflowPolicy } from "./policy/load.js";
import { resolveRepositoryIdentity } from "./domain/identity.js";
import { resolveRepoState } from "./domain/repo-state.js";

export interface WorkflowHookProviderOptions {
  workspaceRoot: string;
}
interface WorkflowRequest {
  operation: WorkflowOperation;
  branch?: string;
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
  const match = command.match(new RegExp(`(?:^|[;&|]\\s*)(?:env\\s+[^;&|]+\\s+|sudo\\s+)?git\\s+${subcommand}\\b([\\s\\S]*)`, "u"));
  return match?.[1]?.trim();
}

function words(value: string): string[] {
  return value.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\S+)/gu)?.map((word) => word.replace(/^(?:"|')|(?:"|')$/gu, "")) ?? [];
}

function pushBranch(command: string): string | undefined {
  const tail = commandAfterGit(command, "push");
  if (tail === undefined) return undefined;
  const args = words(tail).filter((arg) => !arg.startsWith("-"));
  const refspec = args.length > 1 ? args[1] : undefined;
  if (refspec === undefined) return undefined;
  const destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
  if (destination === "") return undefined;
  return destination.replace(/^refs\/heads\//u, "");
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
    return undefined;
  }
  if (command === undefined) return undefined;

  const push = commandAfterGit(command, "push");
  if (push !== undefined) {
    const force = /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/u.test(push);
    return { operation: force ? "forcePush" : "directPush", branch: pushBranch(command) };
  }
  if (commandAfterGit(command, "commit") !== undefined) return { operation: "commit" };
  if (commandAfterGit(command, "add") !== undefined) return { operation: "stage" };
  if (/(?:^|\s)(?:--delete|-d|-D)(?:\s|$)/u.test(commandAfterGit(command, "branch") ?? "")) {
    return { operation: "destructiveBranchOp" };
  }
  if (commandAfterGit(command, "worktree") !== undefined) return { operation: "worktreeManagement" };
  if (commandAfterGit(command, "fetch") !== undefined || commandAfterGit(command, "pull") !== undefined) {
    return { operation: "repoSync" };
  }
  if (commandAfterGit(command, "reset")?.includes("--hard") === true) return { operation: "destructiveBranchOp" };
  return undefined;
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

      const decision = decideProtectedBranchOperation({
        policy: loaded.document,
        branch: request.branch ?? repoState.state.branch,
        operation: request.operation,
        repository: { isPrimaryCheckout: repoState.state.isPrimaryCheckout },
      });
      const rule = PROTECTED_OPERATIONS.has(request.operation as ProtectedBranchOperation)
        ? `protectedBranchRule.${request.operation}`
        : `workflow.${request.operation}`;
      return {
        provider: "workflow",
        state: "authoritative",
        action: decision.allowed ? (decision.mode === "advisory" ? "warn" : "allow") : "deny",
        reason: decision.reason === "control-plane-source-denied" ? "workflow_control_plane" : "workflow_protected_branch",
        rule,
        diagnostic: bounded(`mode=${decision.mode};reason=${decision.reason}`),
      };
    },
  };
}
