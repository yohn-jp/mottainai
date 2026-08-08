import type { TestContext } from "node:test";
import { WorkflowSqliteStateStore } from "../workflow/state/sqlite-store.js";

// テスト間のSQLite handle残留を防ぎ、後続テストのDB境界を汚染しないため。
export function createWorkflowStore(t: TestContext): WorkflowSqliteStateStore {
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  t.after(() => store.close());
  return store;
}
