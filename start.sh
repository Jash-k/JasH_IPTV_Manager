#!/bin/sh
# =============================================================================
# start.sh — Launch both IPTV servers
#
# Main Server  (port 10000) — 302 redirect + API + frontend
# HLS Proxy    (port 10001) — manifest rewrite for redirect-chain HLS streams
# =============================================================================

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  📺  IPTV Manager — Starting Servers                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Main Server  : port ${PORT:-10000} (302 redirects + API)            ║"
echo "║  HLS Proxy    : port ${HLS_PORT:-10001} (manifest rewrite)            ║"
echo "║  DB           : ${DB_FILE:-/data/db/db.json}                 ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Ensure /data directory exists for persistent DB
mkdir -p /data/db 2>/dev/null || true
mkdir -p /app     2>/dev/null || true

# Start HLS Proxy in background — restart if it crashes
start_hls() {
  while true; do
    echo "[START] Starting HLS Proxy on port ${HLS_PORT:-10001}..."
    node /app/hls-proxy.cjs || true
    echo "[START] HLS Proxy crashed — restarting in 3s..."
    sleep 3
  done
}

start_hls &
HLS_BG_PID=$!
echo "[START] HLS Proxy background watcher PID: $HLS_BG_PID"

# Give HLS proxy a moment to start
sleep 2

# Start Main Server in foreground — if this exits, container exits
echo "[START] Starting Main Server on port ${PORT:-10000}..."
exec node /app/server.cjs
