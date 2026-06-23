#!/usr/bin/env bash
# Template for storing API keys in Google Secret Manager.
# Copy to scripts/set-secrets.sh (gitignored) and fill in real values.
set -euo pipefail

printf '%s' 'YOUR_DEEPSEEK_API_KEY' \
  | firebase functions:secrets:set DEEPSEEK_API_KEY --data-file=- --force

printf '%s' 'YOUR_TAVILY_API_KEY' \
  | firebase functions:secrets:set TAVILY_API_KEY --data-file=- --force

echo "✓ Secrets stored. Now deploy: firebase deploy --only functions"
