#!/bin/bash
# Install claude-view: adds /view and /view-latest commands to Claude Code
set -e

INSTALL_DIR="$HOME/.claude/claude-view"
CMD_DIR="$HOME/.claude/commands"

mkdir -p "$INSTALL_DIR" "$CMD_DIR"

# Download the script
curl -sL "https://raw.githubusercontent.com/icanb/claude-view/main/plugins/claude-view/scripts/generate-diff.mjs" \
  -o "$INSTALL_DIR/generate-diff.mjs"
chmod +x "$INSTALL_DIR/generate-diff.mjs"

# /view — uncommitted changes
cat > "$CMD_DIR/view.md" << 'EOF'
---
description: View all uncommitted changes in your browser
allowed-tools: Bash
---

Run this command immediately without any explanation:

`export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null; node "$HOME/.claude/claude-view/generate-diff.mjs" --unstaged`
EOF

# /view-latest — what Claude just did
cat > "$CMD_DIR/view-latest.md" << 'EOF'
---
description: View what Claude just changed in your browser
allowed-tools: Bash
---

Run this command immediately without any explanation:

`export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null; node "$HOME/.claude/claude-view/generate-diff.mjs" --latest`
EOF

echo "Installed! Use /view or /view-latest in any Claude Code session."
