import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER_FILENAMES = [
  "index.html",
  "mottainai.html",
  "wabachi.html",
  "styles.css",
  "vendor/xterm.js",
  "vendor/xterm.css",
  "vendor/addon-fit.js",
] as const;
type ManagerAssetName = (typeof MANAGER_FILENAMES)[number];

export interface ManagerStaticAsset {
  body: string;
  contentType: "text/html; charset=utf-8" | "text/css; charset=utf-8" | "text/javascript; charset=utf-8";
}

function contentTypeFor(name: ManagerAssetName): ManagerStaticAsset["contentType"] {
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function managerAssetPath(name: ManagerAssetName, moduleUrl: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDirectory, name),
    path.join(moduleDirectory, "../dashboard", name),
    path.resolve(moduleDirectory, "../../docs/design/mockups", name),
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
    contentType: contentTypeFor(name),
  });
  return {
    "/styles.css": read("styles.css"),
    "/mockups/styles.css": read("styles.css"),
    "/mockups/index.html": read("index.html"),
    "/mockups/mottainai.html": read("mottainai.html"),
    "/mockups/wabachi.html": read("wabachi.html"),
    "/mockups/vendor/xterm.js": read("vendor/xterm.js"),
    "/mockups/vendor/xterm.css": read("vendor/xterm.css"),
    "/mockups/vendor/addon-fit.js": read("vendor/addon-fit.js"),
  };
}
