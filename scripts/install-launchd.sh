#!/bin/bash
# 맥 미니에서 논문 정리 서버를 상시 실행(launchd)하고 테일넷에만 연다(tailscale serve, Funnel 아님).
# 다시 실행해도 안전: plist 를 새로 쓰고 서비스를 다시 올린다.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="lab.paper-organizer"
PORT="${PORT:-8790}"
TS_PORT="${TS_PORT:-8443}"
DATA_DIR="${DATA_DIR:-$HOME/lab/paper-organizer-data}"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/paper-organizer.log"

mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>DATA_DIR</key><string>$DATA_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/health" || { echo "서버가 안 떴어요 — $LOG 를 보세요"; tail -20 "$LOG"; exit 1; }
echo

# 테일넷 안에서만: https://<맥 이름>.<tailnet>.ts.net:$TS_PORT → 127.0.0.1:$PORT
tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"
DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo "테일넷 주소: https://$DNS:$TS_PORT"
