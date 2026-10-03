#!/bin/sh
# Builds MediaMTX's config from environment variables, then starts it. Nothing secret is stored in the
# repository or the image: the grid login and the viewer password only ever come from the environment.
#
# What it does: for every camera id it creates a path (cam01, cam02, ...) that PULLS that camera's RTSP
# stream from the grid -- but only while somebody is watching (sourceOnDemand), once, no matter how many
# viewers there are -- and republishes it over HLS (and WebRTC) for browsers.
set -eu
# Never let the shell expand '*' (the default allowed origin) into file names.
set -f

: "${GRID_EMAIL:?Set GRID_EMAIL (the camera grid account email)}"
: "${GRID_PASSWORD:?Set GRID_PASSWORD (the camera grid account password)}"
: "${MEDIA_VIEWER_PASSWORD:?Set MEDIA_VIEWER_PASSWORD (what browsers must send to watch; make it long and random)}"

GRID_RTSP_HOST="${GRID_RTSP_HOST:-103.250.160.189}"
GRID_RTSP_PORT="${GRID_RTSP_PORT:-8554}"
GRID_RTSP_PATH="${GRID_RTSP_PATH:-stream}"
CAMERA_COUNT="${CAMERA_COUNT:-30}"
CAMERA_IDS="${CAMERA_IDS:-}"
MEDIA_HLS_PORT="${MEDIA_HLS_PORT:-8888}"
MEDIA_WEBRTC_PORT="${MEDIA_WEBRTC_PORT:-8889}"
MEDIA_WEBRTC_UDP_PORT="${MEDIA_WEBRTC_UDP_PORT:-8189}"
MEDIA_API_PORT="${MEDIA_API_PORT:-9997}"
MEDIA_ALLOW_ORIGIN="${MEDIA_ALLOW_ORIGIN:-*}"
MEDIA_PUBLIC_HOST="${MEDIA_PUBLIC_HOST:-}"
# fmp4 = standard HLS: about 1 request a second per camera and tolerant of a slow or distant connection.
# lowLatency saves a few seconds of delay but fetches tiny parts several times a second; in testing with a
# 300 ms network delay it stalled (14 buffering events in 45 s against none for fmp4) and made 4x the requests.
MEDIA_HLS_VARIANT="${MEDIA_HLS_VARIANT:-fmp4}"
# Some grid cameras only send a keyframe every 20-40 s and a stream cannot start before one arrives.
SOURCE_START_TIMEOUT="${SOURCE_START_TIMEOUT:-60s}"
# How long a camera stays pulled from the grid after its last viewer leaves: the HLS muxer waits
# MEDIA_IDLE_CLOSE, then the source waits SOURCE_CLOSE_AFTER, so the two add up, and watch time on the grid
# account is spent while a camera is pulled. MEDIA_IDLE_CLOSE must NOT be shorter than the slowest camera's
# keyframe interval: the timer also runs while a stream waits for its first keyframe, and a camera that
# sends one only every 30 s would be torn down before it could ever start (seen in testing at 15 s).
MEDIA_IDLE_CLOSE="${MEDIA_IDLE_CLOSE:-60s}"
SOURCE_CLOSE_AFTER="${SOURCE_CLOSE_AFTER:-5s}"
MEDIAMTX_BIN="${MEDIAMTX_BIN:-/mediamtx}"
CONFIG="${MEDIAMTX_CONFIG:-/tmp/mediamtx.yml}"

case "$MEDIA_VIEWER_PASSWORD" in
  *[!A-Za-z0-9\!\$\(\)\*+.\;\<=\>\[\]^_,@#\&-]*)
    echo "MEDIA_VIEWER_PASSWORD may only contain letters, digits and ! \$ ( ) * + . ; < = > [ ] ^ _ , @ # & - (MediaMTX's own rule). A random hex string is safest." >&2; exit 1 ;;
esac

# Percent-encode a string for use inside a URL's user:password part.
urlencode() {
  s="$1"; out=""; i=1; n=${#s}
  while [ "$i" -le "$n" ]; do
    c=$(printf '%s' "$s" | cut -c"$i")
    case "$c" in
      [a-zA-Z0-9.~_-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}
# A YAML single-quoted scalar ('' is an escaped quote).
yq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

if [ -z "$CAMERA_IDS" ]; then
  i=1
  while [ "$i" -le "$CAMERA_COUNT" ]; do
    CAMERA_IDS="$CAMERA_IDS$(printf 'cam%02d' "$i"),"
    i=$((i + 1))
  done
fi

USER_ENC=$(urlencode "$GRID_EMAIL")
PASS_ENC=$(urlencode "$GRID_PASSWORD")

ORIGINS=""
for o in $(printf '%s' "$MEDIA_ALLOW_ORIGIN" | tr ',' ' '); do ORIGINS="$ORIGINS$(yq "$o"), "; done
ORIGINS="[${ORIGINS%, }]"
HOSTS="[]"
if [ -n "$MEDIA_PUBLIC_HOST" ]; then HOSTS="[$(yq "$MEDIA_PUBLIC_HOST")]"; fi

{
  cat <<YAML
logLevel: info
# The grid is the only source: nobody may publish here, only read (watch).
authMethod: internal
authInternalUsers:
  - user: viewer
    pass: $(yq "$MEDIA_VIEWER_PASSWORD")
    permissions:
      - action: read
  - user: any
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: api
      - action: metrics
# Local-only, used by the health check.
api: yes
apiAddress: 127.0.0.1:$MEDIA_API_PORT
rtsp: no
rtmp: no
srt: no
moq: no
playback: no
hls: yes
hlsAddress: :$MEDIA_HLS_PORT
hlsVariant: $MEDIA_HLS_VARIANT
# The HLS muxer has its own idle timer (default 60 s) that keeps a camera pulled.
hlsMuxerCloseAfter: $MEDIA_IDLE_CLOSE
hlsAllowOrigins: $ORIGINS
webrtc: yes
webrtcAddress: :$MEDIA_WEBRTC_PORT
webrtcLocalUDPAddress: :$MEDIA_WEBRTC_UDP_PORT
webrtcAllowOrigins: $ORIGINS
webrtcAdditionalHosts: $HOSTS
paths:
YAML
  for id in $(printf '%s' "$CAMERA_IDS" | tr ',' ' '); do
    case "$id" in
      *[!A-Za-z0-9_-]*|"") echo "Invalid camera id '$id': use letters, digits, - and _ only." >&2; exit 1 ;;
    esac
    cat <<YAML
  $id:
    source: rtsp://$USER_ENC:$PASS_ENC@$GRID_RTSP_HOST:$GRID_RTSP_PORT/$GRID_RTSP_PATH/$id
    rtspTransport: tcp
    sourceOnDemand: yes
    sourceOnDemandStartTimeout: $SOURCE_START_TIMEOUT
    sourceOnDemandCloseAfter: $SOURCE_CLOSE_AFTER
YAML
  done
} > "$CONFIG"
chmod 600 "$CONFIG"

echo "[media-server] $(printf '%s' "$CAMERA_IDS" | tr ',' '\n' | grep -c .) cameras from rtsp://$GRID_RTSP_HOST:$GRID_RTSP_PORT/$GRID_RTSP_PATH/<id>; HLS on :$MEDIA_HLS_PORT, WebRTC on :$MEDIA_WEBRTC_PORT"
exec "$MEDIAMTX_BIN" "$CONFIG"
