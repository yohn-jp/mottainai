import type { BoundaryOperations } from "../boundary.js";

export interface FaultSpec {
  /** Fail this operation this many times, starting with its first invocation. */
  times?: number;
  error?: Error;
}

/**
 * Deterministic operation fault controller for integration tests.
 * It is test infrastructure only and is never read from runtime configuration.
 */
export class FaultInjector implements BoundaryOperations {
  private readonly remaining = new Map<string, number>();
  private readonly errors = new Map<string, Error>();
  readonly calls = new Map<string, number>();

  constructor(specs: Record<string, FaultSpec | number> = {}) {
    for (const [operation, spec] of Object.entries(specs)) {
      const normalized = typeof spec === "number" ? { times: spec } : spec;
      this.remaining.set(operation, normalized.times ?? 1);
      this.errors.set(operation, normalized.error ?? new Error(`injected failure: ${operation}`));
    }
  }

  arm(operation: string, spec: FaultSpec | number = 1): void {
    const normalized = typeof spec === "number" ? { times: spec } : spec;
    this.remaining.set(operation, normalized.times ?? 1);
    this.errors.set(operation, normalized.error ?? new Error(`injected failure: ${operation}`));
  }

  file<T>(operation: string, action: () => T): T {
    return this.invoke(operation, action);
  }

  process<T>(operation: string, action: () => T): T {
    return this.invoke(operation, action);
  }

  storage<T>(operation: string, action: () => T): T {
    return this.invoke(operation, action);
  }

  private invoke<T>(operation: string, action: () => T): T {
    this.calls.set(operation, (this.calls.get(operation) ?? 0) + 1);
    const remaining = this.remaining.get(operation) ?? 0;
    if (remaining > 0) {
      this.remaining.set(operation, remaining - 1);
      throw this.errors.get(operation) ?? new Error(`injected failure: ${operation}`);
    }
    return action();
  }
}
