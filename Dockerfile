# =============================================================================
# Multi-stage Dockerfile — IPTV Manager v16
#
# Stage 1: deps    — npm install (cached when package.json unchanged)
# Stage 2: builder — Vite build  (cached when src/ unchanged)
# Stage 3: runner  — lean ~120MB production image
#
# Startup: start.sh → hls-proxy.cjs (port 10001) + server.cjs (port 10000)
# =============================================================================

# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./

# Force Express 4 — Express 5 breaks wildcard routes
RUN npm install --no-audit --no-fund && \
    npm install --save-exact \
      express@4.21.2 \
      cors@2.8.5 \
    --no-audit --no-fund --legacy-peer-deps

# ── Stage 2: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json    ./
COPY index.html      ./
COPY vite.config.ts  ./
COPY tsconfig.json   ./
COPY src/            ./src/

# Build args for Supabase (baked into frontend bundle at build time)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# ── Stage 3: Production runner ─────────────────────────────────────────────────
FROM node:20-alpine AS runner

# curl for health checks, tini for proper PID 1 signal handling
RUN apk add --no-cache curl tini

WORKDIR /app

# Copy only what's needed for production
COPY --from=deps    /app/node_modules  ./node_modules
COPY --from=builder /app/dist          ./dist
COPY package.json    ./
COPY server.cjs      ./
COPY hls-proxy.cjs   ./
COPY start.sh        ./

# Make start.sh executable
RUN chmod +x /app/start.sh

# Create persistent data directories
RUN mkdir -p /data/db && chmod -R 777 /data

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app /data

USER nodejs

# Render only exposes one external port — main server on 10000
# HLS proxy runs internally on 10001 (no external access needed)
EXPOSE 10000

# Docker health check
HEALTHCHECK \
  --interval=30s \
  --timeout=10s \
  --start-period=30s \
  --retries=3 \
  CMD curl -sf http://localhost:10000/health || exit 1

# tini as PID 1 — proper signal forwarding + zombie reaping
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/sh", "/app/start.sh"]
