import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPiBashCommand, default as installPiGuard, type PiGuardDecision } from "./pi-guard.js";

function blocked(command: string): PiGuardDecision {
  const decision = classifyPiBashCommand(command);
  assert.equal(decision.allowed, false, `expected blocked: ${command}`);
  return decision;
}

test("Pi guard allows inspection, ordinary development commands, and managed task commands", () => {
  for (const command of [
    "git status --short",
    "git diff --check",
    "git log -1",
    "git branch --show-current",
    "gh pr view 332",
    "gh issue list",
    "pnpm test",
    "npm run build",
    "printf 'git commit'",
    "mottainai task commit --message 'guarded change'",
    "mottainai task push",
    "mottainai task open-pr --title 'guarded change'",
  ]) {
    assert.equal(classifyPiBashCommand(command).allowed, true, command);
  }
});

test("Pi guard blocks representative raw local workflow mutations with canonical replacements", () => {
  assert.equal(blocked("git commit -m change").replacement, "mottainai task commit");
  assert.equal(blocked("git push origin feat/332").replacement, "mottainai task push");
  assert.equal(blocked("git branch new-branch").replacement, "mottainai task start");
  assert.equal(blocked("git worktree add ../other").replacement, "mottainai task start");
  assert.equal(blocked("git reset --hard HEAD").replacement, "mottainai task status");
  assert.equal(blocked("git clean -fd").replacement, "mottainai task cleanup");
  assert.equal(blocked("sudo git commit -am change").allowed, false);
  assert.equal(blocked("env GIT_DIR=.git git push").allowed, false);
});

test("Pi guard blocks direct governed GitHub writes but leaves GitHub reads available", () => {
  for (const command of [
    "gh pr create --title change",
    "gh pr edit 332 --title change",
    "gh pr merge 332",
    "gh pr close 332",
  ]) {
    const decision = blocked(command);
    assert.equal(decision.category, "github-pr-write");
    assert.match(decision.reason ?? "", /mottainai task open-pr/u);
  }
  for (const command of ["gh issue create --title change", "gh issue edit 332 --title change", "gh issue close 332"]) {
    assert.equal(blocked(command).category, "github-issue-write");
  }
  assert.equal(blocked("gh api --method POST repos/yohn-jp/mottainai/issues").category, "github-api-write");
  assert.equal(classifyPiBashCommand("gh api repos/yohn-jp/mottainai/issues/332").allowed, true);
});

test("Pi guard evaluates command sequences and supported shell wrappers before execution", () => {
  assert.equal(blocked("git status && git commit -m change").category, "git-commit");
  assert.equal(blocked("bash -lc 'git push origin feat/332'").category, "git-push");
  assert.equal(blocked('eval "gh pr create --title change"').category, "github-pr-write");
});

test("Pi extension blocks the bash tool call and does not inspect prose or terminal output", () => {
  let handler: ((event: { toolName?: unknown; input?: unknown }) => unknown) | undefined;
  installPiGuard({
    on(_event, callback) {
      handler = callback;
    },
  });
  assert.ok(handler);

  const denied = handler({ toolName: "bash", input: { command: "git push origin feat/332" } });
  assert.deepEqual(denied, {
    block: true,
    reason: "Mottainai managed Pi guard blocked raw git push. Use mottainai task push.",
  });
  assert.equal(handler({ toolName: "bash", input: { command: "git status" } }), undefined);
  assert.equal(handler({ toolName: "read", input: { path: "git commit" } }), undefined);
  assert.equal(handler({ toolName: "bash", input: { command: "git commit" } }) ? true : false, true);
});

test("Pi guard rejects malformed bash input with a bounded actionable result", () => {
  const decision = classifyPiBashCommand({ command: "git commit" });
  assert.equal(decision.allowed, false);
  assert.ok((decision.reason ?? "").length <= 512);
  assert.match(decision.reason ?? "", /managed Pi guard/u);
});
