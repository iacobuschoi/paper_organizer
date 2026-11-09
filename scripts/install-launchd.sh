#!/bin/bash
# 맥 미니에서 논문 정리 서버를 상시 실행(launchd)하고, 로그인으로 막히는 것을 확인한 뒤 Funnel 로 공개한다(PUBLIC=0 이면 테일넷만).
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

# 비밀번호가 없으면 만든다(한 번만 화면에 찍힘). 비밀번호 없이 공개하지 않는다.
if [ ! -f "$DATA_DIR/auth.json" ]; then DATA_DIR="$DATA_DIR" "$NODE" "$REPO/server/set-password.js"; fi
# 로그인 없이 막히는지 확인한 뒤에만 공개
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")
[ "$code" = 401 ] || { echo "로그인 없이 /api/state 가 $code — 공개하지 않음"; exit 1; }
if [ "${PUBLIC:-1}" = 1 ]; then
  # 인터넷 공개(Funnel): https://<맥 이름>.<tailnet>.ts.net:$TS_PORT → 127.0.0.1:$PORT  (443 의 다른 Funnel 은 안 건드림)
  tailscale funnel --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"
else
  tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT"
fi
DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo "주소: https://$DNS:$TS_PORT"
