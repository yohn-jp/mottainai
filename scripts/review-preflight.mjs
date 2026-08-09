import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const DEFAULT_MODEL = "moonshotai/Kimi-K3";

export const DEFAULT_REVIEW_BUDGET = Object.freeze({
  totalContextTokens: 32_768,
  reservedOutputTokens: 8_192,
  safetyMarginTokens: 2_048,
});

const GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const CONTEXT_SECTION_OVERHEAD_TOKENS = 32;
const DEFAULT_REPO_CONTEXT_MAX_LINES = 240;

const KNOWN_MODEL_PROFILES = new Map([["moonshotai/kimi-k3", DEFAULT_REVIEW_BUDGET]]);

function normalizeModel(model) {
  return String(model)
    .trim()
    .toLowerCase()
    .replace(/^openai\//u, "");
}

function parseBoolean(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

export function parseTokenCount(value, fieldName, { allowZero = false } = {}) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/u.test(text)) {
    throw new Error(`${fieldName} must be a decimal integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed < 1)) {
    throw new Error(`${fieldName} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return parsed;
}

export function calculateMaximumInputTokens({ totalContextTokens, reservedOutputTokens, safetyMarginTokens }) {
  const total = parseTokenCount(totalContextTokens, "totalContextTokens");
  const output = parseTokenCount(reservedOutputTokens, "reservedOutputTokens");
  const margin = parseTokenCount(safetyMarginTokens, "safetyMarginTokens", { allowZero: true });
  const maximumInputTokens = total - output - margin;
  if (maximumInputTokens < 1) {
    throw new Error("reservedOutputTokens + safetyMarginTokens must be less than totalContextTokens");
  }
  return maximumInputTokens;
}

export function resolveBudgetConfig({
  model = DEFAULT_MODEL,
  totalContextTokens = DEFAULT_REVIEW_BUDGET.totalContextTokens,
  reservedOutputTokens = DEFAULT_REVIEW_BUDGET.reservedOutputTokens,
  safetyMarginTokens = DEFAULT_REVIEW_BUDGET.safetyMarginTokens,
  allowUnknownModel = false,
} = {}) {
  const selectedModel = String(model).trim();
  if (selectedModel.length === 0) throw new Error("model must not be empty");

  const profile = KNOWN_MODEL_PROFILES.get(normalizeModel(selectedModel));
  if (profile === undefined && !allowUnknownModel) {
    throw new Error(`no defensible context profile is configured for model ${selectedModel}`);
  }

  const budget = {
    totalContextTokens: parseTokenCount(totalContextTokens, "totalContextTokens"),
    reservedOutputTokens: parseTokenCount(reservedOutputTokens, "reservedOutputTokens"),
    safetyMarginTokens: parseTokenCount(safetyMarginTokens, "safetyMarginTokens", { allowZero: true }),
  };
  return Object.freeze({
    model: selectedModel,
    ...budget,
    maximumInputTokens: calculateMaximumInputTokens(budget),
    profile: profile === undefined ? "explicit" : "known",
  });
}

export function readBudgetFromEnvironment(environment = process.env) {
  return resolveBudgetConfig({
    model: environment.REVIEW_MODEL || DEFAULT_MODEL,
    totalContextTokens: environment.REVIEW_CONTEXT_TOKENS || DEFAULT_REVIEW_BUDGET.totalContextTokens,
    reservedOutputTokens: environment.REVIEW_OUTPUT_RESERVE_TOKENS || DEFAULT_REVIEW_BUDGET.reservedOutputTokens,
    safetyMarginTokens: environment.REVIEW_SAFETY_MARGIN_TOKENS || DEFAULT_REVIEW_BUDGET.safetyMarginTokens,
    allowUnknownModel: parseBoolean(environment.REVIEW_BUDGET_EXPLICIT),
  });
}

export function estimateUpperBoundTokens(value) {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(String(value), "utf8");
}

export function estimateReviewInput(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .reduce((total, part) => total + estimateUpperBoundTokens(part) + CONTEXT_SECTION_OVERHEAD_TOKENS, 0);
}

export function evaluateReviewBudget({ maximumInputTokens, estimatedInputTokens }) {
  if (estimatedInputTokens <= maximumInputTokens) {
    return Object.freeze({
      ok: true,
      status: "ready",
      reason: "input is within the effective budget",
    });
  }
  return Object.freeze({
    ok: false,
    status: "review_not_generated",
    reason: `estimated input (${estimatedInputTokens}) exceeds effective input budget (${maximumInputTokens})`,
  });
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOBUFS" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("git review input exceeds the preflight collection limit");
    }
    throw new Error(`unable to collect review input from git (${error?.code ?? "unknown error"})`);
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function changedPaths(baseSha, headSha) {
  return runGit(["diff", "--name-only", "--diff-filter=ACMR", baseSha, headSha, "--"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function applicableInstruction(instructionPath, filePath) {
  const directory = instructionPath.includes("/") ? instructionPath.slice(0, instructionPath.lastIndexOf("/")) : "";
  return directory === "" || filePath === directory || filePath.startsWith(`${directory}/`);
}

function collectRepositoryInstructions(baseSha, files, maxLines) {
  const paths = runGit(["ls-tree", "-r", "--name-only", baseSha])
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value === "AGENTS.md" || value.endsWith("/AGENTS.md"));
  const sections = [];
  let linesRemaining = maxLines;
  for (const instructionPath of paths) {
    if (files.length > 0 && !files.some((filePath) => applicableInstruction(instructionPath, filePath))) continue;
    if (linesRemaining <= 0) break;
    const content = runGit(["show", `${baseSha}:${instructionPath}`]);
    const lines = content.split("\n").slice(0, linesRemaining);
    linesRemaining -= lines.length;
    sections.push(`## ${instructionPath}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

function collectEventMetadata(environment) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) return "";
  const event = readJsonFile(eventPath);
  if (!event) return "";
  const pullRequest = event.pull_request;
  if (!pullRequest) return "";
  return [`title: ${pullRequest.title ?? ""}`, `body:\n${pullRequest.body ?? ""}`].join("\n");
}

async function fetchPullRequestMetadata(environment) {
  const token = environment.GITHUB_TOKEN;
  const repository = environment.GITHUB_REPOSITORY;
  const number = environment.REVIEW_PR_NUMBER;
  if (!token || !repository || !number) return undefined;

  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`unable to fetch pull request metadata (HTTP ${response.status})`);
  const pullRequest = await response.json();
  return [`title: ${pullRequest.title ?? ""}`, `body:\n${pullRequest.body ?? ""}`].join("\n");
}

async function collectInputParts(environment) {
  const parts = [];
  const inputFile = environment.REVIEW_INPUT_FILE;
  if (inputFile) {
    parts.push(fs.readFileSync(inputFile, "utf8"));
  } else if (environment.REVIEW_INPUT_TEXT) {
    parts.push(environment.REVIEW_INPUT_TEXT);
  } else if (environment.REVIEW_BASE_SHA && environment.REVIEW_HEAD_SHA) {
    parts.push(
      runGit(["diff", "--no-ext-diff", "--unified=3", environment.REVIEW_BASE_SHA, environment.REVIEW_HEAD_SHA, "--"]),
    );
  }

  if (environment.REVIEW_BASE_SHA && environment.REVIEW_HEAD_SHA) {
    const files = changedPaths(environment.REVIEW_BASE_SHA, environment.REVIEW_HEAD_SHA);
    const instructions = collectRepositoryInstructions(
      environment.REVIEW_BASE_SHA,
      files,
      parseTokenCount(
        environment.REVIEW_REPO_CONTEXT_MAX_LINES || DEFAULT_REPO_CONTEXT_MAX_LINES,
        "repoContextMaxLines",
      ),
    );
    if (instructions) parts.push(instructions);
  }

  const metadata = await fetchPullRequestMetadata(environment);
  parts.push(metadata ?? collectEventMetadata(environment));
  return parts.filter((part) => String(part).length > 0);
}

export function normalizePrAgentManualEvent(event) {
  if (event?.comment?.body?.trim() !== "/qodo-review") return event;
  return {
    ...event,
    comment: {
      ...event.comment,
      body: "/review",
    },
  };
}

function normalizePrAgentEventFile(environment) {
  if (!parseBoolean(environment.REVIEW_NORMALIZE_PR_AGENT_COMMAND)) return;
  if (environment.GITHUB_EVENT_NAME !== "issue_comment" || !environment.GITHUB_EVENT_PATH) return;
  const event = readJsonFile(environment.GITHUB_EVENT_PATH);
  const normalized = normalizePrAgentManualEvent(event);
  if (normalized === event) return;
  fs.writeFileSync(environment.GITHUB_EVENT_PATH, `${JSON.stringify(normalized)}\n`);
}

function writeOutput(environment, result) {
  if (!environment.GITHUB_OUTPUT) return;
  const lines = Object.entries({
    status: result.status,
    model: result.budget?.model ?? "unavailable",
    total_context_tokens: result.budget?.totalContextTokens ?? "unavailable",
    reserved_output_tokens: result.budget?.reservedOutputTokens ?? "unavailable",
    safety_margin_tokens: result.budget?.safetyMarginTokens ?? "unavailable",
    maximum_input_tokens: result.budget?.maximumInputTokens ?? "unavailable",
    estimated_input_tokens: result.estimatedInputTokens ?? "unavailable",
    chunked: "false",
  }).map(([key, value]) => `${key}=${String(value)}`);
  fs.appendFileSync(environment.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function writeSummary(environment, result) {
  if (!environment.GITHUB_STEP_SUMMARY) return;
  const reviewer = environment.REVIEWER || "LLM reviewer";
  const budget = result.budget;
  const lines = [
    `### ${reviewer} preflight`,
    `- Status: ${result.status}`,
    `- Model: ${budget?.model ?? "unavailable"}`,
    `- Total context: ${budget?.totalContextTokens ?? "unavailable"} tokens`,
    `- Reserved output: ${budget?.reservedOutputTokens ?? "unavailable"} tokens`,
    `- Safety margin: ${budget?.safetyMarginTokens ?? "unavailable"} tokens`,
    `- Effective maximum input: ${budget?.maximumInputTokens ?? "unavailable"} tokens`,
    `- Estimated input: ${result.estimatedInputTokens ?? "unavailable"} tokens`,
    "- Chunking: unavailable for the pinned upstream action; oversized requests fail closed",
    `- Reason: ${result.reason}`,
  ];
  fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

export async function runPreflight(environment = process.env) {
  let budget;
  try {
    budget = readBudgetFromEnvironment(environment);
    const parts = await collectInputParts(environment);
    if (parts.length === 0) throw new Error("no review input was collected; refusing to invoke the model");
    const estimatedInputTokens = estimateReviewInput(parts);
    const decision = evaluateReviewBudget({
      maximumInputTokens: budget.maximumInputTokens,
      estimatedInputTokens,
    });
    return Object.freeze({ ...decision, budget, estimatedInputTokens });
  } catch (error) {
    return Object.freeze({
      ok: false,
      status: "review_not_generated",
      reason: error instanceof Error ? error.message : "review preflight failed",
      budget,
    });
  }
}

async function main() {
  const result = await runPreflight();
  writeOutput(process.env, result);
  writeSummary(process.env, result);
  if (!result.ok) {
    console.error(`review preflight failed: ${result.reason}`);
    return 1;
  }
  normalizePrAgentEventFile(process.env);
  console.log(
    `review preflight ready: ${result.estimatedInputTokens}/${result.budget.maximumInputTokens} input tokens`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("review-preflight.mjs")) {
  process.exitCode = await main();
}
