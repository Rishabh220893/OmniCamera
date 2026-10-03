# Media server: pulls each grid camera once (only while someone is watching) and re-serves it to many
# browsers as HLS / WebRTC, so video never has to pass through the app server. MediaMTX is open source;
# no account or licence key is needed.
#
# The -ffmpeg variant of the official image is Alpine-based (it has a shell, which the entrypoint needs).
#
#   docker build -t omnisee-media media-server
#   docker run -d --env-file media-server/.env -p 8888:8888 -p 8889:8889 -p 8189:8189/udp omnisee-media
ARG MEDIAMTX_VERSION=1.21.1
FROM bluenviron/mediamtx:${MEDIAMTX_VERSION}-ffmpeg
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8888 8889 8189/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:9997/v3/paths/list >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
