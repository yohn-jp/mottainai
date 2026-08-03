/**
 * MCPツール説明のうち、英語散文にだけ適用する機械的圧縮。
 * コードフェンス、インラインコード、URL、日本語を含む行は変更しない。
 */
const PROTECTED_LITERAL = /https?:\/\/[^\s`]+|`[^`]*`|'[^']*'|"[^"]*"/g;
const ENGLISH_FILLERS: Array<[RegExp, string]> = [
  [/\buse it when you need to\s+/gi, "use to "],
  [/\buse (.+?) instead for\s+/gi, "use $1 for "],
  [/\bsee server instructions for\s+/gi, "server instructions: "],
  [/\bonly use if\s+/gi, "use if "],
  [/\bthis returns\s+/gi, "returns "],
  [/\bimportant:\s*/gi, ""],
  [/\bplease\s+/gi, ""],
  [/\bnote that\s+/gi, ""],
  [/\bit is important to\s+/gi, ""],
  [/\bit is\s+/gi, ""],
  [/\bin order to\b/gi, "to"],
  [/\b(?:basically|simply|just|actually|really|very)\s+/gi, ""],
  [/\b(?:you can|you should)\s+/gi, ""],
  [/\bsearch for\s+/gi, "search "],
  [/\b(?:a|an|the)\s+/gi, ""],
];

function compressProseLine(line: string): string {
  // 日本語の助詞・空白は英語向け規則で扱わない。
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(line)) return line;

  const protectedParts: string[] = [];
  let text = line.replace(PROTECTED_LITERAL, (part) => {
    const index = protectedParts.push(part) - 1;
    return `\u0000${index}\u0000`;
  });

  for (const [pattern, replacement] of ENGLISH_FILLERS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/ {2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1");
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => protectedParts[Number(index)]);
}

/** 説明文を圧縮する。Markdownコードフェンス内は完全に保持する。 */
export function compressToolDescription(input: string): string {
  let inCodeFence = false;
  return input
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeFence = !inCodeFence;
        return line;
      }
      return inCodeFence ? line : compressProseLine(line);
    })
    .join("\n");
}

function compressSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compressSchemaDescriptions);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === "description" && typeof child === "string"
      ? compressToolDescription(child)
      : compressSchemaDescriptions(child);
  }
  return out;
}

/**
 * name以外のToolフィールドを保ったまま、descriptionとinputSchema内descriptionを圧縮する。
 * JSON Schema構造・制約値・examples・defaultは変更しない。
 */
export function compressToolDefinition<T extends { description?: string; inputSchema: unknown }>(tool: T): T {
  return {
    ...tool,
    ...(tool.description === undefined ? {} : { description: compressToolDescription(tool.description) }),
    inputSchema: compressSchemaDescriptions(tool.inputSchema),
  };
}
