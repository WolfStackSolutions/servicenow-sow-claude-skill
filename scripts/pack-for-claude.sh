#!/usr/bin/env bash
# Pack this skill for Claude.ai upload (ZIP with skill folder at the root).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="servicenow-sow-bookmarklet"
OUT="${1:-$ROOT/dist/${NAME}.zip}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/$NAME"
cp "$ROOT/SKILL.md" "$ROOT/LICENSE" "$tmpdir/$NAME/"
cp -R "$ROOT/references" "$ROOT/examples" "$tmpdir/$NAME/"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(
  cd "$tmpdir"
  zip -r "$OUT" "$NAME" >/dev/null
)

echo "Wrote $OUT"
echo "Structure (must be folder-wrapped):"
unzip -l "$OUT" | head -20
echo
echo "Upload in Claude.ai: Customize → Skills → Upload skill → enable the toggle."
