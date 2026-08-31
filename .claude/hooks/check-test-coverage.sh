#!/usr/bin/env bash
# PostToolUse (Write|Edit): if a package source file was written and has no sibling
# .test.ts, tell the agent. Advisory only — never blocks.
#
# Emits JSON with hookSpecificOutput.additionalContext: plain stdout on exit 0 is
# only visible in transcript mode and never reaches the model, so the reminder was
# silently dropped (that is why tests kept not getting written).
set -uo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("file_path", ""))
except Exception:
    print("")
' 2>/dev/null)

[ -n "$FILE" ] || exit 0

case "$FILE" in
  */node_modules/*|*/.next/*|*/generated/*|*/dist/*|*/target/*) exit 0 ;;
  *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*.d.ts) exit 0 ;;
  *.test-setup.ts|*/index.ts|*/types.ts) exit 0 ;;
esac

# Only package sources and web lib/services — not UI components or API routes.
case "$FILE" in
  */packages/*/src/*.ts|*/apps/web/src/lib/*.ts|*/apps/web/src/services/*.ts) ;;
  *) exit 0 ;;
esac

BASE="${FILE%.ts}"
[ -f "${BASE}.test.ts" ] && exit 0

REL="${FILE#"${CLAUDE_PROJECT_DIR:-}/"}"
MSG="${REL} has no sibling ${BASE##*/}.test.ts. Repo convention is a sibling \`*.test.ts\` run by \`tsx --test\`. Before finishing this task, either add one covering the behaviour you just wrote, or tell the user in your reply why this file does not warrant a unit test. Do not silently skip it."

REL="$REL" MSG="$MSG" python3 -c '
import json, os
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": os.environ["MSG"],
    }
}))
'
exit 0
