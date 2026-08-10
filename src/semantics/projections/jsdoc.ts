import { compareText, stableStringifyValue } from "../ir/canonical.js";
import type { LogicalId } from "../ir/ids.js";
import type { Contract, JsonValue, RepositorySemanticSnapshot, SemanticEntity, SourceReference } from "../ir/types.js";
import { budgetStructuredProjection, capItems, resolveSemanticProjectionBudget } from "./budget.js";
import {
  createProjectionModel,
  entityReference,
  projectedProvenance,
  relationName,
  sourceReadsFor,
  uniqueReads,
  type ProjectionModel,
} from "./model.js";
import type {
  JsdocConstraint,
  JsdocContradiction,
  JsdocParameter,
  JsdocProjection,
  JsdocProjectionInput,
  JsdocThrows,
  ProjectionOmission,
  ProjectedEntityReference,
  ProjectedText,
  EntityId,
} from "./types.js";

function targetFallback(model: ProjectionModel, targetId: EntityId): ProjectedEntityReference {
  return (
    entityReference(model, targetId) ?? {
      id: targetId,
      kind: "unknown",
      name: targetId,
      authority: "integrity",
      provenance: model.snapshot.declarations.project.provenance,
      authoritative: false,
    }
  );
}

function linkedIds(model: ProjectionModel, targetId: EntityId, kind: string): EntityId[] {
  const subjects = [
    targetId,
    ...model
      .relationsFor(targetId)
      .map((relation) => (relation.from === targetId ? relation.to : relation.from))
      .filter((id) => model.entity(id)?.kind === "component"),
  ];
  const ids = new Set<EntityId>();
  for (const subject of subjects) {
    for (const relation of model.relationsFor(subject)) {
      const other = relation.from === subject ? relation.to : relation.from;
      if (model.entity(other)?.kind === kind) ids.add(other);
    }
  }
  return [...ids].sort(compareText);
}

function targetComponent(model: ProjectionModel, targetId: EntityId): SemanticEntity | undefined {
  const target = model.entity(targetId);
  if (target?.kind === "component") return target;
  const owner = model.relationsFor(targetId).find((relation) => {
    const other = relation.from === targetId ? relation.to : relation.from;
    return model.entity(other)?.kind === "component" && ["owns", "shares"].includes(relationName(relation.kind));
  });
  return owner === undefined ? undefined : model.entity(owner.from === targetId ? owner.to : owner.from);
}

function exactSignature(model: ProjectionModel, targetId: EntityId): JsdocProjection["exactSignature"] {
  const target = model.entity(targetId);
  if (target?.kind !== "symbol") return undefined;
  const locatorSignature = target.locator.signature;
  if (locatorSignature !== undefined) {
    return {
      value: locatorSignature,
      sourceId: target.id,
      provenance: target.provenance,
      authoritative: model.authoritative("derived", target.provenance),
    };
  }
  const fact = model
    .factsFor(targetId)
    .find((item) => item.predicate === "symbol.signature" && typeof item.value === "string");
  if (fact !== undefined && typeof fact.value === "string") {
    return {
      value: fact.value,
      sourceId: fact.id,
      provenance: fact.provenance,
      authoritative: model.authoritative(fact.authority, fact.provenance),
    };
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  return stableStringifyValue(value);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

function contradiction(
  field: string,
  contracts: readonly { id: EntityId; value: JsonValue | undefined }[],
  reason: string,
): JsdocContradiction | undefined {
  const present = contracts.filter((item): item is { id: EntityId; value: JsonValue } => item.value !== undefined);
  const values = [...new Map(present.map((item) => [canonicalJson(item.value), item.value])).values()];
  if (values.length < 2) return undefined;
  return { field, reason, sourceIds: present.map((item) => item.id).sort(compareText), values };
}

function text(model: ProjectionModel, value: string, entity: SemanticEntity): ProjectedText {
  return {
    value,
    authority: entity.authority,
    provenance: entity.provenance,
    authoritative: model.authoritative(entity.authority, entity.provenance),
  };
}

function contractValues(
  contracts: readonly Contract[],
  ids: readonly EntityId[],
  selector: (contract: Contract) => JsonValue | undefined,
): { id: EntityId; value: JsonValue | undefined }[] {
  return contracts.map((contract, index) => ({ id: ids[index] ?? `contract:${index}`, value: selector(contract) }));
}

function projectParameters(contracts: readonly Contract[], ids: readonly EntityId[]): JsdocParameter[] {
  const byName = new Map<string, JsdocParameter>();
  for (const [index, contract] of contracts.entries()) {
    const sourceId = ids[index] ?? `contract:${index}`;
    for (const parameter of contract.inputs.parameters) {
      const existing = byName.get(parameter.name);
      if (existing === undefined) {
        byName.set(parameter.name, { ...parameter, sourceIds: [sourceId] });
      } else {
        byName.set(parameter.name, {
          ...existing,
          type: existing.type === parameter.type ? existing.type : undefined,
          required: existing.required === parameter.required ? existing.required : undefined,
          domain: existing.domain === parameter.domain ? existing.domain : undefined,
          sourceIds: [...new Set([...existing.sourceIds, sourceId])].sort(compareText),
        });
      }
    }
  }
  return [...byName.values()].sort((left, right) => compareText(left.name, right.name));
}

function projectConstraints(
  model: ProjectionModel,
  targetId: EntityId,
  contracts: readonly Contract[],
  contractIds: readonly EntityId[],
): JsdocConstraint[] {
  const constraints: JsdocConstraint[] = [];
  for (const [index, contract] of contracts.entries()) {
    const sourceId = contractIds[index] ?? `contract:${index}`;
    for (const assertion of [
      ...contract.inputs.acceptedDomain,
      ...contract.inputs.preconditions,
      ...contract.outputs.postconditions,
    ]) {
      constraints.push({ text: assertion.description ?? assertion.expression, sourceIds: [sourceId] });
    }
  }
  const invariantIds = linkedIds(model, targetId, "invariant");
  for (const id of invariantIds) {
    const invariant = model.entity(id);
    if (invariant?.kind === "invariant") constraints.push({ text: invariant.statement, sourceIds: [id] });
  }
  return constraints.sort((left, right) =>
    compareText(`${left.text}:${left.sourceIds.join(",")}`, `${right.text}:${right.sourceIds.join(",")}`),
  );
}

function projectThrows(contracts: readonly Contract[], ids: readonly EntityId[]): JsdocThrows[] {
  const result: JsdocThrows[] = [];
  for (const [index, contract] of contracts.entries()) {
    const sourceId = ids[index] ?? `contract:${index}`;
    for (const error of contract.outputs.errors) result.push({ ...error, sourceIds: [sourceId] });
  }
  return result.sort((left, right) =>
    compareText(`${left.type}:${left.condition ?? ""}`, `${right.type}:${right.condition ?? ""}`),
  );
}

function sourceReads(
  model: ProjectionModel,
  targetId: EntityId,
  max: number,
): { reads: SourceReference[]; omission?: ProjectionOmission } {
  const reads = uniqueReads([
    ...sourceReadsFor(model, targetId),
    ...linkedIds(model, targetId, "contract").flatMap((id) => sourceReadsFor(model, id)),
  ]);
  const bounded = capItems(
    reads,
    max,
    "recommendedSourceReads",
    "additional exact signature/declaration reads omitted",
    "navigation",
  );
  return { reads: [...bounded.items], omission: bounded.omission };
}

export function projectJsdoc(input: JsdocProjectionInput): JsdocProjection {
  const model = createProjectionModel(input.snapshot);
  const options = input.options ?? {};
  const resolved = resolveSemanticProjectionBudget(options);
  const target = targetFallback(model, input.targetId);
  const contractIds = linkedIds(model, input.targetId, "contract");
  const contracts = contractIds
    .map((id) => model.entity(id))
    .filter((entity): entity is Extract<SemanticEntity, { kind: "contract" }> => entity?.kind === "contract")
    .map((entity) => entity.definition);
  const contradictions: JsdocContradiction[] = [];
  const parameterValues = contractValues(contracts, contractIds, (contract) => toJsonValue(contract.inputs.parameters));
  const returnValues = contractValues(contracts, contractIds, (contract) => contract.outputs.returnValue);
  const errorValues = contractValues(contracts, contractIds, (contract) => toJsonValue(contract.outputs.errors));
  for (const item of [
    contradiction("parameters", parameterValues, "linked declared contracts disagree about API parameters"),
    contradiction("returns", returnValues, "linked declared contracts disagree about the return guarantee"),
    contradiction("throws", errorValues, "linked declared contracts disagree about the error domain"),
  ])
    if (item !== undefined) contradictions.push(item);
  const stabilityValues = input.snapshot.declarations.stability
    .filter((item) => [input.targetId, ...linkedIds(model, input.targetId, "component")].includes(item.subject))
    .map((item) => ({ id: item.subject, value: item.stability as JsonValue }));
  const stabilityContradiction = contradiction("stability", stabilityValues, "declared stability values conflict");
  if (stabilityContradiction !== undefined) contradictions.push(stabilityContradiction);
  if (model.status === "invalid")
    contradictions.push({
      field: "model",
      reason: "invalid model state cannot be rendered as authoritative JSDoc",
      sourceIds: [],
      values: [],
    });
  const component = targetComponent(model, input.targetId);
  const summary = component?.kind === "component" ? text(model, component.responsibility, component) : undefined;
  const exact = exactSignature(model, input.targetId);
  const returns =
    returnValues.filter((item) => item.value !== undefined).length === 0 ||
    contradictions.some((item) => item.field === "returns")
      ? undefined
      : {
          value: (() => {
            const found = returnValues.find((item) => item.value !== undefined)?.value;
            return typeof found === "string" ? found : stableStringifyValue(found);
          })(),
          sourceIds: returnValues.filter((item) => item.value !== undefined).map((item) => item.id),
        };
  const stability =
    stabilityValues.length === 0 || stabilityContradiction !== undefined
      ? undefined
      : { value: String(stabilityValues[0]!.value), sourceIds: stabilityValues.map((item) => item.id) };
  const throws = contradictions.some((item) => item.field === "throws") ? [] : projectThrows(contracts, contractIds);
  const reads = sourceReads(model, input.targetId, resolved.maxSourceReads);
  const base: Record<string, unknown> = {
    apiVersion: 1,
    kind: "jsdoc",
    canonicalLanguage: "en",
    locale: options.locale ?? "en",
    target,
    model: model.state,
    ...(exact === undefined ? {} : { exactSignature: exact }),
    ...(summary === undefined ? {} : { summary }),
    source: {
      available: false,
      reason: "JSDoc is a disposable semantic projection; raw source bodies are never included",
    },
    provenance: projectedProvenance(
      model,
      model.status === "fresh" ? "declared" : "integrity",
      "JSDoc projection from declared semantics plus exact derived signature facts",
    ),
  };
  const groups = [
    {
      field: "parameters",
      value: contradictions.some((item) => item.field === "parameters")
        ? []
        : projectParameters(contracts, contractIds),
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "parameters omitted because declarations contradict or budget is exhausted",
    },
    {
      field: "constraints",
      value: projectConstraints(model, input.targetId, contracts, contractIds),
      priority: "semantic" as const,
      emptyValue: [],
      omissionReason: "constraints omitted under response budget",
    },
    ...(returns === undefined
      ? []
      : [
          {
            field: "returns",
            value: returns,
            priority: "semantic" as const,
            emptyValue: undefined,
            omissionReason: "return guarantee omitted under response budget",
          },
        ]),
    {
      field: "throws",
      value: throws,
      priority: "semantic" as const,
      emptyValue: [],
      omissionReason: "throws domain omitted under response budget",
    },
    ...(stability === undefined
      ? []
      : [
          {
            field: "stability",
            value: stability,
            priority: "semantic" as const,
            emptyValue: undefined,
            omissionReason: "stability omitted under response budget",
          },
        ]),
    ...(stability?.value === "deprecated"
      ? [
          {
            field: "deprecation",
            value: { value: "This API is deprecated.", sourceIds: stability.sourceIds },
            priority: "semantic" as const,
            emptyValue: undefined,
            omissionReason: "deprecation omitted under response budget",
          },
        ]
      : []),
    {
      field: "contradictions",
      value: contradictions,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "contradiction diagnostics omitted under response budget",
      count: contradictions.length,
    },
    {
      field: "recommendedSourceReads",
      value: reads.reads,
      priority: "required" as const,
      emptyValue: [],
      omissionReason: "exact declaration/signature reads omitted under response budget",
      count: reads.reads.length,
    },
  ];
  const initialOmissions: ProjectionOmission[] = reads.omission === undefined ? [] : [reads.omission];
  const bounded = budgetStructuredProjection(base, groups, resolved, initialOmissions);
  return {
    ...bounded.value,
    apiVersion: 1,
    kind: "jsdoc",
    omissions: bounded.omissions,
    budget: bounded.budget,
  } as JsdocProjection;
}

export const projectJSDoc = projectJsdoc;
export const projectJSDocProjection = projectJsdoc;

export function unavailableJsdocProjection(targetId: EntityId, reason: string): JsdocProjection {
  const provenance = {
    kind: "inferred" as const,
    producer: { name: "mottainai-semantic-projections", version: "1" },
    sourceRevision: { repositoryId: "unknown" as LogicalId },
    completeness: "unknown" as const,
  };
  return {
    apiVersion: 1,
    kind: "jsdoc",
    canonicalLanguage: "en",
    locale: "en",
    target: { id: targetId, kind: "unknown", name: targetId, authority: "integrity", provenance, authoritative: false },
    model: { status: "unavailable", integrity: "invalid", authoritative: false, reason },
    parameters: [],
    constraints: [],
    throws: [],
    contradictions: [{ field: "model", reason, sourceIds: [], values: [] }],
    recommendedSourceReads: [],
    source: { available: false, reason },
    provenance: {
      provider: "mottainai-semantic-projections",
      authority: "integrity",
      status: "unavailable",
      authoritative: false,
      note: reason,
    },
    omissions: [],
    budget: { softTokens: 0, hardTokens: 0, hardBytes: 0, projectedBytes: 0, projectedTokens: 0, truncated: false },
  };
}
