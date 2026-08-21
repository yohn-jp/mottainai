import { GithubAdapter } from "./github.js";
import type { PullRequestRecord } from "../state/store.js";

export interface PullRequestReconciliationObservation {
  ok: boolean;
  /** Provider text is untrusted at this boundary; callers authorize only known lifecycle values such as `merged`. */
  lifecycleState: string;
  headSha?: string;
  mergeRevision?: string;
  detail?: string;
}

export type PullRequestObserver = (record: PullRequestRecord) => Promise<PullRequestReconciliationObservation>;

/**
 * Build the workflow's bounded provider observer from the owning GitHub adapter.
 * Reconciliation and task-start recovery share this exact observation path so
 * neither invents a second source of PR/merge authority.
 */
export function createPullRequestObserver(workspaceRoot: string): PullRequestObserver {
  const adapter = new GithubAdapter({ workspaceRoot });
  return async (record) => {
    if (record.provider !== "github")
      return {
        ok: false,
        lifecycleState: "unknown",
        detail: `provider observation is unavailable: ${record.provider}`,
      };
    const result = await adapter.viewPullRequest(record.prNumber, {
      provider: record.provider,
      id: record.repositoryId,
    });
    if (!result.ok) return { ok: false, lifecycleState: "unknown", detail: result.error.message };
    return {
      ok: true,
      lifecycleState: result.value.lifecycleState,
      headSha: result.value.head.revision,
      ...(result.value.mergeRevision === undefined ? {} : { mergeRevision: result.value.mergeRevision }),
    };
  };
}
