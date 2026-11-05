#!/usr/bin/env bash
# Stop the board and remove its launchd agent. Data is not touched.
set -euo pipefail
LABEL=com.agentic-kanban.board
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL"
