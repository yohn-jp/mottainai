import type { EffectId, KnownNodeKind, SymbolLocator } from "./types.js";

export type LogicalId = string & { readonly __logicalId: unique symbol };

/** namespace:local の論理ID。range/content hashは許可する構造に含めない。 */
export const LOGICAL_ID_PATTERN = /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._~+/@#:%-]*$/;
export const EFFECT_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;

export function isLogicalId(value: unknown): value is LogicalId {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value);
}

export function createLogicalId(namespace: string, localId: string): LogicalId {
  if (!/^[a-z][a-z0-9_-]*$/.test(namespace)) throw new Error("invalid logical id namespace");
  if (localId.length === 0 || /\s/.test(localId)) throw new Error("invalid logical id value");
  const value = `${namespace}:${localId}`;
  if (!isLogicalId(value)) throw new Error("invalid logical id value");
  return value;
}

export function logicalIdNamespace(id: LogicalId): string {
  return id.slice(0, id.indexOf(":"));
}

export function createRepositoryId(canonicalName: string): LogicalId {
  return createLogicalId("repo", canonicalName);
}

export function createRevisionId(revision: string): LogicalId {
  return createLogicalId("revision", revision);
}

/** node kindからlogical IDのnamespaceを求める。repositoryだけrepo namespaceに写像する。 */
export function namespaceForNodeKind(kind: string): string {
  return kind === "repository" ? "repo" : kind;
}

export function createNodeId(kind: KnownNodeKind | string, localId: string): LogicalId {
  return createLogicalId(namespaceForNodeKind(kind), localId);
}

export function createFactId(localId: string): LogicalId {
  return createLogicalId("fact", localId);
}

export function createClaimId(localId: string): LogicalId {
  return createLogicalId("claim", localId);
}

export function createEdgeId(localId: string): LogicalId {
  return createLogicalId("edge", localId);
}

export function createEffectId(value: string): EffectId {
  if (!EFFECT_ID_PATTERN.test(value)) throw new Error("invalid effect id");
  return value as EffectId;
}

export function isEffectId(value: unknown): value is EffectId {
  return typeof value === "string" && EFFECT_ID_PATTERN.test(value);
}

const idPartEncoder = new TextEncoder();

/** IDに使えない文字だけを安定的にescapeする。1バイトにつき固定2桁hexで単射を保つ。source rangeは引数に含めない。 */
function encodeIdPart(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field} must be non-empty`);
  return [...value].map((character) => {
    if (/[A-Za-z0-9._~+/@-]/.test(character)) return character;
    return [...idPartEncoder.encode(character)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  }).join("");
}

/** 言語非依存の物理locatorから、rangeを除外した論理symbol IDを作る。package/moduleは固定位置に置き、欠落と空文字を区別する。 */
export function createSymbolId(locator: Pick<SymbolLocator, "kind" | "language" | "package" | "module" | "file" | "symbol" | "signature" | "range">): LogicalId {
  const coordinates = [
    encodeIdPart(locator.language, "language"),
    locator.package === undefined ? "" : encodeIdPart(locator.package, "package"),
    locator.module === undefined ? "" : encodeIdPart(locator.module, "module"),
  ];
  const symbol = encodeIdPart(locator.symbol, "symbol");
  const file = locator.file === undefined ? undefined : encodeIdPart(locator.file, "file");
  const symbolCoordinate = `${file === undefined ? "" : `${file}#`}${symbol}${locator.signature === undefined ? "" : `~${encodeIdPart(locator.signature, "signature")}`}`;
  coordinates.push(symbolCoordinate);
  return createLogicalId("symbol", coordinates.join(":"));
}
