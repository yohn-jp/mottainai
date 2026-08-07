import Parser from "tree-sitter";
import javascript from "tree-sitter-javascript";
import typescript from "tree-sitter-typescript";

export type CodeLanguage = "javascript" | "typescript" | "tsx";

export interface CodeSkeletonOptions {
  /** 入力全体がコードである場合の言語。未指定時は fenced code block だけを対象にする。 */
  language?: CodeLanguage;
}

const LANGUAGE_ALIASES: Record<string, CodeLanguage> = {
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
};

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "method_definition",
  "arrow_function",
]);

const parser = new Parser();
// architecture-check allow: import-time-side-effect -- tree-sitterパーサーは再利用可能なnative singletonのため

function languageFor(language: CodeLanguage): Parameters<Parser["setLanguage"]>[0] {
  switch (language) {
    // architecture-check allow: double-assertion -- tree-sitterのnative handle型宣言がunknownのため
    case "javascript": return javascript as unknown as Parameters<Parser["setLanguage"]>[0];
    // architecture-check allow: double-assertion -- tree-sitterのnative handle型宣言がunknownのため
    case "typescript": return typescript.typescript as unknown as Parameters<Parser["setLanguage"]>[0];
    // architecture-check allow: double-assertion -- tree-sitterのnative handle型宣言がunknownのため
    case "tsx": return typescript.tsx as unknown as Parameters<Parser["setLanguage"]>[0];
  }
}

function bodyNodes(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const bodies: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const body = node.childForFieldName("body");
      if (body?.type === "statement_block") bodies.push(body);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return bodies;
}

/**
 * 関数・メソッド本体だけを AST 境界で省略する。
 * 構文エラーを含む入力は無変形で返す。完全な意味保存ではなく、探索用骨格化。
 */
export function skeletonizeCode(input: string, language: CodeLanguage): string {
  parser.setLanguage(languageFor(language));
  const tree = parser.parse(input);
  if (tree.rootNode.hasError) return input;

  const candidates = bodyNodes(tree.rootNode);
  // 入れ子関数の body は外側 body の省略で同時に消える。重複置換しない。
  const bodies = candidates
    .filter((body) => !candidates.some((other) =>
      other.startIndex < body.startIndex && body.endIndex < other.endIndex,
    ))
    .sort((a, b) => b.startIndex - a.startIndex);
  if (bodies.length === 0) return input;

  let output = input;
  for (const body of bodies) {
    output = `${output.slice(0, body.startIndex)}{ /* mottainai: body omitted */ }${output.slice(body.endIndex)}`;
  }
  return output;
}

function normalizeLanguage(value: string): CodeLanguage | undefined {
  return LANGUAGE_ALIASES[value.trim().toLowerCase()];
}

const FENCED_CODE = /(^|\n)(```([^\n`]*)\n)([\s\S]*?)(\n```(?=\n|$))/g;

/** 明示言語の全体コード、または言語付き fenced code block を骨格化する。 */
export function compressCodeText(input: string, options: CodeSkeletonOptions = {}): string {
  if (options.language) return skeletonizeCode(input, options.language);

  return input.replace(FENCED_CODE, (whole, prefix: string, opening: string, info: string, code: string, closing: string) => {
    const language = normalizeLanguage(info.split(/\s+/, 1)[0] ?? "");
    if (!language) return whole;
    return `${prefix}${opening}${skeletonizeCode(code, language)}${closing}`;
  });
}

/** ツール引数の言語名またはファイル名から対応言語を安全に推定する。 */
export function detectCodeLanguage(arguments_: unknown): CodeLanguage | undefined {
  if (typeof arguments_ !== "object" || arguments_ === null) return undefined;
  const values = arguments_ as Record<string, unknown>;
  for (const key of ["language", "languageId"]) {
    if (typeof values[key] === "string") {
      const language = normalizeLanguage(values[key]);
      if (language) return language;
    }
  }
  for (const key of ["path", "filePath", "filepath", "filename", "uri"]) {
    const value = values[key];
    if (typeof value !== "string") continue;
    const extension = value.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase();
    if (extension) {
      const language = normalizeLanguage(extension);
      if (language) return language;
    }
  }
  return undefined;
}
