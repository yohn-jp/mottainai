const COMMON_TOKEN_PROBABILITIES: Readonly<Record<string, number>> = {
  a: 0.08, all: 0.025, an: 0.02, and: 0.06, are: 0.025, as: 0.03, at: 0.025,
  be: 0.03, been: 0.01, but: 0.02, by: 0.02, for: 0.035, from: 0.015,
  has: 0.012, in: 0.06, is: 0.07, it: 0.035, no: 0.02, not: 0.02,
  of: 0.07, on: 0.03, or: 0.025, please: 0.01, the: 0.09, this: 0.025,
  to: 0.08, was: 0.02, were: 0.01, with: 0.025,
  build: 0.005, building: 0.004, checking: 0.003, compiling: 0.003, completed: 0.004,
  finished: 0.004, lint: 0.004, passed: 0.005, running: 0.004, successful: 0.003, successfully: 0.003,
  success: 0.003, tests: 0.004,
};

const PROTECTED_WORDS = new Set([
  "abort", "assertion", "denied", "error", "exception", "fail", "failed",
  "failure", "fatal", "panic", "permission", "refused", "timeout", "traceback",
]);

const TOKEN_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const PROTECTED_SYNTAX = /(?:https?:\/\/|\b(?:[A-Za-z]:)?[/\\]|::|`|"|'|\b\d|\b[A-Za-z]+[A-Z][A-Za-z]*\b|\b[A-Za-z]+_[A-Za-z0-9_]*\b)/;

export interface StaticInformation {
  tokens: string[];
  averageBits: number;
  protected: boolean;
  lowInformation: boolean;
}

/** 未知語は高情報量として扱う。頻度値は開発ログ定型語向けの初期値。 */
export function staticSelfInformation(token: string): number {
  const probability = COMMON_TOKEN_PROBABILITIES[token.toLowerCase()];
  return probability === undefined ? 12 : -Math.log2(probability);
}

export function tokenizeEnglishPhrase(input: string): string[] {
  return input.match(TOKEN_PATTERN) ?? [];
}

export function containsProtectedInformation(input: string, tokens = tokenizeEnglishPhrase(input)): boolean {
  return PROTECTED_SYNTAX.test(input) || tokens.some((token) => PROTECTED_WORDS.has(token.toLowerCase()));
}

/**
 * 低情報候補だけを判定する。削除は呼出側の構文境界・コマンド別規則で決める。
 */
export function analyzeStaticInformation(input: string): StaticInformation {
  const tokens = tokenizeEnglishPhrase(input);
  const protectedInformation = containsProtectedInformation(input, tokens);
  const averageBits = tokens.length === 0
    ? Number.POSITIVE_INFINITY
    : tokens.reduce((total, token) => total + staticSelfInformation(token), 0) / tokens.length;
  const allKnown = tokens.every((token) => COMMON_TOKEN_PROBABILITIES[token.toLowerCase()] !== undefined);
  return {
    tokens,
    averageBits,
    protected: protectedInformation,
    lowInformation: !protectedInformation && tokens.length >= 2 && allKnown && averageBits <= 8,
  };
}
