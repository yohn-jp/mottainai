declare module "simple-git" {
  export function status(): Promise<unknown>;
  export function add(path: string): Promise<unknown>;
}

declare module "pg" {
  export function query(sql: string): Promise<unknown>;
}

declare module "mystery-effects" {
  export function mystery(): unknown;
}
