FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY bot/package.json bot/package.json
RUN npm ci --include=dev
COPY bot bot
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY bot/package.json bot/package.json
RUN npm ci --omit=dev
COPY --from=build /app/bot/dist bot/dist
COPY dashboard dashboard
ENV NODE_ENV=production
CMD ["npm", "start"]
