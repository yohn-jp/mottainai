#!/usr/bin/env node
/**
 * End-to-end certification for the integrated Pi worker path.
 *
 * This file is intentionally a harness: it builds and loads the published
 * package artifact, then drives the production Manager/Nawabari boundary. It
 * never imports the adapter from packages/pi-mottainai/src.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CERTIFICATION_EPIC_BRANCH = "epic/946-agent-runtime-supervision";
export const CERTIFICATION_EXPECTED_REVISION_ENV = "MOTTAINAI_PI_CERT_EXPECTED_REVISION";
export const PACKED_PACKAGE_NAME = "pi-mottainai";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.join(repositoryRoot, "packages", "pi-mottainai");
const FIXTURE_PROMPT =
  "This is a bounded certification fixture. Immediately call mottainai_execution once, then call report_status with lifecycleState running, phase executing, activity {kind working, label certification fixture}, progress {completed 1, current certification step, remaining 1}, and attention none. Do not use any other tool.";
const BODY_KEYS = /(?:credential|transcript|reasoning|prompt|directive|toolResult|tool_call|input)/iu;

export class CertificationExternalBlocker extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "CertificationExternalBlocker";
    this.cause = cause;
  }
}

export class CertificationProductDefect extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "CertificationProductDefect";
    this.cause = cause;
  }
}

function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Classify only provider/auth/network failures as external blockers. */
export function classifyProviderFailure(error) {
  const detail = textOf(error);
  if (
    /(?:no api key|api key|credential|oauth|authentication|provider|model|rate limit|too many requests|fetch failed|enotfound|econnrefused|etimedout|timed out|network)/iu.test(
      detail,
    )
  ) {
    return { code: "external-provider-unavailable", detail: detail.slice(0, 512) };
  }
  return undefined;
}

/** Keep the persisted/output evidence to the provider-neutral supervision projection. */
export function compactWorkerProjection(projection) {
  if (projection === undefined || projection === null || typeof projection !== "object") {
    throw new TypeError("worker projection must be an object");
  }
  const identity = projection.identity;
  if (identity === undefined || typeof identity !== "object") throw new TypeError("worker identity is missing");
  return {
    identity: {
      managerSessionId: identity.managerSessionId,
      runtimeId: identity.runtimeId,
      taskId: identity.taskId ?? null,
      executionSessionId: identity.executionSessionId ?? null,
      provider: identity.provider,
      agentKind: identity.agentKind ?? null,
      runtimeName: identity.runtimeName ?? null,
    },
    observationState: projection.observationState,
    observedAt: projection.observedAt,
    runtimeState: projection.runtimeState,
    semanticLifecycleState: projection.semanticLifecycleState,
    lifecycleState: projection.lifecycleState,
    phase: projection.phase,
    activity: projection.activity,
    progress: projection.progress,
    attention: projection.attention,
    blockerCode: projection.blockerCode,
    usage: projection.usage,
    context: projection.context,
    diagnosticEventCount: Array.isArray(projection.diagnosticEvents) ? projection.diagnosticEvents.length : 0,
    diagnosticEventKinds: Array.isArray(projection.diagnosticEvents)
      ? projection.diagnosticEvents.map((event) => event.kind)
      : [],
  };
}

/** Detect accidental persistence of ordinary provider bodies in certification evidence. */
export function assertBodyFreeEvidence(value) {
  const serialized = JSON.stringify(value);
  if (BODY_KEYS.test(serialized))
    throw new CertificationProductDefect("bounded evidence contains provider body fields");
  return value;
}

export function assertObservationReadOnly(beforeCalls, afterCalls) {
  const extra = afterCalls.slice(beforeCalls.length);
  const forbidden = extra.filter((call) => call === "prompt" || call === "steer" || call === "abort");
  if (forbidden.length > 0) {
    throw new CertificationProductDefect(
      `repeated status reads delivered implicit worker control: ${forbidden.join(", ")}`,
    );
  }
  return extra;
}

function assert(condition, message) {
  if (!condition) throw new CertificationProductDefect(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new CertificationProductDefect(
      `${command} ${args.join(" ")} failed (status ${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function readPackageJson(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
}

function oneTarball(directory) {
  const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".tgz"));
  if (files.length !== 1) throw new CertificationProductDefect(`expected one packed artifact, found ${files.length}`);
  return path.join(directory, files[0]);
}

function ensureBuild() {
  if (!fs.existsSync(path.join(repositoryRoot, "dist", "manager", "service.js")))
    run("pnpm", ["run", "build"], { cwd: repositoryRoot });
}

async function loadPackedAdapter() {
  const sourcePackage = readPackageJson(packageDirectory);
  assert(sourcePackage.name === PACKED_PACKAGE_NAME, `unexpected package name: ${sourcePackage.name}`);
  assert(sourcePackage.private !== true, "pi-mottainai must be publishable");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mottainai-runtime-certification-"));
  const artifactDirectory = path.join(temporaryRoot, "artifact");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  fs.mkdirSync(artifactDirectory);
  fs.mkdirSync(consumerDirectory);
  try {
    run("pnpm", ["--dir", packageDirectory, "run", "build"]);
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifactDirectory], { cwd: packageDirectory });
    const tarball = oneTarball(artifactDirectory);
    fs.writeFileSync(
      path.join(consumerDirectory, "package.json"),
      JSON.stringify({ name: "pi-mottainai-runtime-certification", private: true, version: "0.0.0", type: "module" }),
    );
    run("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: consumerDirectory,
    });

    const installedDirectory = path.join(consumerDirectory, "node_modules", PACKED_PACKAGE_NAME);
    const installedPackage = readPackageJson(installedDirectory);
    assert(installedPackage.version === sourcePackage.version, "packed adapter version does not match source metadata");
    assert(!fs.existsSync(path.join(installedDirectory, "src")), "packed adapter contains source files");
    const installedEntry = path.join(installedDirectory, "dist", "index.js");
    assert(fs.existsSync(installedEntry), "packed adapter is missing dist/index.js");
    assert(!path.resolve(installedEntry).startsWith(path.resolve(packageDirectory)), "adapter loaded from source tree");

    const adapter = await import(pathToFileURL(installedEntry).href);
    const sdkCandidates = [
      path.join(installedDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
      path.join(consumerDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    ];
    const sdkEntry = sdkCandidates.find((candidate) => fs.existsSync(candidate));
    assert(sdkEntry !== undefined, "packed artifact did not install the Pi SDK dependency");
    const sdk = await import(pathToFileURL(sdkEntry).href);
    return { adapter, sdk, temporaryRoot, consumerDirectory, installedEntry };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

class InertZellij {
  async checkAvailability() {
    return { version: "certification-inert-zellij 0.0.0" };
  }

  async inspect() {
    return "absent";
  }

  async start() {}

  async attach() {
    throw new Error("certification Pi workers do not expose terminal attachment");
  }

  async terminate() {}

  binaryName() {
    return "certification-inert-zellij";
  }
}

function executionSurfaceTool(surface) {
  return {
    name: surface.tool.name,
    label: "Mottainai execution facts",
    description: surface.tool.description,
    promptSnippet: "Read the admitted Mottainai execution facts.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => surface.tool.execute(),
  };
}

function assertCanonicalAttachment(input, evidence, claims) {
  const context = input.executionContext;
  assert(context.repository.worktree === evidence.worktree, "Pi context worktree differs from Nawabari evidence");
  assert(context.repository.branch === evidence.branch, "Pi context branch differs from Nawabari evidence");
  assert(context.repository.sessionId === evidence.sessionId, "Pi context session differs from Nawabari evidence");
  assert(context.task?.baseCommit === evidence.baseRevision, "Pi task base commit differs from Nawabari evidence");
  assert(
    context.repository.worktree === input.executionManifest.attachment.physical.worktree,
    "manifest worktree mismatch",
  );
  assert(context.repository.branch === input.executionManifest.attachment.physical.branch, "manifest branch mismatch");
  assert(
    JSON.stringify(context.scope.claims) === JSON.stringify(claims),
    "Pi scope claims differ from Nawabari claims",
  );
  const loaded = input.executionSurface.resourceLoader();
  assert(loaded.uri === "mottainai://execution", "execution resource URI is not canonical");
  assert(JSON.parse(loaded.text).repository.worktree === evidence.worktree, "execution resource is not canonical");
  return true;
}

function sessionProxy(session, calls) {
  return {
    subscribe(listener) {
      calls.push("subscribe");
      return session.subscribe(listener);
    },
    async steer(text) {
      calls.push("steer");
      return session.steer(text);
    },
    async prompt(text) {
      calls.push("prompt");
      return session.prompt(text);
    },
    async abort() {
      calls.push("abort");
      return session.abort();
    },
    dispose() {
      calls.push("dispose");
      return session.dispose();
    },
  };
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function currentGitValue(args) {
  return run("git", args, { cwd: repositoryRoot }).stdout.trim();
}

function currentGitValueAt(cwd, args) {
  return run("git", args, { cwd }).stdout.trim();
}

export function resolveCertificationRevision({ head, branch, expectedRevision }) {
  if (expectedRevision !== undefined && expectedRevision.length > 0) {
    if (head !== expectedRevision) {
      throw new CertificationProductDefect(
        `certification revision mismatch: expected ${expectedRevision}, observed ${head}`,
      );
    }
    return head;
  }
  if (branch !== CERTIFICATION_EPIC_BRANCH) {
    throw new CertificationProductDefect(
      `certification must run on ${CERTIFICATION_EPIC_BRANCH} or declare ${CERTIFICATION_EXPECTED_REVISION_ENV}`,
    );
  }
  return head;
}

function currentCertificationRevision() {
  return resolveCertificationRevision({
    head: currentGitValue(["rev-parse", "HEAD"]),
    branch: currentGitValue(["branch", "--show-current"]),
    expectedRevision: process.env[CERTIFICATION_EXPECTED_REVISION_ENV],
  });
}

export async function certify() {
  const certificationRevision = currentCertificationRevision();
  ensureBuild();
  const packed = await loadPackedAdapter();
  const managerModule = await import(pathToFileURL(path.join(repositoryRoot, "dist", "manager", "service.js")).href);
  const storeModule = await import(
    pathToFileURL(path.join(repositoryRoot, "dist", "workflow", "state", "sqlite-store.js")).href
  );
  const nawabariModule = await import(pathToFileURL(path.join(repositoryRoot, "dist", "workflow", "nawabari.js")).href);
  const managerTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-manager-certification-"));
  const managerWorkspaceRoot = path.join(managerTempRoot, "repository");
  run("git", ["clone", "--shared", "--no-tags", repositoryRoot, managerWorkspaceRoot]);
  run("git", ["checkout", "-B", "main", certificationRevision], { cwd: managerWorkspaceRoot });
  assert(
    currentGitValueAt(managerWorkspaceRoot, ["rev-parse", "HEAD"]) === certificationRevision,
    "temporary certification repository is not pinned to the certification revision",
  );
  const store = new storeModule.WorkflowSqliteStateStore({ dbPath: path.join(managerTempRoot, "state.sqlite3") });
  store.init();
  const nawabari = new nawabariModule.NawabariExecutionClient();
  const calls = [];
  let runtime;
  let workerBinding;
  let factoryInput;
  let promptError;
  let promptSettled = false;
  let managerSession;
  let executionWorktree;
  const service = new managerModule.ManagerSessionService({
    workspaceRoot: managerWorkspaceRoot,
    store,
    runtime: new InertZellij(),
    nawabari,
    piWorkerFactory: async (input) => {
      factoryInput = input;
      const executionTool = executionSurfaceTool(input.executionSurface);
      runtime = new packed.adapter.PiMottainaiRuntime({
        sessionOptions: {
          cwd: input.executionContext.repository.worktree,
          agentDir: path.join(managerTempRoot, "pi-agent"),
          noTools: "all",
          sessionManager: packed.sdk.SessionManager.inMemory(),
          customTools: [executionTool],
        },
        sessionFactory: async (options) => {
          const created = await packed.sdk.createAgentSession(options);
          return sessionProxy(created.session, calls);
        },
      });
      return {
        start: async (startInput) => {
          const started = await runtime.start(startInput);
          workerBinding = started.binding;
          return started;
        },
        bind: async (bindInput) => {
          const bound = await runtime.bind(bindInput);
          workerBinding = bound.binding;
          return bound;
        },
        observe: (binding) => runtime.observe(binding),
        events: (binding) => runtime.events(binding),
        steer: (input) => runtime.steer(input),
        sendInput: (input) => runtime.sendInput(input),
        stop: (input) => runtime.stop(input),
      };
    },
  });

  try {
    managerSession = await service.start({
      agentKind: "pi",
      provider: "pi",
      instruction: "bounded Pi runtime certification fixture",
      taskSlug: `pi-runtime-certification-${Date.now()}`,
      issueRef: "956",
      branchType: "feat",
      canon: { prefix_id: "prefix-956-certification", execution_state_id: "state-956-certification" },
      scope: { paths: ["src/manager/service.ts"] },
    });
    assert(factoryInput !== undefined, "Manager did not invoke the Pi worker factory");
    assert(runtime !== undefined && workerBinding !== undefined, "real Pi runtime did not bind");
    executionWorktree = factoryInput.executionContext.repository.worktree;
    const evidence = await nawabari.repositoryEvidence({
      cwd: executionWorktree,
      sessionId: factoryInput.executionContext.repository.sessionId,
    });
    const claims = await nawabari.listClaims({
      cwd: executionWorktree,
      sessionId: factoryInput.executionContext.repository.sessionId,
    });
    assertCanonicalAttachment(factoryInput, evidence, claims);
    assert(factoryInput.executionSurface.tool.execute !== undefined, "execution tool is missing");
    const executionToolResult = await factoryInput.executionSurface.tool.execute();
    assert(executionToolResult.details.readOnly === true, "execution surface is not read-only");
    assert(
      !BODY_KEYS.test(executionToolResult.content[0]?.text ?? ""),
      "execution surface contains provider body fields",
    );

    const prompt = FIXTURE_PROMPT;
    const promptPromise = runtime
      .sendInput({ binding: workerBinding, input: prompt })
      .then(() => {
        promptSettled = true;
      })
      .catch((error) => {
        promptError = error;
        promptSettled = true;
      });
    const callsBeforeReads = [...calls];
    const snapshots = [];
    let status;
    for (let index = 0; index < 120; index += 1) {
      await sleep(25);
      const snapshot = compactWorkerProjection(service.listWorkerSupervision({ limit: 1 })[0]);
      snapshots.push(snapshot);
      const detail = service.getWorkerSupervision(managerSession.sessionId);
      assertBodyFreeEvidence(detail);
      if (snapshot.activity?.label === "certification fixture") {
        status = detail;
        break;
      }
      if (promptSettled) break;
    }
    assertObservationReadOnly(callsBeforeReads, calls);
    const promptProviderFailure = classifyProviderFailure(promptError);
    if (promptProviderFailure !== undefined) {
      throw new CertificationExternalBlocker(promptProviderFailure.detail, promptError);
    }
    assert(status !== undefined, "bounded worker report_status never reached supervision projection");
    const stopped = await service.stop(managerSession.sessionId);
    assert(stopped.runtimeState === "stopped", "explicit Pi stop did not produce truthful stopped state");
    const audits = store.listWorkerControlAudit(managerSession.sessionId);
    assert(
      audits.some((audit) => audit.operation === "stop" && audit.acceptedAt !== undefined),
      "Pi stop was not audited",
    );
    await Promise.race([promptPromise, sleep(15_000)]);
    if (!promptSettled) throw new CertificationExternalBlocker("Pi provider turn timed out after 15 seconds");
    if (promptError !== undefined)
      throw new CertificationProductDefect(`real Pi fixture failed: ${textOf(promptError)}`, promptError);

    const statusJson = JSON.stringify(status);
    assertBodyFreeEvidence(status);
    assert(statusJson.includes("certification"), "bounded worker report_status evidence is missing");
    const reconciled = (await service.reconcileNow()).find((session) => session.sessionId === managerSession.sessionId);
    assert(reconciled?.runtimeState === "stopped", "reconciliation invented liveness after stop");

    const restartedStore = new storeModule.WorkflowSqliteStateStore({
      dbPath: path.join(managerTempRoot, "state.sqlite3"),
    });
    restartedStore.init();
    const restartedService = new managerModule.ManagerSessionService({
      workspaceRoot: managerWorkspaceRoot,
      store: restartedStore,
      runtime: new InertZellij(),
      nawabari,
    });
    await restartedService.initialize();
    const restartProjection = await restartedService.get(managerSession.sessionId);
    assert(restartProjection.runtimeState === "stopped", "restart/reconciliation changed terminal state to live");
    return assertBodyFreeEvidence({
      result: "certified",
      revision: certificationRevision,
      artifact: { package: PACKED_PACKAGE_NAME, entry: packed.installedEntry },
      attachment: {
        worktree: evidence.worktree,
        branch: evidence.branch,
        sessionId: evidence.sessionId,
        baseRevision: evidence.baseRevision,
      },
      observations: snapshots,
      controls: audits.map((audit) => ({ operation: audit.operation, acceptedAt: audit.acceptedAt })),
      finalState: restartProjection.runtimeState,
    });
  } finally {
    if (managerSession !== undefined) {
      await service.stop(managerSession.sessionId).catch(() => undefined);
      await service.reconcileNow().catch(() => undefined);
      if (managerSession.executionSessionId !== undefined && executionWorktree !== undefined) {
        await nawabari
          .closeSession({ cwd: executionWorktree, sessionId: managerSession.executionSessionId })
          .catch(() => undefined);
      }
    }
    if (runtime !== undefined) runtime.dispose();
    fs.rmSync(managerTempRoot, { recursive: true, force: true });
    fs.rmSync(packed.temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const evidence = await certify();
    console.log(JSON.stringify(evidence));
  } catch (error) {
    if (error instanceof CertificationExternalBlocker) {
      console.error(
        JSON.stringify({
          result: "external-blocker",
          blocker: { code: "external-provider-unavailable", detail: error.message },
        }),
      );
      process.exitCode = 2;
      return;
    }
    console.error(
      JSON.stringify({
        result: "product-defect",
        blocker: { code: "certification-failed", detail: textOf(error).slice(0, 512) },
      }),
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
