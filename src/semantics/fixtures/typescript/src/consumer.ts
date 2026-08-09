import { topLevel as aliasedTopLevel, overloaded, DerivedBox, ContractAlias } from "./definitions.js";
import { externalFunction, ExternalClass, externalValue } from "fixture-external";

export { topLevel as reExportedTopLevel } from "./definitions.js";
export { externalFunction as reExportedExternal } from "fixture-external";

export function consume(value: number): number {
  const box = new DerivedBox(value);
  const result = aliasedTopLevel(value);
  const external = externalFunction(result);
  const externalObject = new ExternalClass();
  externalObject.externalMethod();
  return external + result + externalValue.length + box.method(value);
}

export function useOverload(value: string): string {
  return overloaded(value);
}

export function shadowed(value: number): number {
  function sameName(input: number): number {
    return input + 1;
  }
  return sameName(value);
}

export function useImportedType(value: ContractAlias): number {
  return value.value;
}
