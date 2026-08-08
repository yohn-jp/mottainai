interface BranchGovernanceAuthority {
  validateBranchName(branch: string): string[];
}

export type BranchGovernanceValidationResult =
  | { ok: true }
  | { ok: false; kind: "invalid" | "unavailable"; detail: string };

let authorityPromise: Promise<BranchGovernanceAuthority> | undefined;

/**
 * repository governance の既存 shared API を domain boundary として利用する。
 * CLI を subprocess 起動せず、同じ `governance-rules.json` を読む authority を
 * source tree と packaged dist の双方から解決する。
 */
function loadBranchGovernanceAuthority(): Promise<BranchGovernanceAuthority> {
  authorityPromise ??= (async () => {
    const authorityUrl = new URL("../../../scripts/governance-lib.mjs", import.meta.url);
    return (await import(authorityUrl.href)) as BranchGovernanceAuthority;
  })();
  return authorityPromise;
}

export async function validateBranchNameAgainstGovernance(branch: string): Promise<BranchGovernanceValidationResult> {
  try {
    const errors = loadBranchGovernanceAuthority().then((authority) => authority.validateBranchName(branch));
    const validationErrors = await errors;
    if (validationErrors.length > 0) return { ok: false, kind: "invalid", detail: validationErrors.join("; ") };
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: `branch governance authority unavailable: ${(err as Error).message}` };
  }
}
