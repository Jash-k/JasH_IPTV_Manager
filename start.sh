#!/bin/sh
# =============================================================================
# start.sh — Launch both servers
#
# Main Server  (port 10000) — Pure 302 redirect for normal streams
# HLS Proxy    (port 10001) — Manifest rewrite for redirect-chain HLS streams
# =============================================================================

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  📺  IPTV Manager — Starting Servers                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Main Server  : port 10000 (302 redirects)               ║"
echo "║  HLS Proxy    : port 10001 (manifest rewrite)            ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Ensure /data directory exists for persistent DB
mkdir -p /data/db 2>/dev/null || true

# Start HLS Proxy in background
node hls-proxy.cjs &
HLS_PID=$!
echo "[START] HLS Proxy started (PID $HLS_PID)"

# Start Main Server in foreground (keeps container alive)
node server.cjs &
MAIN_PID=$!
echo "[START] Main Server started (PID $MAIN_PID)"

# Handle shutdown gracefully
trap "echo '[START] Shutting down...'; kill $HLS_PID $MAIN_PID 2>/dev/null; exit 0" TERM INT

# Wait for either process to exit
wait $HLS_PID $MAIN_PID
