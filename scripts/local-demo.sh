#!/usr/bin/env bash
# Runs the whole demo on this machine, with no Render and no Cloudflare in the path:
#
#   grid cameras --RTSP--> MediaMTX (localhost:8888) --HLS--> the browser at http://localhost:3000
#
# Usage:  bash scripts/local-demo.sh        (from the repository root, in Git Bash)
# First time only: copy demo.local.example to demo.local and fill in GRID_EMAIL / GRID_PASSWORD.
set -eu
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-demo.local}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Copy demo.local.example to $ENV_FILE and fill in GRID_EMAIL and GRID_PASSWORD." >&2; exit 1; }
# Strip Windows line endings so values do not end in a carriage return.
set -a; . <(tr -d '\r' < "$ENV_FILE"); set +a
: "${GRID_EMAIL:?Set GRID_EMAIL in $ENV_FILE}"
: "${GRID_PASSWORD:?Set GRID_PASSWORD in $ENV_FILE}"

APP_PORT="${PORT:-3000}"
MEDIA_PORT="${MEDIA_HLS_PORT:-8888}"
export MEDIA_VIEWER_PASSWORD="${MEDIA_VIEWER_PASSWORD:-localdemo2026}"

# 1. MediaMTX binary (downloaded once into media-server/bin, which is git-ignored).
BIN_DIR="media-server/bin"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) MTX="$BIN_DIR/mediamtx.exe"; ASSET="mediamtx_v1.21.1_windows_amd64.zip" ;;
  Darwin) MTX="$BIN_DIR/mediamtx"; ASSET="mediamtx_v1.21.1_darwin_$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo amd64 ).tar.gz" ;;
  *) MTX="$BIN_DIR/mediamtx"; ASSET="mediamtx_v1.21.1_linux_amd64.tar.gz" ;;
esac
if [ ! -x "$MTX" ] && [ ! -f "$MTX" ]; then
  mkdir -p "$BIN_DIR"
  echo "Downloading MediaMTX v1.21.1 ($ASSET) ..."
  curl -fL -o "$BIN_DIR/$ASSET" "https://github.com/bluenviron/mediamtx/releases/download/v1.21.1/$ASSET"
  case "$ASSET" in
    *.zip) powershell.exe -NoProfile -Command "Expand-Archive -Force -Path \"$(cygpath -w "$BIN_DIR/$ASSET")\" -DestinationPath \"$(cygpath -w "$BIN_DIR")\"" ;;
    *) tar -xzf "$BIN_DIR/$ASSET" -C "$BIN_DIR" ;;
  esac
  rm -f "$BIN_DIR/$ASSET"
fi

# 2. Start the media server (its config is generated from these variables by media-server/entrypoint.sh).
export MEDIAMTX_BIN="$PWD/$MTX" MEDIAMTX_CONFIG="$PWD/$BIN_DIR/mediamtx.local.yml"
export MEDIA_HLS_PORT="$MEDIA_PORT" MEDIA_ALLOW_ORIGIN="http://localhost:$APP_PORT"
sh media-server/entrypoint.sh > "$BIN_DIR/mediamtx.log" 2>&1 &
MEDIA_PID=$!
trap 'kill $MEDIA_PID 2>/dev/null || true' EXIT INT TERM

printf 'Waiting for the media server'
for i in $(seq 1 30); do
  # ?cookieCheck=1 skips MediaMTX's first-visit redirect (302), so a running server answers 401 straight away.
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MEDIA_PORT/cam01/index.m3u8?cookieCheck=1" || true)
  [ "$code" = "401" ] && break          # 401 = up and asking for the viewer password
  printf '.'; sleep 1
done
echo
[ "${code:-}" = "401" ] || { echo "Media server did not start. See $BIN_DIR/mediamtx.log" >&2; tail -20 "$BIN_DIR/mediamtx.log" >&2; exit 1; }
echo "Media server is up on http://localhost:$MEDIA_PORT"

# 3. The app, pointed at the local media server. Guests are allowed because this is localhost only.
export PORT="$APP_PORT" STREAM_EMAIL="$GRID_EMAIL" STREAM_PASSWORD="$GRID_PASSWORD"
export MEDIA_SERVER_URL="http://localhost:$MEDIA_PORT" MEDIA_ALLOW_GUESTS=true MEDIA_MAX_LIVE_TILES="${MEDIA_MAX_LIVE_TILES:-10}"
export NODE_ENV=production
if [ "${SKIP_BUILD:-0}" != "1" ] || [ ! -f dist/server.cjs ]; then npm run build; fi
echo "Open http://localhost:$APP_PORT  (Ctrl+C here stops everything)"
npm start
