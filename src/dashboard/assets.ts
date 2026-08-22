import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_FILENAME = "semantic-project-viewer-v3.html";
const STYLES_FILENAME = "styles.css";

export interface DashboardStaticAsset {
  body: string;
  contentType: "text/css; charset=utf-8";
}

function dashboardAssetPath(name: string, moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDirectory, name),
    path.resolve(moduleDirectory, "../../docs/mockups", name),
  ];
  const candidate = candidates.find((filePath) => fs.existsSync(filePath));
  if (candidate === undefined) throw new Error(`dashboard viewer asset is missing: ${name}`);
  return candidate;
}

export function readDashboardViewer(moduleUrl: string = import.meta.url): string {
  return fs.readFileSync(dashboardAssetPath(VIEWER_FILENAME, moduleUrl), "utf8");
}

export function readDashboardAssets(moduleUrl: string = import.meta.url): Readonly<Record<string, DashboardStaticAsset>> {
  return {
    "/styles.css": {
      body: fs.readFileSync(dashboardAssetPath(STYLES_FILENAME, moduleUrl), "utf8"),
      contentType: "text/css; charset=utf-8",
    },
  };
}
