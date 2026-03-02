FROM node:20-alpine

# ── System deps: FFmpeg + build tools ─────────────────────────────────────────
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    wget \
    curl \
    ca-certificates \
    supervisor

WORKDIR /app

# ── Install main server deps (Express 4) ──────────────────────────────────────
COPY package*.json ./
RUN npm install --legacy-peer-deps && \
    npm install --save express@4.21.2 cors@2.8.5 --legacy-peer-deps

# ── Install streaming server deps ─────────────────────────────────────────────
COPY streaming-server/package.json ./streaming-server/
RUN cd streaming-server && \
    npm install --legacy-peer-deps && \
    npm install --save express@4.21.2 cors@2.8.5 --legacy-peer-deps

# ── Copy ALL source files ──────────────────────────────────────────────────────
COPY . .

# ── Build React frontend ───────────────────────────────────────────────────────
RUN npm run build

# ── Create directories ─────────────────────────────────────────────────────────
RUN mkdir -p /data/db /data/hls-output && chmod -R 777 /data

# ── Supervisord config — run BOTH servers ─────────────────────────────────────
RUN mkdir -p /etc/supervisor/conf.d
COPY supervisord.conf /etc/supervisord.conf

# ── Expose ports ───────────────────────────────────────────────────────────────
EXPOSE 10000 10001

# ── Health check (main server) ─────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:10000/health || exit 1

# ── Start both servers via supervisord ────────────────────────────────────────
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
