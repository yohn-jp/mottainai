# Security Policy

## Supported Versions

Mottainai is pre-1.0 (`0.x`). There is no long-term support branch yet —
security fixes land on `main` and the latest `0.x` release only.

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/yohn-jp/mottainai/security/advisories/new) on this
repository rather than opening a public issue. If that path is unavailable to
you, open an issue with minimal detail and ask a maintainer to follow up
through a private channel.

Include, where possible:

- A description of the issue and its impact
- Steps or a minimal reproduction
- Affected version/commit

We aim to acknowledge reports within 5 business days. This is a small,
independently maintained project without a dedicated security team, so
response times are best-effort.

## Known Trust Boundaries (please read before reporting)

Some behaviors below are **by design, not vulnerabilities** — they are
documented here so reports focus on genuine issues.

### `mottainai_exec` is arbitrary code execution by design

`mottainai_exec` runs shell commands with the privileges of the process
running the gateway. It is intended **only** for trusted users operating on
trusted workspaces (e.g., a developer's own machine, an already-sandboxed CI
job). It is not a multi-tenant or untrusted-input safe primitive.

Specifically, `mottainai_exec` does **not**:

- Provide OS-level sandboxing or isolation (no bubblewrap, no
  `sandbox-exec`, no containers)
- Prevent the command body from reading/writing/deleting files outside
  `gateway.workspaceRoot`, via `cd`, absolute paths, or child processes
- Prevent outbound network access permitted by the host's OS/network policy
- Prevent process spawning or other side effects available to the executing
  OS user

`gateway.workspaceRoot` constrains only:

- The initial `cwd` and any `cwd` argument passed to `mottainai_exec`
- Path resolution for `mottainai_read`, `mottainai_search`, and
  `mottainai_list` (validated against the resolved realpath, including
  symlink-escape checks)

Timeouts and output-size limits are resource controls, not access controls.

**If you plan to expose this gateway to untrusted callers or untrusted
workspaces, put it behind an external OS sandbox.** Tracking issue for
built-in sandboxing: see the [roadmap](README.md#roadmap).

### Credentials in config and logs

- `mottainai.config.json` and `.mottainai/` (logs, traces, policy) are
  gitignored by default — never commit them.
- Raw execution logs (`.mottainai/log/*.jsonl`) apply best-effort redaction
  to common secret-shaped key names (`password`, `token`, `apiKey`,
  `authorization`, `cookie`, `credential`, `accessKey`, `privateKey`,
  `session`, etc.). This is a safety net, not a guarantee — review your log
  retention settings (`MOTTAINAI_LOG_*`) if upstream servers you connect
  handle credentials under other key names.
- `headersFromEnv` in config takes environment variable **names**, not
  values, specifically so secrets never land in the config file itself.

### What *is* in scope for a report

- A way to escape `workspaceRoot` from `mottainai_read` / `mottainai_search`
  / `mottainai_list` (these are meant to be path-confined)
- Secret material leaking into logs, traces, or tool output despite
  redaction being enabled
- A way to make the gateway execute code it did not intend to (e.g., via a
  malicious upstream tool response) outside of the documented `mottainai_exec`
  contract
- Denial-of-service in the compression pipeline itself (e.g., pathological
  input causing unbounded memory/CPU)

If in doubt whether something is a bug or a documented trust boundary, report
it anyway — we'd rather triage a false positive than miss a real issue.
