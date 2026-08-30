#!/usr/bin/env node
// Dev/CI entrypoint for Issue #626's bootstrap CLI. Run via
// `node --import tsx scripts/bootstrap.mjs build --manifest ...` (matches
// scripts/build-managed-generation.mjs's own invocation style). Re-exports
// src/bootstrap/main.ts, the same entry Nix build (nix/bootstrap.nix)
// compiles and wraps as `bin/mottainai-bootstrap` — there is exactly one
// production entrypoint definition, this file just runs it uncompiled via
// tsx for local/CI use.
import "../src/bootstrap/main.ts";
