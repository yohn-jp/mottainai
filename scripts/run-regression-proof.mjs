#!/usr/bin/env node
import { executeRegressionProof, finish, parseArgs, readJson } from "./governance-lib.mjs";

const args = parseArgs(process.argv);
if (!args["plan-file"]) throw new Error("--plan-file is required");
if (!args["base-root"] || !args["head-root"]) throw new Error("--base-root and --head-root are required");

const plan = readJson(args["plan-file"]);
const warnings = [];
const proof = executeRegressionProof({
  plan,
  baseRoot: args["base-root"],
  headRoot: args["head-root"],
});
if (proof.status === "failed" || proof.status === "rejected") {
  warnings.push(
    `quality.regression.execution: changed path(s)=${proof.testPath ?? "none"}; matched path class/rule=regression-proof; missing evidence=${proof.status}; how to satisfy=${proof.output ?? proof.reason}`,
  );
}
finish([], args.report, warnings);
