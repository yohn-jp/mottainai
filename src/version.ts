import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reads the published package version from the package.json shipped alongside dist/. */
export function readPackageVersion(): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json has no version field: ${packageJsonPath}`);
  }
  return parsed.version;
}
