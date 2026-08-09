declare module "fixture-external" {
  export function externalFunction(value: number): number;
  export class ExternalClass {
    externalMethod(): string;
  }
  export const externalValue: string;
}
