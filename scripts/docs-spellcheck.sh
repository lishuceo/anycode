#!/usr/bin/env bash
# Spell check docs using codespell.
# Usage: scripts/docs-spellcheck.sh [--write]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Auto-install codespell if not available
if ! command -v codespell &>/dev/null; then
  echo "codespell not found, installing via pip..."
  pip3 install --quiet codespell
fi

ARGS=()
if [[ "${1:-}" == "--write" ]]; then
  ARGS+=(--write-changes)
fi

IGNORE_FILE="$SCRIPT_DIR/codespell-ignore.txt"
if [[ -f "$IGNORE_FILE" ]]; then
  ARGS+=(-I "$IGNORE_FILE")
fi

codespell \
  --skip="*.png,*.jpg,*.jpeg,*.gif,*.svg,*.ico,node_modules" \
  "${ARGS[@]}" \
  "$ROOT_DIR/README.md" \
  "$ROOT_DIR/docs/"
