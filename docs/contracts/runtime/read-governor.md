# Read Governor

`mottainai_read` progresses source disclosure from search, symbols, and
outline to bounded raw content and finally whole-file raw content. `mode:
"raw"` is not a policy bypass.

## Configuration

The default `gateway.readGovernor` mode is `observe`. It does not stop
existing reads and records the decision that would apply in enforce mode in
telemetry. Strict workspaces should explicitly select `enforce`.

```json
{
  "gateway": {
    "readGovernor": {
      "mode": "enforce",
      "maxRawLines": 400,
      "maxRawBytes": 16384,
      "allowWholeFileBelowLines": 120,
      "preferAuto": true,
      "allowWholeFile": false
    }
  }
}
```

| Mode | Behavior |
| --- | --- |
| `off` | Allows raw content as before; the final response budget still applies |
| `observe` | Allows reads that enforce mode would inspect and records decision metadata |
| `warn` | Allows the read and returns a bounded warning/diagnostic |
| `enforce` | Denies broad raw reads outside policy before returning file content |

Small files at or below `allowWholeFileBelowLines` and `maxRawBytes` may be
returned as whole-file raw content. For larger files, `mode: "auto"` selects a
bounded `outline`; `auto` never becomes unrestricted raw content.
`allowWholeFile: true` is appropriate only when repository or user policy
explicitly permits whole-file raw content.

## Recommended progression

```text
search / code symbol / outline
        ↓
exact symbol/range
        ↓
bounded raw: startLine + endLine
        ↓
whole-file raw: only a small file permitted by policy
```

Examples:

```json
{"path":"src/local-tools.ts","mode":"symbols"}
{"path":"src/local-tools.ts","mode":"raw","startLine":332,"endLine":348}
```

An enforce-mode denial for broad raw content returns structured fields
`file_line_count`, `file_bytes`, `policy_rule`, `policy_reason`, and
`next_actions`, without the file body. The next action is one of `auto`,
`outline`, `symbols`, identifier search, or a bounded line range.

If outline or symbol extraction fails, the governor does not fall back to
whole-file raw content. It returns bounded diagnostics and the smallest next
action; an artifact for an allowed range remains retrievable through its
`result_id`.

## Telemetry

With `MOTTAINAI_TELEMETRY=1`, the read governor aggregates the decision action,
requested mode, raw `raw_lines_returned` and `raw_bytes_returned` returned to
the LLM, policy rule, and reason category. Internal source inspection for
semantic projection is not counted as returned raw content. Aggregates include
`by_mode`, `by_rule`, and `by_reason_category`. Source contents, excerpts,
credentials, environment values, and secrets are never recorded. The legacy
`raw_lines`, `raw_bytes`, `requested_modes`, and `policy_rules` forms are
migrated when read.

Read results pass through the Issue #71 Context Runtime projection and final
response budget. Warnings, denial metadata, and `result_id` also remain below
the hard byte ceiling.
