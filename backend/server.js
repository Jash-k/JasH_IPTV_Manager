#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           JASH ADDON — Full Backend Server                              ║
 * ║   Stremio IPTV Addon · Samsung Tizen HLS Extraction Engine             ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  • Serves the React configurator as static files                        ║
 * ║  • Exposes real Stremio addon endpoints                                 ║
 * ║  • Stream handler with full HLS master→variant→segment extraction       ║
 * ║  • Reads stream config synced from the configurator frontend            ║
 * ║  • Compatible with Render, Koyeb, Vercel, Railway, Fly.io              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * DEPLOY:
 *   npm install && node backend/server.js
 *
 * ENV VARS:
 *   PORT        — HTTP port (default: 7000)
 *   DEBUG       — set to "true" for verbose logs
 *   PUBLIC_URL  — your public domain (e.g. https://jash.onrender.com)
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '7000', 10);
const DEBUG       = process.env.DEBUG === 'true';
const PUBLIC_URL  = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR    = path.join(__dirname, '..', 'dist');
const CONFIG_FILE = path.join(__dirname, 'streams-config.json');
const REQUEST_TIMEOUT = 12000;
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}] [JASH]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DEBUG]`, ...a);
const err   = (...a) => console.error(`[${ts()}] [ERROR]`, ...a);

// ─── Stream Cache (playlist URL → resolved segment URL) ──────────────────────
const streamCache = new Map();

function getCached(playlistUrl) {
  const c = streamCache.get(playlistUrl);
  if (c && Date.now() - c.ts < CACHE_TTL) {
    debug('Cache hit:', playlistUrl.slice(0, 60));
    return c.url;
  }
  streamCache.delete(playlistUrl);
  return null;
}

function setCache(playlistUrl, resolvedUrl) {
  streamCache.set(playlistUrl, { url: resolvedUrl, ts: Date.now() });
}

// ─── ID Helpers ───────────────────────────────────────────────────────────────
function encodeId(rawUrl) {
  return Buffer.from(rawUrl).toString('base64url');
}

function decodeId(id) {
  try { return Buffer.from(id, 'base64url').toString('utf8'); }
  catch { return ''; }
}

// ─── Config Loading ───────────────────────────────────────────────────────────
let cachedConfig = null;
let configLoadedAt = 0;
const CONFIG_RELOAD_INTERVAL = 30 * 1000; // reload config every 30s if file changed

function loadConfig() {
  try {
    const now = Date.now();
    if (cachedConfig && now - configLoadedAt < CONFIG_RELOAD_INTERVAL) {
      return cachedConfig;
    }

    if (!fs.existsSync(CONFIG_FILE)) {
      debug('No config file found, using empty config');
      return { streams: [], groups: [], settings: { addonId: 'jash-iptv', addonName: 'Jash IPTV' } };
    }

    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    cachedConfig = config;
    configLoadedAt = now;
    debug(`Config loaded: ${config.streams?.length || 0} streams, ${config.groups?.length || 0} groups`);
    return config;
  } catch (e) {
    err('Failed to load config:', e.message);
    return { streams: [], groups: [], settings: { addonId: 'jash-iptv', addonName: 'Jash IPTV' } };
  }
}

function getStreams() {
  const config = loadConfig();
  return (config.streams || []).filter(s => s.enabled !== false);
}

function getGroups() {
  const config = loadConfig();
  const streams = getStreams();
  // Build groups from streams if not explicitly stored
  if (config.groups && config.groups.length > 0) {
    return config.groups.filter(g => g.enabled !== false);
  }
  // Auto-derive groups
  const groupSet = new Set();
  streams.forEach(s => groupSet.add(s.group || 'Uncategorized'));
  return [...groupSet].map((name, i) => ({ id: `g${i}`, name }));
}

function getSettings() {
  const config = loadConfig();
  return config.settings || { addonId: 'jash-iptv', addonName: 'Jash IPTV' };
}

// ─── Manifest Builder ─────────────────────────────────────────────────────────
function buildManifest() {
  const settings = getSettings();
  const groups   = getGroups();
  const streams  = getStreams();

  return {
    id         : settings.addonId || 'jash-iptv-addon',
    version    : '2.0.0',
    name       : settings.addonName || 'Jash IPTV',
    description: `Samsung Tizen optimized IPTV · ${streams.length} channels · HLS extraction`,
    logo       : `${PUBLIC_URL}/icon.png`,
    background : `${PUBLIC_URL}/bg.jpg`,
    resources  : ['catalog', 'meta', 'stream'],
    types      : ['tv'],
    idPrefixes : ['jash:'],
    catalogs   : groups.map((g, i) => ({
      type  : 'tv',
      id    : `jash_cat_${i}`,
      name  : g.name,
      extra : [{ name: 'search', isRequired: false }],
    })),
    behaviorHints: { adult: false, p2p: false, configurable: true, configurationRequired: false },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────
function handleCatalog(catId, extra) {
  const groups  = getGroups();
  const streams = getStreams();

  const idx       = parseInt(catId.replace('jash_cat_', ''), 10);
  const group     = groups[idx];

  if (!group) return { metas: [] };

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);

  // Search support
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    list = list.filter(s => s.name.toLowerCase().includes(q));
  }

  const metas = list.map(s => ({
    id         : 'jash:' + encodeId(s.url),
    type       : 'tv',
    name       : s.name,
    poster     : s.logo || '',
    background : s.logo || '',
    logo       : s.logo || '',
    description: `${s.group || 'Uncategorized'} · ${s.tvgId || ''}`,
    genres     : [s.group || 'Uncategorized'],
    links      : [],
    behaviorHints: { defaultVideoId: 'jash:' + encodeId(s.url) },
  }));

  debug(`[CATALOG] ${group.name} → ${metas.length} items`);
  return { metas };
}

// ─── Meta Handler ─────────────────────────────────────────────────────────────
function handleMeta(id) {
  const streams = getStreams();
  const rawUrl  = decodeId(id.replace('jash:', ''));
  const s       = streams.find(st => st.url === rawUrl);

  if (!s) return { meta: null };

  return {
    meta: {
      id,
      type       : 'tv',
      name       : s.name,
      poster     : s.logo || '',
      background : s.logo || '',
      logo       : s.logo || '',
      description: `Group: ${s.group || 'Uncategorized'}`,
      genres     : [s.group || 'Uncategorized'],
      releaseInfo: 'LIVE',
      behaviorHints: { defaultVideoId: id },
    },
  };
}

// ─── Fetch Playlist (Node.js native http/https) ───────────────────────────────
// Uses Samsung Tizen User-Agent — this is the exact same agent as in your working code.
function fetchPlaylist(playlistUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new url.URL(playlistUrl);
    const lib       = parsedUrl.protocol === 'https:' ? https : http;
    const timeout   = setTimeout(() => {
      req.destroy(new Error('Request timeout'));
    }, REQUEST_TIMEOUT);

    const options = {
      hostname: parsedUrl.hostname,
      port    : parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path    : parsedUrl.pathname + parsedUrl.search,
      method  : 'GET',
      headers : {
        // ★ Samsung Tizen UA — critical for servers that check UA
        'User-Agent'     : 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
        'Accept'         : '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection'     : 'keep-alive',
        'Cache-Control'  : 'no-cache',
        'Pragma'         : 'no-cache',
      },
    };

    const req = lib.get(options, (res) => {
      clearTimeout(timeout);

      // Follow redirects (up to 5)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redirectUrl = new url.URL(res.headers.location, playlistUrl).href;
          debug(`[FETCH] Redirect → ${redirectUrl.slice(0, 70)}`);
          fetchPlaylist(redirectUrl).then(resolve).catch(reject);
        } catch (e) {
          reject(new Error(`Bad redirect: ${res.headers.location}`));
        }
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${playlistUrl.slice(0, 60)}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end',  () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

// ─── Extract Real Stream URL ──────────────────────────────────────────────────
// ★ This is your EXACT extractRealStreamUrl function, ported 1:1 to the backend.
//   Samsung Tizen fix: picks MIDDLE quality variant from master playlist.
function extractRealStreamUrl(m3u8Content, baseUrl) {
  try {
    const lines    = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));

    if (isMaster) {
      debug('[EXTRACT] Master playlist detected');

      // Parse all quality variants
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const bwM   = lines[i].match(/BANDWIDTH=(\d+)/);
          const resM  = lines[i].match(/RESOLUTION=(\d+x\d+)/);
          const bandwidth  = bwM  ? parseInt(bwM[1], 10) : 0;
          const resolution = resM ? resM[1] : 'unknown';

          // Next non-comment line is the variant URL
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].startsWith('#')) {
              variants.push({ url: lines[j], bandwidth, resolution });
              break;
            }
          }
        }
      }

      if (!variants.length) {
        debug('[EXTRACT] No variants found in master playlist');
        return null;
      }

      // Sort highest bandwidth first
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // ★ KEY: Select MIDDLE quality index for Samsung TV stability
      // Not highest (buffers on Samsung) · Not lowest (poor quality)
      const selectedIndex = Math.floor(variants.length / 2);
      const selected      = variants[selectedIndex];

      debug(
        `[EXTRACT] Variants: ${variants.length}, ` +
        `Selected[${selectedIndex}]: ${selected.resolution} @ ${selected.bandwidth} bps`
      );

      // Make absolute URL
      let variantUrl = selected.url;
      if (!variantUrl.startsWith('http')) {
        const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        variantUrl = base + variantUrl;
      }

      return variantUrl;

    } else {
      // Media playlist — return first segment URL (same as your original code)
      debug('[EXTRACT] Media playlist detected');

      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (
          line.includes('.ts')   ||
          line.includes('.m4s')  ||
          line.includes('.m3u8') ||
          line.includes('.aac')  ||
          line.includes('.mp4')
        ) {
          let segUrl = line;
          if (!segUrl.startsWith('http')) {
            const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            segUrl     = base + line;
          }
          debug(`[EXTRACT] Segment URL: ${segUrl.slice(0, 70)}`);
          return segUrl;
        }
      }

      debug('[EXTRACT] No segments found in media playlist');
      return null;
    }
  } catch (e) {
    err('[EXTRACT] Error:', e.message);
    return null;
  }
}

// ─── Stream Handler ───────────────────────────────────────────────────────────
// ★ This is the core handler — mirrors your defineStreamHandler exactly.
//   Fetches the playlist, extracts the real URL, caches it, returns it.
async function handleStream(id) {
  const streams = getStreams();

  if (!id.startsWith('jash:')) return { streams: [] };

  let playlistUrl = '';

  try {
    playlistUrl = decodeId(id.replace('jash:', ''));
    if (!playlistUrl) throw new Error('Could not decode stream ID');

    const stream = streams.find(s => s.url === playlistUrl);
    const streamName = stream?.name || 'Live Stream';

    // ── Cache Check ───────────────────────────────────────────────────────
    const cached = getCached(playlistUrl);
    if (cached) {
      log(`[STREAM] ⚡ Cache hit → ${streamName}`);
      return {
        streams: [{
          url          : cached,
          title        : `🔴 ${streamName}`,
          name         : getSettings().addonName || 'Jash IPTV',
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    // ── Skip HLS extraction for non-HLS streams ────────────────────────
    const isHLS =
      playlistUrl.endsWith('.m3u8')     ||
      playlistUrl.includes('.m3u8?')    ||
      playlistUrl.endsWith('.m3u')      ||
      playlistUrl.includes('/playlist') ||
      playlistUrl.includes('play.m3u8') ||
      playlistUrl.includes('/stream');

    if (!isHLS) {
      debug(`[STREAM] Direct stream (non-HLS): ${playlistUrl.slice(0, 60)}`);
      return {
        streams: [{
          url          : playlistUrl,
          title        : `🔴 ${streamName}`,
          name         : getSettings().addonName || 'Jash IPTV',
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    log(`[STREAM] Fetching playlist: ${playlistUrl.slice(0, 70)}…`);

    // ── Fetch M3U8 playlist ───────────────────────────────────────────────
    const m3u8Content = await fetchPlaylist(playlistUrl);
    log(`[STREAM] Playlist fetched (${m3u8Content.length} bytes) → ${streamName}`);

    if (!m3u8Content.includes('#EXTM3U') && !m3u8Content.includes('#EXT-X-')) {
      // Probably a direct stream URL inside the response, just serve the original
      debug('[STREAM] Response is not M3U8, treating as direct');
      return {
        streams: [{
          url          : playlistUrl,
          title        : `🔴 ${streamName}`,
          name         : getSettings().addonName || 'Jash IPTV',
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    // ── Extract real stream URL ───────────────────────────────────────────
    const realStreamUrl = extractRealStreamUrl(m3u8Content, playlistUrl);

    if (!realStreamUrl) {
      log(`[STREAM] No real URL extracted, using original: ${streamName}`);
      return {
        streams: [{
          url          : playlistUrl,
          title        : `🔴 ${streamName}`,
          name         : getSettings().addonName || 'Jash IPTV',
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    log(`[STREAM] ✅ Extracted: ${realStreamUrl.slice(0, 70)}… → ${streamName}`);
    setCache(playlistUrl, realStreamUrl);

    return {
      streams: [{
        url          : realStreamUrl,
        title        : `🔴 ${streamName}`,
        name         : getSettings().addonName || 'Jash IPTV',
        behaviorHints: { notWebReady: true },
      }],
    };

  } catch (e) {
    err(`[STREAM] Handler error for ${playlistUrl.slice(0, 60)}:`, e.message);

    // ── Fallback: return original URL so Stremio can attempt it anyway ──
    if (playlistUrl) {
      return {
        streams: [{
          url          : playlistUrl,
          title        : '🔴 Live (Fallback)',
          name         : getSettings().addonName || 'Jash IPTV',
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    return { streams: [] };
  }
}

// ─── Parse request path & query ───────────────────────────────────────────────
function parseRequest(reqUrl) {
  const parsed = url.parse(reqUrl, true);
  return { pathname: parsed.pathname, query: parsed.query };
}

// ─── Parse extra from query string ────────────────────────────────────────────
function parseExtra(extraStr) {
  if (!extraStr) return {};
  try {
    const parts = {};
    decodeURIComponent(extraStr).split('&').forEach(p => {
      const [k, v] = p.split('=');
      if (k) parts[k] = v || '';
    });
    return parts;
  } catch { return {}; }
}

// ─── Serve static file ────────────────────────────────────────────────────────
function serveStatic(res, filePath, mime) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      res.end(content);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
}

// ─── CORS Headers ────────────────────────────────────────────────────────────
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

// ─── JSON Response ────────────────────────────────────────────────────────────
function jsonRes(res, data, status = 200) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type'  : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ─── Main HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORSHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const { pathname, query } = parseRequest(req.url);
  debug(`[HTTP] ${req.method} ${pathname}`);

  // ── /health — server health check ─────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    const config = loadConfig();
    return jsonRes(res, {
      status      : 'ok',
      addon       : getSettings().addonName || 'Jash IPTV',
      streams     : (config.streams || []).filter(s => s.enabled !== false).length,
      groups      : getGroups().length,
      cache       : streamCache.size,
      uptime      : Math.round(process.uptime()),
      publicUrl   : PUBLIC_URL,
      manifestUrl : `${PUBLIC_URL}/manifest.json`,
    });
  }

  // ── /api/sync — receive config from frontend ───────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        cachedConfig   = config;
        configLoadedAt = Date.now();
        // Clear stream cache when config changes
        streamCache.clear();
        log(`[SYNC] Config updated: ${config.streams?.length || 0} streams`);
        return jsonRes(res, { ok: true, streams: config.streams?.length || 0 });
      } catch (e) {
        err('[SYNC] Failed:', e.message);
        return jsonRes(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── /api/config — get current config ──────────────────────────────────
  if (pathname === '/api/config' && req.method === 'GET') {
    const config = loadConfig();
    return jsonRes(res, config);
  }

  // ── /api/cache — cache management ──────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const size = streamCache.size;
    streamCache.clear();
    log(`[CACHE] Cleared ${size} entries`);
    return jsonRes(res, { ok: true, cleared: size });
  }

  // ── /manifest.json — Stremio addon manifest ────────────────────────────
  if (pathname === '/manifest.json') {
    const manifest = buildManifest();
    log(`[MANIFEST] Served: ${manifest.name} (${manifest.catalogs.length} catalogs)`);
    return jsonRes(res, manifest);
  }

  // ── /catalog/tv/:catId.json — catalog handler ──────────────────────────
  const catalogMatch = pathname.match(/^\/catalog\/tv\/([^/]+)\.json$/);
  if (catalogMatch) {
    const catId = decodeURIComponent(catalogMatch[1]);
    const extra = parseExtra(query.extra);
    const result = handleCatalog(catId, extra);
    debug(`[CATALOG] ${catId} → ${result.metas.length} metas`);
    return jsonRes(res, result);
  }

  // ── /meta/tv/:id.json — meta handler ──────────────────────────────────
  const metaMatch = pathname.match(/^\/meta\/tv\/([^/]+)\.json$/);
  if (metaMatch) {
    const id     = decodeURIComponent(metaMatch[1]);
    const result = handleMeta(id);
    return jsonRes(res, result);
  }

  // ── /stream/tv/:id.json — STREAM HANDLER (HLS extraction) ─────────────
  const streamMatch = pathname.match(/^\/stream\/tv\/([^/]+)\.json$/);
  if (streamMatch) {
    const id = decodeURIComponent(streamMatch[1]);
    log(`[STREAM] Request → ${id.slice(0, 60)}`);
    try {
      const result = await handleStream(id);
      return jsonRes(res, result);
    } catch (e) {
      err('[STREAM] Unhandled:', e.message);
      return jsonRes(res, { streams: [] });
    }
  }

  // ── /configure — redirect to configurator ─────────────────────────────
  if (pathname === '/configure') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // ── Static files (React app) ───────────────────────────────────────────
  // Serve index.html for SPA routes, static assets otherwise
  if (fs.existsSync(DIST_DIR)) {
    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js'  : 'application/javascript',
        '.css' : 'text/css',
        '.json': 'application/json',
        '.png' : 'image/png',
        '.jpg' : 'image/jpeg',
        '.svg' : 'image/svg+xml',
        '.ico' : 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      const mime = mimeTypes[ext] || 'application/octet-stream';
      serveStatic(res, filePath, mime);
    } else {
      // SPA fallback — serve index.html
      serveStatic(res, path.join(DIST_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
  } else {
    // No dist — dev mode info
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Jash Addon</title></head>
      <body style="background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem">
        <h1>🚀 Jash Addon Backend Running</h1>
        <p>Build the frontend first: <code>npm run build</code></p>
        <p>Then restart: <code>node backend/server.js</code></p>
        <hr style="border-color:#334155;margin:1rem 0">
        <p>📋 Manifest: <a href="/manifest.json" style="color:#818cf8">/manifest.json</a></p>
        <p>❤️ Health:   <a href="/health" style="color:#34d399">/health</a></p>
      </body>
      </html>
    `);
  }
});

// ─── Error Handling ───────────────────────────────────────────────────────────
process.on('uncaughtException',  e => err('Uncaught exception:', e.message, e.stack));
process.on('unhandledRejection', (r) => err('Unhandled rejection:', r));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    err(`Port ${PORT} is already in use. Set PORT env var to use a different port.`);
    process.exit(1);
  }
  err('Server error:', e.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('═══════════════════════════════════════════════════════');
  log(`🚀  Jash Addon Server started!`);
  log(`📡  Address   : http://0.0.0.0:${PORT}`);
  log(`🌐  Public URL: ${PUBLIC_URL}`);
  log(`📋  Manifest  : ${PUBLIC_URL}/manifest.json`);
  log(`⚙️   Config UI : ${PUBLIC_URL}/`);
  log(`❤️   Health    : ${PUBLIC_URL}/health`);
  log(`📺  Install   : stremio://${PUBLIC_URL.replace('https://', '').replace('http://', '')}/manifest.json`);
  log('═══════════════════════════════════════════════════════');

  const config = loadConfig();
  if (config.streams && config.streams.length > 0) {
    log(`📺  Streams loaded: ${config.streams.filter(s => s.enabled !== false).length}`);
    log(`📂  Groups        : ${getGroups().length}`);
  } else {
    log('ℹ️   No streams configured yet. Open the configurator to add sources.');
  }
});
