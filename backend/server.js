#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           JASH ADDON — Full Backend Server v5.0                         ║
 * ║   Stremio IPTV Addon · Samsung Tizen HLS Extraction Engine             ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  FIXES in v5:                                                           ║
 * ║  • Fixed "not recognized" — proper Stremio manifest format              ║
 * ║  • Added transportUrl field to manifest (required by Stremio)           ║
 * ║  • CORS headers on ALL routes including manifest.json                   ║
 * ║  • Correct stremio:// deep link generation                              ║
 * ║  • Extra endpoint for /configure redirect                               ║
 * ║  • Robust URL decode for stream IDs with special chars                  ║
 * ║  • Manifest ID stable, version bumps on sync                            ║
 * ║  • Multi-quality channels combined under one entry                      ║
 * ║  • Full HLS master→variant→segment extraction (Samsung Tizen fix)       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const urlMod = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '7000', 10);
const DEBUG      = process.env.DEBUG === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR   = path.join(__dirname, '..', 'dist');
const CFG_FILE   = path.join(__dirname, 'streams-config.json');
const REQ_TIMEOUT = 12000;
const CACHE_TTL   = 5 * 60 * 1000; // 5 min

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}] [JASH]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DBG]`, ...a);
const error = (...a) => console.error(`[${ts()}] [ERR]`, ...a);

// ─── Stream Cache ─────────────────────────────────────────────────────────────
const streamCache = new Map();

function getCached(k) {
  const c = streamCache.get(k);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.url;
  streamCache.delete(k);
  return null;
}
function setCache(k, v) { streamCache.set(k, { url: v, ts: Date.now() }); }

// ─── ID helpers ───────────────────────────────────────────────────────────────
const encodeId = (u) => Buffer.from(u).toString('base64url');
const decodeId = (s) => {
  try { return Buffer.from(s, 'base64url').toString('utf8'); }
  catch { return ''; }
};

// ─── Sync Epoch ───────────────────────────────────────────────────────────────
let syncEpoch = Date.now();

// ─── Config Loading ───────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) {
      return { streams: [], groups: [], settings: { addonId: 'jash-iptv-addon', addonName: 'Jash IPTV' } };
    }
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch (e) {
    error('loadConfig:', e.message);
    return { streams: [], groups: [], settings: { addonId: 'jash-iptv-addon', addonName: 'Jash IPTV' } };
  }
}

function getEnabledStreams() {
  const cfg = loadConfig();
  return (cfg.streams || [])
    .filter(s => s.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function getGroups() {
  const cfg     = loadConfig();
  const streams = getEnabledStreams();

  if (cfg.groups && cfg.groups.length) {
    return cfg.groups.filter(g =>
      g.enabled !== false && streams.some(s => (s.group || 'Uncategorized') === g.name)
    );
  }

  const seen = new Set();
  const out  = [];
  for (const s of streams) {
    const g = s.group || 'Uncategorized';
    if (!seen.has(g)) { seen.add(g); out.push({ id: `g_${out.length}`, name: g }); }
  }
  return out;
}

function getSettings() {
  return loadConfig().settings || { addonId: 'jash-iptv-addon', addonName: 'Jash IPTV' };
}

// ─── Multi-quality grouping ───────────────────────────────────────────────────
function groupByChannel(streams) {
  const map = new Map();
  for (const s of streams) {
    const key = `${s.group || 'Uncategorized'}||${s.name}`;
    if (!map.has(key)) {
      map.set(key, {
        id     : 'jash:' + encodeId(s.url),
        name   : s.name,
        group  : s.group || 'Uncategorized',
        logo   : s.logo  || '',
        tvgId  : s.tvgId || '',
        streams: [],
      });
    }
    map.get(key).streams.push(s);
  }
  return map;
}

// ─── Manifest Builder ─────────────────────────────────────────────────────────
// CRITICAL: Stremio requires these exact fields to recognise an addon:
//   • id        — unique string, stable across updates
//   • version   — semver string
//   • name      — display name
//   • resources — array of resource names
//   • types     — array of content types
//   • catalogs  — array of catalog descriptors
//   • transportUrl — the HTTPS URL to this manifest (added by Stremio SDK automatically,
//                    but we add it explicitly to help clients)
function buildManifest() {
  const settings  = getSettings();
  const groups    = getGroups();
  const streams   = getEnabledStreams();
  const addonId   = settings.addonId   || 'jash-iptv-addon';
  const addonName = settings.addonName || 'Jash IPTV';

  // Version encodes syncEpoch — changes on every sync → Stremio re-fetches catalogs
  const version = `2.${Math.floor(syncEpoch / 1000)}`;

  const catalogs = groups.map((g, i) => ({
    type : 'tv',
    id   : `jash_cat_${i}`,
    name : g.name,
    extra: [{ name: 'search', isRequired: false }],
  }));

  // If no groups yet, return a placeholder so Stremio doesn't reject the manifest
  if (!catalogs.length) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_cat_default',
      name : 'IPTV Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  return {
    id          : addonId,
    version,
    name        : addonName,
    description : `${addonName} · Samsung Tizen Optimized IPTV · ${streams.length} channels · HLS Extraction`,
    logo        : `${PUBLIC_URL}/favicon.ico`,
    // transportUrl is the HTTPS URL of this manifest — required for Stremio to properly identify addon
    transportUrl: `${PUBLIC_URL}/manifest.json`,
    resources   : ['catalog', 'meta', 'stream'],
    types       : ['tv'],
    idPrefixes  : ['jash:'],
    catalogs,
    behaviorHints: {
      adult                : false,
      p2p                  : false,
      configurable         : true,
      configurationRequired: false,
    },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ─── Catalog Handler ──────────────────────────────────────────────────────────
function handleCatalog(catId, extra) {
  const groups  = getGroups();
  const streams = getEnabledStreams();

  // Support both index-based (jash_cat_0) and name-based lookup
  let group;
  const idxMatch = catId.match(/^jash_cat_(\d+)$/);
  if (idxMatch) {
    group = groups[parseInt(idxMatch[1], 10)];
  } else {
    group = groups.find(g => g.id === catId || g.name === catId);
  }

  if (!group) {
    debug(`[CATALOG] Unknown catId: ${catId} — groups: ${groups.map(g => g.id).join(', ')}`);
    return { metas: [] };
  }

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    list = list.filter(s => s.name.toLowerCase().includes(q));
  }

  const channelMap = groupByChannel(list);
  const metas      = [];

  for (const ch of channelMap.values()) {
    const qualityNote = ch.streams.length > 1 ? ` · ${ch.streams.length} quality options` : '';
    metas.push({
      id          : ch.id,
      type        : 'tv',
      name        : ch.name,
      poster      : ch.logo || null,
      background  : ch.logo || null,
      logo        : ch.logo || null,
      description : `${ch.group}${qualityNote}`,
      genres      : [ch.group],
      behaviorHints: { defaultVideoId: ch.id },
    });
  }

  debug(`[CATALOG] ${group.name} → ${metas.length} channels (${list.length} streams)`);
  return { metas };
}

// ─── Meta Handler ─────────────────────────────────────────────────────────────
function handleMeta(id) {
  let rawUrl = '';
  try {
    // id is URL-encoded when it comes from the router
    const decoded = decodeURIComponent(id);
    rawUrl = decodeId(decoded.replace('jash:', ''));
  } catch {
    rawUrl = decodeId(id.replace('jash:', ''));
  }

  const allStreams = getEnabledStreams();
  const s         = allStreams.find(st => st.url === rawUrl);
  if (!s) {
    // Try to find by prefix match (multi-quality — return first match)
    const partial = allStreams.find(st => st.url.startsWith(rawUrl.slice(0, 40)));
    if (!partial) return { meta: null };
    return buildMeta(partial, id);
  }
  return buildMeta(s, id);
}

function buildMeta(s, id) {
  return {
    meta: {
      id,
      type        : 'tv',
      name        : s.name,
      poster      : s.logo || null,
      background  : s.logo || null,
      logo        : s.logo || null,
      description : `Group: ${s.group || 'Uncategorized'}`,
      genres      : [s.group || 'Uncategorized'],
      releaseInfo : 'LIVE',
      behaviorHints: { defaultVideoId: id },
    },
  };
}

// ─── Fetch Playlist ───────────────────────────────────────────────────────────
function fetchPlaylist(playlistUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new urlMod.URL(playlistUrl); }
    catch (e) { return reject(new Error(`Invalid URL: ${playlistUrl}`)); }

    const lib      = parsed.protocol === 'https:' ? https : http;
    let   timedOut = false;
    const timeout  = setTimeout(() => { timedOut = true; reject(new Error('Request timeout')); }, REQ_TIMEOUT);

    const req = lib.get({
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      headers : {
        'User-Agent'     : 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
        'Accept'         : '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection'     : 'keep-alive',
        'Cache-Control'  : 'no-cache',
        'Referer'        : parsed.origin || parsed.href,
      },
    }, (res) => {
      clearTimeout(timeout);
      if (timedOut) return;

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redir = new urlMod.URL(res.headers.location, playlistUrl).href;
          debug(`[FETCH] Redirect → ${redir.slice(0, 70)}`);
          fetchPlaylist(redir, redirectCount + 1).then(resolve).catch(reject);
        } catch (e) { reject(e); }
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

// ─── Extract Real Stream URL ──────────────────────────────────────────────────
// ★ Your EXACT algorithm — Samsung Tizen middle-quality fix.
function extractRealStreamUrl(m3u8Content, baseUrl) {
  try {
    const lines    = m3u8Content.split('\n').map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));

    if (isMaster) {
      debug('[EXTRACT] Master playlist detected');
      const variants = [];

      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('#EXT-X-STREAM-INF')) continue;
        const bwM  = lines[i].match(/BANDWIDTH=(\d+)/);
        const resM = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            variants.push({
              url       : lines[j],
              bandwidth : bwM  ? parseInt(bwM[1], 10) : 0,
              resolution: resM ? resM[1] : 'unknown',
            });
            break;
          }
        }
      }

      if (!variants.length) { debug('[EXTRACT] No variants found'); return null; }

      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // ★ KEY: Pick MIDDLE quality for Samsung TV stability
      const idx      = Math.floor(variants.length / 2);
      const selected = variants[idx];
      debug(`[EXTRACT] ${variants.length} variants → [${idx}] ${selected.resolution} @ ${selected.bandwidth}bps`);

      let vUrl = selected.url;
      if (!vUrl.startsWith('http')) {
        vUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + vUrl;
      }
      return vUrl;

    } else {
      debug('[EXTRACT] Media playlist detected');
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (
          line.includes('.ts')   || line.includes('.m4s') ||
          line.includes('.m3u8') || line.includes('.aac') ||
          line.includes('.mp4')
        ) {
          let segUrl = line;
          if (!segUrl.startsWith('http')) {
            segUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + line;
          }
          debug(`[EXTRACT] Segment: ${segUrl.slice(0, 70)}`);
          return segUrl;
        }
      }
      debug('[EXTRACT] No segments found in media playlist');
      return null;
    }
  } catch (e) {
    error('[EXTRACT]', e.message);
    return null;
  }
}

// ─── Resolve Single Stream URL ────────────────────────────────────────────────
async function resolveStreamUrl(playlistUrl) {
  const cached = getCached(playlistUrl);
  if (cached) {
    log(`[STREAM] ⚡ Cache hit for ${playlistUrl.slice(0, 50)}`);
    return { url: cached };
  }

  const isHLS =
    playlistUrl.includes('.m3u8') ||
    playlistUrl.includes('.m3u')  ||
    playlistUrl.includes('/playlist') ||
    playlistUrl.includes('play.m3u') ||
    playlistUrl.includes('index.m3u') ||
    playlistUrl.includes('chunklist') ||
    playlistUrl.includes('/hls/');

  if (!isHLS) {
    debug(`[STREAM] Direct (non-HLS): ${playlistUrl.slice(0, 60)}`);
    return { url: playlistUrl };
  }

  log(`[STREAM] Fetching HLS: ${playlistUrl.slice(0, 70)}…`);

  let content;
  try {
    content = await fetchPlaylist(playlistUrl);
  } catch (e) {
    log(`[STREAM] Fetch failed (${e.message}) — using original URL`);
    return { url: playlistUrl };
  }

  log(`[STREAM] Fetched (${content.length} bytes)`);

  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
    debug('[STREAM] Not an M3U8 file — treating as direct');
    return { url: playlistUrl };
  }

  const realUrl = extractRealStreamUrl(content, playlistUrl);
  if (!realUrl) {
    log('[STREAM] No extraction result — using original URL');
    return { url: playlistUrl };
  }

  log(`[STREAM] ✅ Resolved: ${realUrl.slice(0, 70)}…`);
  setCache(playlistUrl, realUrl);
  return { url: realUrl };
}

// ─── Stream Handler ───────────────────────────────────────────────────────────
async function handleStream(rawId) {
  // Decode the ID — it may be URL-encoded
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* keep as-is */ }

  if (!id.startsWith('jash:')) return { streams: [] };

  const primaryUrl = decodeId(id.replace('jash:', ''));
  if (!primaryUrl) return { streams: [] };

  const allStreams = getEnabledStreams();
  const settings  = getSettings();
  const addonName = settings.addonName || 'Jash IPTV';

  const primary = allStreams.find(s => s.url === primaryUrl);
  if (!primary) {
    log(`[STREAM] Not in config, serving directly: ${primaryUrl.slice(0, 60)}`);
    return resolveAndReturn([{ name: 'Live', url: primaryUrl }], addonName);
  }

  // Find ALL quality variants (same name + same group)
  const variants = allStreams.filter(s =>
    s.name === primary.name && (s.group || '') === (primary.group || '')
  );

  log(`[STREAM] "${primary.name}" — ${variants.length} variant(s) in "${primary.group}"`);
  return resolveAndReturn(variants, addonName);
}

async function resolveAndReturn(variants, addonName) {
  const results = [];

  for (const v of variants) {
    try {
      const resolved = await resolveStreamUrl(v.url);
      results.push({
        url          : resolved.url,
        title        : `🔴 ${v.name}`,
        name         : addonName,
        behaviorHints: { notWebReady: true },
      });
    } catch (e) {
      error(`[STREAM] Failed to resolve ${v.url.slice(0, 50)}:`, e.message);
      results.push({
        url          : v.url,
        title        : `🔴 ${v.name} (Fallback)`,
        name         : addonName,
        behaviorHints: { notWebReady: true },
      });
    }
  }

  return { streams: results };
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
function setCORS(res) {
  // These headers MUST be on every response for Stremio to accept the addon
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function json(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type'                : 'application/json; charset=utf-8',
    'Content-Length'              : Buffer.byteLength(body),
    'Access-Control-Allow-Origin' : '*',
  });
  res.end(body);
}

function serveFile(res, filePath, mime) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
  res.end(content);
}

function parseExtra(extraStr) {
  if (!extraStr) return {};
  try {
    const out = {};
    decodeURIComponent(String(extraStr)).split('&').forEach(p => {
      const [k, ...rest] = p.split('=');
      if (k) out[k] = rest.join('=') || '';
    });
    return out;
  } catch { return {}; }
}

// ─── Main HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Set CORS on every response — required for Stremio to accept addon
  setCORS(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed   = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  debug(`${req.method} ${pathname}`);

  // ── /health ─────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    noCache(res);
    return json(res, {
      status     : 'ok',
      addon      : getSettings().addonName || 'Jash IPTV',
      streams    : getEnabledStreams().length,
      groups     : getGroups().length,
      cache      : streamCache.size,
      uptime     : Math.round(process.uptime()),
      syncEpoch,
      publicUrl  : PUBLIC_URL,
      manifestUrl: `${PUBLIC_URL}/manifest.json`,
    });
  }

  // ── /api/sync ────────────────────────────────────────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg   = JSON.parse(body);
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        syncEpoch = Date.now();
        streamCache.clear();
        const count = (cfg.streams || []).filter(s => s.enabled !== false).length;
        log(`[SYNC] ✅ ${count} streams | manifest v2.${Math.floor(syncEpoch / 1000)}`);
        return json(res, { ok: true, streams: count, epoch: syncEpoch, version: `2.${Math.floor(syncEpoch / 1000)}` });
      } catch (e) {
        error('[SYNC]', e.message);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── /api/config ──────────────────────────────────────────────────────────
  if (pathname === '/api/config' && req.method === 'GET') {
    noCache(res);
    return json(res, loadConfig());
  }

  // ── /api/cache ───────────────────────────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const n = streamCache.size;
    streamCache.clear();
    log(`[CACHE] Cleared ${n} entries`);
    return json(res, { ok: true, cleared: n });
  }

  // ── /manifest.json ───────────────────────────────────────────────────────
  // ★ CRITICAL: Must have CORS + no-cache for Stremio to accept the addon
  if (pathname === '/manifest.json') {
    const manifest = buildManifest();
    noCache(res);
    log(`[MANIFEST] v${manifest.version} · ${manifest.catalogs.length} catalogs · ${getEnabledStreams().length} streams`);
    return json(res, manifest);
  }

  // ── /catalog/tv/:catId/extra.json or /catalog/tv/:catId.json ────────────
  // Stremio sends requests in the format:
  //   /catalog/tv/jash_cat_0.json
  //   /catalog/tv/jash_cat_0/search=query.json
  const catM = pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    const catId = decodeURIComponent(catM[1]);
    // extra can be in URL path segment or query string
    let extra = {};
    if (catM[2]) {
      // Parse "search=xyz" style path segment
      catM[2].split('&').forEach(p => {
        const [k, ...v] = p.split('=');
        if (k) extra[k] = decodeURIComponent(v.join('=') || '');
      });
    }
    if (query.extra) Object.assign(extra, parseExtra(query.extra));
    if (query.search) extra.search = query.search;

    const result = handleCatalog(catId, extra);
    noCache(res);
    return json(res, result);
  }

  // ── /meta/tv/:id.json ────────────────────────────────────────────────────
  const metaM = pathname.match(/^\/meta\/tv\/([^/]+)\.json$/);
  if (metaM) {
    const id = metaM[1]; // keep URL-encoded, handleMeta will decode
    return json(res, handleMeta(id));
  }

  // ── /stream/tv/:id.json ──────────────────────────────────────────────────
  const streamM = pathname.match(/^\/stream\/tv\/([^/]+)\.json$/);
  if (streamM) {
    const id = streamM[1];
    log(`[STREAM] Request: ${id.slice(0, 80)}`);
    try {
      const result = await handleStream(id);
      noCache(res);
      return json(res, result);
    } catch (e) {
      error('[STREAM] Unhandled:', e.message);
      return json(res, { streams: [] });
    }
  }

  // ── /configure → redirect ────────────────────────────────────────────────
  if (pathname === '/configure') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // ── Static files (React SPA) ─────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(path.resolve(DIST_DIR))) {
      res.writeHead(403); return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext  = path.extname(filePath).toLowerCase();
      const mime = {
        '.html' : 'text/html; charset=utf-8',
        '.js'   : 'application/javascript',
        '.css'  : 'text/css',
        '.json' : 'application/json',
        '.png'  : 'image/png',
        '.jpg'  : 'image/jpeg',
        '.jpeg' : 'image/jpeg',
        '.svg'  : 'image/svg+xml',
        '.ico'  : 'image/x-icon',
        '.woff' : 'font/woff',
        '.woff2': 'font/woff2',
        '.webp' : 'image/webp',
      }[ext] || 'application/octet-stream';
      return serveFile(res, filePath, mime);
    }

    // SPA fallback
    return serveFile(res, path.join(DIST_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // No dist built yet — info page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Jash Addon</title>
  <style>
    body { background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem;max-width:600px;margin:0 auto }
    a    { color:#818cf8 }
    code { background:#1e293b;padding:2px 8px;border-radius:4px }
    .ok  { color:#34d399 }
    .warn{ color:#fbbf24 }
    pre  { background:#1e293b;padding:1rem;border-radius:8px;overflow-x:auto }
  </style>
</head>
<body>
  <h1>🚀 Jash Addon Backend v5.0</h1>
  <p class="warn">⚠️  Frontend not built yet.</p>
  <p>Run: <code>npm run build</code> then restart the server.</p>
  <hr style="border-color:#334155;margin:1.5rem 0">
  <p>📋 Manifest : <a href="/manifest.json">/manifest.json</a></p>
  <p>❤️  Health   : <a href="/health">/health</a></p>
  <p class="ok">✅ Backend API is running correctly.</p>
  <pre>${JSON.stringify(buildManifest(), null, 2)}</pre>
</body>
</html>`);
});

// ─── Process Handlers ─────────────────────────────────────────────────────────
process.on('uncaughtException',  e => error('Uncaught:', e.message));
process.on('unhandledRejection', r => error('Unhandled:', r));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    error(`Port ${PORT} in use — set PORT env var`);
    process.exit(1);
  }
  error('Server error:', e.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('═══════════════════════════════════════════════════════════════');
  log(`🚀  Jash Addon Server v5.0`);
  log(`📡  Listening  : http://0.0.0.0:${PORT}`);
  log(`🌐  Public URL : ${PUBLIC_URL}`);
  log(`📋  Manifest   : ${PUBLIC_URL}/manifest.json`);
  log(`⚙️   Config UI  : ${PUBLIC_URL}/`);
  log(`❤️   Health    : ${PUBLIC_URL}/health`);
  log(`📺  Stremio    : stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`);
  log('═══════════════════════════════════════════════════════════════');

  const enabled = getEnabledStreams();
  const groups  = getGroups();
  if (enabled.length) {
    log(`📺  Loaded: ${enabled.length} streams | ${groups.length} groups`);
  } else {
    log(`ℹ️   No streams yet — open ${PUBLIC_URL} to configure`);
  }
});
