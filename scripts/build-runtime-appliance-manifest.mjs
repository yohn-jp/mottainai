import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function digest(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function applianceInputs(imageOutput, architecture) {
  const filePath = path.join(imageOutput, "runtime-appliance-inputs.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `canonical Runtime Appliance image inputs cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.contractId !== "mottainai.linux-runtime-appliance.v1" ||
    value.schemaVersion !== 1 ||
    value.architecture !== architecture ||
    typeof value.nixSystemClosure !== "string" ||
    typeof value.canonicalSource !== "object" ||
    value.canonicalSource === null ||
    typeof value.canonicalSource.flake !== "string" ||
    typeof value.canonicalSource.output !== "string"
  ) {
    throw new Error(`canonical Runtime Appliance image inputs are invalid: ${filePath}`);
  }
  return value;
}

const architecture = option("architecture");
const imageOutput = option("image-output");
const sourceRevision = option("source-revision");
const mottainaiVersion = option("mottainai-version");
const nawabariVersion = option("nawabari-version");
const output = path.resolve(option("output"));

if (!/^(?:x86_64-linux|aarch64-linux)$/u.test(architecture)) {
  throw new Error(`unsupported Runtime Appliance architecture: ${architecture}`);
}
if (!/^[0-9a-f]{40}$/iu.test(sourceRevision)) {
  throw new Error("--source-revision must be a full Git commit SHA");
}

const inputs = applianceInputs(imageOutput, architecture);
const diskSource = path.join(imageOutput, "mottainai-runtime-appliance.raw");
if (!fs.statSync(diskSource).isFile()) {
  throw new Error(`missing canonical Runtime Appliance disk: ${diskSource}`);
}

const directory = path.join(output, architecture);
fs.mkdirSync(directory, { recursive: true });
const diskFilename = "mottainai-runtime-appliance.raw";
const stagedDisk = path.join(directory, diskFilename);
fs.copyFileSync(diskSource, stagedDisk);

const manifest = {
  contractId: "mottainai.linux-runtime-appliance.v1",
  schemaVersion: 1,
  architecture,
  sourceRevision,
  nixSystemClosure: inputs.nixSystemClosure,
  mottainaiVersion,
  nawabariVersion,
  image: {
    filename: diskFilename,
    format: "raw",
    sizeBytes: fs.statSync(stagedDisk).size,
    sha256: digest(stagedDisk),
  },
  canonicalSource: inputs.canonicalSource,
};
fs.writeFileSync(
  path.join(directory, "runtime-appliance-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify({ ...manifest, output: directory }, null, 2));
