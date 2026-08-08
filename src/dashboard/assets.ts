import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_FILENAME = "semantic-project-viewer-v2.html";

export function readDashboardViewer(moduleUrl: string = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDirectory, VIEWER_FILENAME),
    path.resolve(moduleDirectory, "../../docs/mockups", VIEWER_FILENAME),
  ];
  const candidate = candidates.find((filePath) => fs.existsSync(filePath));
  if (candidate === undefined) throw new Error("dashboard viewer asset is missing");
  return fs.readFileSync(candidate, "utf8");
}
