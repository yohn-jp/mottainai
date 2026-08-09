import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMottainaiConfig, resolveConfigPath, resolveGatewayConfig } from "../src/config.ts";
import { compactToBudget } from "../src/compress/budget.ts";
import { compressJsonValue } from "../src/compress/json.ts";
import { truncateExcessLines } from "../src/compress/lines.ts";
import { output, OUTPUT_SCHEMA } from "../src/envelope.ts";
import { applyExecutionBudget, fitsResultBudget, normalizeExecutionOutcome } from "../src/execution.ts";
import { safeRemoteUrl, sanitizeArguments } from "../src/init.ts";
import { parseRgJson, resolveInside } from "../src/local-tools.ts";
import { InMemoryArtifactStore } from "../src/retrieve.ts";

const DEFAULT_SEED = 240824;
const DEFAULT_RUNS = 48;
const DEPTH_MARKER = "[truncated: max depth exceeded]";

function parseOptions(argv) {
  const options = { seed: DEFAULT_SEED, runs: DEFAULT_RUNS, report: "test-artifacts/property-report.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed") options.seed = Number(argv[++index]);
    else if (argument === "--runs") options.runs = Number(argv[++index]);
    else if (argument === "--report") options.report = argv[++index];
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0)
    throw new Error("--seed must be a non-negative safe integer");
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 200)
    throw new Error("--runs must be between 1 and 200");
  if (typeof options.report !== "string" || options.report.length === 0)
    throw new Error("--report must be a non-empty path");
  return options;
}

function createRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function integer(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function choose(random, values) {
  return values[integer(random, 0, values.length - 1)];
}

function randomText(random, maxLength = 64) {
  const alphabet = ["a", "Z", "0", " ", "\n", "あ", "界", "🎉", '"', "\\", "é"];
  return Array.from({ length: integer(random, 0, maxLength) }, () => choose(random, alphabet)).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shrinkValues(value) {
  if (typeof value === "string") {
    const half = Math.floor(value.length / 2);
    return [
      ...new Set([
        "",
        value.slice(0, half),
        value.slice(0, Math.max(0, value.length - 1)),
        value.replace(/[^a]/gu, "a"),
      ]),
    ];
  }
  if (typeof value === "number" && Number.isFinite(value)) return [...new Set([0, 1, Math.floor(value / 2)])];
  if (Array.isArray(value))
    return [[], value.slice(0, Math.floor(value.length / 2)), value.slice(0, Math.max(0, value.length - 1))];
  if (value !== null && typeof value === "object") {
    return Object.keys(value).flatMap((key) =>
      shrinkValues(value[key]).map((candidate) => ({ ...value, [key]: candidate })),
    );
  }
  return [];
}

async function runProperty(name, random, runs, generate, property) {
  for (let index = 0; index < runs; index += 1) {
    const generated = generate(random, index);
    let counterexample = generated;
    try {
      await property(generated);
    } catch (error) {
      for (const candidate of shrinkValues(generated)) {
        try {
          await property(candidate);
          continue;
        } catch {
          counterexample = candidate;
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `property=${name} seed=${random.seed} case=${index} counterexample=${stableJson(counterexample)}\n${detail}`,
      );
    }
  }
  return { name, runs };
}

function configCase(random, index) {
  const names = ["alpha", "beta", "gamma"].slice(0, integer(random, 1, 3));
  const mcpServers = Object.fromEntries(
    names.map((name) => [
      name,
      {
        command: "node",
        args: ["server.mjs", name],
        capabilities: [choose(random, ["definitions", "code.search", "runtime_state"])],
      },
    ]),
  );
  return { version: index % 2 === 0 ? 1 : 2, mcpServers };
}

function rgEvent(type, filePath, line, text) {
  return JSON.stringify({ type, data: { path: { text: filePath }, line_number: line, lines: { text } } });
}

function rgCase(random) {
  const files = ["zeta.txt", "alpha.txt", "middle.txt"];
  for (let index = files.length - 1; index > 0; index -= 1) {
    const swap = integer(random, 0, index);
    [files[index], files[swap]] = [files[swap], files[index]];
  }
  return {
    files,
    raw: files.map((file, index) => rgEvent("match", `/root/${file}`, index + 1, `needle-${index}`)).join("\n"),
  };
}

function jsonArrayCase(random, index) {
  const maxArrayItems = integer(random, 1, 8);
  const length = index % 3 === 0 ? maxArrayItems : integer(random, 0, 24);
  return {
    value: Array.from({ length }, (_, itemIndex) => `item-${itemIndex}`),
    options: { maxArrayItems, tailArrayItems: integer(random, 0, maxArrayItems + 2) },
  };
}

function nestedValue(depth) {
  let value = "leaf";
  for (let index = 0; index <= depth; index += 1) value = { value };
  return value;
}

function expectedNested(depth, maxDepth, current = 0) {
  if (current > maxDepth) return DEPTH_MARKER;
  return { value: expectedNested(depth - 1, maxDepth, current + 1) };
}

function envelopeCase(random) {
  return {
    facts: random() > 0.5 ? ["fact"] : { invalid: true },
    diagnostics: random() > 0.5 ? [] : "invalid",
    metrics: random() > 0.5 ? { generated: true } : [],
    custom: `custom-${integer(random, 0, 9)}`,
  };
}

function budgetCase(random) {
  const targetTokens = integer(random, 270, 520);
  return {
    text: Array.from({ length: integer(random, 20, 100) }, (_, index) => `${index}-${randomText(random, 18)}`).join(
      "\n",
    ),
    targetTokens,
    rawBytes: 50_000,
  };
}

function retentionCase(random) {
  return { maxEntries: integer(random, 1, 4), count: integer(random, 1, 8), ttlMs: integer(random, 0, 100) };
}

async function pathProperty(root, random, runs) {
  const cases = [
    { requested: ".", inside: true },
    { requested: "nested", inside: true },
    { requested: "nested/..", inside: true },
    { requested: "../outside", inside: false },
    { requested: "nested/../../outside", inside: false },
    { requested: "link", inside: false },
  ];
  return runProperty(
    "path-containment",
    random,
    runs,
    (source, index) => cases[index % cases.length] ?? source,
    async (value) => {
      try {
        const resolved = await resolveInside(root, value.requested);
        assert.equal(value.inside, true);
        assert.ok(resolved === root || resolved.startsWith(`${root}${path.sep}`));
      } catch (error) {
        assert.equal(value.inside, false, error instanceof Error ? error.message : String(error));
      }
    },
  );
}

async function run() {
  const options = parseOptions(process.argv.slice(2));
  const random = createRandom(options.seed);
  random.seed = options.seed;
  const results = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mottainai-property-"));
  const outside = path.join(root, "..", `${path.basename(root)}-outside`);
  fs.mkdirSync(path.join(root, "nested"));
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "link"), "dir");
  const originalConfigEnv = process.env.MOTTAINAI_CONFIG;
  delete process.env.MOTTAINAI_CONFIG;
  try {
    results.push(
      await runProperty(
        "utf8-budget-bounds",
        random,
        options.runs,
        (source) => ({ text: randomText(source, 96), maxBytes: integer(source, 32, 240) }),
        async (value) => {
          const store = new InMemoryArtifactStore({ maxBytes: value.maxBytes, createId: () => "property" });
          const id = store.putArtifact({ text: value.text, metadata: { operation: "property" } });
          const retrieved = store.retrieve(id);
          assert.ok(retrieved);
          assert.ok(Buffer.byteLength(retrieved.text, "utf8") <= value.maxBytes);
          assert.equal(retrieved.text.includes("\uFFFD"), false);
        },
      ),
    );

    results.push(
      await runProperty(
        "config-path-resolution",
        random,
        options.runs,
        (source) => choose(source, ["", "nested/config.json", undefined]),
        async (value) => {
          const expected = path.resolve(root, value ?? "mottainai.config.json");
          assert.equal(resolveConfigPath(value, root), expected);
        },
      ),
    );

    results.push(
      await runProperty("config-normalization-idempotence", random, options.runs, configCase, async (value) => {
        const firstPath = path.join(root, "first.json");
        const secondPath = path.join(root, "second.json");
        fs.writeFileSync(firstPath, JSON.stringify(value));
        const first = loadMottainaiConfig(firstPath);
        fs.writeFileSync(secondPath, JSON.stringify(first));
        const second = loadMottainaiConfig(secondPath);
        assert.deepEqual(second, first);
        assert.equal(first.version, value.version);
      }),
    );

    results.push(
      await runProperty(
        "config-http-url-validation",
        random,
        options.runs,
        (source, index) =>
          [
            { url: "http://example.test/mcp", valid: true },
            { url: "https://example.test/mcp", valid: true },
            { url: "file:///tmp/mcp", valid: false },
          ][index % 3],
        async (value) => {
          const configPath = path.join(root, "url.json");
          fs.writeFileSync(
            configPath,
            JSON.stringify({ version: 2, mcpServers: { remote: { transport: "streamableHttp", url: value.url } } }),
          );
          if (value.valid) assert.doesNotThrow(() => loadMottainaiConfig(configPath));
          else assert.throws(() => loadMottainaiConfig(configPath), /invalid upstream url/);
        },
      ),
    );

    results.push(await pathProperty(root, random, options.runs));

    results.push(
      await runProperty("deterministic-ordering", random, options.runs, rgCase, async (value) => {
        const first = parseRgJson(value.raw, "/root", 0);
        const second = parseRgJson(value.raw, "/root", 0);
        assert.deepEqual(first, second);
        assert.deepEqual(
          first.map((group) => group.path),
          value.files,
        );
      }),
    );

    results.push(
      await runProperty("envelope-schema-invariants", random, options.runs, envelopeCase, async (details) => {
        const result = output("property", "success", "summary", "mx_property", details, true);
        const structured = result.structuredContent;
        assert.ok(structured);
        for (const field of OUTPUT_SCHEMA.required) assert.equal(Object.hasOwn(structured, field), true, field);
        assert.equal(structured.operation, "property");
        assert.equal(structured.custom, details.custom);
        assert.equal(result.isError, true);
        assert.ok(Array.isArray(structured.facts));
        assert.ok(!Object.hasOwn(structured, "isError"));
      }),
    );

    results.push(
      await runProperty("json-compression-preservation", random, options.runs, jsonArrayCase, async (value) => {
        const result = compressJsonValue(value.value, value.options);
        assert.deepEqual(result, compressJsonValue(value.value, value.options));
        if (value.value.length <= value.options.maxArrayItems) {
          assert.deepEqual(result, value.value);
          return;
        }
        assert.ok(Array.isArray(result));
        const tailCount = Math.min(value.options.tailArrayItems, value.options.maxArrayItems - 1);
        const headCount = value.options.maxArrayItems - tailCount;
        assert.equal(result.length, value.options.maxArrayItems + 1);
        assert.deepEqual(result.slice(0, headCount), value.value.slice(0, headCount));
        if (tailCount > 0) assert.deepEqual(result.slice(-tailCount), value.value.slice(-tailCount));
        assert.equal(result[headCount].__truncated__, true);
        assert.equal(result[headCount].totalCount, value.value.length);
      }),
    );

    results.push(
      await runProperty(
        "json-depth-boundary",
        random,
        options.runs,
        (source) => integer(source, 0, 4),
        async (maxDepth) => {
          assert.deepEqual(compressJsonValue(nestedValue(maxDepth), { maxDepth }), expectedNested(maxDepth, maxDepth));
        },
      ),
    );

    results.push(
      await runProperty(
        "line-boundary-preservation",
        random,
        options.runs,
        (source) => {
          const maxTotalLines = integer(source, 1, 12);
          const count = integer(source, 0, maxTotalLines + 4);
          return { input: Array.from({ length: count }, (_, index) => `line-${index}`).join("\n"), maxTotalLines };
        },
        async (value) => {
          const result = truncateExcessLines(value.input, value.maxTotalLines, 1, value.maxTotalLines);
          if (value.input.split("\n").length <= value.maxTotalLines) assert.equal(result, value.input);
          else assert.ok(result.includes("lines omitted"));
        },
      ),
    );

    results.push(
      await runProperty("compression-budget-bound", random, options.runs, budgetCase, async (value) => {
        const targetBytes = Math.max(256, Math.min((value.targetTokens - 256) * 4, value.rawBytes - 1024));
        const result = compactToBudget(value.text, value.targetTokens, value.rawBytes);
        assert.ok(Buffer.byteLength(result, "utf8") <= targetBytes);
      }),
    );

    results.push(
      await runProperty(
        "compression-head-tail-allocation",
        random,
        options.runs,
        () => ({
          input: Array.from({ length: 200 }, (_, index) => `L${String(index).padStart(3, "0")}`).join("\n"),
          targetTokens: 361,
        }),
        async (value) => {
          const lines = compactToBudget(value.input, value.targetTokens, 50_000).split("\n");
          const marker = lines.findIndex((line) => line.startsWith("⋯ mottainai omitted="));
          assert.equal(marker, 39);
          assert.equal(lines.length - marker - 1, 27);
          assert.equal(lines[0], "L000");
          assert.equal(lines.at(-1), "L199");
        },
      ),
    );

    results.push(
      await runProperty(
        "compression-exact-boundary",
        random,
        options.runs,
        (source) => 300 + integer(source, 0, 100),
        async (targetTokens) => {
          const targetBytes = Math.max(256, (targetTokens - 256) * 4);
          const input = "x".repeat(targetBytes);
          assert.equal(compactToBudget(input, targetTokens, 50_000), input);
        },
      ),
    );

    results.push(
      await runProperty(
        "execution-budget-boundary",
        random,
        options.runs,
        (source) => randomText(source, 80),
        async (text) => {
          const candidate = { content: [{ type: "text", text }] };
          const exact = Buffer.byteLength(JSON.stringify(candidate), "utf8");
          assert.equal(fitsResultBudget(candidate, exact), true);
          if (exact > 0) assert.equal(fitsResultBudget(candidate, exact - 1), false);
        },
      ),
    );

    results.push(
      await runProperty(
        "execution-token-budget-conversion",
        random,
        options.runs,
        (source) => 300 + integer(source, 0, 120),
        async (targetTokens) => {
          const outcome = normalizeExecutionOutcome({
            result: { content: [{ type: "text", text: "payload\n".repeat(2_000) }] },
            selectedProvider: "property",
            selectedTool: "budget",
            capability: "property",
            risk: "read_only",
          });
          const budgeted = applyExecutionBudget(
            outcome,
            "budget",
            "property",
            resolveGatewayConfig({ tokenBudgets: { default: targetTokens } }),
            new InMemoryArtifactStore({ createId: () => "conversion" }),
          );
          const text = budgeted.outcome.result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
          assert.match(text, /mottainai compression: original_id=mx_conversion/);
          assert.equal(fitsResultBudget(budgeted.outcome.result, targetTokens * 4), true);
        },
      ),
    );

    results.push(
      await runProperty("artifact-retention-boundaries", random, options.runs, retentionCase, async (value) => {
        let now = 0;
        const store = new InMemoryArtifactStore({ ttlMs: value.ttlMs, maxEntries: value.maxEntries, now: () => now });
        const ids = [];
        for (let index = 0; index < value.count; index += 1) {
          const id = `entry-${index}`;
          ids.push(id);
          store.putArtifact({ text: id, metadata: { operation: "retention" } }, id);
        }
        const expected = ids.slice(-value.maxEntries).reverse();
        assert.deepEqual(
          store.search("entry", 100).map((entry) => entry.id),
          expected,
        );
        const ttlStore = new InMemoryArtifactStore({ ttlMs: value.ttlMs, now: () => now, createId: () => "ttl" });
        const ttlId = ttlStore.putArtifact({ text: "ttl", metadata: { operation: "retention" } });
        now = value.ttlMs;
        assert.equal(ttlStore.retrieve(ttlId), undefined);
      }),
    );

    results.push(
      await runProperty(
        "secret-sanitization",
        random,
        options.runs,
        (source) => ({
          url: choose(source, [
            "https://example.test/mcp",
            "http://example.test/mcp",
            "file:///tmp/mcp",
            "https://example.test/mcp?sig=x",
            "https://user:pass@example.test/mcp",
            "https://example.test/mcp#token",
          ]),
          args: choose(source, [
            ["--safe", "value"],
            ["--token", "literal"],
            ["Authorization: Bearer literal"],
            ["--safe"],
          ]),
        }),
        async (value) => {
          const plainUrl = value.url === "https://example.test/mcp" || value.url === "http://example.test/mcp";
          assert.equal(safeRemoteUrl(value.url), plainUrl);
          const hasSecret = value.args.some((argument) => /token|bearer|authorization/i.test(argument));
          const sanitized = sanitizeArguments(value.args);
          assert.equal(sanitized?.rejected, hasSecret);
          assert.deepEqual(sanitized?.args, hasSecret ? [] : value.args);
        },
      ),
    );
  } finally {
    if (originalConfigEnv === undefined) delete process.env.MOTTAINAI_CONFIG;
    else process.env.MOTTAINAI_CONFIG = originalConfigEnv;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  const report = { schemaVersion: 1, seed: options.seed, runs: options.runs, passed: true, properties: results };
  fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `property tests: ${results.length} properties passed (${results.reduce((total, result) => total + result.runs, 0)} generated cases), seed=${options.seed}`,
  );
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`property tests failed: ${message}`);
  process.exitCode = 1;
});
