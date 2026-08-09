import type { LogicalId } from "../ir/ids.js";
import type { RepositorySemanticSnapshot } from "../ir/types.js";
import type { ImpactPath, PropagationStopPoint } from "../diff/types.js";

export interface ImpactPropagationInput {
  baseSnapshot: RepositorySemanticSnapshot;
  headSnapshot: RepositorySemanticSnapshot;
  changedSymbolIds: readonly LogicalId[];
  changedComponentIds: readonly LogicalId[];
  boundaryChangedSymbolIds?: readonly LogicalId[];
  unknownSymbolIds?: readonly LogicalId[];
  maxDepth?: number;
}

export interface ImpactPropagationResult {
  affectedEntities: readonly LogicalId[];
  impactPaths: readonly ImpactPath[];
  stopPoints: readonly PropagationStopPoint[];
  unknownSymbolIds: readonly LogicalId[];
}
