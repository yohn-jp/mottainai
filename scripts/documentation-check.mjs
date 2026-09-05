#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDocsRoot = path.join(repositoryRoot, "docs");
const ignoredLinkDirectories = new Set([".git", "node_modules", "dist", "target"]);

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function collectFiles(root) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredLinkDirectories.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else files.push(fullPath);
    }
  }
  visit(root);
  return files.sort();
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/iu.test(target);
}

function stripNonRenderedMarkdown(source) {
  return source.replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");
}

function markdownTargets(source) {
  const rendered = stripNonRenderedMarkdown(source);
  const targets = [];
  const pattern = /!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/gu;
  for (const match of rendered.matchAll(pattern)) targets.push(match[1] ?? match[2]);
  return targets;
}

function htmlTargets(source) {
  const targets = [];
  const pattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu;
  for (const match of source.matchAll(pattern)) targets.push(match[1]);
  return targets;
}

function targetPath(target) {
  return target.split("#", 1)[0].split("?", 1)[0];
}

function readDocumentationPolicy({ docsRoot, root }) {
  const policyPath = path.join(docsRoot, "README.md");
  const relativePolicyPath = normalize(path.relative(root, policyPath));
  if (!fs.existsSync(policyPath)) {
    return {
      allowedTopLevelDirectories: new Set(),
      errors: [`documentation category policy is missing: ${relativePolicyPath}`],
    };
  }

  let source;
  try {
    if (!fs.statSync(policyPath).isFile()) {
      return {
        allowedTopLevelDirectories: new Set(),
        errors: [`documentation category policy is not a file: ${relativePolicyPath}`],
      };
    }
    source = fs.readFileSync(policyPath, "utf8");
  } catch {
    return {
      allowedTopLevelDirectories: new Set(),
      errors: [`documentation category policy cannot be read: ${relativePolicyPath}`],
    };
  }

  const headingMatch = /^## Categories\s*$/mu.exec(source);
  if (!headingMatch) {
    return {
      allowedTopLevelDirectories: new Set(),
      errors: [`documentation category policy is missing the Categories table: ${relativePolicyPath}`],
    };
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const remaining = source.slice(sectionStart);
  const nextHeadingIndex = remaining.search(/^##\s/mu);
  const section = nextHeadingIndex === -1 ? remaining : remaining.slice(0, nextHeadingIndex);
  const lines = section.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => /^\|\s*Category\s*\|/u.test(line));
  if (headerIndex === -1) {
    return {
      allowedTopLevelDirectories: new Set(),
      errors: [`documentation category policy is missing the Categories table: ${relativePolicyPath}`],
    };
  }

  const allowedTopLevelDirectories = new Set();
  const errors = [];
  let categoryRows = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || !line.startsWith("|")) break;
    if (/^\|\s*:?-{3,}/u.test(line)) continue;
    categoryRows += 1;
    const match = /^\|\s*\[`([^`]+)`\]\((?:<([^>\n]+)>|([^) \t\n]+))\)\s*\|/u.exec(line);
    const categoryLabel = match?.[1] ?? "";
    const category = categoryLabel.endsWith("/") ? categoryLabel.slice(0, -1) : "";
    const target = match?.[2] ?? match?.[3] ?? "";
    const relativeTarget = targetPath(target);
    const targetSegments = relativeTarget.endsWith("/")
      ? relativeTarget.slice(0, -1).split("/")
      : relativeTarget.split("/");
    const targetCategory = targetSegments[0];
    const resolvedTarget = relativeTarget ? path.resolve(docsRoot, relativeTarget) : "";
    const resolvedRelative = resolvedTarget ? path.relative(docsRoot, resolvedTarget) : "";
    const targetStaysInDocs =
      Boolean(resolvedRelative) &&
      resolvedRelative !== ".." &&
      !resolvedRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(resolvedRelative);
    const validCategory =
      Boolean(match) &&
      Boolean(category) &&
      !category.includes("/") &&
      !category.includes("\\") &&
      !isExternalTarget(target) &&
      targetCategory === category &&
      targetSegments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..") &&
      targetStaysInDocs;
    if (!validCategory) {
      errors.push(`documentation category policy has an invalid category row: ${relativePolicyPath}`);
      continue;
    }
    if (allowedTopLevelDirectories.has(category)) {
      errors.push(`documentation category policy has a duplicate category: ${relativePolicyPath}`);
      continue;
    }
    allowedTopLevelDirectories.add(category);
  }

  if (categoryRows === 0) {
    errors.push(`documentation category policy contains no categories: ${relativePolicyPath}`);
  }
  return { allowedTopLevelDirectories, errors };
}

function validateDocumentationTree({ docsRoot = defaultDocsRoot, root = repositoryRoot } = {}) {
  if (!fs.existsSync(docsRoot) || !fs.statSync(docsRoot).isDirectory()) {
    return [`documentation root is missing: ${normalize(path.relative(root, docsRoot))}`];
  }

  const policy = readDocumentationPolicy({ docsRoot, root });
  if (policy.errors.length > 0) return policy.errors;

  const errors = [];
  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!policy.allowedTopLevelDirectories.has(entry.name)) {
        errors.push(`unclassified top-level documentation directory: docs/${entry.name}`);
      }
      continue;
    }
    if (entry.name !== "README.md") {
      errors.push(`ordinary files are not allowed directly under docs/: docs/${entry.name}`);
    }
  }

  for (const file of collectFiles(root).filter((candidate) => {
    const relative = normalize(path.relative(root, candidate));
    return relative === "docs" || relative.startsWith("docs/") || !relative.includes("/");
  })) {
    const relativeFile = normalize(path.relative(root, file));
    const extension = path.extname(file).toLowerCase();
    if (extension !== ".md" && extension !== ".html") continue;
    const source = fs.readFileSync(file, "utf8");
    const targets = extension === ".md" ? markdownTargets(source) : htmlTargets(source);
    for (const target of targets) {
      if (isExternalTarget(target)) continue;
      const relativeTarget = targetPath(target);
      if (!relativeTarget) continue;
      const resolved = path.resolve(path.dirname(file), relativeTarget);
      if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
        errors.push(`${relativeFile} links outside the repository: ${target}`);
      } else if (!fs.existsSync(resolved)) {
        errors.push(`${relativeFile} links to a missing path: ${target}`);
      }
    }
  }
  return errors;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const errors = validateDocumentationTree();
  if (errors.length > 0) {
    for (const error of errors) console.error(`documentation: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("documentation: tree and internal links are valid");
  }
}

export { readDocumentationPolicy, validateDocumentationTree };
