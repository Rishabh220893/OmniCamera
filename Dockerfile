# Main app (Express server + built React app) with ffmpeg, which server-side frame
# capture needs. Use this if GET /api/analysis/config reports "ffmpeg": false on your host,
# e.g. as a Docker web service on Render (see docs/deployment.md).
#
#   docker build -t omnisee .
#   docker run -p 3000:3000 --env-file .env omnisee
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# devDependencies are needed both to build and at runtime (the server imports vite).
RUN npm install --include=dev
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Runs as the unprivileged `node` user (uid 1000), which the Kubernetes manifests (deploy/k8s) rely on. /data is where the server keeps its small state files
# (set VMS_DATA_DIR=/data and mount a volume there).
RUN mkdir -p /data && chown -R node:node /app /data
USER node
# The server binds to $PORT when the host provides one, otherwise 3000.
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
