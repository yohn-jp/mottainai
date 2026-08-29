import path from "node:path";
import process from "node:process";

export const SCHEMA_VERSION = 2;
export const VERSION = "9.2.2";
export const BUILD_ID = `qemu-${VERSION}-mottainai-runtime-v1`;
export const LICENSE = "GPL-2.0-or-later";
export const RELEASE_ORIGIN = "https://github.com/yohn-jp/mottainai/releases/download/";

export function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

export function repeatedOption(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.push(value);
  }
  return values;
}

export function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const slashPath = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  return (
    normalized === slashPath &&
    !path.posix.isAbsolute(normalized) &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}
