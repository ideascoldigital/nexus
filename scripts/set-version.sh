#!/usr/bin/env bash
# Update the Nexux version across every manifest, in one command.
#
# Usage:
#   scripts/set-version.sh 0.2.0
#   scripts/set-version.sh v0.2.0
#
# Bumps:
#   - package.json                          (root)
#   - apps/web/package.json
#   - apps/native/package.json
#   - apps/native/src-tauri/tauri.conf.json
#   - apps/native/src-tauri/Cargo.toml      [package] version
#   - apps/native/src-tauri/Cargo.lock      (via cargo update, best effort)
#
# Does NOT commit, tag, or push — caller decides. CI (release-native.yml) runs
# this from the tag before building, so a forgotten local bump can never ship
# a build whose baked-in version disagrees with its release tag.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

VER="${1#v}"

if ! printf '%s' "$VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+.][A-Za-z0-9.-]+)?$'; then
  echo "invalid semver: $VER" >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CURRENT="$(node -p "require('./package.json').version")"
echo "current: $CURRENT"
echo "next:    $VER"

TAURI_CONF="apps/native/src-tauri/tauri.conf.json"
for JSON in package.json apps/web/package.json apps/native/package.json "$TAURI_CONF"; do
  node -e '
    const fs = require("fs");
    const [path, ver] = process.argv.slice(1);
    const src = fs.readFileSync(path, "utf8");
    // Textual replace of the first version line: keeps key order,
    // indentation and trailing newline exactly as committed.
    const re = /^(\s*"version":\s*")[^"]*(")/m;
    if (!re.test(src)) throw new Error(`no version line in ${path}`);
    fs.writeFileSync(path, src.replace(re, `$1${ver}$2`));
  ' "$JSON" "$VER"
done

CARGO_TOML="apps/native/src-tauri/Cargo.toml"
node -e '
  const fs = require("fs");
  const [path, ver] = process.argv.slice(1);
  const src = fs.readFileSync(path, "utf8");
  // First version line only — that is [package] at the top of the file;
  // dependency versions further down must not change.
  const re = /^version = "[^"]*"$/m;
  if (!re.test(src)) throw new Error(`no version line in ${path}`);
  fs.writeFileSync(path, src.replace(re, `version = "${ver}"`));
' "$CARGO_TOML" "$VER"

# Refresh Cargo.lock so it matches Cargo.toml. Best effort: cargo may be
# missing on a JS-only checkout; CI's rust toolchain always has it.
if command -v cargo >/dev/null 2>&1; then
  (cd apps/native/src-tauri && cargo update -p nexux --precise "$VER" >/dev/null 2>&1) ||
    echo "warn: could not refresh Cargo.lock (run 'cargo update -p nexux' manually)" >&2
else
  echo "warn: cargo not found — Cargo.lock not refreshed" >&2
fi

echo ""
echo "Updated to $VER:"
grep -Hn '"version"' package.json apps/web/package.json apps/native/package.json "$TAURI_CONF" | head -4
grep -Hn '^version' "$CARGO_TOML" | head -1

echo ""
echo "Next steps:"
echo "  pnpm --filter @nexux/native test        # parity check"
echo "  git commit -am \"release: v$VER\""
echo "  git tag v$VER && git push origin main v$VER"
