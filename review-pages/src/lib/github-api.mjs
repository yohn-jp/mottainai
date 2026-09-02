// Thin, timeout-bounded GitHub REST client. Only the two read endpoints
// Review Pages needs: an issue lookup and a commit's check-runs. Every
// call fails soft (returns null) so a transient API error degrades a
// field to "unavailable" rather than aborting generation.

async function getJson(url, token) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchIssue({ owner, repo, number, token }) {
  if (!token || !number) return null;
  return getJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, token);
}

export async function fetchCheckRuns({ owner, repo, headSha, token }) {
  if (!token || !headSha) return null;
  const payload = await getJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
    token,
  );
  return payload?.check_runs ?? null;
}
