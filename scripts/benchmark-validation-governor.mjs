import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryArtifactStore } from "../src/retrieve.ts";
import { runManagedCheck } from "../src/workflow/validation/governor.ts";
import { WorkflowSqliteStateStore } from "../src/workflow/state/sqlite-store.ts";

/**
 * issue #184 acceptance: "Add a benchmark or fixture demonstrating reduced validation
 * executions and model-visible output versus the current repeated-command path."
 *
 * This replays a representative coding-agent session (issue #184's own example:
 * run tests -> edit code -> run tests -> edit docs -> run tests again -> run full verify
 * -> run full verify again before PR) against two paths:
 *
 *   naive:    every managed-check call re-executes the process and the full raw stdout is
 *             the model-visible payload (today's repeated-command behavior).
 *   governed: the same call sequence through `runManagedCheck` — a matching prior PASS is
 *             reused without spawning a process, and the model only ever sees the compact
 *             receipt.
 */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

function verboseTestOutputScript(passCount) {
  // No explicit `process.exit(0)` at the end: forcing exit immediately after synchronous
  // console.log calls can truncate buffered stdout before it reaches the pipe. Letting the
  // script finish naturally drains stdio first and exits 0 once the event loop is empty.
  const lines = Array.from({ length: passCount }, (_, index) => `console.log("PASS test/case-${index}.spec.ts");`);
  return lines.join("\n");
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mottainai-validation-governor-benchmark-"));
  try {
    git(["init", "--quiet", "-b", "main"], root);
    git(["config", "user.email", "bench@example.com"], root);
    git(["config", "user.name", "Mottainai Benchmark"], root);
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "docs.md"), "# docs\n");
    git(["add", "-A"], root);
    git(["commit", "--quiet", "-m", "initial"], root);

    const testCheck = {
      id: "test",
      label: "fast tests",
      command: process.execPath,
      args: ["-e", verboseTestOutputScript(400)],
      scope: ["src/**"],
      required: true,
    };
    const verifyCheck = {
      id: "verify",
      label: "full repository verification",
      command: process.execPath,
      args: ["-e", verboseTestOutputScript(1200)],
      required: false,
    };

    const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
    store.init();
    const instanceId = "bench-instance";
    store.observeRepositoryInstance({
      rootCommitDigest: "bench-digest",
      instanceId,
      gitCommonDir: join(root, ".git"),
      canonicalWorktreePath: root,
    });
    const artifactStore = new InMemoryArtifactStore();
    const context = { workspaceRoot: root, store, artifactStore, instanceId, worktreeId: "bench-worktree" };

    // Naive baseline: run the check's command directly and treat the full stdout as the
    // model-visible payload, exactly as an unmanaged repeated tool call would.
    function naiveRun(check) {
      const result = spawnSync(check.command, check.args, { cwd: root, encoding: "utf8" });
      return { executed: true, modelVisibleBytes: Buffer.byteLength(result.stdout ?? "", "utf8") };
    }

    async function governedRun(check) {
      const receipt = await runManagedCheck(context, check);
      const modelVisibleBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
      return { executed: receipt.execution === "executed", modelVisibleBytes, receipt };
    }

    const session = [
      { step: "run tests (cold)", check: testCheck, mutate: null },
      { step: "edit docs (out of scope)", check: null, mutate: () => writeFileSync(join(root, "docs.md"), "# docs v2\n") },
      { step: "run tests again", check: testCheck, mutate: null },
      { step: "edit docs again", check: null, mutate: () => writeFileSync(join(root, "docs.md"), "# docs v3\n") },
      { step: "run tests a third time", check: testCheck, mutate: null },
      {
        step: "edit src (in scope)",
        check: null,
        mutate: () => writeFileSync(join(srcDir, "index.ts"), "export const value = 2;\n"),
      },
      { step: "run tests after a real change", check: testCheck, mutate: null },
      { step: "run full verify (cold)", check: verifyCheck, mutate: null },
      { step: "run full verify again before PR", check: verifyCheck, mutate: null },
    ];

    const results = [];
    for (const entry of session) {
      if (entry.mutate) {
        entry.mutate();
        continue;
      }
      const naive = naiveRun(entry.check);
      const governed = await governedRun(entry.check);
      results.push({
        step: entry.step,
        check: entry.check.id,
        naiveExecuted: naive.executed,
        naiveBytes: naive.modelVisibleBytes,
        governedExecuted: governed.executed,
        governedExecution: governed.receipt.execution,
        governedBytes: governed.modelVisibleBytes,
      });
    }

    const totalNaiveExecutions = results.length; // naive always executes
    const totalGovernedExecutions = results.filter((row) => row.governedExecuted).length;
    const totalNaiveBytes = results.reduce((sum, row) => sum + row.naiveBytes, 0);
    const totalGovernedBytes = results.reduce((sum, row) => sum + row.governedBytes, 0);

    const summary = {
      benchmark: "validation-governor",
      sessionSteps: results.length,
      totalNaiveExecutions,
      totalGovernedExecutions,
      executionReductionRatio: 1 - totalGovernedExecutions / totalNaiveExecutions,
      totalNaiveBytes,
      totalGovernedBytes,
      modelVisibleByteReductionRatio: 1 - totalGovernedBytes / totalNaiveBytes,
      steps: results,
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
