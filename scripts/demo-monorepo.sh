#!/usr/bin/env bash
# Builds a throwaway monorepo with a deliberate port collision, for walking
# seed → validate → repair by hand. Prints where it put it.
#
#   ./scripts/demo-monorepo.sh [dir]
#
# Two apps, both defaulting to :3000, plus a library that must NOT become a
# node. Deleting the directory is the whole cleanup.
set -euo pipefail

DIR="${1:-/tmp/nexus-demo-monorepo}"
rm -rf "$DIR"
mkdir -p "$DIR/apps/web" "$DIR/apps/api" "$DIR/packages/ui"
cd "$DIR"

cat > package.json <<'EOF'
{ "name": "demo-mono", "private": true, "packageManager": "pnpm@12.6.0" }
EOF

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "apps/*"
  - "packages/*"
EOF

# Two apps that both want :3000 — the collision the repair loop resolves.
cat > apps/web/package.json <<'EOF'
{ "name": "web", "scripts": { "dev": "next dev", "build": "next build" } }
EOF
printf 'PORT=3000\nAPI_URL=http://localhost:3000\n' > apps/web/.env.example

cat > apps/api/package.json <<'EOF'
{ "name": "api", "scripts": { "dev": "node server.js", "build": "tsc" } }
EOF
# The connection strings name their engines, so the seed infers conclusively
# rather than guessing.
printf 'PORT=3000\nDATABASE_URL=postgres://user:pw@localhost:5432/app\nREDIS_URL=redis://localhost:6379\n' > apps/api/.env.example

# Build and test only: a library, and the seed must say so rather than make a
# node for it.
cat > packages/ui/package.json <<'EOF'
{ "name": "ui", "scripts": { "build": "tsup", "test": "vitest" } }
EOF

git init -q
git add -A
git -c user.email=demo@local -c user.name=demo commit -qm "demo monorepo"

echo "$DIR"
