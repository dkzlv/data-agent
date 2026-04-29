#!/usr/bin/env bash
# Push all secrets from .dev.vars into the Cloudflare Secrets Store.
# Idempotent: uses `secret update` (which creates if missing).
#
# Usage:
#   scripts/push-secrets.sh [path/to/.dev.vars]
#
# Requires: wrangler authenticated for the right account.

set -euo pipefail

STORE_ID="5fca98fdba4f4972b9d14ac74ea58cf4"  # default_secrets_store
DEV_VARS_FILE="${1:-.dev.vars}"

if [[ ! -f "$DEV_VARS_FILE" ]]; then
  echo "error: $DEV_VARS_FILE not found" >&2
  exit 1
fi

echo "Pushing secrets from $DEV_VARS_FILE to store $STORE_ID..."
echo

# Comment out keys you don't want in the store (e.g., URLs that aren't secrets).
KEYS_TO_PUSH=(
  CONTROL_PLANE_DB_URL
  BETTER_AUTH_SECRET
  INTERNAL_JWT_SIGNING_KEY
  MASTER_ENCRYPTION_KEY
)

for key in "${KEYS_TO_PUSH[@]}"; do
  # Extract value from .dev.vars (handles VALUE="..." or VALUE=...)
  value=$(grep -E "^${key}=" "$DEV_VARS_FILE" | head -1 | sed -E 's/^[^=]+=//' | sed -E 's/^"(.*)"$/\1/')

  if [[ -z "$value" ]]; then
    echo "skip $key (not in $DEV_VARS_FILE)"
    continue
  fi

  echo "→ $key"
  # `secret update` creates if missing and updates if exists. Pipe value via stdin.
  printf '%s' "$value" | wrangler secrets-store secret create "$STORE_ID" \
    --name "$key" \
    --scopes workers \
    --value-from-stdin \
    --remote 2>&1 | tail -3 || echo "  (already exists or non-fatal error — continuing)"
done

echo
echo "Done. Verify with: wrangler secrets-store secret list $STORE_ID --remote"
