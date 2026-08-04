import { approvePolicy, loadActivePolicy, loadPolicies, resolvePolicyDir } from "../src/adaptive/policy.js";
import { aggregateTraces } from "../src/adaptive/stats.js";
import { createTraceStore } from "../src/adaptive/trace.js";

/**
 * routing policy と trace の人手操作 CLI。
 *
 * 候補 policy の承認はここだけで行う。MCP ツールから activate させないのは、
 * 呼び出し側エージェントが自分の統計で自分の routing を書き換えられないようにするため。
 */

const USAGE = `usage:
  pnpm run policy list                          approved / candidate policies
  pnpm run policy show <version>                print one policy document
  pnpm run policy approve <version> [--by who]  activate a candidate policy
  pnpm run policy traces [--limit n] [--category c]
  pnpm run policy stats [--category c] [--since-hours n]
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const [command = "list", ...argv] = process.argv.slice(2);
const directory = resolvePolicyDir();

if (command === "list") {
  const active = loadActivePolicy();
  print({
    policy_directory: directory,
    active_policy_version: active.policy_version,
    policies: loadPolicies(directory).map((stored) => ({
      policy_version: stored.document.policy_version,
      status: stored.document.status,
      source: stored.document.source,
      generated_at: stored.document.generated_at,
      rules: stored.document.rules.length,
      file: stored.filePath,
    })),
  });
} else if (command === "show") {
  const version = argv[0];
  const stored = loadPolicies(directory).find((candidate) => candidate.document.policy_version === version);
  if (stored === undefined) {
    console.error(`unknown policy version: ${version ?? "(missing argument)"}`);
    process.exit(1);
  }
  print(stored.document);
} else if (command === "approve") {
  const version = argv[0];
  if (version === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const before = loadActivePolicy();
  const approved = approvePolicy(directory, version, flag(argv, "by") ?? "cli");
  const after = loadActivePolicy();
  print({
    approved: approved.document.policy_version,
    file: approved.filePath,
    previous_active_policy_version: before.policy_version,
    active_policy_version: after.policy_version,
    changed_rules: approved.document.rules
      .filter((rule) => {
        const previous = before.rules.find((candidate) => candidate.task_category === rule.task_category);
        return previous === undefined || previous.capabilities.join(",") !== rule.capabilities.join(",");
      })
      .map((rule) => ({ task_category: rule.task_category, capabilities: rule.capabilities, support: rule.support, confidence: rule.confidence })),
  });
} else if (command === "traces") {
  const limit = Number(flag(argv, "limit") ?? 20);
  const traces = createTraceStore().load({ taskCategory: flag(argv, "category") });
  print(traces
    .sort((left, right) => right.request.timestamp.localeCompare(left.request.timestamp))
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20)
    .map((trace) => ({
      request_id: trace.request.request_id,
      timestamp: trace.request.timestamp,
      task_category: trace.request.task_category,
      task_intent: trace.request.task_intent,
      requested_capabilities: trace.request.requested_capabilities,
      executions: trace.executions.map((execution) => `${execution.provider}:${execution.capability}=${execution.status}`),
      review: trace.review === undefined ? undefined : {
        expected_found: trace.review.expected_found,
        sufficient: trace.review.sufficient,
        missing_capabilities: trace.review.missing_capabilities,
        unexpected_noise: trace.review.unexpected_noise,
      },
    })));
} else if (command === "stats") {
  const sinceHours = Number(flag(argv, "since-hours") ?? NaN);
  print(aggregateTraces(createTraceStore().load({
    taskCategory: flag(argv, "category"),
    since: Number.isFinite(sinceHours) ? Date.now() - sinceHours * 60 * 60 * 1000 : undefined,
  })));
} else {
  console.error(USAGE);
  process.exit(1);
}
