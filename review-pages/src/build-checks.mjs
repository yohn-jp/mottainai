import { fetchCheckRuns } from "./lib/github-api.mjs";

export const CHECKS_SCHEMA_VERSION = "mottainai.review-pages.checks/v1";

// GitHub check-run evidence available at generation time. This surfaces
// whatever check-runs already exist for the head SHA (including this
// repository's own governance jobs) rather than re-implementing
// governance evaluation.
export async function buildChecks({ owner, repo, headSha, token, fetchCheckRunsFn = fetchCheckRuns }) {
  const checkRuns = await fetchCheckRunsFn({ owner, repo, headSha, token });
  if (checkRuns === null) {
    return {
      schemaVersion: CHECKS_SCHEMA_VERSION,
      headSha,
      available: false,
      checkRuns: [],
    };
  }

  return {
    schemaVersion: CHECKS_SCHEMA_VERSION,
    headSha,
    available: true,
    checkRuns: checkRuns
      .map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        detailsUrl: run.details_url ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}
