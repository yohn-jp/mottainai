declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, value: string): void;
}

declare module "node:http" {
  export function request(options: { host: string }): unknown;
}

declare module "node:child_process" {
  export function spawn(command: string, args: string[]): unknown;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:perf_hooks" {
  export const performance: { now(): number };
}

declare module "node:process" {
  const process: { env: Record<string, string | undefined>; cwd(): string };
  export default process;
}
