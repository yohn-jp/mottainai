import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveStateDbPath, resolveStateDir, STATE_DB_FILE_NAME } from "./paths.js";

test("resolveStateDir: MOTTAINAI_STATE_DIR override wins on supported platforms", () => {
  const env = { MOTTAINAI_STATE_DIR: "/custom/state/dir" };
  assert.equal(resolveStateDir(env, "linux"), path.resolve("/custom/state/dir"));
  assert.equal(resolveStateDir(env, "darwin"), path.resolve("/custom/state/dir"));
});

test("resolveStateDir: linux uses XDG_STATE_HOME when set", () => {
  const env = { HOME: "/home/user", XDG_STATE_HOME: "/home/user/.state" };
  assert.equal(resolveStateDir(env, "linux"), path.join("/home/user/.state", "mottainai"));
});

test("resolveStateDir: linux falls back to ~/.local/state without XDG_STATE_HOME", () => {
  const env = { HOME: "/home/user" };
  assert.equal(resolveStateDir(env, "linux"), path.join("/home/user", ".local", "state", "mottainai"));
});

test("resolveStateDir: linux ignores a relative XDG_STATE_HOME", () => {
  const env = { HOME: "/home/user", XDG_STATE_HOME: "relative/state" };
  assert.equal(resolveStateDir(env, "linux"), path.join("/home/user", ".local", "state", "mottainai"));
});

test("resolveStateDir: macOS uses Application Support", () => {
  const env = { HOME: "/Users/user" };
  assert.equal(resolveStateDir(env, "darwin"), path.join("/Users/user", "Library", "Application Support", "mottainai"));
});

test("resolveStateDir: never resolves inside cwd/node_modules/tmp by default", () => {
  const env = { HOME: "/home/user" };
  const resolved = resolveStateDir(env, "linux");
  assert.ok(!resolved.includes("node_modules"));
  assert.ok(!resolved.startsWith("/tmp"));
  assert.ok(!resolved.startsWith(process.cwd()));
});

test("resolveStateDbPath: appends state db file name", () => {
  const env = { MOTTAINAI_STATE_DIR: "/custom/state/dir" };
  assert.equal(resolveStateDbPath(env, "linux"), path.join(path.resolve("/custom/state/dir"), STATE_DB_FILE_NAME));
});
