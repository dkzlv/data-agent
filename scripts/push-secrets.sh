#!/usr/bin/env bash
# Push secrets from .dev.vars into Cloudflare Secrets Store.
#
# Usage:
#   scripts/push-secrets.sh [path/to/.dev.vars]

set -euo pipefail

STORE_ID="5fca98fdba4f4972b9d14ac74ea58cf4"
DEV_VARS_FILE="${1:-.dev.vars}"

if [[ ! -f "$DEV_VARS_FILE" ]]; then
  echo "error: $DEV_VARS_FILE not found" >&2
  exit 1
fi

echo "Pushing secrets from $DEV_VARS_FILE to store $STORE_ID..."
echo

KEYS_TO_PUSH=(
  CONTROL_PLANE_DB_URL
  BETTER_AUTH_SECRET
  INTERNAL_JWT_SIGNING_KEY
  MASTER_ENCRYPTION_KEY
)

# Look up existing secret ids by name (so we can delete + recreate).
EXISTING_JSON=$(wrangler secrets-store secret list "$STORE_ID" --remote --per-page 100 2>/dev/null || echo "")

for key in "${KEYS_TO_PUSH[@]}"; do
  value=$(grep -E "^${key}=" "$DEV_VARS_FILE" | head -1 | sed -E 's/^[^=]+=//' | sed -E 's/^"(.*)"$/\1/')
  if [[ -z "$value" ]]; then
    echo "skip $key (not in $DEV_VARS_FILE)"
    continue
  fi

  echo "→ $key"

  # If a secret with this name exists, delete it first (delete-by-name is supported).
  EXISTING_ID=$(echo "$EXISTING_JSON" | grep -oE "│ $key[[:space:]]+│ [a-f0-9]{32}" | grep -oE "[a-f0-9]{32}" | head -1 || true)
  if [[ -n "$EXISTING_ID" ]]; then
    wrangler secrets-store secret delete "$STORE_ID" \
        --secret-id "$EXISTING_ID" --remote >/dev/null 2>&1 || true
    sleep 0.5
  fi

  if wrangler secrets-store secret create "$STORE_ID" \
        --name "$key" \
        --scopes workers \
        --value "$value" \
        --remote 2>&1 | grep -q "Created secret"; then
    echo "  ✓"
  else
    echo "  ✗ failed (see ~/.wrangler/logs/)" >&2
  fi
done

echo
echo "Done. List with: wrangler secrets-store secret list $STORE_ID --remote"
