#!/usr/bin/env bash
# Install the board as an always-on launchd agent (starts at login, restarts if it dies).
#   scripts/install-launchd.sh               install + load
#   PLIST_OUT=/tmp/x.plist scripts/install-launchd.sh --write-only    just write the plist there
# Env: PORT (default 5173), KANBAN_CONFIG_DIR (default ~/.config/agentic-kanban; machine-local actors and repo registry)
set -euo pipefail

LABEL=com.agentic-kanban.board
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Prefer a stable system-wide node; a version-manager path (nvm) breaks when that version is removed.
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$c" ]]; then NODE="$c"; break; fi
done
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node)"
  case "$NODE" in
    *"/.nvm/"*|*"/.fnm/"*|*"/.volta/"*|*"/.asdf/"*)
      echo "Warning: using $NODE. The service will stop working if that node version is removed;" >&2
      echo "         install node via Homebrew (brew install node) and re-run to avoid this." >&2 ;;
  esac
fi
PORT="${PORT:-5173}"
CONFIG_DIR="${KANBAN_CONFIG_DIR:-$HOME/.config/agentic-kanban}"
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
    <key>KANBAN_CONFIG_DIR</key><string>$(esc "$CONFIG_DIR")</string>
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

if lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use (a dev server?). Stop it first, then re-run." >&2
  exit 1
fi

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do   # wait until the old job is really gone
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
ok=0
for _ in 1 2 3 4 5; do     # "Bootstrap failed: 5" can happen right after a bootout; retry
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [[ $ok -ne 1 ]]; then launchctl bootstrap "$DOMAIN" "$PLIST"; fi
echo "Installed $LABEL -> http://localhost:$PORT  (logs: $LOG)"
