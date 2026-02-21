# ─────────────────────────────────────────────────────────────────────────────
# JASH ADDON — Dockerfile
# Multi-stage build: 1) Build React app  2) Run Node.js server
# Compatible with: Render, Koyeb, Railway, Fly.io, Docker, any VPS
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build the React frontend ────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./

# Install ALL dependencies including devDependencies (needed for vite build)
RUN npm install --include=dev

# Copy source code
COPY . .

# Build the React app → outputs to /app/dist
RUN npm run build

# ── Stage 2: Production server ────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies (express, cors)
RUN npm install --omit=dev

# Copy the built React app from builder stage
COPY --from=builder /app/dist ./dist

# Copy the backend server
COPY backend/ ./backend/

# Copy any other needed files
COPY index.html ./

# Create empty config if it doesn't exist
RUN mkdir -p backend && \
    echo '{"streams":[],"groups":[],"sources":[],"settings":{"addonId":"jash-iptv-addon","addonName":"Jash IPTV","corsProxy":"https://corsproxy.io/?","autoRemoveDead":false,"combineByGroups":true,"healthCheckInterval":60}}' \
    > backend/streams-config.json 2>/dev/null || true

# Expose port (default 7000, override with PORT env var)
EXPOSE 7000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 7000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the backend server
CMD ["node", "backend/server.js"]
