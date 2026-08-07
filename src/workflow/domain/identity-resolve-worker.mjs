// concurrent first-time resolution テスト用の子プロセス worker。
// resolveRepositoryIdentity() を 1 回呼び出し instanceId だけを stdout に出す。
import { resolveRepositoryIdentity } from "./identity.js";

const cwd = process.argv[2];
const result = resolveRepositoryIdentity(cwd);
if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}
process.stdout.write(result.identity.instanceId);
