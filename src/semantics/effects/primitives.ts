import type { EffectId } from "../ir/types.js";
import type { EffectOperation, EffectPrimitiveAdapter, ResolvedSymbolIdentity } from "./types.js";

export interface ModuleEffectRule {
  module: string;
  paths: readonly string[];
  effects: readonly EffectId[];
  operations?: readonly EffectOperation[];
}

const fsRead = [
  "access",
  "accessSync",
  "createReadStream",
  "exists",
  "existsSync",
  "fstat",
  "fstatSync",
  "lstat",
  "lstatSync",
  "open",
  "openSync",
  "read",
  "readSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "realpath",
  "realpathSync",
  "stat",
  "statSync",
  "watch",
  "watchFile",
];
const fsWrite = [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
];

const effect = {
  filesystemRead: "filesystem.read" as EffectId,
  filesystemWrite: "filesystem.write" as EffectId,
  networkRead: "network.read" as EffectId,
  networkWrite: "network.write" as EffectId,
  processSpawn: "process.spawn" as EffectId,
  processState: "process.state" as EffectId,
  environmentRead: "environment.read" as EffectId,
  environmentWrite: "environment.write" as EffectId,
  clockRead: "clock.read" as EffectId,
  randomnessRead: "randomness.read" as EffectId,
  gitRead: "git.read" as EffectId,
  gitWrite: "git.write" as EffectId,
  databaseRead: "database.read" as EffectId,
  databaseWrite: "database.write" as EffectId,
  consoleWrite: "console.write" as EffectId,
};

function modulePath(identity: ResolvedSymbolIdentity): string {
  return identity.exportPath.filter((part) => part !== "default").join(".");
}

function matchesRule(identity: ResolvedSymbolIdentity, rule: ModuleEffectRule): boolean {
  if (identity.module !== rule.module) return false;
  const path = modulePath(identity);
  return rule.paths.some((candidate) => path === candidate || path.startsWith(`${candidate}.`));
}

export function createModuleEffectAdapter(id: string, rules: readonly ModuleEffectRule[]): EffectPrimitiveAdapter {
  return {
    id,
    resolve: (context) => resolveRules(rules, context),
  };
}

function resolveRules(
  rules: readonly ModuleEffectRule[],
  context: Parameters<EffectPrimitiveAdapter["resolve"]>[0],
): readonly EffectId[] {
  const matched = rules.filter(
    (rule) =>
      (rule.operations === undefined || rule.operations.includes(context.operation)) &&
      matchesRule(context.identity, rule),
  );
  return [...new Set(matched.flatMap((rule) => rule.effects))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function rulesForModules(
  modules: readonly string[],
  paths: readonly string[],
  effects: readonly EffectId[],
  operations: readonly EffectOperation[] = ["call"],
): ModuleEffectRule[] {
  return modules.map((module) => ({ module, paths, effects, operations }));
}

let defaultRulesCache: readonly ModuleEffectRule[] | undefined;

function defaultRules(): readonly ModuleEffectRule[] {
  if (defaultRulesCache !== undefined) return defaultRulesCache;
  const rules: ModuleEffectRule[] = [
    ...rulesForModules(["node:fs", "node:fs/promises"], fsRead, [effect.filesystemRead]),
    ...rulesForModules(["node:fs", "node:fs/promises"], fsWrite, [effect.filesystemWrite]),
    ...rulesForModules(["node:http", "node:https"], ["request", "get"], [effect.networkRead, effect.networkWrite]),
    ...rulesForModules(
      ["node:net", "node:tls"],
      ["connect", "createConnection"],
      [effect.networkRead, effect.networkWrite],
    ),
    { module: "node:dgram", paths: ["send"], effects: [effect.networkWrite], operations: ["call"] },
    { module: "node:dgram", paths: ["recvmsg"], effects: [effect.networkRead], operations: ["call"] },
    {
      module: "global:fetch",
      paths: ["fetch"],
      effects: [effect.networkRead, effect.networkWrite],
      operations: ["call"],
    },
    {
      module: "global:WebSocket",
      paths: ["WebSocket"],
      effects: [effect.networkRead, effect.networkWrite],
      operations: ["construct"],
    },
    ...rulesForModules(
      ["node:child_process"],
      ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
      [effect.processSpawn],
    ),
    ...rulesForModules(
      ["node:process"],
      ["abort", "chdir", "cwd", "exit", "kill", "nextTick", "umask"],
      [effect.processState],
    ),
    ...rulesForModules(
      ["node:process"],
      [
        "argv",
        "config",
        "cpuUsage",
        "env",
        "execArgv",
        "execPath",
        "hrtime",
        "memoryUsage",
        "pid",
        "platform",
        "release",
        "resourceUsage",
        "title",
        "uptime",
        "version",
        "versions",
      ],
      [effect.processState],
    ),
    { module: "node:process", paths: ["process.env"], effects: [effect.environmentRead], operations: ["read"] },
    { module: "node:process", paths: ["env"], effects: [effect.environmentRead], operations: ["read"] },
    { module: "node:process", paths: ["process.env"], effects: [effect.environmentWrite], operations: ["write"] },
    { module: "node:process", paths: ["env"], effects: [effect.environmentWrite], operations: ["write"] },
    { module: "global:Date", paths: ["Date"], effects: [effect.clockRead], operations: ["construct", "call"] },
    { module: "global:Date", paths: ["now"], effects: [effect.clockRead], operations: ["call"] },
    { module: "global:performance", paths: ["now"], effects: [effect.clockRead], operations: ["call"] },
    { module: "node:perf_hooks", paths: ["performance.now"], effects: [effect.clockRead], operations: ["call"] },
    { module: "node:process", paths: ["hrtime"], effects: [effect.clockRead], operations: ["call"] },
    { module: "global:Math", paths: ["random"], effects: [effect.randomnessRead], operations: ["call"] },
    ...rulesForModules(
      ["node:crypto"],
      [
        "randomBytes",
        "randomFill",
        "randomFillSync",
        "randomInt",
        "randomUUID",
        "getRandomValues",
        "generateKey",
        "generateKeyPair",
        "generateKeyPairSync",
      ],
      [effect.randomnessRead],
    ),
    {
      module: "node:console",
      paths: [
        "console.log",
        "log",
        "debug",
        "error",
        "info",
        "warn",
        "dir",
        "table",
        "trace",
        "group",
        "groupEnd",
        "groupCollapsed",
        "time",
        "timeEnd",
        "timeLog",
        "assert",
        "clear",
        "count",
        "countReset",
      ],
      effects: [effect.consoleWrite],
      operations: ["call"],
    },
    {
      module: "global:console",
      paths: [
        "console.log",
        "console.debug",
        "console.error",
        "console.info",
        "console.warn",
        "console.dir",
        "console.table",
        "console.trace",
        "console.group",
        "console.groupEnd",
        "console.groupCollapsed",
        "console.time",
        "console.timeEnd",
        "console.timeLog",
        "console.assert",
        "console.clear",
        "console.count",
        "console.countReset",
        "log",
        "debug",
        "error",
        "info",
        "warn",
        "dir",
        "table",
        "trace",
        "group",
        "groupEnd",
        "groupCollapsed",
        "time",
        "timeEnd",
        "timeLog",
        "assert",
        "clear",
        "count",
        "countReset",
      ],
      effects: [effect.consoleWrite],
      operations: ["call"],
    },
    ...rulesForModules(
      ["node:sqlite"],
      ["DatabaseSync", "DatabaseSync.exec", "DatabaseSync.prepare", "exec", "run", "prepare"],
      [effect.databaseWrite],
    ),
    ...rulesForModules(["node:sqlite"], ["get", "all", "iterate", "columns"], [effect.databaseRead]),
    ...rulesForModules(
      ["better-sqlite3"],
      ["Database", "Database.prepare", "Database.exec", "Database.run"],
      [effect.databaseWrite],
    ),
    ...rulesForModules(
      ["better-sqlite3"],
      ["Statement.get", "Statement.all", "Statement.iterate"],
      [effect.databaseRead],
    ),
    ...rulesForModules(
      ["pg", "mysql2", "@libsql/client", "mongodb", "redis"],
      ["query", "execute", "run", "get", "all", "find", "findOne", "scan"],
      [effect.databaseRead, effect.databaseWrite],
    ),
    ...rulesForModules(
      ["simple-git"],
      [
        "status",
        "log",
        "diff",
        "show",
        "branch",
        "raw",
        "simpleGit.status",
        "simpleGit.log",
        "simpleGit.diff",
        "simpleGit.show",
        "simpleGit.branch",
        "simpleGit.raw",
      ],
      [effect.gitRead],
    ),
    ...rulesForModules(
      ["simple-git"],
      [
        "add",
        "commit",
        "push",
        "pull",
        "checkout",
        "branch",
        "reset",
        "merge",
        "rebase",
        "tag",
        "rm",
        "simpleGit.add",
        "simpleGit.commit",
        "simpleGit.push",
        "simpleGit.pull",
        "simpleGit.checkout",
        "simpleGit.reset",
        "simpleGit.merge",
        "simpleGit.rebase",
        "simpleGit.tag",
        "simpleGit.rm",
      ],
      [effect.gitWrite],
    ),
    ...rulesForModules(["isomorphic-git"], ["status", "log", "readBlob", "resolveRef", "listFiles"], [effect.gitRead]),
    ...rulesForModules(
      ["isomorphic-git"],
      ["add", "commit", "push", "checkout", "writeBlob", "writeRef", "deleteRef"],
      [effect.gitWrite],
    ),
  ];
  defaultRulesCache = rules;
  return rules;
}

export const DEFAULT_EFFECT_PRIMITIVE_ADAPTER: EffectPrimitiveAdapter = {
  id: "node-and-common-adapters",
  resolve: (context) => resolveRules(defaultRules(), context),
};

export const EFFECT_IDS = Object.freeze(effect);
