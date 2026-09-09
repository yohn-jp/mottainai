import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireSemanticSourceLockForTest, removeSemanticSourceLockGenerationForTest } from "./store.js";

const [, , optionsJson] = process.argv;
const options = JSON.parse(optionsJson);
const lockPath = join(options.rootDir, ".mottainai/.semantics.lock");
await mkdir(join(options.rootDir, ".mottainai"), { recursive: true });

function emit(event, extra = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...extra })}\n`);
}

if (options.mode === "initialize") {
  await mkdir(lockPath, { recursive: false });
  emit("READY");
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    for (const command of chunk
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (command === "PUBLISH") {
        await writeFile(
          join(lockPath, "owner.json"),
          JSON.stringify({ version: 1, token: options.token, pid: process.pid, startedAt: Date.now() }),
          "utf8",
        );
        emit("PUBLISHED", { token: options.token });
      } else if (command === "RELEASE") {
        await rm(lockPath, { recursive: true, force: true });
        emit("RELEASED");
        process.exit(0);
      }
    }
  }
  process.exit(0);
}

if (options.mode === "try") {
  const lock = await acquireSemanticSourceLockForTest(options.rootDir);
  if (lock === undefined) {
    emit("FAILED");
  } else {
    emit("ACQUIRED", { token: lock.token });
    await lock.release();
  }
  process.exit(0);
}

const token = options.token ?? randomUUID();
await mkdir(lockPath);
await writeFile(
  join(lockPath, "owner.json"),
  JSON.stringify({ version: 1, token, pid: process.pid, startedAt: Date.now() }),
  "utf8",
);
emit("ACQUIRED", { token });
if (options.mode === "crash-after-acquire") process.exit(0);

process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  for (const command of chunk
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (command === "RELEASE") {
      await removeSemanticSourceLockGenerationForTest(options.rootDir, token);
      emit("RELEASED", { token });
      process.exit(0);
    }
    if (command === "REMOVE-GENERATION") {
      await removeSemanticSourceLockGenerationForTest(options.rootDir, token);
      emit("REMOVED", { token });
    }
  }
}
