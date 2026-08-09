export interface Contract {
  value: number;
}

export type ContractAlias = Contract;

export function topLevel(value: number): number {
  return value + 1;
}

export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number {
  return typeof value === "string" ? value.toUpperCase() : value + 1;
}

export class BaseBox {
  private hidden = 1;
  protected protectedValue = 2;

  public method(value: number): number {
    return value + this.hidden + this.protectedValue;
  }
}

export class DerivedBox extends BaseBox implements Contract {
  public value: number;

  public constructor(value: number) {
    super();
    this.value = value;
  }
}

export const exportedConstant = 3;
const hiddenConstant = 4;

/** This comment is intentionally not a semantic input. */
export function nestedCaller(value: number): number {
  function nestedLocal(input: number): number {
    return input + hiddenConstant;
  }
  return nestedLocal(value);
}

export function sameName(value: number): number {
  return value + 10;
}
