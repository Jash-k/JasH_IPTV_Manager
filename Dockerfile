# =============================================================================
# Multi-stage Dockerfile — IPTV Manager v15
# Stage 1: deps    — npm install (cached unless package.json changes)
# Stage 2: builder — Vite build  (cached unless src/ changes)
# Stage 3: runner  — lean production image ~120MB
# =============================================================================

# ── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./

# Force Express 4 — Express 5 breaks wildcard routes
RUN npm install --no-audit --no-fund && \
    npm install --save-exact \
      express@4.21.2 \
      cors@2.8.5 \
      axios@1.7.7 \
    --no-audit --no-fund --legacy-peer-deps

# ── Stage 2: Build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.html   ./
COPY vite.config.ts ./
COPY tsconfig.json  ./
COPY src/ ./src/

RUN npm run build

# ── Stage 3: Production runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

# curl for health check, tini for proper PID 1
RUN apk add --no-cache curl tini

WORKDIR /app

# Copy production node_modules
COPY --from=deps /app/node_modules ./node_modules

# Copy built React frontend
COPY --from=builder /app/dist ./dist

# Copy servers
COPY server.cjs     ./server.cjs
COPY hls-proxy.cjs  ./hls-proxy.cjs
COPY start.sh       ./start.sh
COPY package.json   ./package.json

# Make start.sh executable
RUN chmod +x ./start.sh

# Persistent data directory
RUN mkdir -p /data/db && chmod -R 777 /data

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app /data

USER nodejs

# Main server port (Render only exposes one port)
EXPOSE 10000

# Health check on main server
HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=20s \
  --retries=3 \
  CMD curl -sf http://localhost:10000/health || exit 1

# tini as PID 1 — proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Start both servers via start.sh
CMD ["sh", "./start.sh"]
