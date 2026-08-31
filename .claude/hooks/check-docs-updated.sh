#!/usr/bin/env bash
# Stop: if the working tree has code changes under packages/ or apps/ but no doc
# updates, remind about the AGENTS.md housekeeping rules.
# Advisory only (exit 0) and guarded against re-entry so it can never loop.
set -uo pipefail

INPUT=$(cat)
ACTIVE=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try:
    print(json.load(sys.stdin).get("stop_hook_active", False))
except Exception:
    print(True)
' 2>/dev/null)

# Already re-entered once — do not fire again.
[ "$ACTIVE" = "True" ] && exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

CHANGED=$(git status --porcelain 2>/dev/null | awk '{print $NF}')
[ -n "$CHANGED" ] || exit 0

CODE=$(printf '%s\n' "$CHANGED" | grep -E '^(packages|apps)/.*\.(ts|tsx|rs)$' | grep -v '\.test\.' || true)
[ -n "$CODE" ] || exit 0

DOCS=$(printf '%s\n' "$CHANGED" | grep -E '(^docs/|ARCHITECTURE\.md$|^specs/)' || true)
[ -n "$DOCS" ] && exit 0

COUNT=$(printf '%s\n' "$CODE" | wc -l | tr -d ' ')
cat <<EOF
$COUNT code file(s) changed with no doc updates in this working tree. AGENTS.md housekeeping:
- shipped something significant -> docs/PROGRESS.md (module table + timeline line)
- non-obvious choice -> docs/DECISIONS.md entry
- module shape/API changed -> that module's ARCHITECTURE.md
Update whichever applies, or say why none do.
EOF
exit 0
