import type { RepositorySemanticSnapshot, SymbolEntity, SymbolLocator } from "../ir/types.js";
import type { BindingResolution, SymbolBindingResolver } from "./types.js";

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || left === right;
}

function sameRange(left: SymbolLocator["range"], right: SymbolLocator["range"]): boolean {
  if (left === undefined) return true;
  if (right === undefined || left.start.line !== right.start.line || left.start.column !== right.start.column)
    return false;
  if (left.end === undefined) return true;
  return right.end !== undefined && left.end.line === right.end.line && left.end.column === right.end.column;
}

function matches(locator: SymbolLocator, candidate: SymbolEntity): boolean {
  const target = candidate.locator;
  return (
    locator.language === target.language &&
    sameOptional(locator.package, target.package) &&
    sameOptional(locator.module, target.module) &&
    sameOptional(locator.file, target.file) &&
    locator.symbol === target.symbol &&
    sameOptional(locator.signature, target.signature) &&
    sameRange(locator.range, target.range)
  );
}

export function createSnapshotSymbolBindingResolver(snapshot: RepositorySemanticSnapshot): SymbolBindingResolver {
  const symbols = [...snapshot.derived.symbols];
  const revision = snapshot.revisionIdentity?.revision;
  return {
    resolve(locator, expectedRevision): BindingResolution {
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return {
          status: "stale",
          locator,
          message: `Symbol binding targets revision ${expectedRevision}, current revision is ${revision ?? "unknown"}`,
        };
      }
      const candidates = symbols.filter((symbol) => matches(locator, symbol));
      if (candidates.length === 0) return { status: "missing", locator };
      if (candidates.length > 1) {
        return { status: "ambiguous", locator, candidates: candidates.map((candidate) => candidate.id) };
      }
      const symbol = candidates[0]!;
      return { status: "resolved", symbolId: symbol.id, locator: symbol.locator };
    },
  };
}

export function createFixtureSymbolBindingResolver(snapshot: RepositorySemanticSnapshot): SymbolBindingResolver {
  return createSnapshotSymbolBindingResolver(snapshot);
}
