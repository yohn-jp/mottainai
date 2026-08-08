import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { NormalizedReadRequest, ReadFileMetadata } from "./read-policy.js";

const READ_SCAN_CHUNK_BYTES = 64 * 1024;

export interface InspectedReadFile extends ReadFileMetadata {
  lineByteLengths: number[];
  contentHash: string;
}

/** 本文を保持せず、指定 file の SHA-256 と line metadata をストリーミングで計算する。 */
async function scanFile(filePath: string): Promise<{ contentHash: string; lineByteLengths: number[]; byteSize: number }> {
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(READ_SCAN_CHUNK_BYTES);
  const lineByteLengths: number[] = [];
  const contentHasher = createHash("sha256");
  let currentLineBytes = 0;
  let byteSize = 0;
  let lastByte = -1;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      contentHasher.update(buffer.subarray(0, bytesRead));
      byteSize += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        lastByte = byte;
        if (byte === 0x0a) {
          lineByteLengths.push(currentLineBytes);
          currentLineBytes = 0;
        } else {
          currentLineBytes += 1;
        }
      }
    }
  } finally {
    await handle.close();
  }
  if (lineByteLengths.length === 0 || lastByte !== 0x0a) lineByteLengths.push(currentLineBytes);
  return { contentHash: contentHasher.digest("hex"), lineByteLengths, byteSize };
}

/** 本文を保持せず、policy判定に必要なbyte/line metadataだけ収集する。 */
export async function inspectReadFile(filePath: string): Promise<InspectedReadFile> {
  const scanned = await scanFile(filePath);
  return {
    lineCount: scanned.lineByteLengths.length,
    byteSize: scanned.byteSize,
    lineByteLengths: scanned.lineByteLengths,
    contentHash: scanned.contentHash,
  };
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
export async function verifyFileContentUnchanged(filePath: string, expected: { contentHash: string }): Promise<boolean> {
  try {
    const rescanned = await scanFile(filePath);
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

/** policy通過済みの明示範囲だけbyte offsetで再読する。 */
async function readAuthorizedRange(
  filePath: string,
  metadata: InspectedReadFile,
  startLine: number,
  endLine: number,
): Promise<string> {
  if (startLine > metadata.lineCount) return "";
  const startByte = lineStartByte(metadata, startLine);
  const endByte = lineStartByte(metadata, endLine) + metadata.lineByteLengths[endLine - 1];
  const length = Math.max(0, endByte - startByte);
  if (length === 0) return "";

  const handle = await fs.open(filePath, "r");
  const chunks: Buffer[] = [];
  let position = startByte;
  let remaining = length;
  try {
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
  return Buffer.concat(chunks).toString("utf8");
}

/** normalized requestだけを実行。明示範囲ではファイル全体をmaterializeしない。 */
export async function readAuthorizedFile(
  filePath: string,
  metadata: InspectedReadFile,
  request: NormalizedReadRequest,
): Promise<string> {
  if (request.startLine === undefined || request.endLine === undefined) return fs.readFile(filePath, "utf8");
  return readAuthorizedRange(filePath, metadata, request.startLine, request.endLine);
}

/** policy判定後のsemantic projectionだけが使う内部抽出用全体read。公開結果には直接返さない。 */
export async function readSemanticInspectionSource(filePath: string, request: NormalizedReadRequest): Promise<string> {
  if (request.mode !== "outline" && request.mode !== "symbols")
    throw new Error("semantic inspection requires a semantic mode");
  return fs.readFile(filePath, "utf8");
}
