import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addSecondaryDiagnostic } from "./boundary.js";
import type { BoundaryOperations } from "./boundary.js";

export interface AtomicReplaceOptions {
  /** temp file に rename 前に適用する permission。省略時は既存 destination の mode を維持する。 */
  mode?: number;
}

/**
 * 同一ディレクトリの一時ファイル経由で destination を atomic replace する。
 * complete かつ fsync 済みの一時ファイル作成後にのみ rename し、rename 成功後は親ディレクトリも
 * fsync する。write/close/rename の途中失敗でも destination は byte-for-byte 未変更のまま。成功時は
 * 一時ファイルを残さない。
 * cleanup 失敗は primary error を保持し、bounded secondary evidence だけを付加する。
 *
 * permission: `options.mode` を明示指定しない限り、destination が既存ならその mode を
 * temp file へ rename 前に適用し維持する（umask依存で 0600 が 0644 等へ緩むのを防ぐ）。
 * destination が存在しない場合は fs.writeFileSync の既定 mode 相当。rename 後に
 * destination を chmod することはない（可視状態には常に最終 mode のファイルのみ現れる）。
 */
export function replaceFileAtomically(
  filePath: string,
  content: string | Buffer,
  boundaries: BoundaryOperations,
  operation: string,
  options: AtomicReplaceOptions = {},
): void {
  const directory = path.dirname(filePath);
  boundaries.file(`${operation}.directory.create`, () => fs.mkdirSync(directory, { recursive: true }));
  const mode = options.mode ?? existingFileMode(filePath);
  const temporaryFile = boundaries.file(`${operation}.temp.create`, () =>
    createTemporaryFile(directory, filePath, mode),
  );
  const temporaryPath = temporaryFile.path;
  let fileDescriptor: number | undefined = temporaryFile.fileDescriptor;
  let primary: unknown;
  try {
    boundaries.file(`${operation}.temp.write`, () => fs.writeFileSync(fileDescriptor!, content));
    if (mode !== undefined) {
      boundaries.file(`${operation}.temp.permission`, () => fs.chmodSync(temporaryPath, mode));
    }
    boundaries.file(`${operation}.temp.sync`, () => fs.fsyncSync(fileDescriptor!));
    boundaries.file(`${operation}.temp.close`, () => {
      if (fileDescriptor !== undefined) {
        fs.closeSync(fileDescriptor);
        fileDescriptor = undefined;
      }
    });
    boundaries.file(`${operation}.rename`, () => fs.renameSync(temporaryPath, filePath));
    syncParentDirectory(directory, boundaries, operation);
  } catch (error) {
    primary = error;
    closeFileDescriptor(fileDescriptor);
    const cleanupError = cleanupTemporaryFile(temporaryPath, boundaries, operation, primary);
    if (cleanupError !== undefined) throw cleanupError;
    throw error;
  }
  const cleanupError = cleanupTemporaryFile(temporaryPath, boundaries, operation);
  if (cleanupError !== undefined) {
    // A successful replacement must not be turned into a protocol-breaking failure
    // merely because best-effort cleanup failed. The diagnostic is intentionally generic.
    console.error(`mottainai: temporary ${operation} cleanup failed; replacement completed`);
  }
}

interface TemporaryFile {
  path: string;
  fileDescriptor: number;
}

function createTemporaryFile(directory: string, filePath: string, mode: number | undefined): TemporaryFile {
  const temporaryMode = mode ?? 0o666;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const temporaryPath = path.join(directory, `.mottainai-tmp-${randomUUID()}`);
    try {
      return { path: temporaryPath, fileDescriptor: fs.openSync(temporaryPath, "wx", temporaryMode) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`unable to allocate a temporary file for atomic replacement: ${filePath}`);
}

/** destinationが存在すればその permission bits を返す。存在しない/statできない場合は undefined。 */
function existingFileMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

function syncParentDirectory(directory: string, boundaries: BoundaryOperations, operation: string): void {
  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = boundaries.file(`${operation}.directory.open`, () => fs.openSync(directory, "r"));
    boundaries.file(`${operation}.directory.sync`, () => fs.fsyncSync(directoryDescriptor!));
    boundaries.file(`${operation}.directory.close`, () => {
      if (directoryDescriptor !== undefined) {
        fs.closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
      }
    });
  } finally {
    closeFileDescriptor(directoryDescriptor);
  }
}

function closeFileDescriptor(fileDescriptor: number | undefined): void {
  if (fileDescriptor === undefined) return;
  try {
    fs.closeSync(fileDescriptor);
  } catch {
    // Preserve the original operation error; the temporary path cleanup follows.
  }
}

function cleanupTemporaryFile(
  temporaryPath: string,
  boundaries: BoundaryOperations,
  operation: string,
  primary?: unknown,
): Error | undefined {
  try {
    boundaries.file(`${operation}.temp.cleanup`, () => fs.rmSync(temporaryPath, { force: true }));
    return undefined;
  } catch {
    try {
      boundaries.file(`${operation}.temp.cleanup.retry`, () => fs.rmSync(temporaryPath, { force: true }));
      return undefined;
    } catch (retryError) {
      // Fault injection fails before invoking the action. A direct final attempt
      // keeps a test seam failure from leaving an otherwise removable file
      // behind while the injected failure remains secondary evidence.
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (fallbackError) {
        retryError = fallbackError;
      }
      if (primary === undefined) {
        return retryError instanceof Error ? retryError : new Error(String(retryError));
      }
      return addSecondaryDiagnostic(primary, `${operation}.temp.cleanup`, retryError);
    }
  }
}
