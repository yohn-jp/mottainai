import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HookRepository, HookWorktree } from "./types.js";

export interface TrustedHookContextInput {
  workspaceRoot: string;
  /** This value is a process/configuration boundary, not a client event field. */
  workingDirectory?: string;
  branch?: string;
}

export interface TrustedHookContext {
  repository?: HookRepository;
  worktree?: HookWorktree;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Derive repository/worktree identity from validated local paths. */
export function deriveTrustedHookContext(input: TrustedHookContextInput): TrustedHookContext {
  try {
    const root = fs.realpathSync(path.resolve(input.workspaceRoot));
    const workingDirectory = fs.realpathSync(path.resolve(input.workingDirectory ?? root));
    if (!inside(root, workingDirectory)) return {};
    const identity = `repo_${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
    return {
      repository: { root, identity },
      worktree: { root: workingDirectory, ...(input.branch === undefined ? {} : { branch: input.branch.slice(0, 128) }) },
    };
  } catch {
    return {};
  }
}
