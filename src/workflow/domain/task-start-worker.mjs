// 並行性テスト用の子プロセス worker。startTask() を 1 回呼び出し、結果を JSON で
// stdout に出す。同一プロセス内の Promise.all では node:sqlite の同期呼び出しが
// 真の競合（SQLITE_BUSY 相当のロック待ち）を再現しないため、実プロセスを
// 複数同時起動して DB ファイルを共有させる（task.test.ts 参照）。
import { WorkflowSqliteStateStore } from "../state/sqlite-store.js";
import { BUILTIN_PRESETS } from "../policy/presets.js";
import { startTask } from "./task.js";

const [, , workspaceRoot, dbPath, taskSlug, issueRefArg, branchType] = process.argv;
const issueRef = issueRefArg === "" ? undefined : issueRefArg;

const store = new WorkflowSqliteStateStore({ dbPath });
store.init();

const policy = BUILTIN_PRESETS.standard;

try {
  const result = await startTask({ workspaceRoot, store, policy, taskSlug, branchType, issueRef });
  process.stdout.write(JSON.stringify(result));
} finally {
  store.close();
}
