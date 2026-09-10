import { readFileSync } from "node:fs";

const rules = JSON.parse(readFileSync(new URL("./product-pr-checks-rules.json", import.meta.url), "utf8"));

/**
 * Mottainai-specific conditional PR quality gates. These are independent of,
 * and do not extend or wrap, the canonical organization PR-title/branch/body
 * contract enforced by yohn-jp/.github's reusable governance workflow (see
 * .github/workflows/governance.yml). They exist next to that canonical gate
 * as separate product checks, not as a local fork of shared semantics.
 */

function changed(files, patterns) {
  return files.some((file) => patterns.some((pattern) => new RegExp(pattern).test(file)));
}

function hasCompletedCheckbox(body, item) {
  return body.split(/\r?\n/).some((line) => {
    for (const prefix of [`- [x] ${item}`, `- [X] ${item}`, `\\- [x] ${item}`, `\\- [X] ${item}`]) {
      if (!line.startsWith(prefix)) continue;
      const suffix = line.slice(prefix.length);
      if (suffix.length === 0 || /^[, ]/.test(suffix)) return true;
    }
    return false;
  });
}

export function validateProductChecks({ body = "", draft = false, files = [] }) {
  const errors = [];

  if (!draft && changed(files, rules.packageCheckPaths) && !hasCompletedCheckbox(body, "Package check")) {
    errors.push("Validation must be completed: Package check");
  }

  if (changed(files, rules.compressionPaths)) {
    if (!changed(files, rules.compressionTestPaths))
      errors.push("compression changes require a test change under configured compression test paths");
    if (
      !/\btransform(?:s|ed|ation|ations)?\b/i.test(body) ||
      !/\bpreserv(?:e|es|ed|ing|ation|ations)?\b|\bunmodified\b/i.test(body)
    ) {
      errors.push("compression changes require validation for transformation and preservation cases");
    }
  }

  if (changed(files, rules.cliPaths) && !changed(files, rules.cliEvidencePaths))
    errors.push("CLI changes require a README or CLI test change");

  return { errors };
}
