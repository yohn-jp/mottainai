import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalStringify } from "./lib/canonical-json.mjs";
import { refreshNavigationPages } from "./navigation-pages.mjs";
import { buildExpectedManifestUrl, PAGES_SERVING_OUTCOMES, verifyPagesManifest } from "./verify-pages-serving.mjs";

const DEFAULT_MAX_ATTEMPTS = 5;

const DETERMINISTIC_RESOURCE_FILES = Object.freeze(["issue.json", "diff.json", "ocr.json", "index.html"]);

export class ImmutableRevisionConflictError extends Error {}

function canonicalManifestForComparison(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.volatile) delete manifest.volatile.generatedAt;
  return canonicalStringify(manifest);
}

function deterministicRevisionSignature(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const reviewResultFile = manifest.resources?.reviewResult;
  const resourceFiles = reviewResultFile
    ? [...DETERMINISTIC_RESOURCE_FILES, reviewResultFile]
    : DETERMINISTIC_RESOURCE_FILES;
  const parts = [canonicalManifestForComparison(path.join(dir, "manifest.json"))];
  for (const name of resourceFiles) parts.push(fs.readFileSync(path.join(dir, name), "utf8"));
  return parts.join(" ");
}

export function mergeRevisionIntoSite(siteDir, prNumber, revisionSourceDir, prIndexSourceFile) {
  const headSha = path.basename(revisionSourceDir);
  const prDir = path.join(siteDir, "reviews", "pr", String(prNumber));
  const revisionTargetDir = path.join(prDir, headSha);
  fs.mkdirSync(prDir, { recursive: true });

  if (fs.existsSync(revisionTargetDir)) {
    const existing = deterministicRevisionSignature(revisionTargetDir);
    const incoming = deterministicRevisionSignature(revisionSourceDir);
    if (existing !== incoming) {
      throw new ImmutableRevisionConflictError(
        `refusing to publish PR #${prNumber} @ ${headSha}: an immutable revision already exists with different deterministic content`,
      );
    }
    fs.copyFileSync(path.join(revisionSourceDir, "checks.json"), path.join(revisionTargetDir, "checks.json"));
  } else {
    fs.cpSync(revisionSourceDir, revisionTargetDir, { recursive: true });
  }

  fs.copyFileSync(prIndexSourceFile, path.join(prDir, "index.json"));
  const prIndex = JSON.parse(fs.readFileSync(prIndexSourceFile, "utf8"));
  refreshNavigationPages(siteDir, prNumber, prIndex);
  return revisionTargetDir;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function branchExistsOnRemote(remoteUrl, branch) {
  try {
    const output = git(["ls-remote", "--heads", remoteUrl, branch], process.cwd());
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function prepareWorkingTree(workDir, remoteUrl, branch) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  if (branchExistsOnRemote(remoteUrl, branch)) {
    git(["clone", "--branch", branch, "--single-branch", "--depth", "1", remoteUrl, "."], workDir);
    return;
  }
  git(["init", "--initial-branch", branch, "."], workDir);
  git(["remote", "add", "origin", remoteUrl], workDir);
  fs.writeFileSync(path.join(workDir, ".nojekyll"), "");
  git(["add", "-A"], workDir);
  git(["-c", "user.name=review-pages", "-c", "user.email=review-pages@users.noreply.github.com", "commit", "-m", "chore(review-pages): initialize Pages branch"], workDir);
}

export function refreshWorkingTreeFromRemote(workDir, branch) {
  git(["fetch", "origin", branch], workDir);
  git(["reset", "--hard", `origin/${branch}`], workDir);
  git(["clean", "-fd"], workDir);
}

export function publishGeneratedRevision({ remoteUrl, branch, prNumber, revisionDir, prIndexFile, workDir, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const headSha = path.basename(revisionDir);
  const commitMessage = `chore(review-pages): publish PR #${prNumber} @ ${headSha}`;
  prepareWorkingTree(workDir, remoteUrl, branch);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) refreshWorkingTreeFromRemote(workDir, branch);
    mergeRevisionIntoSite(workDir, prNumber, revisionDir, prIndexFile);
    git(["add", "-A"], workDir);
    const status = git(["status", "--porcelain"], workDir);
    if (status.trim().length === 0) return { pushed: false, attempts: attempt };

    git(["-c", "user.name=review-pages", "-c", "user.email=review-pages@users.noreply.github.com", "commit", "-m", commitMessage], workDir);
    try {
      git(["push", "origin", `HEAD:${branch}`], workDir);
      return { pushed: true, attempts: attempt };
    } catch (error) {
      if (attempt === maxAttempts) throw new Error(`failed to publish PR #${prNumber} after ${maxAttempts} attempts: ${error.message}`);
    }
  }
  throw new Error(`failed to publish PR #${prNumber}: exhausted retries`);
}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gu, "https://[redacted]@")
    .replace(/\s+/gu, " ")
    .slice(0, 1_000);
}

function repositoryFullNameFromEnvironment(environment) {
  const repository = environment.GITHUB_REPOSITORY?.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be set as owner/name to verify Pages serving");
  }
  return repository;
}

function resolvePagesBaseUrl(environment) {
  const configured = environment.REVIEW_PAGES_BASE_URL?.trim();
  if (configured) return configured;
  const [owner, name] = repositoryFullNameFromEnvironment(environment).split("/");
  return `https://${owner}.github.io/${name}`;
}

export function pagesServingExitCode(outcome) {
  return outcome === PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY ? 1 : 0;
}

async function main() {
  const environment = process.env;
  const remoteUrl = environment.REVIEW_PAGES_REMOTE_URL;
  const branch = environment.REVIEW_PAGES_BRANCH ?? "gh-pages";
  const prNumber = environment.REVIEW_PAGES_PR_NUMBER;
  const outputDir = environment.REVIEW_PAGES_OUTPUT_DIR;
  const workDir = environment.REVIEW_PAGES_WORK_DIR;
  if (!remoteUrl || !prNumber || !outputDir || !workDir) {
    throw new Error("REVIEW_PAGES_REMOTE_URL, REVIEW_PAGES_PR_NUMBER, REVIEW_PAGES_OUTPUT_DIR, REVIEW_PAGES_WORK_DIR are required");
  }

  const prIndexFile = path.join(outputDir, "pr-index.json");
  const prIndex = JSON.parse(fs.readFileSync(prIndexFile, "utf8"));
  const revisionDir = path.join(outputDir, prIndex.latest.headSha);

  let result;
  try {
    result = publishGeneratedRevision({ remoteUrl, branch, prNumber: Number(prNumber), revisionDir, prIndexFile, workDir });
  } catch (error) {
    console.error(`${PAGES_SERVING_OUTCOMES.PUSH_FAILURE}: ${safeErrorMessage(error)}`);
    return 1;
  }

  console.log(result.pushed
    ? `published PR #${prNumber} @ ${prIndex.latest.shortId} after ${result.attempts} attempt(s)`
    : `PR #${prNumber} @ ${prIndex.latest.shortId} already published; no changes`);

  let manifestUrl;
  let repositoryFullName;
  try {
    repositoryFullName = repositoryFullNameFromEnvironment(environment);
    manifestUrl = buildExpectedManifestUrl({ pagesBaseUrl: resolvePagesBaseUrl(environment), prNumber: Number(prNumber), headSha: prIndex.latest.headSha });
  } catch (error) {
    console.warn(`published-but-not-serving: cannot determine expected Pages manifest URL (${safeErrorMessage(error)}); publication itself succeeded`);
    return 0;
  }

  const verification = await verifyPagesManifest({ manifestUrl, repositoryFullName, prNumber: Number(prNumber), headSha: prIndex.latest.headSha });

  if (verification.outcome === PAGES_SERVING_OUTCOMES.SUCCESS) {
    console.log(`success: Pages serves the expected manifest at ${manifestUrl} after ${verification.attempts} attempt(s)`);
    return 0;
  }

  if (verification.outcome === PAGES_SERVING_OUTCOMES.SERVING_WRONG_IDENTITY) {
    console.error(`serving-wrong-identity: manifest at ${manifestUrl} does not match ${repositoryFullName} PR #${prNumber} @ ${prIndex.latest.headSha} (${verification.mismatches?.join(", ") ?? verification.reason ?? "invalid manifest"})`);
    return pagesServingExitCode(verification.outcome);
  }

  console.warn(
    `published-but-not-serving: expected manifest at ${manifestUrl} was not reachable after ${verification.attempts} attempt(s)` +
      `${verification.status === null ? ` (${verification.reason})` : ` (HTTP ${verification.status})`}; ` +
      "gh-pages publication succeeded, so Pages propagation remains best-effort and does not fail the PR",
  );
  return pagesServingExitCode(verification.outcome);
}

if (process.argv[1] && process.argv[1].endsWith("publish-to-pages.mjs")) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
