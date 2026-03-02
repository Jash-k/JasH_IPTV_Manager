FROM node:20-alpine

# ── Install FFmpeg (required for DRM stream decryption + HLS packaging) ────────
RUN apk add --no-cache \
    ffmpeg \
    ffmpeg-dev \
    python3 \
    make \
    g++ \
    wget \
    curl \
    ca-certificates

WORKDIR /app

# ── Install Node deps ──────────────────────────────────────────────────────────
COPY package.json ./
RUN npm install --legacy-peer-deps && \
    npm install --save express@4.21.2 cors@2.8.5 --legacy-peer-deps

# ── Copy server files ──────────────────────────────────────────────────────────
COPY . .

# ── Create output directory for HLS segments ──────────────────────────────────
RUN mkdir -p /data/hls-output && chmod 777 /data/hls-output

# ── Expose streaming server port ───────────────────────────────────────────────
EXPOSE 10001

# ── Health check ───────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:10001/health || exit 1

# ── Start streaming server ─────────────────────────────────────────────────────
CMD ["node", "server.js"]
