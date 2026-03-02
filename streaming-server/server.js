'use strict';
/**
 * streaming-server/server.js
 * ══════════════════════════════════════════════════════════════════════════════
 *  IPTV DRM Streaming Server v1.0
 *  Separate server for DRM-protected & transcoded streams
 *
 *  Architecture:
 *    ┌─────────────────────────────────────────────────────────────────┐
 *    │                    Player (VLC/Kodi/TiviMate)                   │
 *    └────────────────────────┬────────────────────────────────────────┘
 *                             │  HLS / M3U8
 *    ┌────────────────────────▼────────────────────────────────────────┐
 *    │              IPTV Manager Frontend (React)                       │
 *    │              Main Server  :10000  (server.cjs)                  │
 *    │   ┌──────────────────────────────────────────────────────────┐  │
 *    │   │  Non-DRM streams  → /proxy/redirect/:id (302 redirect)   │  │
 *    │   │  DRM streams      → /proxy/drm/:id (manifest rewrite)    │  │
 *    │   └──────────────────────┬───────────────────────────────────┘  │
 *    └──────────────────────────┼────────────────────────────────────  ┘
 *                               │  DRM channels (Widevine/ClearKey/PR)
 *    ┌──────────────────────────▼────────────────────────────────────  ┐
 *    │           DRM Streaming Server  :10001  (this file)             │
 *    │   ┌──────────────────────────────────────────────────────────┐  │
 *    │   │  FFmpeg  ─────► HLS segments (output/) ──► /stream/:id   │  │
 *    │   │  DRM resolve: ClearKey/Widevine/PlayReady/JioTV          │  │
 *    │   │  AES-128 re-encrypt output for universal playback        │  │
 *    │   │  HLS proxy for non-DRM streams (no transcoding)          │  │
 *    │   └──────────────────────────────────────────────────────────┘  │
 *    └────────────────────────────────────────────────────────────────  ┘
 *
 *  Endpoints:
 *    GET  /health                           — Health check
 *    GET  /api/stats                        — Server statistics
 *    GET  /stream/start/:channelId          — Start/resume session → redirect to HLS
 *    GET  /stream/:sessionId/master.m3u8    — Live HLS playlist
 *    GET  /stream/:sessionId/:seg.ts        — HLS segments
 *    GET  /stream/key/:channelId            — AES-128 key for HLS decryption
 *    POST /stream/stop/:channelId           — Stop transcoding
 *    GET  /stream/sessions                  — All active sessions
 *    GET  /hls-proxy/manifest/:id?url=...   — Proxy remote M3U8
 *    GET  /hls-proxy/seg/:id?url=...        — Proxy remote segment
 *    GET  /hls-proxy/key/:id?url=...        — Proxy remote key
 *    POST /keys/clearkey/:id               — ClearKey W3C EME license
 *    POST /keys/widevine/:id               — Widevine license proxy
 *    POST /keys/playready/:id              — PlayReady SOAP proxy
 *    POST /keys/fairplay/:id               — FairPlay CKC proxy
 *    GET  /keys/info/:channelId            — PSSH + KID inspector
 *    GET  /keys/aes/:sessionId             — AES-128 key
 *    GET  /playlist/all.m3u               — All channels via this server
 *    GET  /playlist/tamil.m3u             — Tamil channels via this server
 * ══════════════════════════════════════════════════════════════════════════════
 */

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const cfg        = require('./config');
const cache      = require('./src/cacheManager');
const transcoder = require('./src/transcoder');
const hlsManager = require('./src/hlsManager');
const drm        = require('./src/drmHandler');
const streamRoutes = require('./src/routes/stream');
const keyRoutes    = require('./src/routes/keys');

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Raw body for DRM binary challenges — applied in key routes
// Output dir static serving (segments)
if (!fs.existsSync(cfg.OUTPUT_DIR)) fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────────────────────────────────
app.use('/stream',     streamRoutes);
app.use('/hls-proxy',  streamRoutes); // hls-proxy routes are in stream.js
app.use('/keys',       keyRoutes);

// ─────────────────────────────────────────────────────────────────────────────
//  Health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const ffcheck = await transcoder.checkFFmpeg();
  res.json({
    status:     'ok',
    version:    '1.0.0',
    uptime:     Math.floor(process.uptime()),
    ffmpeg:     ffcheck.available,
    ffmpegVer:  ffcheck.version,
    sessions:   cache.getStats().activeSessions,
    nodeVersion: process.version,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Stats
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const ffcheck  = await transcoder.checkFFmpeg();
  const cacheStats = cache.getStats();
  const sessions   = cache.getAllSessions();

  res.json({
    server:     'IPTV DRM Streaming Server',
    version:    '1.0.0',
    uptime:     Math.floor(process.uptime()),
    nodeVersion: process.version,
    ffmpeg: {
      available: ffcheck.available,
      version:   ffcheck.version,
      hwAccel:   cfg.HW_ACCEL,
      videoCodec: cfg.VIDEO_CODEC,
      audioCodec: cfg.AUDIO_CODEC,
    },
    sessions: {
      total:   cacheStats.totalSessions,
      active:  cacheStats.activeSessions,
      viewers: cacheStats.totalViewers,
    },
    disk: {
      outputDir:   cfg.OUTPUT_DIR,
      usageMB:     cacheStats.diskUsageMB,
      maxMB:       cfg.CACHE_MAX_SIZE,
    },
    activeSessions: sessions
      .filter(s => s.status === 'running' || s.status === 'starting')
      .map(s => ({
        id:         s.id,
        channelId:  s.channelId,
        name:       s.channelName,
        status:     s.status,
        viewers:    s.viewers,
        uptime:     Math.floor((Date.now() - s.startedAt) / 1000),
        url:        s.playlistUrl,
      })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Playlist endpoints — channels routed through this streaming server
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllChannels() {
  try {
    const resp = await drm.fetchRaw(`${cfg.MAIN_SERVER}/api/channels?active=1`, {}, 10000);
    if (!resp.ok) return [];
    return resp.json();
  } catch { return []; }
}

const TAMIL_KW = [
  'tamil','sun tv','vijay tv','zee tamil','kalaignar','raj tv','jaya tv',
  'polimer','captain','vendhar','vasanth','adithya','puthuyugam','thanthi',
  'news7 tamil','news18 tamil','sathiyam','makkal','sirippoli','peppers',
  'chutti','star vijay','colors tamil','dd tamil','sun music','imayam',
  'puthiya thalaimurai','mega tv','zee thirai',
];

function isTamil(ch) {
  const hay = [ch.name, ch.group, ch.language, ch.tvgName, ch.country, ch.tvgId]
    .map(v => typeof v === 'string' ? v.toLowerCase() : typeof v === 'number' ? String(v) : '')
    .join(' ');
  return ch.isTamil === true || TAMIL_KW.some(k => hay.includes(k));
}

app.get('/playlist/all.m3u', async (req, res) => {
  const BASE     = req.protocol + '://' + req.get('host');
  const channels = await fetchAllChannels();
  const m3u      = hlsManager.generateStreamingPlaylist(channels, BASE, { name: 'All Channels' });
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u);
});

app.get('/playlist/tamil.m3u', async (req, res) => {
  const BASE     = req.protocol + '://' + req.get('host');
  const channels = (await fetchAllChannels()).filter(isTamil);
  const m3u      = hlsManager.generateStreamingPlaylist(channels, BASE, { name: 'Tamil Channels' });
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Landing page
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const BASE    = req.protocol + '://' + req.get('host');
  const ffcheck = await transcoder.checkFFmpeg();
  const stats   = cache.getStats();

  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IPTV DRM Streaming Server</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:ui-monospace,monospace;padding:2rem;line-height:1.7}
h1{color:#38bdf8;font-size:1.8rem;margin-bottom:.5rem}
h2{color:#7dd3fc;margin:1.5rem 0 .5rem;font-size:1.1rem}
.ok{color:#10b981}.err{color:#ef4444}.warn{color:#f59e0b}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem;margin:.4rem 0}
code{background:#0f172a;color:#f472b6;padding:2px 6px;border-radius:4px;font-size:.88em}
a{color:#38bdf8}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.8rem;margin:.5rem 0}
.badge{background:#1d4ed8;color:#fff;padding:1px 8px;border-radius:10px;font-size:.75em;margin-left:6px}
table{width:100%;border-collapse:collapse}td,th{padding:.4rem .8rem;border:1px solid #334155;font-size:.85em}
th{background:#1e3a5f;color:#7dd3fc}
</style></head><body>
<h1>🔴 IPTV DRM Streaming Server <span class="badge">v1.0</span></h1>
<p>FFmpeg: <span class="${ffcheck.available?'ok':'err'}">${ffcheck.available?'✅ '+ffcheck.version:'❌ Not found — install FFmpeg!'}</span>
  &nbsp;|&nbsp; Sessions: <b>${stats.activeSessions}</b> active
  &nbsp;|&nbsp; Disk: <b>${stats.diskUsageMB}MB</b>
  &nbsp;|&nbsp; <a href="/health">/health</a> | <a href="/api/stats">/api/stats</a>
</p>

<h2>📺 Playlist URLs</h2>
<div class="grid">
  <div class="card"><b>All Channels</b><br><a href="${BASE}/playlist/all.m3u">${BASE}/playlist/all.m3u</a></div>
  <div class="card"><b>Tamil Channels</b><br><a href="${BASE}/playlist/tamil.m3u">${BASE}/playlist/tamil.m3u</a></div>
</div>

<h2>🔐 DRM Engine (Kodi inputstream.adaptive)</h2>
<div class="grid">
  <div class="card">
    <b>ClearKey</b> (AES-128, JioTV)<br>
    <code>POST /keys/clearkey/:id</code><br>
    <small>W3C EME JSON — kid:key inline or license server proxy</small>
  </div>
  <div class="card">
    <b>Widevine</b><br>
    <code>POST /keys/widevine/:id</code><br>
    <small>Binary protobuf challenge → real license server</small>
  </div>
  <div class="card">
    <b>PlayReady</b><br>
    <code>POST /keys/playready/:id</code><br>
    <small>SOAP XML challenge → license server</small>
  </div>
  <div class="card">
    <b>FairPlay</b><br>
    <code>POST /keys/fairplay/:id</code><br>
    <small>SPC → CKC proxy</small>
  </div>
</div>

<h2>📡 Stream Routes</h2>
<div class="grid">
  <div class="card">
    <b>Start Stream</b><br>
    <code>GET /stream/start/:channelId</code><br>
    <small>Starts FFmpeg → returns HLS playlist URL</small>
  </div>
  <div class="card">
    <b>HLS Playlist</b><br>
    <code>GET /stream/:sessionId/master.m3u8</code><br>
    <small>Live HLS playlist (FFmpeg output)</small>
  </div>
  <div class="card">
    <b>HLS Proxy (no transcode)</b><br>
    <code>GET /hls-proxy/manifest/:id?url=...</code><br>
    <small>Proxy remote M3U8 — rewrites segment URLs</small>
  </div>
  <div class="card">
    <b>PSSH Inspector</b><br>
    <code>GET /keys/info/:channelId</code><br>
    <small>Extracts PSSH boxes + KIDs from MPD/HLS</small>
  </div>
</div>

<h2>⚙️ FFmpeg Config</h2>
<div class="card">
  <table><tr><th>Setting</th><th>Value</th></tr>
  <tr><td>Video Codec</td><td><code>${cfg.VIDEO_CODEC}</code></td></tr>
  <tr><td>Audio Codec</td><td><code>${cfg.AUDIO_CODEC}</code></td></tr>
  <tr><td>HW Accel</td><td><code>${cfg.HW_ACCEL}</code></td></tr>
  <tr><td>Segment Time</td><td><code>${cfg.HLS_SEGMENT_TIME}s</code></td></tr>
  <tr><td>List Size</td><td><code>${cfg.HLS_LIST_SIZE} segments</code></td></tr>
  <tr><td>Output Dir</td><td><code>${cfg.OUTPUT_DIR}</code></td></tr>
  <tr><td>Main Server</td><td><code>${cfg.MAIN_SERVER}</code></td></tr>
  </table>
</div>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  404 fallback
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found: '+req.path, server: 'IPTV DRM Streaming Server' });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — stopping all sessions...');
  transcoder.stopAllSessions();
  setTimeout(() => process.exit(0), 3000);
});
process.on('SIGINT', () => {
  console.log('[Server] SIGINT received — stopping all sessions...');
  transcoder.stopAllSessions();
  setTimeout(() => process.exit(0), 2000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(cfg.PORT, cfg.HOST, async () => {
  const ffcheck = await transcoder.checkFFmpeg();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║    🔴  IPTV DRM Streaming Server v1.0                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`  🌐  URL:          http://${cfg.HOST}:${cfg.PORT}`);
  console.log(`  📺  All:          http://${cfg.HOST}:${cfg.PORT}/playlist/all.m3u`);
  console.log(`  🇮🇳  Tamil:        http://${cfg.HOST}:${cfg.PORT}/playlist/tamil.m3u`);
  console.log(`  🔐  ClearKey:     http://${cfg.HOST}:${cfg.PORT}/keys/clearkey/:id`);
  console.log(`  🔐  Widevine:     http://${cfg.HOST}:${cfg.PORT}/keys/widevine/:id`);
  console.log(`  🔐  PlayReady:    http://${cfg.HOST}:${cfg.PORT}/keys/playready/:id`);
  console.log(`  📡  Stream:       http://${cfg.HOST}:${cfg.PORT}/stream/start/:id`);
  console.log(`  🔍  PSSH Info:    http://${cfg.HOST}:${cfg.PORT}/keys/info/:id`);
  console.log(`  📊  Stats:        http://${cfg.HOST}:${cfg.PORT}/api/stats`);
  console.log(`  🎬  FFmpeg:       ${ffcheck.available ? '✅ '+ffcheck.version : '❌ NOT FOUND — install FFmpeg!'}`);
  console.log(`  📁  Output:       ${cfg.OUTPUT_DIR}`);
  console.log(`  🔗  Main Server:  ${cfg.MAIN_SERVER}`);
  console.log('');

  if (!ffcheck.available) {
    console.warn('  ⚠️  FFmpeg not found! DRM transcoding will fail.');
    console.warn('     Install: apt-get install ffmpeg  OR  apk add ffmpeg');
  }
});
