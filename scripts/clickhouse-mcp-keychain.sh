#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
mcp_dir="$repo_dir/mcp-servers/clickhouse"
entrypoint="$mcp_dir/src/index.js"
node_bin="$(command -v node || true)"

if [[ -z "$node_bin" ]]; then
	print -u2 "ClickHouse MCP startup failed: Node.js was not found on PATH. Install Node.js 18+ or initialize nvm in the environment that starts VS Code, then reload VS Code."
	exit 127
fi

if [[ ! -f "$entrypoint" ]]; then
	print -u2 "ClickHouse MCP startup failed: server entrypoint is missing: $entrypoint"
	exit 1
fi

if [[ ! -d "$mcp_dir/node_modules/@modelcontextprotocol/sdk" ]]; then
	print -u2 "ClickHouse MCP startup failed: dependencies are missing. Run 'npm ci' in $mcp_dir."
	exit 1
fi

keychain_account="${USER}"
api_key="$(security find-generic-password -a "$keychain_account" -s 'copilot-clickhouse-api-key' -w)"
api_secret="$(security find-generic-password -a "$keychain_account" -s 'copilot-clickhouse-api-secret' -w)"

export CLICKHOUSE_API_KEY="$api_key"
export CLICKHOUSE_API_SECRET="$api_secret"

exec "$node_bin" "$entrypoint"