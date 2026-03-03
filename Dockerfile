# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: deps — install ALL node_modules (cached unless package.json changes)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy ONLY package files first — layer cached until package*.json changes
COPY package.json package-lock.json* ./

# Install all deps (including devDeps needed for build)
# Force Express 4 to avoid path-to-regexp wildcard breakage in Express 5
RUN npm ci --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund && \
    npm install --save-exact \
      express@4.21.2 \
      cors@2.8.5 \
      axios@1.7.7 \
    --no-audit --no-fund --legacy-peer-deps

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: builder — compile React/Vite (cached unless src/ changes)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy installed node_modules from deps stage (pre-cached)
COPY --from=deps /app/node_modules ./node_modules

# Copy build config files (cached layer — rarely changes)
COPY package.json vite.config.ts tsconfig.json index.html ./

# Copy source code (invalidates only when source changes)
COPY src/ ./src/

# Build React app — outputs to /app/dist
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: runner — lean production image (no devDeps, no build tools)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Install ONLY runtime system deps: FFmpeg + curl (for keepalive)
RUN apk add --no-cache \
    ffmpeg \
    curl \
    ca-certificates \
    tini

WORKDIR /app

# Copy ONLY production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy built React dist from builder stage
COPY --from=builder /app/dist ./dist

# Copy ONLY the server file (single CJS file — no src/ needed)
COPY server.cjs ./server.cjs

# Create persistent data directories
RUN mkdir -p /data/db /data/hls-output && \
    chmod -R 777 /data

# Drop to non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app /data

USER nodejs

# Expose port
EXPOSE 10000

# Use tini as PID 1 for proper signal handling (fast shutdown/restart)
ENTRYPOINT ["/sbin/tini", "--"]

# Health check — fast, lightweight
HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=10s \
  --retries=3 \
  CMD curl -sf http://localhost:10000/health || exit 1

# Start server
CMD ["node", "server.cjs"]
