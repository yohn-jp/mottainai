import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { InMemoryArtifactStore } from "../src/retrieve.ts";

const KIB = 1024;
const MAX_BYTES = 64 * KIB;
const SHAPES = ["ascii", "escaped", "utf8"];
const PROTOCOLS = [
  { bytes: 100 * KIB, warmup: 3, iterations: 20 },
  { bytes: 1 * 1024 * KIB, warmup: 2, iterations: 8 },
  { bytes: 10 * 1024 * KIB, warmup: 1, iterations: 3 },
];

function makeInput(bytes, shape) {
  if (shape === "ascii") return "a".repeat(bytes);
  if (shape === "escaped") {
    const unit = '"\\';
    return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  }
  const multibyteBytes = bytes - (bytes % 3);
  return "あ".repeat(multibyteBytes / 3) + "x".repeat(bytes - multibyteBytes);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function runCase(protocol, shape) {
  const input = makeInput(protocol.bytes, shape);
  assert.equal(Buffer.byteLength(input, "utf8"), protocol.bytes);
  assert.ok(protocol.bytes > MAX_BYTES);

  const artifact = {
    text: input,
    metadata: {
      operation: "benchmark",
      command: "artifact-bounding",
      cwd: "/benchmark",
      summary: "artifact bounding benchmark",
    },
  };
  const store = new InMemoryArtifactStore({
    maxBytes: MAX_BYTES,
    maxEntries: 1,
    createId: () => "benchmark",
  });

  for (let iteration = 0; iteration < protocol.warmup; iteration += 1) {
    store.putArtifact(artifact, "benchmark");
  }

  const firstId = store.putArtifact(artifact, "benchmark");
  const retained = store.retrieve(firstId);
  assert.ok(retained);
  assert.match(retained.text, /artifact truncated/);
  assert.equal(retained.text.includes("\uFFFD"), false);
  assert.ok(Buffer.byteLength(retained.text, "utf8") <= MAX_BYTES);

  const elapsed = [];
  for (let iteration = 0; iteration < protocol.iterations; iteration += 1) {
    const started = performance.now();
    store.putArtifact(artifact, "benchmark");
    elapsed.push(performance.now() - started);
  }

  return {
    bytes: protocol.bytes,
    shape,
    maxBytes: MAX_BYTES,
    iterations: protocol.iterations,
    medianMs: median(elapsed),
  };
}

console.log("Artifact bounding benchmark");
console.log(`node ${process.version}`);
console.log(`maxBytes ${MAX_BYTES}`);
console.log(`warmup ${PROTOCOLS.map(({ warmup }) => warmup).join(",")}`);
console.log("size\tshape\tinput_bytes\tmaxBytes\titerations\tmedian_ms");

for (const protocol of PROTOCOLS) {
  for (const shape of SHAPES) {
    const result = runCase(protocol, shape);
    console.log([
      `${result.bytes / KIB} KiB`,
      result.shape,
      result.bytes,
      result.maxBytes,
      result.iterations,
      result.medianMs.toFixed(3),
    ].join("\t"));
  }
}
