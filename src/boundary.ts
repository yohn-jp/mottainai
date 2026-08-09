/**
 * Critical boundary operations are routed through this tiny internal seam.
 * The production implementation executes the supplied operation directly;
 * tests can replace the seam without changing runtime configuration or
 * monkey-patching Node globals.
 */
export interface BoundaryOperations {
  file<T>(operation: string, action: () => T): T;
  process<T>(operation: string, action: () => T): T;
  storage<T>(operation: string, action: () => T): T;
}

export const DIRECT_BOUNDARIES: BoundaryOperations = Object.freeze({
  file<T>(_operation: string, action: () => T): T {
    return action();
  },
  process<T>(_operation: string, action: () => T): T {
    return action();
  },
  storage<T>(_operation: string, action: () => T): T {
    return action();
  },
});

export interface SecondaryBoundaryDiagnostic {
  operation: string;
  message: string;
}

export interface BoundaryAnnotatedError extends Error {
  secondaryDiagnostics?: SecondaryBoundaryDiagnostic[];
}

/** Preserve the primary error while attaching cleanup evidence separately. */
export function addSecondaryDiagnostic(primary: unknown, operation: string, secondary: unknown): Error {
  const error: BoundaryAnnotatedError =
    primary instanceof Error ? (primary as BoundaryAnnotatedError) : new Error(String(primary));
  const diagnostics = error.secondaryDiagnostics ?? [];
  error.secondaryDiagnostics = [
    ...diagnostics,
    { operation, message: secondary instanceof Error ? secondary.message : String(secondary) },
  ];
  return error;
}
