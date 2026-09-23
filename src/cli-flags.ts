/**
 * Canonical `--flag value` / `--flag=value` argv parser shared by every CLI
 * surface that reads public options (`src/cli.ts`'s dispatcher and
 * `src/init.ts`). A single implementation means an inline value is honored
 * (or rejected) identically everywhere it is accepted, instead of each
 * surface re-deriving its own grammar for the same public flags (Issue #825
 * — init previously only consumed separate-token values, silently dropping
 * `--workspace=path` while the dispatcher already accepted it).
 */

export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}

export interface FlagValue {
  found: boolean;
  inline: boolean;
  value?: string;
}

export function findFlag(argv: readonly string[], name: string): FlagValue {
  const option = `--${name}`;
  const inlinePrefix = `${option}=`;
  const index = argv.findIndex((argument) => argument === option || argument.startsWith(inlinePrefix));
  if (index === -1) return { found: false, inline: false };
  const argument = argv[index];
  if (argument.startsWith(inlinePrefix))
    return { found: true, inline: true, value: argument.slice(inlinePrefix.length) };
  return { found: true, inline: false, value: argv[index + 1] };
}

export function flag(argv: readonly string[], name: string): string | undefined {
  return findFlag(argv, name).value;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** `--name` が渡された場合、値が欠落または別 flag に見える（`--` 始まり）なら fail する。
 * `--name=value` は option-looking な値を明示的に渡す transport として許可する。
 * 素の `flag()` はそのまま返すため、`--workspace` 抜けが cwd への静かな fallback に、
 * `--workspace --issue 12` が `--issue` を workspace 値として誤読することにつながる
 * （`task start` は worktree/branch を作るため、誤った workspace への書き込みになる）。 */
export function requireFlagValue(argv: readonly string[], name: string): string | undefined {
  const parsed = findFlag(argv, name);
  if (!parsed.found) return undefined;
  if (
    parsed.value === undefined ||
    (parsed.inline && parsed.value === "") ||
    (!parsed.inline && parsed.value.startsWith("--"))
  )
    fail(`missing value for --${name}`);
  return parsed.value;
}

/** `--name` または `--name=value` の全出現数（値の内容は問わない）。重複検出用。 */
function occurrenceCount(argv: readonly string[], name: string): number {
  const option = `--${name}`;
  const inlinePrefix = `${option}=`;
  return argv.filter((argument) => argument === option || argument.startsWith(inlinePrefix)).length;
}

/**
 * 値を取る public flag が高々一度しか渡されていないことを要求したうえで
 * `requireFlagValue` と同じ意味論で値を返す。二重指定は値が同一でも fail する
 * — `--workspace a --workspace b` のような衝突だけでなく `--workspace a --workspace a`
 * も、誤って合成された呼び出しの兆候として一律に拒否する。
 */
export function requireSingleFlagValue(argv: readonly string[], name: string): string | undefined {
  const count = occurrenceCount(argv, name);
  if (count > 1) fail(`--${name} was passed more than once`);
  return requireFlagValue(argv, name);
}
