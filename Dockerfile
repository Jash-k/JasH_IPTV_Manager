# =============================================================================
# Multi-stage Dockerfile — IPTV Manager
# Stage 1: deps    — npm install (cached unless package.json changes)
# Stage 2: builder — Vite build  (cached unless src/ changes)
# Stage 3: runner  — lean production image ~120MB
# =============================================================================

# =============================================================================
# Stage 1: deps — install node_modules
# Cached as long as package.json / package-lock.json don't change
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy ONLY package files first — maximises layer cache hit rate
COPY package.json ./
COPY package-lock.json* ./

# Install all dependencies (including devDeps needed for Vite build)
# Force Express 4 — Express 5 breaks wildcard routes via path-to-regexp
RUN npm install --no-audit --no-fund && \
    npm install --save-exact \
      express@4.21.2 \
      cors@2.8.5 \
      axios@1.7.7 \
    --no-audit --no-fund --legacy-peer-deps

# =============================================================================
# Stage 2: builder — compile React / Vite
# Cached as long as src/ and config files don't change
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Bring in node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy build config (separate layer — changes less often than src/)
COPY package.json ./
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./

# Copy source code (this layer invalidates when src changes)
COPY src/ ./src/

# Build React app → /app/dist
RUN npm run build

# =============================================================================
# Stage 3: runner — lean production image
# Only production node_modules + built dist + server.cjs
# =============================================================================
FROM node:20-alpine AS runner

# Install runtime tools only
RUN apk add --no-cache curl tini

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy built React frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server (single file — CJS bypasses "type":"module" in package.json)
COPY server.cjs ./server.cjs

# Copy package.json (needed by Node for module resolution)
COPY package.json ./package.json

# Create data directory for persistent DB
RUN mkdir -p /data/db && chmod -R 777 /data

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app /data

USER nodejs

EXPOSE 10000

# tini as PID 1 — proper signal handling, fast shutdown
ENTRYPOINT ["/sbin/tini", "--"]

# Docker health check
HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=15s \
  --retries=3 \
  CMD curl -sf http://localhost:10000/health || exit 1

CMD ["node", "server.cjs"]
