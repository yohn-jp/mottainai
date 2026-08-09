import type { EffectId } from "../ir/types.js";
import type { EffectDefinition, EffectPrimitiveAdapter, EffectTaxonomy } from "./types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CORE_DEFINITIONS: readonly EffectDefinition[] = [
  {
    id: "filesystem.read" as EffectId,
    domain: "filesystem",
    operation: "read",
    description: "Read filesystem state or content.",
  },
  {
    id: "filesystem.write" as EffectId,
    domain: "filesystem",
    operation: "write",
    description: "Create or mutate filesystem state or content.",
  },
  {
    id: "network.read" as EffectId,
    domain: "network",
    operation: "read",
    description: "Receive data from a network resource.",
  },
  {
    id: "network.write" as EffectId,
    domain: "network",
    operation: "write",
    description: "Send data to a network resource.",
  },
  {
    id: "process.spawn" as EffectId,
    domain: "process",
    operation: "spawn",
    description: "Create or execute an operating-system process.",
  },
  {
    id: "process.state" as EffectId,
    domain: "process",
    operation: "state",
    description: "Read or mutate process lifecycle/state.",
  },
  {
    id: "environment.read" as EffectId,
    domain: "environment",
    operation: "read",
    description: "Read process or host environment state.",
  },
  {
    id: "environment.write" as EffectId,
    domain: "environment",
    operation: "write",
    description: "Mutate process or host environment state.",
  },
  {
    id: "clock.read" as EffectId,
    domain: "clock",
    operation: "read",
    description: "Read wall-clock or monotonic clock state.",
  },
  {
    id: "randomness.read" as EffectId,
    domain: "randomness",
    operation: "read",
    description: "Read nondeterministic random state.",
  },
  { id: "git.read" as EffectId, domain: "git", operation: "read", description: "Read Git repository state." },
  { id: "git.write" as EffectId, domain: "git", operation: "write", description: "Mutate Git repository state." },
  { id: "database.read" as EffectId, domain: "database", operation: "read", description: "Read database state." },
  { id: "database.write" as EffectId, domain: "database", operation: "write", description: "Mutate database state." },
  {
    id: "console.write" as EffectId,
    domain: "console",
    operation: "write",
    description: "Write diagnostic or user-visible console output.",
  },
];

function definitionKey(definition: EffectDefinition): string {
  return `${definition.id}|${definition.domain}|${definition.operation}`;
}

function createTaxonomy(definitions: readonly EffectDefinition[]): EffectTaxonomy {
  const sorted = [...definitions].sort((left, right) => compareText(left.id, right.id));
  const known = new Set(sorted.map((definition) => definition.id));
  return {
    version: 1,
    definitions: sorted,
    isKnown: (effect: EffectId): boolean => known.has(effect),
    extend: (extensions: readonly EffectDefinition[]): EffectTaxonomy => {
      const byKey = new Map(sorted.map((definition) => [definitionKey(definition), definition]));
      for (const extension of extensions) {
        if (byKey.has(definitionKey(extension))) continue;
        byKey.set(definitionKey(extension), extension);
      }
      return createTaxonomy([...byKey.values()]);
    },
  };
}

export const CORE_EFFECT_TAXONOMY: EffectTaxonomy = {
  version: 1,
  definitions: CORE_DEFINITIONS,
  isKnown: (effect: EffectId): boolean => CORE_DEFINITIONS.some((definition) => definition.id === effect),
  extend: (extensions: readonly EffectDefinition[]): EffectTaxonomy =>
    createTaxonomy([...CORE_DEFINITIONS, ...extensions]),
};

export function createEffectTaxonomy(extensions: readonly EffectDefinition[] = []): EffectTaxonomy {
  return CORE_EFFECT_TAXONOMY.extend(extensions);
}

export function effectIdsFromAdapters(
  adapters: readonly EffectPrimitiveAdapter[],
  context: Parameters<EffectPrimitiveAdapter["resolve"]>[0],
): readonly EffectId[] {
  return [...new Set(adapters.flatMap((adapter) => adapter.resolve(context)))].sort(compareText);
}

export const CORE_EFFECT_DEFINITIONS = CORE_DEFINITIONS;
