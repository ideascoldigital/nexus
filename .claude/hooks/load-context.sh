#!/usr/bin/env bash
# SessionStart: inject AGENTS.md + docs/DECISIONS.md + docs/PROGRESS.md into the session context.
# Rationale: CLAUDE.md only *links* these files, so they entered context only if the
# agent chose to read them. This makes them unconditional.
set -uo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

emit() {
  local label="$1" path="$2" max="$3"
  [ -f "$path" ] || return 0
  local lines
  lines=$(wc -l < "$path" | tr -d ' ')
  printf '\n===== %s (%s lines) =====\n' "$label" "$lines"
  if [ "$lines" -gt "$max" ]; then
    head -n "$max" "$path"
    printf '\n[truncated at %s lines — read %s in full if you need the rest]\n' "$max" "$path"
  else
    cat "$path"
  fi
}

{
  echo "Project docs loaded automatically. Per AGENTS.md housekeeping rules:"
  echo "- shipped something significant -> update docs/PROGRESS.md (module table + timeline line)"
  echo "- made a non-obvious choice -> add an entry to docs/DECISIONS.md"
  echo "- changed a module's shape/API -> touch its ARCHITECTURE.md"
  emit "AGENTS.md" "$REPO/AGENTS.md" 150
  emit "docs/DECISIONS.md" "$REPO/docs/DECISIONS.md" 200
  emit "docs/PROGRESS.md" "$REPO/docs/PROGRESS.md" 120
} 2>/dev/null

exit 0
