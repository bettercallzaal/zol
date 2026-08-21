#!/bin/bash
# scripts/secret-scan.sh - run before every commit. Scans staged (or, with
# --all, all tracked) files for private keys and common API-key shapes.
# Exits non-zero and prints matches if anything looks like a real secret.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--all" ]; then
  FILES=$(git ls-files)
else
  FILES=$(git diff --cached --name-only --diff-filter=ACM)
fi

if [ -z "$FILES" ]; then
  echo "secret-scan: no files to check"
  exit 0
fi

FOUND=0
PATTERNS=(
  '0x[0-9a-fA-F]{64}'            # 0x-prefixed hex private key (Ethereum/EVM)
  'sk-[A-Za-z0-9]{20,}'          # OpenAI-style key
  'sk-or-[A-Za-z0-9-]{20,}'      # OpenRouter key
  'gho_[A-Za-z0-9]{20,}'         # GitHub OAuth token
  'ghp_[A-Za-z0-9]{20,}'         # GitHub PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}' # Slack token
  '[0-9]{9,10}:[A-Za-z0-9_-]{35}' # Telegram bot token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

for f in $FILES; do
  [ -f "$f" ] || continue
  case "$f" in
    # Skip generated, upstream, and intentional-fake-data files
    *.md|*.example|scripts/secret-scan.sh) continue ;;
    vendor/*|node_modules/*) continue ;;
    # capsules/ holds provenance.content_hash SHA-256 values — not secrets
    capsules/*) continue ;;
    # test files contain intentional fake credentials for redaction tests
    *__tests__/*|test/*|scripts/dl-dry-run*.js) continue ;;
  esac
  for p in "${PATTERNS[@]}"; do
    if grep -nEo "$p" "$f" >/dev/null 2>&1; then
      echo "SECRET-LIKE MATCH in $f:"
      grep -nEo "$p" "$f" | sed 's/./&/' | cut -c1-80
      FOUND=1
    fi
  done
done

if [ "$FOUND" -eq 1 ]; then
  echo
  echo "secret-scan: refusing - looks like a real secret is about to be committed."
  echo "If this is a false positive, fix the pattern or the file, don't bypass it."
  exit 1
fi

echo "secret-scan: clean"
