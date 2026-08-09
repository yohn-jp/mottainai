declare module "fixture-external" {
  export function externalFunction(value: number): number;
  export class ExternalClass {
    externalMethod(): string;
  }
  export const externalValue: string;
}

declare module "fixture-external/subpath" {
  export function subpathFunction(value: number): number;
}
