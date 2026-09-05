import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destinationDirectory = path.join(repositoryRoot, "dist", "dashboard");
const sharedAssets = [
  "index.html",
  "mottainai.html",
  "wabachi.html",
  "styles.css",
  "vendor/xterm.js",
  "vendor/xterm.css",
  "vendor/addon-fit.js",
];
const retiredViewerPattern = /^semantic-project-viewer-v\d+\.html$/u;

for (const asset of sharedAssets) {
  const assetSource = path.join(repositoryRoot, "docs", "design", "mockups", asset);
  if (!fs.existsSync(assetSource)) throw new Error(`shared viewer asset is missing: ${assetSource}`);
}

fs.mkdirSync(destinationDirectory, { recursive: true });
for (const entry of fs.readdirSync(destinationDirectory)) {
  if (retiredViewerPattern.test(entry)) fs.rmSync(path.join(destinationDirectory, entry), { force: true });
}
for (const asset of sharedAssets) {
  const destination = path.join(destinationDirectory, asset);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "docs", "design", "mockups", asset), destination);
}
