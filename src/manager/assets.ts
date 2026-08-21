import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER_FILENAMES = ["index.html", "mottainai.html", "wabachi.html", "styles.css"] as const;
type ManagerAssetName = (typeof MANAGER_FILENAMES)[number];

export interface ManagerStaticAsset {
  body: string;
  contentType: "text/html; charset=utf-8" | "text/css; charset=utf-8";
}

function managerAssetPath(name: ManagerAssetName, moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDirectory, name),
    path.join(moduleDirectory, "../dashboard", name),
    path.resolve(moduleDirectory, "../../docs/mockups", name),
  ];
  const candidate = candidates.find((filePath) => fs.existsSync(filePath));
  if (candidate === undefined) throw new Error(`Manager viewer asset is missing: ${name}`);
  return candidate;
}

export function readManagerViewer(moduleUrl: string = import.meta.url): string {
  return fs.readFileSync(managerAssetPath("mottainai.html", moduleUrl), "utf8");
}

export function readManagerAssets(moduleUrl: string = import.meta.url): Readonly<Record<string, ManagerStaticAsset>> {
  const read = (name: ManagerAssetName): ManagerStaticAsset => ({
    body: fs.readFileSync(managerAssetPath(name, moduleUrl), "utf8"),
    contentType: name === "styles.css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8",
  });
  return {
    "/styles.css": read("styles.css"),
    "/mockups/styles.css": read("styles.css"),
    "/mockups/index.html": read("index.html"),
    "/mockups/mottainai.html": read("mottainai.html"),
    "/mockups/wabachi.html": read("wabachi.html"),
  };
}
