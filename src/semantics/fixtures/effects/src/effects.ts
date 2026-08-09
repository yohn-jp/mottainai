import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import runtimeProcess from "node:process";
import { add as gitAdd, status as gitStatus } from "simple-git";
import { query } from "pg";
import { mystery } from "mystery-effects";
import { readFileSync as localReadFileSync } from "./local-helper.js";
import { DatabaseSync } from "node:sqlite";

export function primitiveEffects(path: string): Promise<unknown> {
  readFileSync(path, "utf8");
  writeFileSync(path, "updated");
  request({ host: "example.test" });
  spawn("node", ["--version"]);
  runtimeProcess["env"].MOTTAINAI_EFFECT;
  runtimeProcess["env"].MOTTAINAI_EFFECT = "enabled";
  runtimeProcess.cwd();
  Date.now();
  new Date();
  Math.random();
  randomUUID();
  performance.now();
  gitStatus();
  gitAdd(path);
  query("select 1");
  console["log"](path);
  return fetch("https://example.test");
}

export function readThroughHelper(path: string): string {
  return readFileSync(path, "utf8");
}

export function localAlias(path: string): string {
  return localReadFileSync(path);
}

export function transitiveEntry(path: string): string {
  return readThroughHelper(path);
}

export function recursiveA(): void {
  recursiveB();
}

export function recursiveB(): void {
  recursiveA();
  readFileSync("recursive-input", "utf8");
}

export function sameNameLocalApi(path: string): string {
  function readFile(value: string): string {
    return value;
  }
  return readFile(path);
}

export function sameNameRequire(path: string): string {
  function require(_moduleName: string): { readFileSync(value: string): string } {
    return { readFileSync: (value) => value };
  }
  return require("node:fs").readFileSync(path);
}

export function dynamicCall(target: Record<string, () => unknown>, method: string): unknown {
  return target[method]?.();
}

export function dynamicImport(moduleName: string): Promise<unknown> {
  return import(moduleName);
}

export function opaqueExternal(): unknown {
  return mystery();
}

export function databaseEffects(path: string): unknown {
  const database = new DatabaseSync(path);
  database.exec("create table if not exists effects (value text)");
  return database.prepare("select value from effects").get();
}
