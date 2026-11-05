#!/usr/bin/env bash
# Install the board as an always-on launchd agent (starts at login, restarts if it dies).
#   scripts/install-launchd.sh               install + load
#   PLIST_OUT=/tmp/x.plist scripts/install-launchd.sh --write-only    just write the plist there
# Env: PORT (default 5173), KANBAN_DATA_DIR (default ~/Developer/kanban-data)
set -euo pipefail

LABEL=com.agentic-kanban.board
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PORT="${PORT:-5173}"
DATA_DIR="${KANBAN_DATA_DIR:-$HOME/Developer/kanban-data}"
LOG="$HOME/Library/Logs/agentic-kanban.log"
PLIST="${PLIST_OUT:-$HOME/Library/LaunchAgents/$LABEL.plist}"

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(esc "$NODE")</string>
    <string>server/index.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$(esc "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>KANBAN_DATA_DIR</key><string>$(esc "$DATA_DIR")</string>
    <key>PATH</key><string>$(esc "$(dirname "$NODE")"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(esc "$LOG")</string>
  <key>StandardErrorPath</key><string>$(esc "$LOG")</string>
</dict>
</plist>
PLIST

if [[ "${1:-}" == "--write-only" ]]; then
  echo "Wrote $PLIST"
  exit 0
fi

(cd "$REPO" && npm run build)

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is in use (a dev server?). Stop it first, then re-run." >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL -> http://localhost:$PORT  (logs: $LOG)"
