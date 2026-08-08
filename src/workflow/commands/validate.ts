const TASK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// `..` と末尾 `.lock` を除外する — issueRef は branch 名に入るため、git が ref として
// 拒否する値を予約前に弾く（さもないと git-worktree-add-failed として予約後・rollback 前に失敗する）。
const ISSUE_REF_PATTERN = /^[A-Za-z0-9](?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._-]*$/;

/** MCP と CLI の両方の入口が `startTask` を呼ぶ前に通す唯一の境界検証。
 * ここで弾かなければ、無効な値は state 予約や `git worktree add` まで進んでから
 * 失敗する（予約行の補償削除、Windows でのパス/ref 由来の失敗など）。 */
export function validateTaskSlug(taskSlug: string): void {
  if (!TASK_SLUG_PATTERN.test(taskSlug)) throw new Error(`invalid taskSlug: ${taskSlug} (use lowercase, digits, hyphens)`);
}

export function validateIssueRef(issueRef: string | undefined): void {
  if (issueRef !== undefined && !ISSUE_REF_PATTERN.test(issueRef)) throw new Error(`invalid issueRef: ${issueRef}`);
}
