export {
  analyzeSemanticDelta,
  compareRepositorySnapshots,
  compareSemanticSnapshots,
  computeSemanticChangeSet,
  projectSemanticChangeSet,
} from "./engine.js";
export { parseSemanticChangeSet, serializeSemanticChangeSet, validateSemanticChangeSet } from "./serialize.js";
export type {
  AuthorizedActualComparison,
  ChangeKind,
  CompatibilityResult,
  DerivedChange,
  EffectInputs,
  EvidenceRefreshNeed,
  IdentityStatus,
  ImpactPath,
  PropagationStopPoint,
  SemanticChangeSet,
  SemanticDeltaRecord,
  SemanticDiffInput,
  SemanticDiffOptions,
  SymbolChange,
  TransactionComparisonStatus,
  UnknownRegion,
} from "./types.js";
export { DIFF_ENGINE_PRODUCER, SEMANTIC_CHANGE_SET_VERSION } from "./types.js";
