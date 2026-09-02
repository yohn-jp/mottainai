import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_MAX_ATTEMPTS = 5;

// Copies one revision's generated files into the shared Pages tree at
// reviews/pr/<number>/<headSha>/ and refreshes that PR's own
// reviews/pr/<number>/index.json pointer. This never touches any other
// PR's directory, which is what makes concurrent publication safe at the
// filesystem level: two PRs only ever write disjoint subtrees.
export function mergeRevisionIntoSite(siteDir, prNumber, revisionSourceDir, prIndexSourceFile) {
  const headSha = path.basename(revisionSourceDir);
  const prDir = path.join(siteDir, "reviews", "pr", String(prNumber));
  const revisionTargetDir = path.join(prDir, headSha);
  fs.mkdirSync(prDir, { recursive: true });
  fs.cpSync(revisionSourceDir, revisionTargetDir, { recursive: true });
  fs.copyFileSync(prIndexSourceFile, path.join(prDir, "index.json"));
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
  git(
    [
      "-c",
      "user.name=review-pages",
      "-c",
      "user.email=review-pages@users.noreply.github.com",
      "commit",
      "-m",
      "chore(review-pages): initialize Pages branch",
    ],
    workDir,
  );
}

export function refreshWorkingTreeFromRemote(workDir, branch) {
  git(["fetch", "origin", branch], workDir);
  git(["reset", "--hard", `origin/${branch}`], workDir);
  git(["clean", "-fd"], workDir);
}

// Publishes a generated revision to the Pages branch with optimistic
// concurrency: on a non-fast-forward push rejection (another PR's
// publish landed first), re-fetch, re-apply this PR's own merge on top
// of the new tip, and retry. Because mergeRevisionIntoSite only ever
// writes this PR's own subtree, replaying it after a rebase can never
// erase another PR's directory.
export function publishGeneratedRevision({
  remoteUrl,
  branch,
  prNumber,
  revisionDir,
  prIndexFile,
  workDir,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const headSha = path.basename(revisionDir);
  const commitMessage = `chore(review-pages): publish PR #${prNumber} @ ${headSha}`;

  prepareWorkingTree(workDir, remoteUrl, branch);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) refreshWorkingTreeFromRemote(workDir, branch);

    mergeRevisionIntoSite(workDir, prNumber, revisionDir, prIndexFile);

    git(["add", "-A"], workDir);
    const status = git(["status", "--porcelain"], workDir);
    if (status.trim().length === 0) return { pushed: false, attempts: attempt };

    git(
      [
        "-c",
        "user.name=review-pages",
        "-c",
        "user.email=review-pages@users.noreply.github.com",
        "commit",
        "-m",
        commitMessage,
      ],
      workDir,
    );

    try {
      git(["push", "origin", `HEAD:${branch}`], workDir);
      return { pushed: true, attempts: attempt };
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`failed to publish PR #${prNumber} after ${maxAttempts} attempts: ${error.message}`);
      }
    }
  }

  throw new Error(`failed to publish PR #${prNumber}: exhausted retries`);
}

async function main() {
  const environment = process.env;
  const remoteUrl = environment.REVIEW_PAGES_REMOTE_URL;
  const branch = environment.REVIEW_PAGES_BRANCH ?? "gh-pages";
  const prNumber = environment.REVIEW_PAGES_PR_NUMBER;
  const outputDir = environment.REVIEW_PAGES_OUTPUT_DIR;
  const workDir = environment.REVIEW_PAGES_WORK_DIR;
  if (!remoteUrl || !prNumber || !outputDir || !workDir) {
    throw new Error(
      "REVIEW_PAGES_REMOTE_URL, REVIEW_PAGES_PR_NUMBER, REVIEW_PAGES_OUTPUT_DIR, REVIEW_PAGES_WORK_DIR are required",
    );
  }

  const prIndexFile = path.join(outputDir, "pr-index.json");
  const prIndex = JSON.parse(fs.readFileSync(prIndexFile, "utf8"));
  const revisionDir = path.join(outputDir, prIndex.latest.headSha);

  const result = publishGeneratedRevision({
    remoteUrl,
    branch,
    prNumber: Number(prNumber),
    revisionDir,
    prIndexFile,
    workDir,
  });

  console.log(
    result.pushed
      ? `published PR #${prNumber} @ ${prIndex.latest.shortId} after ${result.attempts} attempt(s)`
      : `PR #${prNumber} @ ${prIndex.latest.shortId} already published; no changes`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("publish-to-pages.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
