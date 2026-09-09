import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NormalizedReadRequest, ReadFileMetadata } from "./read-policy.js";

const READ_SCAN_CHUNK_BYTES = 64 * 1024;

export interface InspectedReadFile extends ReadFileMetadata {
  lineByteLengths: number[];
  lineContentHashes: string[];
  contentHash: string;
}

export interface AuthorizedReadContent {
  text: string;
  contentHash: string;
  rangeFingerprint?: string;
}

const RANGE_FINGERPRINT_PREFIX = "mottainai-read-range-v1\0";

function contentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function rangeFingerprint(lineContentHashes: readonly string[]): string {
  const hasher = createHash("sha256");
  hasher.update(RANGE_FINGERPRINT_PREFIX);
  for (const [index, lineContentHash] of lineContentHashes.entries()) {
    if (index > 0) hasher.update("\n");
    hasher.update(lineContentHash);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function rangeFingerprintFromBytes(content: Buffer): string {
  const lineContentHashes: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    lineContentHashes.push(contentHash(content.subarray(lineStart, index)));
    lineStart = index + 1;
  }
  if (
    lineContentHashes.length === 0 ||
    lineStart < content.length ||
    (content.length > 0 && content[content.length - 1] === 0x0a)
  ) {
    lineContentHashes.push(contentHash(content.subarray(lineStart)));
  }
  return rangeFingerprint(lineContentHashes);
}

/** 本文を保持せず、指定 file の SHA-256 と line metadata をストリーミングで計算する。 */
async function scanFile(
  filePath: string,
  authorizedRoot?: string,
): Promise<{ contentHash: string; lineByteLengths: number[]; lineContentHashes: string[]; byteSize: number }> {
  const handle = await openReadDescriptor(filePath, authorizedRoot);
  const buffer = Buffer.alloc(READ_SCAN_CHUNK_BYTES);
  const lineByteLengths: number[] = [];
  const lineContentHashes: string[] = [];
  const contentHasher = createHash("sha256");
  let lineHasher = createHash("sha256");
  let currentLineBytes = 0;
  let byteSize = 0;
  let lastByte = -1;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      contentHasher.update(buffer.subarray(0, bytesRead));
      byteSize += bytesRead;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        lastByte = byte;
        if (byte === 0x0a) {
          if (index > lineStart) lineHasher.update(buffer.subarray(lineStart, index));
          lineContentHashes.push(lineHasher.digest("hex"));
          lineHasher = createHash("sha256");
          lineByteLengths.push(currentLineBytes);
          currentLineBytes = 0;
          lineStart = index + 1;
        } else {
          currentLineBytes += 1;
        }
      }
      if (lineStart < bytesRead) lineHasher.update(buffer.subarray(lineStart, bytesRead));
    }
  } finally {
    await handle.close();
  }
  if (lineByteLengths.length === 0 || lastByte !== 0x0a) {
    lineByteLengths.push(currentLineBytes);
    lineContentHashes.push(lineHasher.digest("hex"));
  }
  return { contentHash: contentHasher.digest("hex"), lineByteLengths, lineContentHashes, byteSize };
}

/** 本文を保持せず、policy判定に必要なbyte/line metadataだけ収集する。 */
export async function inspectReadFile(filePath: string, authorizedRoot?: string): Promise<InspectedReadFile> {
  const scanned = await scanFile(filePath, authorizedRoot);
  return {
    lineCount: scanned.lineByteLengths.length,
    byteSize: scanned.byteSize,
    lineByteLengths: scanned.lineByteLengths,
    lineContentHashes: scanned.lineContentHashes,
    contentHash: scanned.contentHash,
  };
}

/** inspection 時点の bounded range の内容を、返却 bytes と比較できる fingerprint にする。 */
export function inspectedRangeFingerprint(metadata: InspectedReadFile, startLine: number, endLine: number): string {
  return rangeFingerprint(metadata.lineContentHashes.slice(startLine - 1, endLine));
}

/**
 * inspect 時点の content hash を、現在の file を再スキャンして得た hash と比較する。
 * これが correctness authority であり、stat（mtime/size/inode）は使わない: 同一
 * inode への same-size 上書き＋mtime 巻き戻しは stat 一致のまま content だけ変え
 * 得るため、stat 一致は「hash 計算 bytes と返却 bytes が同一だった」ことの証明に
 * ならない。一致しなければ、identity と実際に返した bytes が同一 snapshot に
 * 束縛されている保証がないということなので、呼び出し側は fail-closed に identity
 * を破棄する。
 */
export async function verifyFileContentUnchanged(
  filePath: string,
  expected: { contentHash: string },
  authorizedRoot?: string,
): Promise<boolean> {
  try {
    const rescanned = await scanFile(filePath, authorizedRoot);
    return rescanned.contentHash === expected.contentHash;
  } catch {
    return false;
  }
}

function lineStartByte(metadata: InspectedReadFile, line: number): number {
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += metadata.lineByteLengths[index] + 1;
  return offset;
}

/**
 * fd を開いた直後に、その同一 fd へ fstat する共通ガード。
 *
 * readTool は authorizedRoot を渡して open 後の fd 実体も root 境界で検証する。
 * resolveInside の realpath 検査から
 * この open() 自体はパス文字列で行われるため、検査から open までの間に祖先ディレクトリが
 * symlink に置き換えられても、外部へ解決された fd は fail-closed で破棄する。
 * ここで保証しているのは、一度 open
 * できた fd に対して fstat と実際の読み取りを両方バインドすることで、
 * 「fstat で見た種別・inode」と「実際に読んだ bytes」が同一スナップショットから
 * 来ることは保証する（stat(path) → 別の open(path) → read という別々パス解決を
 * 挟まない）。procfs が利用できない環境では fd/path の identity も比較する。
 */
async function assertRegularFile(handle: fs.FileHandle): Promise<void> {
  const stats = await handle.stat();
  if (!stats.isFile()) throw new Error("path must be a file");
}

/**
 * 開いた fd の実体が認可済み root の内側にあることを確認する。
 * resolveInside() は fd を保持しないため、検査後に祖先を差し替えられると
 * open(path) が別の実体を選ぶ可能性がある。open 後に procfs の fd 実体を
 * realpath して再度 root 境界を確認し、外部へ解決された場合は bytes を返さず
 * fail-closed にする。procfs がない環境では path の再解決と fd/path の stat
 * identity 比較にフォールバックする。
 */
async function assertDescriptorInsideRoot(
  handle: fs.FileHandle,
  filePath: string,
  authorizedRoot: string,
): Promise<void> {
  const rootReal = await fs.realpath(authorizedRoot);
  let resolvedDescriptor: string;
  try {
    resolvedDescriptor = await fs.realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    resolvedDescriptor = await fs.realpath(filePath);
    const [descriptorStats, pathStats] = await Promise.all([handle.stat(), fs.stat(filePath)]);
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino)
      throw new Error("path changed while opening");
  }
  if (resolvedDescriptor !== rootReal && !resolvedDescriptor.startsWith(`${rootReal}${path.sep}`))
    throw new Error("path resolves outside workspaceRoot");
}

async function openReadDescriptor(filePath: string, authorizedRoot?: string): Promise<fs.FileHandle> {
  const handle = await fs.open(filePath, "r");
  try {
    await assertRegularFile(handle);
    if (authorizedRoot !== undefined) await assertDescriptorInsideRoot(handle, filePath, authorizedRoot);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** policy通過済みの明示範囲だけbyte offsetで再読する。fstat と読み取りは同一 fd に束縛。 */
async function readAuthorizedRange(
  filePath: string,
  metadata: InspectedReadFile,
  startLine: number,
  endLine: number,
  authorizedRoot?: string,
): Promise<AuthorizedReadContent> {
  if (startLine > metadata.lineCount) {
    const empty = Buffer.alloc(0);
    return {
      text: "",
      contentHash: contentHash(empty),
      rangeFingerprint: rangeFingerprintFromBytes(empty),
    };
  }
  const startByte = lineStartByte(metadata, startLine);
  const endByte = lineStartByte(metadata, endLine) + metadata.lineByteLengths[endLine - 1];
  const length = Math.max(0, endByte - startByte);
  if (length === 0) {
    const empty = Buffer.alloc(0);
    return {
      text: "",
      contentHash: contentHash(empty),
      rangeFingerprint: rangeFingerprintFromBytes(empty),
    };
  }

  const handle = await openReadDescriptor(filePath, authorizedRoot);
  const chunks: Buffer[] = [];
  let position = startByte;
  let remaining = length;
  try {
    await assertRegularFile(handle);
    while (remaining > 0) {
      const chunk = Buffer.alloc(Math.min(READ_SCAN_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await handle.close();
  }
  const content = Buffer.concat(chunks);
  return {
    text: content.toString("utf8"),
    contentHash: contentHash(content),
    rangeFingerprint: rangeFingerprintFromBytes(content),
  };
}

/** 明示範囲なしの全文読み取り。open した fd に fstat し、同じ fd から読む（別 open で再解決しない）。 */
async function readWholeFileByDescriptor(filePath: string, authorizedRoot?: string): Promise<AuthorizedReadContent> {
  const handle = await openReadDescriptor(filePath, authorizedRoot);
  try {
    const content = await handle.readFile();
    return { text: content.toString("utf8"), contentHash: contentHash(content) };
  } finally {
    await handle.close();
  }
}

/** normalized requestだけを実行。明示範囲ではファイル全体をmaterializeしない。 */
export async function readAuthorizedContent(
  filePath: string,
  metadata: InspectedReadFile,
  request: NormalizedReadRequest,
  authorizedRoot?: string,
): Promise<AuthorizedReadContent> {
  if (request.startLine === undefined || request.endLine === undefined)
    return readWholeFileByDescriptor(filePath, authorizedRoot);
  return readAuthorizedRange(filePath, metadata, request.startLine, request.endLine, authorizedRoot);
}

export async function readAuthorizedFile(
  filePath: string,
  metadata: InspectedReadFile,
  request: NormalizedReadRequest,
  authorizedRoot?: string,
): Promise<string> {
  return (await readAuthorizedContent(filePath, metadata, request, authorizedRoot)).text;
}

/** policy判定後のsemantic projectionだけが使う内部抽出用全体read。公開結果には直接返さない。 */
export async function readSemanticInspectionSourceContent(
  filePath: string,
  request: NormalizedReadRequest,
  authorizedRoot?: string,
): Promise<AuthorizedReadContent> {
  if (request.mode !== "outline" && request.mode !== "symbols")
    throw new Error("semantic inspection requires a semantic mode");
  return readWholeFileByDescriptor(filePath, authorizedRoot);
}

export async function readSemanticInspectionSource(
  filePath: string,
  request: NormalizedReadRequest,
  authorizedRoot?: string,
): Promise<string> {
  return (await readSemanticInspectionSourceContent(filePath, request, authorizedRoot)).text;
}
