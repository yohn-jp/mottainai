import type { HookClientAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

export const hookAdapters: readonly HookClientAdapter[] = Object.freeze([claudeAdapter, codexAdapter]);

export function adapterForClient(client: string): HookClientAdapter | undefined {
  return hookAdapters.find((adapter) => adapter.client === client);
}

export { claudeAdapter } from "./claude.js";
export { codexAdapter } from "./codex.js";
export type * from "./types.js";
