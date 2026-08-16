/**
 * The packaged Pi extension used by managed Manager sessions.
 *
 * Keep this asset self-contained: Pi loads it outside Mottainai's Node module
 * graph, and a missing/broken asset must never be replaced by an unguarded
 * launch. The classifier deliberately covers known workflow mutation classes;
 * it is not a general shell parser or sandbox.
 */

export const PI_GUARD_ASSET_MARKER = "mottainai-managed-pi-guard-v1";
const MAX_REASON_LENGTH = 512;

export type PiGuardCategory =
  | "allowed"
  | "invalid-input"
  | "git-commit"
  | "git-push"
  | "git-branch"
  | "git-worktree"
  | "git-reset"
  | "git-clean"
  | "git-repository"
  | "git-history"
  | "git-staging"
  | "github-pr-write"
  | "github-issue-write"
  | "github-api-write";

export interface PiGuardDecision {
  allowed: boolean;
  category: PiGuardCategory;
  reason?: string;
  replacement?: string;
}

type ShellSegment = string[];

function allow(): PiGuardDecision {
  return { allowed: true, category: "allowed" };
}

function block(category: Exclude<PiGuardCategory, "allowed">, detail: string, replacement?: string): PiGuardDecision {
  const action = replacement === undefined ? "Use the Mottainai/gh-inari governed workflow" : `Use ${replacement}`;
  return {
    allowed: false,
    category,
    ...(replacement === undefined ? {} : { replacement }),
    reason: `Mottainai managed Pi guard blocked ${detail}. ${action}.`.slice(0, MAX_REASON_LENGTH),
  };
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash < 0 ? value : value.slice(slash + 1);
}

function flushWord(words: string[], current: string[]): void {
  if (current.length > 0) {
    words.push(current.join(""));
    current.length = 0;
  }
}

/** Split only the shell boundaries needed to identify command invocations. */
function tokenize(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let current: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flushSegment = (): void => {
    flushWord(words, current);
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current.push(character ?? "");
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current.push(character ?? "");
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaped = true;
      else current.push(character ?? "");
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (/\s/u.test(character ?? "")) {
      flushWord(words, current);
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      flushSegment();
      while (index + 1 < command.length && [";", "|", "&"].includes(command[index + 1] ?? "")) index += 1;
      continue;
    }
    current.push(character ?? "");
  }
  if (escaped) current.push("\\");
  flushSegment();
  return segments;
}

function isAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function skipWrapperOptions(words: string[], index: number, optionsWithValue: ReadonlySet<string>): number {
  let next = index;
  while (next < words.length && words[next]?.startsWith("-")) {
    const option = words[next] ?? "";
    next += 1;
    if (optionsWithValue.has(option)) next += 1;
  }
  return next;
}

/** Remove environment assignments and the small set of transparent wrappers. */
function commandWords(segment: ShellSegment): string[] {
  let index = 0;
  while (index < segment.length && isAssignment(segment[index] ?? "")) index += 1;
  while (index < segment.length) {
    const command = segment[index] ?? "";
    if (command === "env") {
      index += 1;
      index = skipWrapperOptions(segment, index, new Set(["-u", "--unset"]));
      while (index < segment.length && isAssignment(segment[index] ?? "")) index += 1;
      continue;
    }
    if (command === "sudo") {
      index += 1;
      index = skipWrapperOptions(segment, index, new Set(["-u", "--user", "-g", "--group", "-D", "--chdir"]));
      continue;
    }
    if (command === "command" || command === "exec" || command === "nohup" || command === "setsid") {
      index += 1;
      if (segment[index] === "--") index += 1;
      continue;
    }
    if (command === "time" || command === "nice") {
      index += 1;
      index = skipWrapperOptions(segment, index, new Set(["-n"]));
      continue;
    }
    return segment.slice(index);
  }
  return [];
}

function gitSubcommand(words: string[]): { subcommand: string | undefined; args: string[] } {
  let index = 1;
  const optionsWithValue = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  while (index < words.length) {
    const option = words[index] ?? "";
    if (option === "--") {
      index += 1;
      break;
    }
    if (!option.startsWith("-")) break;
    index += optionsWithValue.has(option) ? 2 : 1;
  }
  return { subcommand: words[index], args: words.slice(index + 1) };
}

function ghSubcommand(words: string[]): { group: string | undefined; action: string | undefined; args: string[] } {
  let index = 1;
  index = skipWrapperOptions(words, index, new Set(["--repo", "--hostname", "--help"]));
  const group = words[index];
  if (group === undefined) return { group: undefined, action: undefined, args: [] };
  index += 1;
  index = skipWrapperOptions(words, index, new Set(["--repo", "--hostname"]));
  return { group, action: words[index], args: words.slice(index + 1) };
}

function classifyGit(words: string[]): PiGuardDecision {
  const { subcommand, args } = gitSubcommand(words);
  if (subcommand === undefined) return allow();
  if (subcommand === "commit") return block("git-commit", "raw git commit", "mottainai task commit");
  if (subcommand === "push") return block("git-push", "raw git push", "mottainai task push");
  if (subcommand === "branch") {
    const readOnly = new Set([
      "-a",
      "-r",
      "-v",
      "-vv",
      "--list",
      "--show-current",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
    ]);
    if (args.length === 0 || args.every((argument) => readOnly.has(argument) || argument.startsWith("--format=")))
      return allow();
    return block("git-branch", "raw Git branch/worktree mutation", "mottainai task start");
  }
  if (subcommand === "worktree") {
    if (args.length === 0 || args[0] === "list" || (args[0] === "lock" && args[1] === "--dry-run")) return allow();
    return block("git-worktree", "raw Git worktree mutation", "mottainai task start");
  }
  if (subcommand === "reset" || subcommand === "restore")
    return block("git-reset", `raw git ${subcommand}`, "mottainai task status");
  if (subcommand === "clean") return block("git-clean", "raw git clean", "mottainai task cleanup");
  if (["checkout", "switch"].includes(subcommand))
    return block("git-branch", `raw git ${subcommand} branch/worktree mutation`, "mottainai task start");
  if (["merge", "rebase", "cherry-pick", "revert", "pull"].includes(subcommand))
    return block("git-history", `raw git ${subcommand} history mutation`, "mottainai task commit");
  if (["init", "clone", "update-ref", "replace"].includes(subcommand))
    return block("git-repository", `raw git ${subcommand} repository mutation`, "mottainai task start");
  if (subcommand === "add" || subcommand === "rm" || subcommand === "mv")
    return block("git-staging", `raw git ${subcommand} staging mutation`, "mottainai task commit");
  if (subcommand === "tag") {
    const readOnly = new Set(["-l", "--list", "--contains", "--points-at", "--merged", "--no-merged", "-n"]);
    if (args.length === 0 || args.every((argument) => readOnly.has(argument))) return allow();
    return block("git-repository", "raw Git tag mutation", "mottainai task commit");
  }
  if (subcommand === "remote") {
    const action = args.find((argument) => !argument.startsWith("-"));
    if (action === undefined || action === "show" || action === "get-url") return allow();
    return block("git-repository", "raw Git remote mutation", "mottainai task status");
  }
  if (
    ["gc", "fsck", "reflog"].includes(subcommand) &&
    args.some((argument) => /^(expire|delete|drop|prune)/u.test(argument))
  )
    return block("git-repository", "raw Git repository maintenance mutation", "mottainai task status");
  return allow();
}

const PR_WRITES = new Set(["create", "edit", "merge", "close", "reopen", "delete", "ready", "draft", "review"]);
const ISSUE_WRITES = new Set([
  "create",
  "edit",
  "close",
  "reopen",
  "delete",
  "comment",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "transfer",
]);

function classifyGh(words: string[]): PiGuardDecision {
  if (words[1] === "api") {
    const args = words.slice(2);
    const methodIndex = args.findIndex((argument) => argument === "--method" || argument === "-X");
    const method = methodIndex < 0 ? "GET" : (args[methodIndex + 1] ?? "").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) return block("github-api-write", `direct GitHub API ${method} mutation`);
    return allow();
  }
  const { group, action, args } = ghSubcommand(words);
  if (group === "pr" && action !== undefined && PR_WRITES.has(action))
    return block("github-pr-write", `direct gh pr ${action} mutation`, "mottainai task open-pr");
  if (group === "issue" && action !== undefined && ISSUE_WRITES.has(action))
    return block("github-issue-write", `direct gh issue ${action} mutation`);
  if (group === "pr" && action === "checkout")
    return block("git-branch", "gh pr checkout branch mutation", "mottainai task start");
  return allow();
}

function classifySegment(segment: ShellSegment, depth: number): PiGuardDecision {
  if (depth > 3) return allow();
  const words = commandWords(segment);
  const executable = basename(words[0] ?? "");
  if (executable === "bash" || executable === "sh" || executable === "zsh" || executable === "dash") {
    const commandIndex = words.findIndex(
      (word) => word === "-c" || word === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/u.test(word),
    );
    const nested = commandIndex < 0 ? undefined : words[commandIndex + 1];
    return nested === undefined ? allow() : classifyPiBashCommand(nested, depth + 1);
  }
  if (executable === "eval") return classifyPiBashCommand(words.slice(1).join(" "), depth + 1);
  if (executable === "git") return classifyGit(words);
  if (executable === "gh") return classifyGh(words);
  return allow();
}

/** Classify a Pi bash tool input without executing or consulting terminal output. */
export function classifyPiBashCommand(command: unknown, depth = 0): PiGuardDecision {
  if (typeof command !== "string") return block("invalid-input", "a malformed bash tool input");
  for (const segment of tokenize(command)) {
    const decision = classifySegment(segment, depth);
    if (!decision.allowed) return decision;
  }
  return allow();
}

interface PiToolCallEvent {
  toolName?: unknown;
  input?: unknown;
}

interface PiExtensionApi {
  on(event: "tool_call", handler: (event: PiToolCallEvent) => unknown): void;
}

/** Pi extension entry point. Pi invokes this before the built-in bash tool executes. */
export default function mottainaiManagedPiGuard(pi: PiExtensionApi): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    if (typeof event.input !== "object" || event.input === null || Array.isArray(event.input))
      return { block: true, reason: "Mottainai managed Pi guard blocked malformed bash tool input." };
    const command = (event.input as Record<string, unknown>).command;
    const decision = classifyPiBashCommand(command);
    return decision.allowed ? undefined : { block: true, reason: decision.reason };
  });
}
