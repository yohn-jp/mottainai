import fs from "node:fs";
import path from "node:path";
import { addSecondaryDiagnostic } from "./boundary.js";
import type { BoundaryOperations } from "./boundary.js";

export interface AtomicReplaceOptions {
  /** temp file に rename 前に適用する permission。省略時は変更しない。 */
  mode?: number;
}

/**
 * 同一ディレクトリの一時ファイル経由で destination を atomic replace する。
 * complete な一時ファイル作成後にのみ rename するため、write/close/rename の途中失敗でも
 * destination は byte-for-byte 未変更のまま。成功時は一時ディレクトリを残さない。
 * cleanup 失敗は primary error を保持し、bounded secondary evidence だけを付加する。
 *
 * permission: `options.mode` を明示指定しない限り、destination が既存ならその mode を
 * temp file へ rename 前に適用し維持する（umask依存で 0600 が 0644 等へ緩むのを防ぐ）。
 * destination が存在しない場合は fs.writeFileSync の既定 mode のまま。rename 後に
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
  const temporaryDirectory = boundaries.file(`${operation}.temp.create`, () =>
    fs.mkdtempSync(path.join(directory, ".mottainai-tmp-")),
  );
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath));
  const mode = options.mode ?? existingFileMode(filePath);
  let primary: unknown;
  try {
    boundaries.file(`${operation}.temp.write`, () => fs.writeFileSync(temporaryPath, content));
    // writeFileSync owns the OS handle; this named checkpoint makes its close phase
    // deterministic and injectable without replacing Node's filesystem globally.
    boundaries.file(`${operation}.temp.close`, () => undefined);
    if (mode !== undefined) {
      boundaries.file(`${operation}.temp.permission`, () => fs.chmodSync(temporaryPath, mode));
    }
    boundaries.file(`${operation}.rename`, () => fs.renameSync(temporaryPath, filePath));
  } catch (error) {
    primary = error;
    const cleanupError = cleanupTemporaryDirectory(temporaryDirectory, boundaries, operation, primary);
    if (cleanupError !== undefined) throw cleanupError;
    throw error;
  }
  const cleanupError = cleanupTemporaryDirectory(temporaryDirectory, boundaries, operation);
  if (cleanupError !== undefined) {
    // A successful replacement must not be turned into a protocol-breaking failure
    // merely because best-effort cleanup failed. The diagnostic is intentionally generic.
    console.error(`mottainai: temporary ${operation} cleanup failed; replacement completed`);
  }
}

/** destinationが存在すればその permission bits を返す。存在しない/statできない場合は undefined。 */
function existingFileMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

function cleanupTemporaryDirectory(
  temporaryDirectory: string,
  boundaries: BoundaryOperations,
  operation: string,
  primary?: unknown,
): Error | undefined {
  try {
    boundaries.file(`${operation}.temp.cleanup`, () =>
      fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
    );
    return undefined;
  } catch {
    try {
      boundaries.file(`${operation}.temp.cleanup.retry`, () =>
        fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
      );
      return undefined;
    } catch (retryError) {
      // Fault injection fails before invoking the action. A direct final attempt
      // keeps a test seam failure from leaving an otherwise removable directory
      // behind while the injected failure remains secondary evidence.
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
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
