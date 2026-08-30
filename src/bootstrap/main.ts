#!/usr/bin/env node
import process from "node:process";
import { runBootstrapCli } from "./cli.js";

/**
 * The actual packaged executable entrypoint (nix/bootstrap.nix wraps this
 * compiled file directly as `bin/mottainai-bootstrap`). Distinct from
 * scripts/bootstrap.mjs, which is the dev/CI entrypoint that runs this same
 * dispatcher via `node --import tsx` against uncompiled TypeScript — this
 * file is the compiled, dependency-minimal equivalent nix/bootstrap.nix
 * ships instead.
 */
process.exitCode = await runBootstrapCli(process.argv.slice(2));
