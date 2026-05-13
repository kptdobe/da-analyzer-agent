#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$SCRIPT_DIR/.claude"
REPOS_DIR="$SCRIPT_DIR/repos"

echo "=== DA Analyzer Agent Setup ==="
echo ""

# Check prerequisites
for cmd in node npm gh; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

# Install MCP server dependencies
echo "Installing Coralogix MCP server dependencies..."
npm install --prefix "$SCRIPT_DIR/mcp-servers/coralogix" --silent
echo "Done."
echo ""

# Detect shell profile
if [ -f "$HOME/.zshrc" ]; then
  SHELL_PROFILE="$HOME/.zshrc"
elif [ -f "$HOME/.bash_profile" ]; then
  SHELL_PROFILE="$HOME/.bash_profile"
else
  SHELL_PROFILE="$HOME/.profile"
fi

# Coralogix DA API key
if [ -z "${CORALOGIX_DA_KEY:-}" ]; then
  echo "Coralogix DA API key"
  echo "  Get one at: da-logs.coralogix.com → Settings → API Keys → New Key (Query, read-only)"
  echo -n "  Key: "
  read -r -s CORALOGIX_DA_KEY_INPUT
  echo ""
  if [ -n "$CORALOGIX_DA_KEY_INPUT" ]; then
    echo "" >> "$SHELL_PROFILE"
    echo "export CORALOGIX_DA_KEY=$CORALOGIX_DA_KEY_INPUT" >> "$SHELL_PROFILE"
    echo "  Added CORALOGIX_DA_KEY to $SHELL_PROFILE"
    export CORALOGIX_DA_KEY="$CORALOGIX_DA_KEY_INPUT"
  else
    echo "  Skipped (no key entered). Set CORALOGIX_DA_KEY manually in your shell profile."
  fi
else
  echo "CORALOGIX_DA_KEY already set — skipping."
fi
echo ""

# Coralogix Helix key (optional)
if [ -z "${CORALOGIX_HELIX_KEY:-}" ]; then
  echo "Coralogix Helix API key (optional — needed for Helix log queries)"
  echo -n "  Key (press Enter to skip): "
  read -r -s CORALOGIX_HELIX_KEY_INPUT
  echo ""
  if [ -n "$CORALOGIX_HELIX_KEY_INPUT" ]; then
    echo "export CORALOGIX_HELIX_KEY=$CORALOGIX_HELIX_KEY_INPUT" >> "$SHELL_PROFILE"
    echo "  Added CORALOGIX_HELIX_KEY to $SHELL_PROFILE"
  fi
else
  echo "CORALOGIX_HELIX_KEY already set — skipping."
fi
echo ""

# DA repos root
DEFAULT_DA_ROOT="$HOME/work/dev/helix/da"
echo "Path to your DA repos root (directory containing da-live, da-admin, da-collab, etc.):"
echo -n "  [default: $DEFAULT_DA_ROOT]: "
read -r DA_ROOT_INPUT
DA_ROOT="${DA_ROOT_INPUT:-$DEFAULT_DA_ROOT}"
DA_ROOT="${DA_ROOT/#\~/$HOME}"
echo ""

if [ ! -d "$DA_ROOT" ]; then
  echo "Warning: $DA_ROOT does not exist. Skipping symlink creation."
  echo "Run setup.sh again once your repos are cloned, or create repos/ symlinks manually."
else
  echo "Creating repo symlinks in repos/..."
  mkdir -p "$REPOS_DIR"
  for repo in da-live da-admin da-collab da-content da-nx da-tools da-auth da-universal; do
    src="$DA_ROOT/$repo"
    dst="$REPOS_DIR/$repo"
    if [ -d "$src" ]; then
      [ -L "$dst" ] && rm "$dst"
      ln -s "$src" "$dst"
      echo "  repos/$repo → $src"
    else
      echo "  Skipped repos/$repo (not found at $src)"
    fi
  done
fi
echo ""

# Generate .claude/settings.local.json with absolute MCP server path
MCP_PATH="$SCRIPT_DIR/mcp-servers/coralogix/src/index.js"
cat > "$CLAUDE_DIR/settings.local.json" << EOF
{
  "mcpServers": {
    "coralogix": {
      "command": "node",
      "args": ["$MCP_PATH"]
    }
  }
}
EOF
echo "Generated .claude/settings.local.json"
echo ""

echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Reload your shell:  source $SHELL_PROFILE"
echo "  2. Start Claude Code:  claude"
echo "  3. The 'coralogix' MCP tool will be available automatically."
