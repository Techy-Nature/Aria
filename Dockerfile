FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY bot/package.json bot/package.json
RUN npm ci --include=dev
COPY bot bot
RUN npm run build

FROM docker.io/tailscale/tailscale:v1.104.4 AS tailscale

FROM node:22-bookworm-slim
ARG YTDLP_VERSION=2026.10.26
ARG BGUTIL_PROVIDER_VERSION=1.3.2
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates git \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]==${YTDLP_VERSION}" "bgutil-ytdlp-pot-provider==${BGUTIL_PROVIDER_VERSION}" \
    && git clone --depth 1 --branch "${BGUTIL_PROVIDER_VERSION}" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /root/bgutil-ytdlp-pot-provider \
    && cd /root/bgutil-ytdlp-pot-provider/server && npm ci && npx tsc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY bot/package.json bot/package.json
RUN npm ci --omit=dev
COPY --from=build /app/bot/dist bot/dist
COPY dashboard dashboard
# Tailscale's static binaries; only used when TS_AUTHKEY is set (see scripts/start.sh).
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
COPY scripts/start.sh /app/start.sh
ENV NODE_ENV=production
ENV YTDLP_PO_TOKEN_ENABLED=true
ENV BGUTIL_SCRIPT_PATH=/root/bgutil-ytdlp-pot-provider/server/build/generate_once.js
CMD ["/app/start.sh"]
