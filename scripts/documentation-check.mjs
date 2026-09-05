#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDocsRoot = path.join(repositoryRoot, "docs");
const allowedTopLevelDirectories = new Set([
  "architecture",
  "contracts",
  "decisions",
  "design",
  "governance",
  "history",
  "operations",
  "reports",
  "testing",
]);
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

function validateDocumentationTree({ docsRoot = defaultDocsRoot, root = repositoryRoot } = {}) {
  const errors = [];
  if (!fs.existsSync(docsRoot) || !fs.statSync(docsRoot).isDirectory()) {
    return [`documentation root is missing: ${normalize(path.relative(root, docsRoot))}`];
  }

  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!allowedTopLevelDirectories.has(entry.name)) {
        errors.push(`unclassified top-level documentation directory: docs/${entry.name}`);
      }
      continue;
    }
    if (entry.name !== "README.md") {
      errors.push(`ordinary files are not allowed directly under docs/: docs/${entry.name}`);
    }
  }
  if (!fs.existsSync(path.join(docsRoot, "README.md"))) errors.push("docs/README.md is required");

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

export { allowedTopLevelDirectories, validateDocumentationTree };
