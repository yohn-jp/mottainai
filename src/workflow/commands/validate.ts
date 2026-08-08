const TASK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// issueRef は branch 名に入るため、git が ref として拒否する値を予約前に弾く。
const ISSUE_REF_PATTERN = /^[A-Za-z0-9](?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9._-]*$/;

/** 無効な値が state 予約や `git worktree add` 後に失敗し、補償処理を必要にしないため。 */
export function validateTaskSlug(taskSlug: string): void {
  if (!TASK_SLUG_PATTERN.test(taskSlug)) throw new Error(`invalid task slug: ${taskSlug} (use lowercase, digits, hyphens)`);
}

export function validateIssueRef(issueRef: string | undefined): void {
  if (issueRef !== undefined && !ISSUE_REF_PATTERN.test(issueRef)) throw new Error(`invalid issue ref: ${issueRef}`);
}
