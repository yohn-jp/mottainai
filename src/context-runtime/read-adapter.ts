import fs from "node:fs/promises";
import type { ReadFileMetadata } from "./read-policy.js";

const READ_BUFFER_BYTES = 64 * 1024;

export interface InspectedReadFile extends ReadFileMetadata {
  rangeStartByte?: number;
  rangeEndByte?: number;
}

/** 本文を保持せず、policy判定に必要なサイズと行境界だけを走査する。 */
export async function inspectReadFile(
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<InspectedReadFile> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    let line = 1;
    let rangeStartByte: number | undefined;
    let rangeEndByte: number | undefined;

    if (startLine === 1) rangeStartByte = 0;

    while (position < stat.size) {
      const readLength = Math.min(buffer.length, stat.size - position);
      const result = await handle.read(buffer, 0, readLength, position);
      if (result.bytesRead === 0) break;
      for (let index = 0; index < result.bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0x0a) {
          if (endLine === line) rangeEndByte = position + index;
          line += 1;
          if (startLine === line && rangeStartByte === undefined) rangeStartByte = position + index + 1;
        }
      }
      position += result.bytesRead;
    }

    if (startLine === line && rangeStartByte === undefined) rangeStartByte = position;
    if (endLine === line && rangeEndByte === undefined) rangeEndByte = position;

    const rangeBytes =
      rangeStartByte !== undefined && rangeEndByte !== undefined && rangeEndByte >= rangeStartByte
        ? rangeEndByte - rangeStartByte
        : undefined;
    return {
      lineCount: stat.size === 0 ? 1 : line,
      byteSize: stat.size,
      ...(rangeBytes === undefined ? {} : { rangeBytes }),
      withinWorkspace: true,
      symlinkSafe: true,
      ...(rangeStartByte === undefined ? {} : { rangeStartByte }),
      ...(rangeEndByte === undefined ? {} : { rangeEndByte }),
    };
  } finally {
    await handle.close();
  }
}

/** 明示範囲はbyte offsetで再読し、bounded rawがファイル全体を再取得しないようにする。 */
export async function readInspectedFile(
  filePath: string,
  inspected: InspectedReadFile,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    inspected.rangeStartByte !== undefined &&
    inspected.rangeEndByte !== undefined
  ) {
    const length = inspected.rangeEndByte - inspected.rangeStartByte;
    if (length === 0) return "";
    const handle = await fs.open(filePath, "r");
    try {
      const result = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const read = await handle.read(result, offset, length - offset, inspected.rangeStartByte + offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      return result.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  return fs.readFile(filePath, "utf8");
}
