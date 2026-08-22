import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardAsset = "semantic-project-viewer-v3.html";
const source = path.join(repositoryRoot, "docs", "mockups", dashboardAsset);
const destinationDirectory = path.join(repositoryRoot, "dist", "dashboard");
const destination = path.join(destinationDirectory, dashboardAsset);
const sharedAssets = ["index.html", "mottainai.html", "wabachi.html", "styles.css"];

if (!fs.existsSync(source)) throw new Error(`dashboard viewer asset is missing: ${source}`);
for (const asset of sharedAssets) {
  const assetSource = path.join(repositoryRoot, "docs", "mockups", asset);
  if (!fs.existsSync(assetSource)) throw new Error(`shared viewer asset is missing: ${assetSource}`);
}
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
for (const asset of sharedAssets) {
  fs.copyFileSync(path.join(repositoryRoot, "docs", "mockups", asset), path.join(destinationDirectory, asset));
}
