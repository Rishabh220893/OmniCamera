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
# HLS sessions are tied to the viewer's IP address. Behind a hosting proxy (Render, Cloudflare) every request
# can arrive from a different proxy address, so sessions "disappear" (401 "session not found") unless MediaMTX
# takes the real IP from X-Forwarded-For. Trusting every proxy only lets a viewer pick the IP of its own session;
# the viewer password is still checked on every request.
MEDIA_TRUSTED_PROXIES="${MEDIA_TRUSTED_PROXIES:-0.0.0.0/0,::/0}"
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
# MediaMTX keeps only the newest HLS_SEGMENT_COUNT segments. The default (7 x 1 s) is too short for a viewer whose
# requests take 1-5 s through a hosting proxy: by the time it asks for a segment the window has moved on and the
# server answers 404 (seen in a production HAR). A longer window costs memory and a few seconds of delay.
HLS_SEGMENT_COUNT="${HLS_SEGMENT_COUNT:-30}"
HLS_SEGMENT_DURATION="${HLS_SEGMENT_DURATION:-2s}"
case "$HLS_SEGMENT_COUNT$HLS_SEGMENT_DURATION" in
  *[!0-9sm]*|"") echo "HLS_SEGMENT_COUNT must be a number and HLS_SEGMENT_DURATION like 2s." >&2; exit 1 ;;
esac
SOURCE_CLOSE_AFTER="${SOURCE_CLOSE_AFTER:-5s}"
# H.265 cameras: MediaMTX receives them but its HLS output never starts for the grid's H.265 streams (tested on
# cam06 and cam26: no playlist in 60 s), so the browser gets nothing. Cameras listed here are instead re-encoded to
# H.264 by ffmpeg, only while somebody watches. Needs ffmpeg with Intel Quick Sync (h264_qsv, hevc_qsv); empty = off.
# ffmpeg publishes back over a private RTSP port that only listens on this machine.
MEDIA_TRANSCODE_IDS="${MEDIA_TRANSCODE_IDS:-}"
MEDIA_TRANSCODE_BITRATE="${MEDIA_TRANSCODE_BITRATE:-2500k}"
MEDIA_TRANSCODE_RTSP_PORT="${MEDIA_TRANSCODE_RTSP_PORT:-18554}"
MEDIA_FFMPEG="${MEDIA_FFMPEG:-ffmpeg}"
case "$MEDIA_TRANSCODE_IDS" in
  *[!A-Za-z0-9_,-]*) echo "MEDIA_TRANSCODE_IDS must be comma-separated camera ids (letters, digits, - and _)." >&2; exit 1 ;;
esac
case "$MEDIA_TRANSCODE_BITRATE$MEDIA_TRANSCODE_RTSP_PORT" in
  *[!0-9km]*|"") echo "MEDIA_TRANSCODE_BITRATE must look like 2500k and MEDIA_TRANSCODE_RTSP_PORT must be a number." >&2; exit 1 ;;
esac
case "$MEDIA_FFMPEG" in
  *[!A-Za-z0-9_./:\\-]*) echo "MEDIA_FFMPEG must be a plain path or command name." >&2; exit 1 ;;
esac
MEDIAMTX_BIN="${MEDIAMTX_BIN:-/mediamtx}"
CONFIG="${MEDIAMTX_CONFIG:-/tmp/mediamtx.yml}"

case "$MEDIA_VIEWER_PASSWORD" in
  *[!A-Za-z0-9\!\$\(\)\*+.\;\<=\>\[\]^_,@#\&-]*)
    echo "MEDIA_VIEWER_PASSWORD may only contain letters, digits and ! \$ ( ) * + . ; < = > [ ] ^ _ , @ # & - (MediaMTX's own rule). A random hex string is safest." >&2; exit 1 ;;
esac

case "$MEDIA_TRUSTED_PROXIES" in
  *[!0-9A-Fa-f:./,\ ]*) echo "MEDIA_TRUSTED_PROXIES must be comma-separated IPs or CIDRs." >&2; exit 1 ;;
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
PROXIES=""
for o in $(printf '%s' "$MEDIA_TRUSTED_PROXIES" | tr ',' ' '); do PROXIES="$PROXIES$(yq "$o"), "; done
PROXIES="[${PROXIES%, }]"
HOSTS="[]"
if [ -n "$MEDIA_PUBLIC_HOST" ]; then HOSTS="[$(yq "$MEDIA_PUBLIC_HOST")]"; fi

# Private RTSP listener (127.0.0.1 only) so ffmpeg can publish the re-encoded H.264 of the cameras above.
RTSP_YAML="rtsp: no"
PUBLISH_PERM=""
TRANSCODE_PATHS=""
if [ -n "$MEDIA_TRANSCODE_IDS" ]; then
  for t in $(printf '%s' "$MEDIA_TRANSCODE_IDS" | tr ',' ' '); do TRANSCODE_PATHS="$TRANSCODE_PATHS$t|"; done
  TRANSCODE_PATHS="${TRANSCODE_PATHS%|}"
  RTSP_YAML="rtsp: yes
rtspAddress: 127.0.0.1:$MEDIA_TRANSCODE_RTSP_PORT
rtspTransports: [tcp]"
  PUBLISH_PERM="      - action: publish
        path: '~^($TRANSCODE_PATHS)\$'"
fi
is_transcoded() { case ",$MEDIA_TRANSCODE_IDS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

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
${PUBLISH_PERM}
# Local-only, used by the health check.
api: yes
apiAddress: 127.0.0.1:$MEDIA_API_PORT
$RTSP_YAML
rtmp: no
srt: no
moq: no
playback: no
hls: yes
hlsAddress: :$MEDIA_HLS_PORT
hlsVariant: $MEDIA_HLS_VARIANT
# The HLS muxer has its own idle timer (default 60 s) that keeps a camera pulled.
hlsMuxerCloseAfter: $MEDIA_IDLE_CLOSE
hlsSegmentCount: $HLS_SEGMENT_COUNT
hlsSegmentDuration: $HLS_SEGMENT_DURATION
hlsAllowOrigins: $ORIGINS
hlsTrustedProxies: $PROXIES
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
    if is_transcoded "$id"; then
      # ffmpeg pulls the H.265 camera, re-encodes it to H.264 on the GPU and publishes it as this very path.
      # -g 30 forces a keyframe about every 3 s so HLS can start quickly. Do NOT add -use_wallclock_as_timestamps:
      # on cam06 it makes ffmpeg see 90000 fps and h264_qsv then refuses to open ("Function not implemented").
      FF="$MEDIA_FFMPEG -hide_banner -loglevel warning -hwaccel qsv -c:v hevc_qsv -rtsp_transport tcp -i rtsp://$USER_ENC:$PASS_ENC@$GRID_RTSP_HOST:$GRID_RTSP_PORT/$GRID_RTSP_PATH/$id -an -c:v h264_qsv -b:v $MEDIA_TRANSCODE_BITRATE -g 30 -bf 0 -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$MEDIA_TRANSCODE_RTSP_PORT/$id"
      cat <<YAML
  $id:
    runOnDemand: $(yq "$FF")
    runOnDemandStartTimeout: $SOURCE_START_TIMEOUT
    runOnDemandCloseAfter: $SOURCE_CLOSE_AFTER
YAML
    else
      cat <<YAML
  $id:
    source: rtsp://$USER_ENC:$PASS_ENC@$GRID_RTSP_HOST:$GRID_RTSP_PORT/$GRID_RTSP_PATH/$id
    rtspTransport: tcp
    sourceOnDemand: yes
    sourceOnDemandStartTimeout: $SOURCE_START_TIMEOUT
    sourceOnDemandCloseAfter: $SOURCE_CLOSE_AFTER
YAML
    fi
  done
} > "$CONFIG"
chmod 600 "$CONFIG"

echo "[media-server] $(printf '%s' "$CAMERA_IDS" | tr ',' '\n' | grep -c .) cameras from rtsp://$GRID_RTSP_HOST:$GRID_RTSP_PORT/$GRID_RTSP_PATH/<id>; HLS on :$MEDIA_HLS_PORT, WebRTC on :$MEDIA_WEBRTC_PORT"
if [ -n "$MEDIA_TRANSCODE_IDS" ]; then echo "[media-server] H.265 -> H.264 transcoding (Quick Sync) for: $MEDIA_TRANSCODE_IDS"; fi
exec "$MEDIAMTX_BIN" "$CONFIG"
