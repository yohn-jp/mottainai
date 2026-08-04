#!/usr/bin/env bash
# PreToolUse(Bash) hook: nudge toward codegraph_explore / mottainai_search instead of
# raw grep for source-code lookups. Non-blocking — just a systemMessage (UI only, no
# token cost to the model). Never fails the tool call.
set -uo pipefail

cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"

if [[ "$cmd" =~ (^|[[:space:]\;\|\&])(grep|egrep|fgrep|rg)([[:space:]]|$) ]] && [[ ! "$cmd" =~ git[[:space:]]+grep ]]; then
  echo '{"systemMessage":"grep/rg使用: コードシンボル調査ならcodegraph_explore、文字列検索ならmottainai_search優先検討"}'
fi

exit 0
