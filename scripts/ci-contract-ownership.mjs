// Parses the `runtime-contract-changes` job's dorny/paths-filter block out
// of .github/workflows/ci.yml and re-implements its glob semantics so the
// contract-ownership selection defined in docs/architecture/ci/topology.md can be
// exercised against representative path fixtures without running GitHub
// Actions (Issue #766).

import fs from "node:fs";

const CI_WORKFLOW_RELATIVE_PATH = ".github/workflows/ci.yml";
const FILTERS_STEP_NAME_LINE = "name: Filter contract-owned paths";
const GLOB_SPECIAL_CHARACTERS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

export function extractFiltersBlock(ciWorkflowText) {
  const lines = ciWorkflowText.split(/\r?\n/u);
  const stepIndex = lines.findIndex((line) => line.includes(FILTERS_STEP_NAME_LINE));
  if (stepIndex === -1) {
    throw new Error(`could not find step "${FILTERS_STEP_NAME_LINE}" in ${CI_WORKFLOW_RELATIVE_PATH}`);
  }

  const filtersLineIndex = lines.findIndex((line, index) => index > stepIndex && /^\s*filters:\s*\|\s*$/u.test(line));
  if (filtersLineIndex === -1) {
    throw new Error("could not find `filters: |` block after the paths-filter step");
  }

  const blockIndent = lines[filtersLineIndex].match(/^(\s*)filters:/u)[1].length;
  const blockLines = [];
  for (let index = filtersLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      blockLines.push(line);
      continue;
    }
    const indent = line.match(/^(\s*)/u)[1].length;
    if (indent <= blockIndent) break;
    blockLines.push(line);
  }

  return blockLines.join("\n");
}

export function parseFilterClasses(filtersBlockText) {
  const classes = {};
  let currentClass = null;

  for (const rawLine of filtersBlockText.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) continue;
    if (rawLine.trim().startsWith("#")) continue;

    const classMatch = rawLine.match(/^\s*([A-Za-z0-9_]+):\s*$/u);
    if (classMatch !== null) {
      currentClass = classMatch[1];
      classes[currentClass] = [];
      continue;
    }

    const itemMatch = rawLine.match(/^\s*-\s*'([^']*)'\s*$/u);
    if (itemMatch !== null) {
      if (currentClass === null) {
        throw new Error(`path pattern outside of a filter class: ${rawLine}`);
      }
      classes[currentClass].push(itemMatch[1]);
      continue;
    }

    throw new Error(`unrecognized filters line: ${rawLine}`);
  }

  return classes;
}

function globPatternToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    source += GLOB_SPECIAL_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  source += "$";
  return new RegExp(source, "u");
}

export function matchesPattern(pattern, filePath) {
  return globPatternToRegExp(pattern).test(filePath);
}

export function classifyChangedFiles(classes, changedFiles) {
  const selected = {};
  for (const className of Object.keys(classes)) {
    selected[className] = changedFiles.some((filePath) =>
      classes[className].some((pattern) => matchesPattern(pattern, filePath)),
    );
  }
  return selected;
}

export function loadContractOwnershipClasses(repositoryRoot) {
  const ciWorkflowText = fs.readFileSync(`${repositoryRoot}/${CI_WORKFLOW_RELATIVE_PATH}`, "utf8");
  return parseFilterClasses(extractFiltersBlock(ciWorkflowText));
}
