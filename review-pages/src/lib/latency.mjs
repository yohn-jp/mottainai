import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LATENCY_SCHEMA_VERSION = "mottainai.review-pages.latency/v1";

// Keep the vocabulary intentionally small. The workflow is the owner of the
// stage boundaries; this module only records them and computes durations.
export const LATENCY_STAGE_NAMES = Object.freeze([
  "runner-start",
  "checkout",
  "setup",
  "install",
  "generation",
  "validation",
  "artifact-handoff",
  "publish",
  "pages-serving",
]);

export const LATENCY_MILESTONE_NAMES = Object.freeze(["generation-complete", "gh-pages-push-complete", "http-visible"]);

export const LATENCY_VISIBILITY_STATUSES = Object.freeze([
  "success",
  "push-failure",
  "published-but-not-serving",
  "wrong-served-revision",
]);

const MAX_EVENTS_PER_JOB = 32;
const MAX_JOBS = 4;
export const MAX_LATENCY_FILE_BYTES = 128 * 1024;
const MAX_STRING_LENGTH = 200;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function boundedString(value, max = MAX_STRING_LENGTH) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\r\n\t]/gu, " ").trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function optionalSha(value) {
  const normalized = boundedString(value, 40);
  return normalized && SHA_PATTERN.test(normalized) ? normalized : null;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function captureTimestamp({ monotonicNs = process.hrtime.bigint(), wallClock = new Date() } = {}) {
  const monotonic = typeof monotonicNs === "bigint" ? monotonicNs : BigInt(monotonicNs);
  const wall = wallClock instanceof Date ? wallClock : new Date(wallClock);
  if (Number.isNaN(wall.getTime())) throw new Error("latency wall clock timestamp is invalid");
  return Object.freeze({ monotonicNs: monotonic.toString(), wallClock: wall.toISOString() });
}

function metadataFromEnvironment(environment) {
  return {
    repository: boundedString(environment.GITHUB_REPOSITORY),
    workflow: boundedString(environment.GITHUB_WORKFLOW),
    runId: boundedString(environment.GITHUB_RUN_ID, 40),
    runAttempt: optionalInteger(environment.GITHUB_RUN_ATTEMPT),
    pullRequestNumber: optionalInteger(environment.REVIEW_PAGES_PR_NUMBER),
    headSha: optionalSha(environment.REVIEW_PAGES_HEAD_SHA),
    workflowStartedAt: validIsoTimestamp(
      environment.GITHUB_RUN_STARTED_AT ?? environment.REVIEW_PAGES_WORKFLOW_STARTED_AT,
    ),
  };
}

function emptyJob() {
  return { events: [], stages: {} };
}

function cloneMetadata(metadata = {}) {
  return {
    repository: boundedString(metadata.repository),
    workflow: boundedString(metadata.workflow),
    runId: boundedString(metadata.runId, 40),
    runAttempt: optionalInteger(metadata.runAttempt),
    pullRequestNumber: optionalInteger(metadata.pullRequestNumber),
    headSha: optionalSha(metadata.headSha),
    workflowStartedAt: validIsoTimestamp(metadata.workflowStartedAt),
  };
}

export function createLatencyEvidence({ metadata = {}, job, timestamp = captureTimestamp() } = {}) {
  const evidence = {
    schemaVersion: LATENCY_SCHEMA_VERSION,
    run: cloneMetadata(metadata),
    jobs: {},
    milestones: {},
    visibility: null,
  };
  if (job) ensureJob(evidence, job);
  if (timestamp && job) addEvent(evidence, job, "runner-start", "mark", timestamp);
  return evidence;
}

function assertEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== LATENCY_SCHEMA_VERSION) {
    throw new Error("unsupported Review Pages latency evidence schema");
  }
  if (!evidence.jobs || typeof evidence.jobs !== "object") throw new Error("latency evidence jobs are invalid");
  if (!evidence.milestones || typeof evidence.milestones !== "object") {
    throw new Error("latency evidence milestones are invalid");
  }
}

function ensureJob(evidence, job) {
  const name = boundedString(job, 40);
  if (!name) throw new Error("latency job name is required");
  if (!Object.hasOwn(evidence.jobs, name)) {
    if (Object.keys(evidence.jobs).length >= MAX_JOBS) throw new Error("latency evidence has too many jobs");
    evidence.jobs[name] = emptyJob();
  }
  return evidence.jobs[name];
}

function assertStageName(stage) {
  if (!LATENCY_STAGE_NAMES.includes(stage)) throw new Error(`unsupported latency stage: ${stage}`);
}

function assertMilestoneName(name) {
  if (!LATENCY_MILESTONE_NAMES.includes(name)) throw new Error(`unsupported latency milestone: ${name}`);
}

function addEvent(evidence, job, name, phase, timestamp, details) {
  const target = ensureJob(evidence, job);
  if (target.events.length >= MAX_EVENTS_PER_JOB) throw new Error("latency evidence event bound exceeded");
  const event = { name, phase, timestamp };
  if (details !== undefined) event.details = details;
  target.events.push(event);
  return event;
}

function monotonicMilliseconds(start, end) {
  const startNs = BigInt(start.monotonicNs);
  const endNs = BigInt(end.monotonicNs);
  const delta = endNs - startNs;
  if (delta < 0n) throw new Error("latency monotonic clock moved backwards");
  return Number(delta) / 1_000_000;
}

function openStage(job, stage) {
  const record = job.stages[stage];
  return record && record.completedAt === null ? record : null;
}

export function recordStage(evidence, { job, stage, phase, timestamp = captureTimestamp() } = {}) {
  assertEvidence(evidence);
  assertStageName(stage);
  const target = ensureJob(evidence, job);
  if (phase === "start") {
    if (target.stages[stage] && target.stages[stage].completedAt === null) {
      throw new Error(`latency stage is already open: ${stage}`);
    }
    target.stages[stage] = { startedAt: timestamp, completedAt: null, durationMs: null };
    addEvent(evidence, job, stage, "start", timestamp);
    return target.stages[stage];
  }
  if (phase === "complete") {
    const record = openStage(target, stage);
    if (!record) throw new Error(`latency stage is not open: ${stage}`);
    record.completedAt = timestamp;
    record.durationMs = Number(monotonicMilliseconds(record.startedAt, timestamp).toFixed(3));
    addEvent(evidence, job, stage, "complete", timestamp);
    return record;
  }
  throw new Error(`unsupported latency stage phase: ${phase}`);
}

export function recordMilestone(evidence, { job, name, timestamp = captureTimestamp(), details } = {}) {
  assertEvidence(evidence);
  assertMilestoneName(name);
  ensureJob(evidence, job);
  if (Object.hasOwn(evidence.milestones, name)) throw new Error(`latency milestone already recorded: ${name}`);
  const boundedDetails = details === undefined ? undefined : boundedDetailsObject(details);
  const milestone = { job, timestamp };
  if (boundedDetails !== undefined) milestone.details = boundedDetails;
  evidence.milestones[name] = milestone;
  addEvent(evidence, job, name, "mark", timestamp, boundedDetails);
  return milestone;
}

function boundedDetailsObject(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const result = {};
  for (const [key, value] of Object.entries(details).slice(0, 8)) {
    const safeKey = boundedString(key, 48);
    if (!safeKey) continue;
    if (typeof value === "boolean" || value === null) result[safeKey] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[safeKey] = value;
    else if (typeof value === "string") result[safeKey] = boundedString(value, 200);
  }
  return result;
}

function ensureRunCompatibility(left, right) {
  for (const key of ["repository", "runId", "pullRequestNumber", "headSha"]) {
    if (left.run[key] !== null && right.run[key] !== null && left.run[key] !== right.run[key]) {
      throw new Error(`latency evidence run metadata mismatch: ${key}`);
    }
  }
}

export function mergeLatencyEvidence(target, source) {
  assertEvidence(target);
  assertEvidence(source);
  ensureRunCompatibility(target, source);
  for (const [key, value] of Object.entries(target.run)) {
    if (value === null && source.run[key] !== null) target.run[key] = source.run[key];
  }
  for (const [job, sourceJob] of Object.entries(source.jobs)) {
    if (Object.hasOwn(target.jobs, job)) throw new Error(`latency evidence job already exists: ${job}`);
    if (Object.keys(target.jobs).length >= MAX_JOBS) throw new Error("latency evidence has too many jobs");
    target.jobs[job] = sourceJob;
  }
  for (const [name, milestone] of Object.entries(source.milestones)) {
    if (Object.hasOwn(target.milestones, name)) throw new Error(`latency milestone already exists: ${name}`);
    target.milestones[name] = milestone;
  }
  if (target.visibility === null && source.visibility !== null) target.visibility = source.visibility;
  return target;
}

export function readLatencyFile(filePath) {
  const evidence = readJson(filePath);
  assertEvidence(evidence);
  return evidence;
}

function readJson(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_LATENCY_FILE_BYTES) throw new Error("latency evidence exceeds its size bound");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function bootstrapEvidence(existing, metadata, job) {
  if (!existing || existing.schemaVersion === LATENCY_SCHEMA_VERSION) return existing;
  const bootstrap = existing.bootstrap;
  if (!bootstrap || typeof bootstrap !== "object") return null;
  const evidence = createLatencyEvidence({ metadata, job, timestamp: null });
  if (bootstrap.workflowStartedAt && evidence.run.workflowStartedAt === null) {
    evidence.run.workflowStartedAt = validIsoTimestamp(bootstrap.workflowStartedAt);
  }
  if (bootstrap.runnerStart) {
    addEvent(evidence, job, "runner-start", "mark", bootstrap.runnerStart);
    const target = ensureJob(evidence, job);
    const completedAt = bootstrap.checkoutStart ?? bootstrap.runnerStart;
    target.stages["runner-start"] = {
      startedAt: bootstrap.runnerStart,
      completedAt,
      durationMs: Number(monotonicMilliseconds(bootstrap.runnerStart, completedAt).toFixed(3)),
    };
  }
  if (bootstrap.checkoutStart) {
    const target = ensureJob(evidence, job);
    target.stages.checkout = { startedAt: bootstrap.checkoutStart, completedAt: null, durationMs: null };
    addEvent(evidence, job, "checkout", "start", bootstrap.checkoutStart);
  }
  return evidence;
}

export function initializeLatencyFile(filePath, { metadata = {}, job, bootstrap } = {}) {
  let existing = null;
  if (fs.existsSync(filePath)) existing = readJson(filePath);
  let evidence = bootstrapEvidence(existing, metadata, job);
  if (!evidence) evidence = existing ?? createLatencyEvidence({ metadata, job, timestamp: null });
  assertEvidence(evidence);
  for (const [key, value] of Object.entries(cloneMetadata(metadata))) {
    if (evidence.run[key] === null && value !== null) evidence.run[key] = value;
  }
  if (job) ensureJob(evidence, job);
  writeLatencyFile(filePath, evidence);
  return evidence;
}

export function writeLatencyFile(filePath, evidence) {
  assertEvidence(evidence);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LATENCY_FILE_BYTES) {
    throw new Error("latency evidence exceeds its size bound");
  }
  fs.writeFileSync(filePath, serialized);
}

export function recordVisibility(
  evidence,
  { job, status, attempts, expectedPath, observedHeadSha, lastStatusCode } = {},
) {
  assertEvidence(evidence);
  if (!LATENCY_VISIBILITY_STATUSES.includes(status)) throw new Error(`unsupported HTTP visibility status: ${status}`);
  ensureJob(evidence, job);
  const details = boundedDetailsObject({ attempts, expectedPath, observedHeadSha, lastStatusCode });
  evidence.visibility = { status, ...details };
  return evidence.visibility;
}

export function updateLatencyFile(filePath, update) {
  const evidence = readJson(filePath);
  assertEvidence(evidence);
  if (update.type === "stage") recordStage(evidence, update);
  else if (update.type === "milestone") recordMilestone(evidence, update);
  else if (update.type === "visibility") recordVisibility(evidence, update);
  else throw new Error(`unsupported latency update: ${update.type}`);
  writeLatencyFile(filePath, evidence);
  return evidence;
}

function formatDuration(durationMs) {
  return durationMs === null || durationMs === undefined ? "unavailable" : `${durationMs.toFixed(3)} ms`;
}

function wallDeltaMs(start, end) {
  if (!start || !end) return null;
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

export function renderLatencySummary(evidence) {
  assertEvidence(evidence);
  const lines = [
    "### Review Pages latency",
    "",
    "Durations use the runner's monotonic clock; timestamps are UTC. Cross-job deltas use wall-clock timestamps and are informational.",
    "",
    "| Job | Stage | Started (UTC) | Completed (UTC) | Duration |",
    "| --- | --- | --- | --- | ---: |",
  ];
  for (const [jobName, job] of Object.entries(evidence.jobs)) {
    for (const [stage, record] of Object.entries(job.stages)) {
      lines.push(
        `| ${jobName} | ${stage} | ${record.startedAt.wallClock} | ${record.completedAt?.wallClock ?? "—"} | ${formatDuration(record.durationMs)} |`,
      );
    }
  }

  const runnerStarts = Object.entries(evidence.jobs)
    .map(([job, value]) => ({ job, event: value.events.find((event) => event.name === "runner-start") }))
    .filter((entry) => entry.event);
  for (const { job, event } of runnerStarts) {
    const delay = wallDeltaMs(evidence.run.workflowStartedAt, event.timestamp.wallClock);
    lines.push(
      `- ${job} runner-start: ${event.timestamp.wallClock} (workflow-start to marker: ${formatDuration(delay)})`,
    );
  }

  const generation = evidence.milestones["generation-complete"]?.timestamp?.wallClock;
  const pushed = evidence.milestones["gh-pages-push-complete"]?.timestamp?.wallClock;
  const visible = evidence.milestones["http-visible"]?.timestamp?.wallClock;
  lines.push(`- generation-complete: ${generation ?? "not observed"}`);
  lines.push(`- gh-pages-push-complete: ${pushed ?? "not observed"}`);
  lines.push(`- http-visible: ${visible ?? "not observed"}`);
  lines.push(`- generation → gh-pages push (wall-clock): ${formatDuration(wallDeltaMs(generation, pushed))}`);
  lines.push(`- gh-pages push → HTTP visible (wall-clock): ${formatDuration(wallDeltaMs(pushed, visible))}`);
  if (evidence.visibility) {
    lines.push(`- HTTP visibility status: ${evidence.visibility.status}`);
    lines.push(`- HTTP visibility attempts: ${evidence.visibility.attempts}`);
  }
  return `${lines.join("\n")}\n`;
}

function environmentMetadata(environment) {
  return metadataFromEnvironment(environment);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bootstrapBeforeCheckout(environment) {
  const filePath = requiredEnvironment(environment, "REVIEW_PAGES_LATENCY_FILE");
  const runnerStart = captureTimestamp();
  const checkoutStart = captureTimestamp();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      bootstrap: {
        runnerStart,
        checkoutStart,
        workflowStartedAt: validIsoTimestamp(environment.REVIEW_PAGES_WORKFLOW_STARTED_AT),
      },
    })}\n`,
  );
}

function main() {
  const [command, argument] = process.argv.slice(2);
  const environment = process.env;
  const filePath = environment.REVIEW_PAGES_LATENCY_FILE;
  const job = environment.REVIEW_PAGES_LATENCY_JOB;

  if (command === "bootstrap") {
    bootstrapBeforeCheckout(environment);
    return;
  }
  if (!filePath) throw new Error("REVIEW_PAGES_LATENCY_FILE is required");
  if (command === "init") {
    initializeLatencyFile(filePath, { metadata: environmentMetadata(environment), job });
    return;
  }
  if (command === "start" || command === "complete") {
    if (!job || !argument) throw new Error("REVIEW_PAGES_LATENCY_JOB and stage are required");
    updateLatencyFile(filePath, { type: "stage", job, stage: argument, phase: command, timestamp: captureTimestamp() });
    return;
  }
  if (command === "mark") {
    if (!job || !argument) throw new Error("REVIEW_PAGES_LATENCY_JOB and milestone are required");
    updateLatencyFile(filePath, {
      type: "milestone",
      job,
      name: argument,
      timestamp: captureTimestamp(),
    });
    return;
  }
  if (command === "merge") {
    if (!argument) throw new Error("latency source file is required");
    const target = readJson(filePath);
    const source = readJson(argument);
    mergeLatencyEvidence(target, source);
    writeLatencyFile(filePath, target);
    return;
  }
  if (command === "summary") {
    process.stdout.write(renderLatencySummary(readJson(filePath)));
    return;
  }
  throw new Error(
    "usage: latency.mjs bootstrap|init|start <stage>|complete <stage>|mark <milestone>|merge <file>|summary",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
