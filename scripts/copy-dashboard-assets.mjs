import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repositoryRoot, "docs", "mockups", "semantic-project-viewer-v2.html");
const destinationDirectory = path.join(repositoryRoot, "dist", "dashboard");
const destination = path.join(destinationDirectory, "semantic-project-viewer-v2.html");
const managerAssets = ["index.html", "mottainai.html", "wabachi.html", "styles.css"];

if (!fs.existsSync(source)) throw new Error(`dashboard viewer asset is missing: ${source}`);
for (const asset of managerAssets) {
  const managerSource = path.join(repositoryRoot, "docs", "mockups", asset);
  if (!fs.existsSync(managerSource)) throw new Error(`Manager viewer asset is missing: ${managerSource}`);
}
fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
for (const asset of managerAssets) {
  fs.copyFileSync(path.join(repositoryRoot, "docs", "mockups", asset), path.join(destinationDirectory, asset));
}
