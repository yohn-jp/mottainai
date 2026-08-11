import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER_FILENAME = "manager-v0.html";

export function readManagerViewer(moduleUrl: string = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDirectory, MANAGER_FILENAME),
    path.join(moduleDirectory, "../dashboard", MANAGER_FILENAME),
    path.resolve(moduleDirectory, "../../docs/mockups", MANAGER_FILENAME),
  ];
  const candidate = candidates.find((filePath) => fs.existsSync(filePath));
  if (candidate === undefined) throw new Error("Manager viewer asset is missing");
  return fs.readFileSync(candidate, "utf8");
}
