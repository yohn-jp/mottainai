export function anyMediated(target: unknown, value: number): unknown {
  const callable = JSON.parse(String(target));
  return callable(value);
}

export function computedCall(values: Record<string, () => number>, key: string): number {
  return values[key]();
}

export async function unresolvedImport(name: string): Promise<unknown> {
  return import(name);
}
