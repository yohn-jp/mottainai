import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDirectory = process.argv[2];
if (packageDirectory === undefined) throw new Error("installed Mottainai package directory is required");

const { GhInariClient, GH_INARI_SUPPORTED_OPERATIONS, GH_INARI_SUPPORTED_VERSION } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "gh-inari.js")).href
);
const { GhInariPullRequestAdapter } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "providers", "gh-inari.js")).href
);
const { openWorkflowTaskPullRequest } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "commands", "write.js")).href
);
const { resolveRepositoryIdentity } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "domain", "identity.js")).href
);
const { BUILTIN_PRESETS } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "policy", "presets.js")).href
);
const { WorkflowSqliteStateStore } = await import(
  pathToFileURL(path.join(packageDirectory, "dist", "workflow", "state", "sqlite-store.js")).href
);

function fakeGhInariExecutable({ version = "0.7.0", response } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-gh-inari-package-smoke-"));
  const executable = path.join(directory, "gh-inari");
  const logPath = path.join(directory, "invocations.jsonl");
  const defaultResponse = JSON.stringify({
    ok: false,
    error: { code: "TEMPLATE_NOT_FOUND", message: "template not found" },
  });
  const source = `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) process.stdout.write("gh-inari ${version}\\n");
	else if (process.argv.includes("--help=full")) process.stdout.write("  pr create --from <file.json>\\n  pr get <number> --json\\n  --from <path>\\n  --json\\n  --repository <r>\\n  --template <id>\\n");
	else process.stdout.write(${JSON.stringify(response ?? defaultResponse)});`;
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(executable, 0o755);
  return { directory, executable, logPath };
}

function invocationArgs(fake) {
  return fs
    .readFileSync(fake.logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function initializeWorkflowWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-packed-managed-pr-"));
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "packed-workflow@example.invalid"]);
  runGit(workspace, ["config", "user.name", "Mottainai Packed Workflow"]);
  fs.writeFileSync(path.join(workspace, "README.md"), "packed managed workflow\n");
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "initial"]);
  runGit(workspace, ["switch", "-c", "feat/307-packed-managed-pr"]);
  return workspace;
}

function createWorkflowFixture() {
  const workspaceRoot = initializeWorkflowWorkspace();
  const identityResult = resolveRepositoryIdentity(workspaceRoot);
  assert.equal(identityResult.ok, true, JSON.stringify(identityResult));
  if (!identityResult.ok) throw new Error("packed workflow repository identity setup failed");
  const identity = identityResult.identity;
  const store = new WorkflowSqliteStateStore({ dbPath: ":memory:" });
  store.init();
  store.observeRepositoryInstance({
    rootCommitDigest: identity.rootCommitDigest,
    instanceId: identity.instanceId,
    gitCommonDir: identity.gitCommonDir,
    canonicalWorktreePath: identity.worktreePath,
  });
  const reserved = store.reserveTask({
    instanceId: identity.instanceId,
    taskSlug: "packed-managed-pr",
    issueRef: "307",
    baseBranch: "main",
    baseCommit: runGit(workspaceRoot, ["rev-parse", "main"]),
    allowMultipleActiveTasksPerIssue: true,
  });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  if (!reserved.ok) throw new Error("packed workflow task setup failed");
  const sessionId = "packed-session-307";
  store.attachNawabariSession(reserved.task.taskId, sessionId);
  store.updateTaskLifecycleState(reserved.task.taskId, "active");
  store.updateTaskLifecycleState(reserved.task.taskId, "pushed");
  const nawabari = {
    currentSessionId: async () => sessionId,
    showSession: async () => ({
      sessionId,
      repository: identity.gitCommonDir,
      worktree: workspaceRoot,
      branch: "feat/307-packed-managed-pr",
      state: "active",
    }),
  };
  return {
    workspaceRoot,
    store,
    taskId: reserved.task.taskId,
    nawabari,
    branch: "feat/307-packed-managed-pr",
  };
}

function closeWorkflowFixture(fixture) {
  fixture.store.close();
  fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
}

function workflowInput(fixture) {
  return {
    workspaceRoot: fixture.workspaceRoot,
    store: fixture.store,
    taskId: fixture.taskId,
    nawabari: fixture.nawabari,
    policy: BUILTIN_PRESETS.standard,
    title: "Governed packed workflow PR",
    repository: "yohn-jp/mottainai",
    issueReference: "yohn-jp/mottainai#307",
    sections: { Summary: "packed managed PR intent" },
    acceptanceCriteria: ["gh-inari owns repository-native governance"],
  };
}

function emptyLookup(onCall) {
  return {
    findPullRequests: async () => {
      onCall?.();
      return { ok: true, value: [], attempts: 1 };
    },
  };
}

function exactPullRequest(input, number, url) {
  return {
    identity: { provider: "github", id: `pull-request:${number}` },
    reference: `#${number}`,
    number,
    url,
    state: "open",
    lifecycleState: "open",
    repository: input.repository,
    head: { ...input.head },
    base: { ...input.base },
  };
}

function createPackedAdapter(fixture, fake, lookupAdapter) {
  return new GhInariPullRequestAdapter({
    workspaceRoot: fixture.workspaceRoot,
    client: new GhInariClient({ command: fake.executable, cwd: fixture.workspaceRoot }),
    lookupAdapter,
  });
}

function assertNoSupportedDirectCreateEntryPoint() {
  const productionFiles = [
    "dist/workflow/commands/write.js",
    "dist/workflow/commands/mcp-tools.js",
    "dist/workflow/providers/github.js",
  ];
  for (const relativePath of productionFiles) {
    const source = fs.readFileSync(path.join(packageDirectory, relativePath), "utf8");
    assert.doesNotMatch(source, /gh\\s+pr\\s+create/u, `${relativePath} must not invoke direct gh PR creation`);
    assert.doesNotMatch(
      source,
      /["']pr["']\\s*,\\s*["']create["']/u,
      `${relativePath} must not contain a direct PR-create argv path`,
    );
  }
  const companionSource = fs.readFileSync(path.join(packageDirectory, "dist", "gh-inari.js"), "utf8");
  assert.match(companionSource, /["']pr["'],\s*["']create["']/u);
}

async function runPackedManagedWorkflowChecks() {
  assert.equal(GH_INARI_SUPPORTED_VERSION, ">=0.7.0");
  assert.deepEqual([...GH_INARI_SUPPORTED_OPERATIONS], ["pr.create", "pr.get"]);
  assertNoSupportedDirectCreateEntryPoint();

  {
    const fixture = createWorkflowFixture();
    const fake = fakeGhInariExecutable({
      response: JSON.stringify({
        ok: true,
        artifact: {
          number: 30701,
          url: "https://github.com/yohn-jp/mottainai/pull/30701",
          head: fixture.branch,
          base: "main",
        },
      }),
    });
    let lookupCalls = 0;
    try {
      const input = workflowInput(fixture);
      const result = await openWorkflowTaskPullRequest(input, {
        pullRequestAdapter: createPackedAdapter(
          fixture,
          fake,
          emptyLookup(() => (lookupCalls += 1)),
        ),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok) {
        assert.equal(result.pullRequest.number, 30701);
        assert.equal(result.task.lifecycleState, "pull-request-open");
        assert.equal(result.record.prNumber, 30701);
      }
      assert.equal(lookupCalls, 1);
      const creates = invocationArgs(fake).filter((args) => args[0] === "pr" && args[1] === "create");
      assert.equal(creates.length, 1, "packed managed create must cross gh-inari exactly once");
    } finally {
      closeWorkflowFixture(fixture);
      fs.rmSync(fake.directory, { recursive: true, force: true });
    }
  }

  {
    const fixture = createWorkflowFixture();
    const fake = fakeGhInariExecutable({
      response: JSON.stringify({
        ok: false,
        error: {
          code: "GOVERNANCE_REJECTED",
          message: "current repository governance rejected the PR",
          details: { path: "$.fields" },
        },
      }),
    });
    try {
      const input = workflowInput(fixture);
      const result = await openWorkflowTaskPullRequest(input, {
        pullRequestAdapter: createPackedAdapter(fixture, fake, emptyLookup()),
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "provider-failed");
        assert.equal(result.provider?.authority, "gh-inari");
        assert.equal(result.provider?.inari?.code, "INARI_REJECTED");
        assert.equal(result.provider?.inari?.remote?.code, "GOVERNANCE_REJECTED");
      }
      assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pushed");
    } finally {
      closeWorkflowFixture(fixture);
      fs.rmSync(fake.directory, { recursive: true, force: true });
    }
  }

  {
    const fixture = createWorkflowFixture();
    const missing = path.join(fixture.workspaceRoot, "missing-gh-inari");
    let lookupCalls = 0;
    try {
      const input = workflowInput(fixture);
      const result = await openWorkflowTaskPullRequest(input, {
        pullRequestAdapter: new GhInariPullRequestAdapter({
          workspaceRoot: fixture.workspaceRoot,
          client: new GhInariClient({ command: missing, cwd: fixture.workspaceRoot }),
          lookupAdapter: emptyLookup(() => (lookupCalls += 1)),
        }),
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.provider?.inari?.code, "INARI_COMPANION_MISSING");
      assert.equal(lookupCalls, 1);
      assert.equal(fixture.store.getTask(fixture.taskId)?.lifecycleState, "pushed");
    } finally {
      closeWorkflowFixture(fixture);
    }
  }

  {
    const fixture = createWorkflowFixture();
    const incompatible = fakeGhInariExecutable({ version: "0.1.0" });
    try {
      const input = workflowInput(fixture);
      const result = await openWorkflowTaskPullRequest(input, {
        pullRequestAdapter: createPackedAdapter(fixture, incompatible, emptyLookup()),
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.provider?.inari?.code, "INARI_COMPANION_INCOMPATIBLE");
      assert.deepEqual(invocationArgs(incompatible), [["--version"]]);
    } finally {
      closeWorkflowFixture(fixture);
      fs.rmSync(incompatible.directory, { recursive: true, force: true });
    }
  }

  {
    const fixture = createWorkflowFixture();
    const fake = fakeGhInariExecutable({
      response: JSON.stringify({
        ok: true,
        artifact: {
          number: 30702,
          url: "https://github.com/yohn-jp/mottainai/pull/30702",
          head: fixture.branch,
          base: "main",
        },
      }),
    });
    let lookupCalls = 0;
    const originalRecordPullRequest = fixture.store.recordPullRequest.bind(fixture.store);
    let failPersistence = true;
    fixture.store.recordPullRequest = (input) => {
      if (failPersistence) {
        failPersistence = false;
        throw new Error("simulated packed PR persistence failure");
      }
      return originalRecordPullRequest(input);
    };
    try {
      const input = workflowInput(fixture);
      const lookupAdapter = {
        findPullRequests: async (lookupInput) => {
          lookupCalls += 1;
          if (lookupCalls === 1) return { ok: true, value: [], attempts: 1 };
          return {
            ok: true,
            value: [exactPullRequest(lookupInput, 30702, "https://github.com/yohn-jp/mottainai/pull/30702")],
            attempts: 1,
          };
        },
      };
      const adapter = createPackedAdapter(fixture, fake, lookupAdapter);
      const first = await openWorkflowTaskPullRequest(input, { pullRequestAdapter: adapter });
      assert.equal(first.ok, false);
      if (!first.ok) assert.equal(first.providerCreated, true, JSON.stringify(first));
      assert.equal(fixture.store.listPullRequestRecordsForTask(fixture.taskId).length, 0);
      const recovered = await openWorkflowTaskPullRequest(input, { pullRequestAdapter: adapter });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      if (recovered.ok) {
        assert.equal(recovered.reused, true);
        assert.equal(recovered.pullRequest.number, 30702);
        assert.equal(recovered.task.lifecycleState, "pull-request-open");
      }
      assert.equal(lookupCalls, 2);
      assert.equal(
        invocationArgs(fake).filter((args) => args[0] === "pr" && args[1] === "create").length,
        1,
        "reconciliation must not create a duplicate remote PR",
      );
    } finally {
      closeWorkflowFixture(fixture);
      fs.rmSync(fake.directory, { recursive: true, force: true });
    }
  }
}

const fake = process.env.GH_INARI_EXECUTABLE === undefined ? fakeGhInariExecutable() : undefined;
let compatible;
let incompatible;
try {
  const client = new GhInariClient({
    command: process.env.GH_INARI_EXECUTABLE ?? fake.executable,
    cwd: process.cwd(),
  });

  const capabilities = await client.checkCapabilities();
  assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
  if (capabilities.ok) {
    assert.equal(capabilities.value.version, "0.7.0");
    assert.deepEqual(capabilities.value.operations, ["pr.create", "pr.get"]);
  }

  const rejected = await client.createPullRequest({
    repository: "yohn-jp/mottainai",
    template: "missing-template-for-package-smoke",
    input: { fields: {}, head: "feat/inari-package-smoke", base: "main" },
  });
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "INARI_REJECTED");
    assert.equal(rejected.error.remote?.code, "TEMPLATE_NOT_FOUND");
  }

  const githubProviderSource = fs.readFileSync(
    path.join(packageDirectory, "dist", "workflow", "providers", "github.js"),
    "utf8",
  );
  assert.doesNotMatch(githubProviderSource, /["']pr["']\s*,\s*["']create["']/u);

  compatible = fakeGhInariExecutable({
    response: JSON.stringify({
      ok: true,
      artifact: {
        number: 42,
        url: "https://github.com/yohn-jp/mottainai/pull/42",
        head: "feat/package-smoke",
        base: "main",
      },
    }),
  });
  let lookupCalls = 0;
  const lookupAdapter = {
    findPullRequests: async () => {
      lookupCalls += 1;
      return { ok: true, value: [], attempts: 1 };
    },
  };
  const createInput = {
    repository: { provider: "github", id: "yohn-jp/mottainai", namespace: "yohn-jp", name: "mottainai" },
    title: "package smoke",
    head: { name: "feat/package-smoke", revision: "head-sha" },
    base: { name: "main", revision: "base-sha" },
    draft: { sections: { Summary: "typed package smoke intent" } },
  };
  const governed = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: compatible.executable, cwd: process.cwd() }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(governed.ok, true, JSON.stringify(governed));
  assert.equal(lookupCalls, 0, "governed create must not use the GitHub read adapter as a mutation fallback");

  const missing = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: path.join(os.tmpdir(), "mottainai-no-such-gh-inari-package-smoke") }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(missing.ok, false, JSON.stringify(missing));
  if (!missing.ok) assert.equal(missing.error.inari?.code, "INARI_COMPANION_MISSING");

  incompatible = fakeGhInariExecutable({ version: "0.1.0" });
  const incompatibleResult = await new GhInariPullRequestAdapter({
    workspaceRoot: process.cwd(),
    client: new GhInariClient({ command: incompatible.executable, cwd: process.cwd() }),
    lookupAdapter,
  }).openPullRequest(createInput);
  assert.equal(incompatibleResult.ok, false, JSON.stringify(incompatibleResult));
  if (!incompatibleResult.ok) assert.equal(incompatibleResult.error.inari?.code, "INARI_COMPANION_INCOMPATIBLE");
  assert.equal(lookupCalls, 0, "capability failure must not fall back to a provider mutation");
} finally {
  if (fake !== undefined) fs.rmSync(fake.directory, { recursive: true, force: true });
  if (compatible !== undefined) fs.rmSync(compatible.directory, { recursive: true, force: true });
  if (incompatible !== undefined) fs.rmSync(incompatible.directory, { recursive: true, force: true });
}

await runPackedManagedWorkflowChecks();
