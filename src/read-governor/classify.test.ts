import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFile } from "./classify.js";

test("classifies source extensions", () => {
  assert.equal(classifyFile("src/index.ts"), "source");
  assert.equal(classifyFile("apps/gateway/main.py"), "source");
  assert.equal(classifyFile("scripts/deploy.sh"), "source");
});

test("classifies document extensions", () => {
  assert.equal(classifyFile("docs/architecture.md"), "document");
  assert.equal(classifyFile("README.mdx"), "document");
});

test("classifies structured config extensions", () => {
  assert.equal(classifyFile("package.json"), "structured-config");
  assert.equal(classifyFile("config/values.yaml"), "structured-config");
  assert.equal(classifyFile("Cargo.toml"), "structured-config");
});

test("classifies log files", () => {
  assert.equal(classifyFile("var/log/app.log"), "log");
});

test("classifies known lockfiles regardless of extension", () => {
  assert.equal(classifyFile("pnpm-lock.yaml"), "lockfile");
  assert.equal(classifyFile("package-lock.json"), "lockfile");
  assert.equal(classifyFile("Cargo.lock"), "lockfile");
});

test("classifies generated/vendor paths by directory segment", () => {
  assert.equal(classifyFile("node_modules/foo/index.js"), "generated");
  assert.equal(classifyFile("apps/gateway/dist/index.js"), "generated");
  assert.equal(classifyFile("packages/domain/coverage/lcov.info"), "generated");
});

test("classifies generated files by suffix", () => {
  assert.equal(classifyFile("bundle.min.js"), "generated");
  assert.equal(classifyFile("app.js.map"), "generated");
  assert.equal(classifyFile("src/index.tsbuildinfo"), "generated");
});

test("classifies unrecognized extensions as unknown", () => {
  assert.equal(classifyFile("assets/logo.png"), "unknown");
  assert.equal(classifyFile("Makefile"), "unknown");
});
