/**
 * Managed check の `scope` に使う最小限の glob マッチャ。issue #184 が明示的に禁止する
 * 「投機的な依存グラフ」ではなく、宣言された literal path pattern を repository の
 * 変更パスへ機械的に突き合わせるだけ — 意味解析・依存推論は一切行わない。
 *
 * 対応: `*`（1 segment 内の任意文字列、`/` を跨がない）、`**`（0 個以上の segment）、
 * `?`（1 文字）。それ以外は literal。
 */

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      const isTrailing = index + 2 === normalized.length;
      if (isTrailing) {
        // pattern が `**` で終わる（例: `src/**`）: 直前の segment 配下の任意の深さの
        // 残り全部にマッチする — minimatch の trailing globstar と同じ慣習。
        source += ".*";
        index += 2;
        continue;
      }
      // `**/` の途中出現は「0個以上の segment」として、直後の literal `/` も飲み込む。
      const consumesSlash = normalized[index + 2] === "/";
      source += "(?:.*/)?";
      index += consumesSlash ? 3 : 2;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += escapeRegExpLiteral(char);
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

const compiledPatternCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  const cached = compiledPatternCache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = globToRegExp(pattern);
  compiledPatternCache.set(pattern, compiled);
  return compiled;
}

/** `path` が repository-relative の `/`-normalized path であることを呼び出し側が保証する。 */
export function matchesScope(repositoryRelativePath: string, patterns: readonly string[]): boolean {
  const normalizedPath = repositoryRelativePath.replace(/\\/g, "/");
  return patterns.some((pattern) => compilePattern(pattern).test(normalizedPath));
}
