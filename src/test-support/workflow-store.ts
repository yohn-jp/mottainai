import type { TestContext } from "node:test";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";

/** インメモリ (`:memory:`) の WorkflowSqliteStateStore を開き、テスト終了時に必ず close する。 */
export function createWorkflowStore(t: TestContext): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  return store;
}
