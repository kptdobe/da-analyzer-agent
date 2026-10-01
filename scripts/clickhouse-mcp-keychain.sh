#!/bin/zsh
set -euo pipefail

keychain_account="${USER}"
api_key="$(security find-generic-password -a "$keychain_account" -s 'copilot-clickhouse-api-key' -w)"
api_secret="$(security find-generic-password -a "$keychain_account" -s 'copilot-clickhouse-api-secret' -w)"

export CLICKHOUSE_API_KEY="$api_key"
export CLICKHOUSE_API_SECRET="$api_secret"

exec node "/Users/acapt/work/dev/helix/da/da-analyzer-agent/mcp-servers/clickhouse/src/index.js"