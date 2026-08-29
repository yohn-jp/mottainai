import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLogger, MIN_LOG_FILE_BYTES } from "./logging.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-log-test-"));
}

function logFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
}

function assertFilesWithinByteBound(dir: string, maxBytes: number): string[] {
  const files = logFiles(dir);
  for (const file of files) {
    const contents = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(Buffer.byteLength(contents, "utf8") <= maxBytes, `${file} exceeds ${maxBytes} bytes`);
    for (const line of contents.trimEnd().split("\n")) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
  return files;
}

test("createLogger returns a no-op logger when MOTTAINAI_LOG=0", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG: "0", MOTTAINAI_LOG_DIR: dir });
  await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: {} });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("createLogger writes JSON Lines records with id and timestamp", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir });
  await logger.log({ upstreamName: "fff", toolName: "grep", arguments: { q: "x" }, rawResult: { content: [] } });
  await logger.log({ upstreamName: "fff", toolName: "grep", arguments: { q: "y" }, rawResult: { content: [] } });

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);

  const contents = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const lines = contents.trim().split("\n");
  assert.equal(lines.length, 2);

  const record1 = JSON.parse(lines[0]);
  assert.equal(typeof record1.id, "string");
  assert.equal(typeof record1.timestamp, "string");
  assert.equal(record1.upstreamName, "fff");
  assert.equal(record1.toolName, "grep");
  assert.deepEqual(record1.arguments, { q: "x" });

  const record2 = JSON.parse(lines[1]);
  assert.notEqual(record1.id, record2.id);
});

test("createLogger creates the log directory if missing", async () => {
  const dir = path.join(tmpDir(), "nested", "log", "dir");
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir });
  await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: {} });
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("createLogger redacts fields whose key matches secret/token/cookie patterns", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir });
  await logger.log({
    upstreamName: "u",
    toolName: "t",
    arguments: {
      apiKey: "sk-live-abc123",
      headers: { Authorization: "Bearer xyz", Cookie: "session=abc" },
      password: "hunter2",
    },
    rawResult: { access_token: "tok_1", nested: { secret: "s3cr3t" } },
  });

  const files = fs.readdirSync(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8").trim());

  assert.equal(record.arguments.apiKey, "[REDACTED]");
  assert.equal(record.arguments.headers.Authorization, "[REDACTED]");
  assert.equal(record.arguments.headers.Cookie, "[REDACTED]");
  assert.equal(record.arguments.password, "[REDACTED]");
  assert.equal(record.rawResult.access_token, "[REDACTED]");
  assert.equal(record.rawResult.nested.secret, "[REDACTED]");
});

test("createLogger keeps non-sensitive fields untouched", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir });
  await logger.log({
    upstreamName: "fff",
    toolName: "grep",
    arguments: { query: "TODO", path: "src/index.ts", limit: 10 },
    rawResult: { content: [{ type: "text", text: "line 1\nline 2" }] },
  });

  const files = fs.readdirSync(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8").trim());

  assert.deepEqual(record.arguments, { query: "TODO", path: "src/index.ts", limit: 10 });
  assert.deepEqual(record.rawResult, { content: [{ type: "text", text: "line 1\nline 2" }] });
});

test("createLogger skips redaction when MOTTAINAI_LOG_REDACT=0", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir, MOTTAINAI_LOG_REDACT: "0" });
  await logger.log({ upstreamName: "u", toolName: "t", arguments: { token: "raw-value" }, rawResult: {} });

  const files = fs.readdirSync(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8").trim());
  assert.equal(record.arguments.token, "raw-value");
});

test("createLogger writes files and directory with restrictive permissions", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir });
  await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: {} });

  const files = fs.readdirSync(dir);
  const fileMode = fs.statSync(path.join(dir, files[0])).mode & 0o777;
  assert.equal(fileMode, 0o600);
});

test("createLogger excludes records for tools listed in MOTTAINAI_LOG_EXCLUDE_TOOLS", async () => {
  const dir = tmpDir();
  const logger = createLogger({
    MOTTAINAI_LOG_DIR: dir,
    MOTTAINAI_LOG_EXCLUDE_TOOLS: "secret-tool,fff__grep",
  });
  await logger.log({ upstreamName: "u", toolName: "secret-tool", arguments: {}, rawResult: {} });
  await logger.log({ upstreamName: "fff", toolName: "grep", arguments: {}, rawResult: {} });
  await logger.log({ upstreamName: "fff", toolName: "list", arguments: { ok: true }, rawResult: {} });

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).toolName, "list");
});

test("createLogger normalizes a configured file limit below the supported minimum", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir, MOTTAINAI_LOG_MAX_FILE_BYTES: "10" });
  await logger.log({
    upstreamName: "u",
    toolName: "t",
    arguments: {},
    rawResult: { text: "x".repeat(10_000) },
  });

  const files = assertFilesWithinByteBound(dir, MIN_LOG_FILE_BYTES);
  assert.equal(files.length, 1);
  const contents = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.ok(Buffer.byteLength(contents, "utf8") > 0);
});

test("createLogger rolls over to a new file once MOTTAINAI_LOG_MAX_FILE_BYTES is exceeded", async () => {
  const dir = tmpDir();
  const logger = createLogger({
    MOTTAINAI_LOG_DIR: dir,
    MOTTAINAI_LOG_MAX_FILE_BYTES: String(MIN_LOG_FILE_BYTES),
  });
  for (let index = 0; index < 5; index += 1) {
    await logger.log({ upstreamName: "u", toolName: "t", arguments: { a: index }, rawResult: {} });
  }

  const files = assertFilesWithinByteBound(dir, MIN_LOG_FILE_BYTES);
  assert.ok(files.length > 1);
});

test("createLogger bounds an oversized record while retaining its digest", async () => {
  const dir = tmpDir();
  const logger = createLogger({
    MOTTAINAI_LOG_DIR: dir,
    MOTTAINAI_LOG_MAX_FILE_BYTES: String(MIN_LOG_FILE_BYTES),
  });
  await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: { text: "x".repeat(10_000) } });

  const files = assertFilesWithinByteBound(dir, MIN_LOG_FILE_BYTES);
  const line = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const record = JSON.parse(line) as { rawResult: { truncated?: boolean; sha256?: string } };
  assert.equal(record.rawResult.truncated, true);
  assert.match(record.rawResult.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("createLogger truncates UTF-8 names only at code point boundaries", async () => {
  const cases = [
    { codePoint: "あ", invalidByteBoundaries: [1, 2] },
    { codePoint: "😀", invalidByteBoundaries: [1, 2, 3] },
  ] as const;

  for (const field of ["upstreamName", "toolName"] as const) {
    for (const { codePoint, invalidByteBoundaries } of cases) {
      for (const invalidByteBoundary of invalidByteBoundaries) {
        const dir = tmpDir();
        const logger = createLogger({
          MOTTAINAI_LOG_DIR: dir,
          MOTTAINAI_LOG_MAX_FILE_BYTES: String(MIN_LOG_FILE_BYTES),
        });
        const prefixLength = 96 - invalidByteBoundary;
        const record = {
          upstreamName: "u",
          toolName: "t",
          arguments: {},
          rawResult: { text: "x".repeat(10_000) },
        };
        record[field] = `${"a".repeat(prefixLength)}${codePoint}suffix`;

        await logger.log(record);

        const files = assertFilesWithinByteBound(dir, MIN_LOG_FILE_BYTES);
        assert.equal(files.length, 1);
        const logged = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) as {
          upstreamName: string;
          toolName: string;
          rawResult: { truncated?: boolean; original_bytes?: number; sha256?: string };
        };
        assert.equal(logged[field], "a".repeat(prefixLength));
        assert.ok(!logged[field].includes("\uFFFD"));
        assert.equal(Buffer.byteLength(logged[field], "utf8"), prefixLength);
        assert.equal(logged.rawResult.truncated, true);
        assert.ok((logged.rawResult.original_bytes ?? 0) > 0);
        assert.match(logged.rawResult.sha256 ?? "", /^[0-9a-f]{64}$/);
      }
    }
  }
});

test("createLogger keeps an exact-boundary record and rotates before the next write", async () => {
  const dir = tmpDir();
  const maxBytes = MIN_LOG_FILE_BYTES;
  const lineBytesForPayload = (payloadLength: number): number =>
    Buffer.byteLength(
      `${JSON.stringify({
        id: "0".repeat(36),
        timestamp: "0".repeat(24),
        upstreamName: "u",
        toolName: "t",
        arguments: { payload: "x".repeat(payloadLength) },
        rawResult: {},
      })}\n`,
      "utf8",
    );

  let payloadLength = 0;
  while (lineBytesForPayload(payloadLength) < maxBytes) payloadLength += 1;
  assert.equal(lineBytesForPayload(payloadLength), maxBytes);

  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir, MOTTAINAI_LOG_MAX_FILE_BYTES: String(maxBytes) });
  await logger.log({
    upstreamName: "u",
    toolName: "t",
    arguments: { payload: "x".repeat(payloadLength) },
    rawResult: {},
  });

  let files = assertFilesWithinByteBound(dir, maxBytes);
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(dir, files[0])).size, maxBytes);

  await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: {} });
  files = assertFilesWithinByteBound(dir, maxBytes);
  assert.equal(files.length, 2);
});

test("createLogger does not reject when a raw result cannot be serialized", async () => {
  const dir = tmpDir();
  const logger = createLogger({ MOTTAINAI_LOG_DIR: dir, MOTTAINAI_LOG_REDACT: "0" });
  const circular: { self?: unknown } = {};
  circular.self = circular;

  await assert.doesNotReject(async () => {
    await logger.log({ upstreamName: "u", toolName: "t", arguments: {}, rawResult: circular });
  });
});

test("createLogger rolls over to distinct files even within a single timestamp tick", async () => {
  const dir = tmpDir();
  const logger = createLogger({
    MOTTAINAI_LOG_DIR: dir,
    MOTTAINAI_LOG_MAX_FILE_BYTES: String(MIN_LOG_FILE_BYTES),
  });
  for (let index = 0; index < 5; index += 1) {
    await logger.log({
      upstreamName: "u",
      toolName: "t",
      arguments: { a: "x".repeat(300), index },
      rawResult: {},
    });
  }

  const files = assertFilesWithinByteBound(dir, MIN_LOG_FILE_BYTES);
  assert.equal(files.length, 5);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").length, 1);
  }
});

test("createLogger removes jsonl files older than MOTTAINAI_LOG_RETENTION_DAYS on startup", async () => {
  const dir = tmpDir();
  const stalePath = path.join(dir, "stale.jsonl");
  fs.writeFileSync(stalePath, "{}\n");
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stalePath, oldTime, oldTime);

  createLogger({ MOTTAINAI_LOG_DIR: dir, MOTTAINAI_LOG_RETENTION_DAYS: "1" });

  assert.equal(fs.existsSync(stalePath), false);
});
