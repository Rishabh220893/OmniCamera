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
# The server binds to $PORT when the host provides one, otherwise 3000.
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
