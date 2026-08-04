import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RetrievedArtifact {
  id: string;
  stream?: "combined" | "stdout" | "stderr";
  text: string;
  totalLines: number;
  returnedStartLine: number;
  returnedEndLine: number;
  omittedLines: number;
  matchLine?: number;
}

export interface ArtifactStore {
  put(result: CallToolResult): string;
  putArtifact(artifact: StoredArtifactInput): string;
  retrieve(id: string, options?: RetrieveOptions): RetrievedArtifact | undefined;
  search(query: string, maxResults?: number): ArtifactSearchResult[];
}

export interface RetrieveOptions {
  query?: string;
  startLine?: number;
  maxLines?: number;
  contextLines?: number;
  stream?: "combined" | "stdout" | "stderr";
}

export interface StoredArtifactInput {
  text: string;
  stdout?: string;
  stderr?: string;
  metadata?: ArtifactMetadata;
}

export interface ArtifactMetadata {
  operation: string;
  command?: string;
  cwd?: string;
  summary?: string;
  diagnostics?: Array<{ severity: string; message: string; path?: string; line?: number }>;
}

export interface ArtifactSearchResult {
  id: string;
  operation: string;
  summary?: string;
  command?: string;
  cwd?: string;
}

export interface InMemoryArtifactStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  createId?: () => string;
}

interface StoredArtifact {
  text: string;
  stdout?: string;
  stderr?: string;
  metadata?: ArtifactMetadata;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_LINES = 80;

type ArtifactPayload = Pick<StoredArtifact, "text" | "stdout" | "stderr" | "metadata">;

function textFromResult(result: CallToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.min(maxBytes, bytes.byteLength); end >= 0; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // 切断位置がマルチバイト文字の途中なら、さらに1 byte戻す。
    }
  }
  return "";
}

function payloadBytes(payload: ArtifactPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function fitStringField(
  payload: ArtifactPayload,
  key: "stdout" | "stderr",
  value: string,
  maxBytes: number,
): string | undefined {
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(value, middle);
    if (payloadBytes({ ...payload, [key]: candidate }) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

type MetadataStringKey = "operation" | "command" | "cwd" | "summary";

function fitMetadataString(
  payload: ArtifactPayload,
  metadata: ArtifactMetadata,
  key: MetadataStringKey,
  value: string,
  maxBytes: number,
): string | undefined {
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...metadata, [key]: utf8Prefix(value, middle) };
    if (payloadBytes({ ...payload, metadata: candidate }) <= maxBytes) {
      best = candidate[key];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function boundMetadata(
  payload: ArtifactPayload,
  metadata: ArtifactMetadata,
  maxBytes: number,
): ArtifactMetadata | undefined {
  const operation = fitMetadataString(payload, { operation: "" }, "operation", metadata.operation, maxBytes);
  if (operation === undefined) return undefined;
  let bounded: ArtifactMetadata = { operation };
  for (const key of ["command", "cwd", "summary"] as const) {
    const value = metadata[key];
    if (value === undefined) continue;
    const fitted = fitMetadataString(payload, bounded, key, value, maxBytes);
    if (fitted !== undefined) bounded = { ...bounded, [key]: fitted };
  }
  if (metadata.diagnostics !== undefined) {
    const withDiagnostics = { ...bounded, diagnostics: metadata.diagnostics };
    if (payloadBytes({ ...payload, metadata: withDiagnostics }) <= maxBytes) bounded = withDiagnostics;
  }
  return bounded;
}

function truncationFooter(rawBytes: number, maxBytes: number): string {
  return `\n⋯ artifact truncated bytes=${rawBytes} max=${maxBytes} ⋯`;
}

function fitText(payload: ArtifactPayload, originalText: string, maxBytes: number): string {
  const rawBytes = Buffer.byteLength(originalText, "utf8");
  const footer = truncationFooter(rawBytes, maxBytes);
  let low = 0;
  let high = rawBytes;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${utf8Prefix(originalText, middle)}${footer}`;
    if (payloadBytes({ ...payload, text: candidate }) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) return best;

  low = 0;
  high = rawBytes;
  best = undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(originalText, middle);
    if (payloadBytes({ ...payload, text: candidate }) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? "";
}

function boundArtifact(artifact: StoredArtifactInput, maxBytes: number): ArtifactPayload {
  const payload: ArtifactPayload = {
    text: artifact.text,
    ...(artifact.stdout === undefined ? {} : { stdout: artifact.stdout }),
    ...(artifact.stderr === undefined ? {} : { stderr: artifact.stderr }),
    ...(artifact.metadata === undefined ? {} : { metadata: artifact.metadata }),
  };
  if (payloadBytes(payload) <= maxBytes) return payload;

  for (const key of ["stdout", "stderr"] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    const bounded = fitStringField(payload, key, value, maxBytes);
    if (bounded === undefined) delete payload[key];
    else payload[key] = bounded;
  }

  if (payload.metadata !== undefined) {
    const bounded = boundMetadata(payload, payload.metadata, maxBytes);
    if (bounded === undefined) delete payload.metadata;
    else payload.metadata = bounded;
  }

  for (const key of ["metadata", "stderr", "stdout"] as const) {
    if (payloadBytes(payload) <= maxBytes) break;
    delete payload[key];
  }

  // `operation` drives artifact discovery in search(); keep a minimal { operation }
  // record alive even when the rest of metadata, stdout, stderr, and text had to be
  // dropped or truncated to fit maxBytes. Reserve its bytes before truncating text so
  // fitText doesn't spend the entire remaining budget on text alone.
  const operation = artifact.metadata?.operation;
  const minimalMetadata: ArtifactMetadata | undefined = operation === undefined ? undefined : { operation };

  if (payloadBytes(payload) > maxBytes) {
    const originalText = payload.text;
    const budgetPayload: ArtifactPayload = { ...payload, text: "" };
    if (minimalMetadata === undefined) delete budgetPayload.metadata;
    else budgetPayload.metadata = minimalMetadata;
    payload.text = fitText(budgetPayload, originalText, maxBytes);
    delete payload.metadata;
  }

  if (minimalMetadata !== undefined && payload.metadata === undefined) {
    if (payloadBytes({ ...payload, metadata: minimalMetadata }) <= maxBytes) payload.metadata = minimalMetadata;
  }

  return payload;
}

/** 圧縮前textを短時間だけ保持する、プロセス内CCRストア。 */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly entries = new Map<string, StoredArtifact>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be a finite non-negative number");
    if (!Number.isFinite(maxEntries) || !Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a finite positive integer");
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a finite positive number");
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  put(result: CallToolResult): string {
    return this.putArtifact({ text: textFromResult(result), metadata: { operation: "upstream" } });
  }

  putArtifact(artifact: StoredArtifactInput): string {
    this.deleteExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const id = `mx_${this.createId()}`;
    const bounded = boundArtifact(artifact, this.maxBytes);
    this.entries.set(id, { ...bounded, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  retrieve(
    id: string,
    options: RetrieveOptions = {},
  ): RetrievedArtifact | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);

    const stream = options.stream ?? "combined";
    const source = stream === "stdout" ? entry.stdout ?? "" : stream === "stderr" ? entry.stderr ?? "" : entry.text;
    const lines = source.split("\n");
    const matchIndex = options.query ? lines.findIndex((line) => line.includes(options.query!)) : -1;
    const maxLines = Math.max(1, Math.min(options.maxLines ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES));
    const contextLines = Math.max(0, Math.min(options.contextLines ?? 0, 20));
    const startLine = matchIndex === -1
      ? Math.max(0, options.startLine ?? 0)
      : Math.max(0, matchIndex - Math.min(contextLines, maxLines - 1));
    const selected = lines.slice(startLine, startLine + maxLines);
    const endLine = startLine + selected.length;

    return {
      id,
      ...(stream === "combined" ? {} : { stream }),
      text: selected.join("\n"),
      totalLines: lines.length,
      returnedStartLine: startLine + 1,
      returnedEndLine: endLine,
      omittedLines: lines.length - selected.length,
      ...(matchIndex === -1 ? {} : { matchLine: matchIndex + 1 }),
    };
  }

  search(query: string, maxResults = 20): ArtifactSearchResult[] {
    this.deleteExpired();
    const needle = query.toLowerCase();
    const limit = Math.max(1, Math.min(maxResults, 100));
    const matches: ArtifactSearchResult[] = [];
    for (const [id, entry] of [...this.entries.entries()].reverse()) {
      const metadataText = [
        entry.metadata?.command,
        entry.metadata?.summary,
        ...(entry.metadata?.diagnostics?.map((item) => item.message) ?? []),
      ].join("\n");
      if (!`${metadataText}\n${entry.text}`.toLowerCase().includes(needle)) continue;
      matches.push({
        id,
        operation: entry.metadata?.operation ?? "unknown",
        ...(entry.metadata?.summary ? { summary: entry.metadata.summary } : {}),
        ...(entry.metadata?.command ? { command: entry.metadata.command } : {}),
        ...(entry.metadata?.cwd ? { cwd: entry.metadata.cwd } : {}),
      });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private deleteExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
