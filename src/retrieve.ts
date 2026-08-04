import { randomUUID } from "node:crypto";
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
  put(result: CallToolResult, id?: string): string;
  putArtifact(artifact: StoredArtifactInput, id?: string): string;
  retrieve(id: string, options?: RetrieveOptions): RetrievedArtifact | undefined;
  search(query: string, maxResults?: number): ArtifactSearchResult[];
  /** `put`/`putArtifact` が使う id を、何も保存せずに払い出す。呼び出し側が先に最終結果の byte 長を確定させたいときに使う。 */
  nextId(): string;
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

function textFromResult(result: CallToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
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
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  put(result: CallToolResult, id?: string): string {
    return this.putArtifact({ text: textFromResult(result), metadata: { operation: "upstream" } }, id);
  }

  putArtifact(artifact: StoredArtifactInput, id?: string): string {
    this.deleteExpired();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    const resolvedId = id ?? this.nextId();
    const rawBytes = Buffer.byteLength(artifact.text, "utf8");
    const text = rawBytes <= this.maxBytes
      ? artifact.text
      : `${Buffer.from(artifact.text, "utf8").subarray(0, this.maxBytes).toString("utf8")}\n⋯ artifact truncated bytes=${rawBytes} max=${this.maxBytes} ⋯`;
    this.entries.set(resolvedId, { ...artifact, text, expiresAt: this.now() + this.ttlMs });
    return resolvedId;
  }

  nextId(): string {
    return `mx_${this.createId()}`;
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
    const contextLines = Math.max(0, Math.min(options.contextLines ?? 0, 20));
    const startLine = matchIndex === -1
      ? Math.max(0, options.startLine ?? 0)
      : Math.max(0, matchIndex - contextLines);
    const maxLines = Math.max(1, Math.min(options.maxLines ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES));
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
