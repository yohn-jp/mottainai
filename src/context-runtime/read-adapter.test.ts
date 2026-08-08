import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectReadFile, readAuthorizedFile } from "./read-adapter.js";

test("inspection returns policy metadata without retaining source content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-read-adapter-inspect-"));
  const filePath = path.join(root, "sample.txt");
  const source = "第一行\nsecond line\n";
  await fs.writeFile(filePath, source);
  try {
    const inspected = await inspectReadFile(filePath);
    assert.equal(inspected.lineCount, 2);
    assert.equal(inspected.byteSize, Buffer.byteLength(source, "utf8"));
    assert.deepEqual(inspected.lineByteLengths, [9, 11]);
    assert.equal("text" in inspected, false);
    assert.equal("source" in inspected, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("authorized bounded reads use UTF-8 byte boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mottainai-read-adapter-range-"));
  const filePath = path.join(root, "multibyte.txt");
  await fs.writeFile(filePath, "one\nあいう\n最後\n");
  try {
    const inspected = await inspectReadFile(filePath);
    const result = await readAuthorizedFile(filePath, inspected, {
      path: "multibyte.txt",
      mode: "raw",
      startLine: 2,
      endLine: 2,
      bounded: true,
    });
    assert.equal(result, "あいう");
    assert.equal(Buffer.byteLength(result, "utf8"), 9);
    assert.doesNotMatch(result, /最後/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
