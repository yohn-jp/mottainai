import { resolve } from "node:path";
import {
  evaluateSemanticEnforcement,
  parseSemanticEnforcementMode,
  configuredSemanticEnforcementMode,
  type SemanticEnforcementMode,
} from "../src/semantics/enforcement/index.js";
import type { LogicalId } from "../src/semantics/ir/ids.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function csv(name: string): string[] | undefined {
  const raw = value(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const modeValue = value("--mode");
const mode: SemanticEnforcementMode =
  modeValue === undefined ? configuredSemanticEnforcementMode(process.env) : parseSemanticEnforcementMode(modeValue);
const report = await evaluateSemanticEnforcement({
  rootDir: resolve(process.cwd()),
  mode,
  managedPaths: csv("--managed-paths"),
  managedSymbolIds: (csv("--managed-symbols") ?? csv("--managed-symbol-ids")) as LogicalId[] | undefined,
  commentZero: value("--comment-zero") !== "false",
});

console.log(
  JSON.stringify(
    {
      apiVersion: report.apiVersion,
      mode: report.mode,
      decision: report.decision,
      authoritative: report.authoritative,
      managed: report.managed,
      integrity: report.integrity,
      ownership: report.ownership,
      comments: report.comments,
      transaction: report.transaction,
      review: report.review,
      verification: report.verification,
      effects: report.effects,
      blockers: report.blockers,
      warnings: report.warnings,
      query: report.query,
      provenance: report.provenance,
    },
    null,
    2,
  ),
);

process.exitCode = report.mode === "enforce" && report.decision === "block" ? 1 : 0;
