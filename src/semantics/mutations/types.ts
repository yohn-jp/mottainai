import type {
  CapabilityEntity,
  ComponentEntity,
  ConstraintEntity,
  ContractEntity,
  ContentDigest,
  DecisionEntity,
  DependencyPolicy,
  EffectPolicy,
  InvariantEntity,
  Provenance,
  RationaleEntity,
  RepositorySemanticSnapshot,
  ReviewGuidance,
  SemanticDebtIntent,
  SemanticDeltaKind,
  SemanticDiagnostic,
  SemanticIntent,
  SemanticTransaction,
  StabilityDeclaration,
  SymbolLocator,
  SymbolOwnershipDeclaration,
  TerminologyLink,
} from "../ir/types.js";
import type { LogicalId } from "../ir/ids.js";
import type { SemanticSourceWrite } from "../source/serialization.js";

export type DeclaredEntityInput<T> = Omit<T, "authority" | "provenance">;

/** The mutation boundary receives the complete IR so derived facts remain available for validation. */
export type DeclaredSemanticState = RepositorySemanticSnapshot;

export type SymbolSelector = { symbolId: LogicalId } | { locator: SymbolLocator; expectedRevision?: string };

export type SymbolOwnershipInput =
  | { classification: "managed"; componentId: LogicalId }
  | { classification: "shared"; sharedComponentIds?: readonly LogicalId[] };

export type SemanticMutation =
  | { kind: "component"; component: DeclaredEntityInput<ComponentEntity> }
  | { kind: "symbol-ownership"; symbol: SymbolSelector; ownership: SymbolOwnershipInput }
  | { kind: "capability"; capability: DeclaredEntityInput<CapabilityEntity> }
  | { kind: "contract"; contract: DeclaredEntityInput<ContractEntity> }
  | { kind: "invariant"; invariant: DeclaredEntityInput<InvariantEntity> }
  | { kind: "rationale"; rationale: DeclaredEntityInput<RationaleEntity> }
  | { kind: "constraint"; constraint: DeclaredEntityInput<ConstraintEntity> }
  | { kind: "decision"; decision: DeclaredEntityInput<DecisionEntity> }
  | { kind: "effect-policy"; policy: EffectPolicy }
  | { kind: "dependency-policy"; policy: DependencyPolicy }
  | { kind: "review-guidance"; guidance: ReviewGuidance }
  | { kind: "stability"; declaration: StabilityDeclaration }
  | { kind: "terminology"; link: TerminologyLink }
  | { kind: "semantic-debt"; debt: SemanticDebtIntent };

export interface MutationProvenance {
  actor: string;
  issue?: string;
  task?: string;
  ref?: string;
}

export interface SemanticMutationRequest {
  mutations: readonly SemanticMutation[];
  intent: SemanticIntent;
  reason?: string;
  authorizedDeltaKinds?: readonly SemanticDeltaKind[];
  provenance: MutationProvenance;
  expectedSnapshotDigest?: ContentDigest;
}

export type BindingResolution =
  | { status: "resolved"; symbolId: LogicalId; locator: SymbolLocator }
  | { status: "missing"; locator: SymbolLocator; message?: string }
  | { status: "ambiguous"; locator: SymbolLocator; candidates: readonly LogicalId[]; message?: string }
  | { status: "stale"; locator: SymbolLocator; symbolId?: LogicalId; message?: string };

export interface SymbolBindingResolver {
  resolve(locator: SymbolLocator, expectedRevision?: string): BindingResolution;
}

export interface BindingRequirement {
  selector: SymbolSelector;
  resolution: BindingResolution | { status: "resolved"; symbolId: LogicalId; locator: SymbolLocator };
}

export interface MutationPlan {
  baseSnapshot: RepositorySemanticSnapshot;
  candidateSnapshot?: RepositorySemanticSnapshot;
  request: SemanticMutationRequest;
  baseSnapshotDigest: ContentDigest;
  affectedEntities: readonly LogicalId[];
  protectedChanges: readonly LogicalId[];
  bindingRequirements: readonly BindingRequirement[];
  expectedWrites: readonly SemanticSourceWrite[];
  transaction?: SemanticTransaction;
  diagnostics: readonly SemanticDiagnostic[];
}

export type MutationValidationResult =
  | { ok: true; snapshot: RepositorySemanticSnapshot; diagnostics: readonly SemanticDiagnostic[] }
  | { ok: false; diagnostics: readonly SemanticDiagnostic[] };

export type SemanticMutationResult =
  | {
      ok: true;
      snapshot: RepositorySemanticSnapshot;
      transaction: SemanticTransaction;
      writes: readonly SemanticSourceWrite[];
      affectedEntities: readonly LogicalId[];
      protectedChanges: readonly LogicalId[];
    }
  | { ok: false; diagnostics: readonly SemanticDiagnostic[] };

export interface SemanticMutationService {
  plan(request: SemanticMutationRequest): MutationPlan;
  apply(plan: MutationPlan): SemanticMutationResult;
  validate(state: DeclaredSemanticState): MutationValidationResult;
  getSnapshot(): RepositorySemanticSnapshot;
}

export const MUTATION_ENGINE_PRODUCER: Provenance["producer"] = {
  name: "mottainai-semantic-mutation-engine",
  version: "1.0.0",
};

export type { SymbolOwnershipDeclaration };
