FROM node:20-alpine

# ── System deps: FFmpeg + build tools ─────────────────────────────────────────
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    wget \
    curl \
    ca-certificates

# Check FFmpeg installed correctly
RUN ffmpeg -version 2>&1 | head -1

WORKDIR /app

# ── Install dependencies — Force Express 4 (Express 5 breaks wildcards) ───────
COPY package*.json ./
RUN npm install --legacy-peer-deps && \
    npm install --save express@4.21.2 cors@2.8.5 --legacy-peer-deps

# ── Copy ALL source files ──────────────────────────────────────────────────────
COPY . .

# ── Build React frontend ───────────────────────────────────────────────────────
RUN npm run build

# ── Create data directories ────────────────────────────────────────────────────
RUN mkdir -p /data/db /data/hls-output /data/segments && \
    chmod -R 777 /data

# ── Expose main port ───────────────────────────────────────────────────────────
EXPOSE 10000

# ── Health check ───────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:10000/health || exit 1

# ── Start unified server ───────────────────────────────────────────────────────
CMD ["node", "server.cjs"]
