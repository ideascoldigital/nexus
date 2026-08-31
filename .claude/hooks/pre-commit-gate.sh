#!/usr/bin/env bash
# PreToolUse (Bash): block `git commit` when the test suite is red.
# Exit 2 = deny the tool call and feed stderr back to the agent.
set -uo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' 2>/dev/null)

# Only gate real commits.
printf '%s' "$CMD" | grep -qE '(^|[;&|]|\s)git\s+(-[^ ]+\s+)*commit(\s|$)' || exit 0

# Escape hatches: --no-verify, or NEXUX_SKIP_TESTS=1 in the environment.
printf '%s' "$CMD" | grep -q -- '--no-verify' && exit 0
[ "${NEXUX_SKIP_TESTS:-0}" = "1" ] && exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO" || exit 0

# pnpm may not be on PATH (this repo is commonly driven through npx). Falling
# back keeps the gate honest instead of failing open on a 127.
if command -v pnpm >/dev/null 2>&1; then
  OUT=$(pnpm test 2>&1)
elif command -v npx >/dev/null 2>&1; then
  OUT=$(npx --yes pnpm test 2>&1)
else
  echo "Commit blocked: neither \`pnpm\` nor \`npx\` is on PATH, so the test gate cannot run." >&2
  exit 2
fi
STATUS=$?

if [ $STATUS -ne 0 ]; then
  {
    echo "Commit blocked: \`pnpm test\` failed (exit $STATUS). Fix the failures before committing."
    echo "--- last 60 lines of test output ---"
    printf '%s\n' "$OUT" | tail -n 60
    echo "--- end ---"
    echo "Override for a genuinely unrelated commit: append --no-verify, or run with NEXUX_SKIP_TESTS=1."
  } >&2
  exit 2
fi

exit 0
