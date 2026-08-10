import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createLogicalId, type LogicalId } from "../ir/ids.js";
import { digestCanonicalValue } from "../ir/canonical.js";
import type { CanonicalProsePolicy } from "../ir/types.js";
import type { SemanticCommentFinding, SemanticCommentReport } from "./types.js";

export interface SemanticDebtProposal {
  id: LogicalId;
  path: string;
  line: number;
  subject?: LogicalId;
  statement: string;
  status: "open";
  priority: "medium";
  readyForMutation: false;
}

const TODO_PATTERN = /\b(?:TODO|FIXME|TBD)\b/iu;
const ALLOWED_DIRECTIVE =
  /^(?:#!|\/\/\s*(?:eslint|biome|prettier|istanbul|c8|coverage|webpack|vite|rollup)|\/\*\s*(?:eslint|istanbul|c8|coverage|webpack|vite|rollup)|<reference\b|[#@](?:ts-|type|jsx|sourceMappingURL)|(?:@license|@copyright|@generated|copyright\b|generated\b|sourceMappingURL\b))/iu;

function normalizedPath(rootDir: string, value: string): string {
  return relative(resolve(rootDir), resolve(rootDir, value)).split("\\").join("/");
}

function commentBody(text: string): string {
  return text
    .replace(/^\/\//u, "")
    .replace(/^\/\*/u, "")
    .replace(/\*\/$/u, "")
    .replace(/^\s*\*/gmu, "")
    .trim();
}

function isAllowed(text: string, policy: CanonicalProsePolicy): boolean {
  const body = commentBody(text);
  if (body.length === 0) return true;
  if (ALLOWED_DIRECTIVE.test(text) || ALLOWED_DIRECTIVE.test(body)) return true;
  return policy.inlineDirectives.some((directive) => body.toLowerCase().startsWith(directive.toLowerCase()));
}

function findingFor(
  text: string,
  path: string,
  line: number,
  column: number,
  policy: CanonicalProsePolicy,
): SemanticCommentFinding {
  if (isAllowed(text, policy)) {
    return { path, line, column, kind: "allowed", text, reason: "allowlisted machine/compiler/legal directive" };
  }
  if (TODO_PATTERN.test(text)) {
    return {
      path,
      line,
      column,
      kind: "todo-debt-intent",
      text,
      reason: "TODO/FIXME/TBD meaning must be represented as structured semantic debt before comment removal",
    };
  }
  if (/^\/\*\*/u.test(text)) {
    return {
      path,
      line,
      column,
      kind: "jsdoc",
      text,
      reason: "hand-authored JSDoc is not canonical for managed Symbols",
    };
  }
  return {
    path,
    line,
    column,
    kind: "human",
    text,
    reason: "human semantic comments are forbidden in fully managed source",
  };
}

/** Scan only the explicitly managed source paths; no repository-wide comment reconnaissance is performed. */
export function inspectManagedComments(options: {
  rootDir: string;
  paths: readonly string[];
  policy: CanonicalProsePolicy;
}): SemanticCommentReport {
  const findings: SemanticCommentFinding[] = [];
  const requestedPaths = [...new Set(options.paths)].sort();
  const paths: string[] = [];
  const collect = (rawPath: string): void => {
    const path = normalizedPath(options.rootDir, rawPath);
    try {
      if (statSync(resolve(options.rootDir, path)).isDirectory()) {
        for (const entry of readdirSync(resolve(options.rootDir, path), { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          collect(`${path}/${entry.name}`);
        }
        return;
      }
    } catch {
      // The normal per-file diagnostic below provides the bounded missing-path finding.
    }
    paths.push(rawPath);
  };
  requestedPaths.forEach(collect);
  for (const rawPath of paths) {
    const path = normalizedPath(options.rootDir, rawPath);
    if (path === "" || path.startsWith("..")) {
      findings.push({
        path: rawPath,
        line: 1,
        column: 1,
        kind: "human",
        text: rawPath,
        reason: "managed source path escapes repository root",
      });
      continue;
    }
    let source: string;
    try {
      source = readFileSync(resolve(options.rootDir, path), "utf8");
    } catch {
      findings.push({
        path,
        line: 1,
        column: 1,
        kind: "human",
        text: path,
        reason: "managed source file is unavailable",
      });
      continue;
    }
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
        const start = scanner.getTokenPos();
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        findings.push(
          findingFor(scanner.getTokenText(), path, position.line + 1, position.character + 1, options.policy),
        );
      }
      token = scanner.scan();
    }
  }
  const ordered = findings.sort((left, right) =>
    `${left.path}:${left.line}:${left.column}:${left.text}`.localeCompare(
      `${right.path}:${right.line}:${right.column}:${right.text}`,
    ),
  );
  return {
    managedPaths: requestedPaths,
    findings: ordered,
    humanCommentCount: ordered.filter((item) => item.kind === "human").length,
    todoDebtCount: ordered.filter((item) => item.kind === "todo-debt-intent").length,
    jsdocCount: ordered.filter((item) => item.kind === "jsdoc").length,
    allowedCount: ordered.filter((item) => item.kind === "allowed").length,
  };
}

/** Convert TODO-like findings into explicit, reviewable debt proposals without mutating source. */
export function proposeSemanticDebt(
  report: SemanticCommentReport,
  subjectsByPath: Readonly<Record<string, LogicalId>> = {},
): SemanticDebtProposal[] {
  return report.findings
    .filter((finding) => finding.kind === "todo-debt-intent")
    .map((finding) => ({
      id: createLogicalId(
        "debt",
        digestCanonicalValue(`${finding.path}:${finding.line}:${finding.text}`).value.slice(0, 48),
      ),
      path: finding.path,
      line: finding.line,
      ...(subjectsByPath[finding.path] === undefined ? {} : { subject: subjectsByPath[finding.path] }),
      statement: `Represent the semantic debt identified by the managed comment at ${finding.path}:${finding.line}.`,
      status: "open" as const,
      priority: "medium" as const,
      readyForMutation: false as const,
    }));
}
