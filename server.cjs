'use strict';

// =============================================================================
// IPTV Redirect Server v16 — Production Ready
//
// Features:
//   • Supabase startup load — data survives redeploys even without disk
//   • Pure 302 redirect for direct streams (rawUrl preserved with pipe headers)
//   • HLS proxy for redirect-chain streams (forwarded to hls-proxy:10001)
//   • Overlay/Delta modifications preserved across syncs
//   • Keepalive for Render free tier
//   • Auto-merge: Supabase → disk → memory on startup
// =============================================================================

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const https    = require('https');
const { URL }  = require('url');

const app      = express();
const PORT     = parseInt(process.env.PORT     || '10000', 10);
const HLS_PORT = parseInt(process.env.HLS_PORT || '10001', 10);
const API_KEY  = process.env.API_KEY  || 'iptv-secret';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const DIST_DIR = path.join(__dirname, 'dist');

// Supabase (optional — server-side fetch for DB persistence)
const SUPABASE_URL = process.env.SUPABASE_URL      || process.env.VITE_SUPABASE_URL      || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_ON  = !!(SUPABASE_URL && SUPABASE_KEY);

// DB file path — use persistent Render disk if available
const DB_FILE = process.env.DB_FILE ||
  (fs.existsSync('/data') ? '/data/db/db.json' : path.join(__dirname, 'db.json'));

console.log(`[IPTV] DB_FILE     : ${DB_FILE}`);
console.log(`[IPTV] Supabase    : ${SUPABASE_ON ? 'enabled ✓' : 'disabled'}`);
console.log(`[IPTV] HLS Proxy   : port ${HLS_PORT}`);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(DIST_DIR));

// =============================================================================
// EMPTY DB TEMPLATE
// =============================================================================
const EMPTY_DB = {
  channels     : [],
  sources      : [],
  groups       : [],
  playlists    : [],
  modifications: null,
  settings     : { apiKey: API_KEY },
  savedAt      : 0,
};

// =============================================================================
// DISK DB
// =============================================================================
function readDisk() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (data && Array.isArray(data.channels)) return { ...EMPTY_DB, ...data };
    }
  } catch (e) { console.warn('[DB] disk read error:', e.message); }
  return null;
}

function writeDisk(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const clean = {
      ...data,
      channels: (data.channels || []).filter(c => c && (c.url || c.rawUrl)),
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(clean, null, 2));
  } catch (e) { console.warn('[DB] disk write error:', e.message); }
}

// =============================================================================
// SUPABASE HELPERS (server-side REST)
// =============================================================================
function sbHeaders() {
  return {
    'Content-Type' : 'application/json',
    'apikey'       : SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer'       : 'return=minimal',
  };
}

function sbRequest(method, path2, body) {
  return new Promise((resolve, reject) => {
    const url    = `${SUPABASE_URL}/rest/v1/${path2}`;
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const data   = body ? JSON.stringify(body) : undefined;
    const prefer = method === 'GET'
      ? 'return=representation'
      : 'resolution=merge-duplicates,return=minimal';
    const hdrs   = {
      ...sbHeaders(),
      'Prefer': prefer,
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    };

    const req = lib.request(url, { method, headers: hdrs, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Supabase timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function sbGet(key) {
  if (!SUPABASE_ON) return null;
  try {
    const url = `iptv_store?key=eq.${encodeURIComponent(key)}&select=value`;
    // Need return=representation to get response body
    const r = await sbRequest('GET', url, null);
    const rows = Array.isArray(r.data) ? r.data : [];
    return rows[0]?.value ?? null;
  } catch { return null; }
}

async function sbSet(key, value) {
  if (!SUPABASE_ON) return;
  try {
    // POST with merge-duplicates = upsert
    await sbRequest('POST', 'iptv_store', { key, value, updated_at: new Date().toISOString() });
  } catch { /* silent */ }
}

// Load full DB from Supabase (chunked channels)
async function loadFromSupabase() {
  if (!SUPABASE_ON) return null;
  try {
    const [totalChunks, sources, groups, playlists, mods, meta] = await Promise.all([
      sbGet('iptv_channels__chunks'),
      sbGet('iptv_sources'),
      sbGet('iptv_groups'),
      sbGet('iptv_playlists'),
      sbGet('iptv_mods'),
      sbGet('iptv_meta'),
    ]);

    // Load channel chunks
    const numChunks = typeof totalChunks === 'number' ? totalChunks : 0;
    let channels = [];
    if (numChunks > 0) {
      const chunkResults = await Promise.all(
        Array.from({ length: numChunks }, (_, i) => sbGet(`iptv_channels__chunk_${i}`))
      );
      channels = chunkResults.flatMap(c => Array.isArray(c) ? c : []);
    } else {
      const fallback = await sbGet('iptv_channels');
      if (Array.isArray(fallback)) channels = fallback;
    }

    if (!channels.length && !Array.isArray(sources)) return null;

    const m = (meta && typeof meta === 'object') ? meta : {};
    return {
      channels     : channels,
      sources      : Array.isArray(sources)   ? sources   : [],
      groups       : Array.isArray(groups)    ? groups    : [],
      playlists    : Array.isArray(playlists) ? playlists : [],
      modifications: mods || null,
      settings     : { apiKey: m.apiKey || API_KEY },
      savedAt      : m.savedAt || 0,
    };
  } catch (e) {
    console.warn('[Supabase] load failed:', e.message);
    return null;
  }
}

// Save full DB to Supabase (chunked channels)
async function saveToSupabase(db) {
  if (!SUPABASE_ON) return;
  const CHUNK = 2000;
  const chs   = db.channels || [];
  const total = Math.ceil(chs.length / CHUNK) || 0;

  const saves = [];
  for (let i = 0; i < total; i++) {
    saves.push(sbSet(`iptv_channels__chunk_${i}`, chs.slice(i * CHUNK, (i + 1) * CHUNK)));
  }
  saves.push(sbSet('iptv_channels__chunks', total));
  saves.push(sbSet('iptv_sources',    db.sources    || []));
  saves.push(sbSet('iptv_groups',     db.groups     || []));
  saves.push(sbSet('iptv_playlists',  db.playlists  || []));
  saves.push(sbSet('iptv_mods',       db.modifications || {}));
  saves.push(sbSet('iptv_meta', {
    apiKey : db.settings?.apiKey || API_KEY,
    savedAt: Date.now(),
    count  : chs.length,
  }));

  try { await Promise.all(saves); console.log(`[Supabase] ✅ saved ${chs.length} channels`); }
  catch (e) { console.warn('[Supabase] save error:', e.message); }
}

// =============================================================================
// IN-MEMORY DB — loaded once at startup, kept in sync
// =============================================================================
let DB = { ...EMPTY_DB };

async function initDB() {
  console.log('[DB] Initializing...');

  // 1. Try Supabase first (always has latest data, survives redeploys)
  if (SUPABASE_ON) {
    try {
      const sb = await loadFromSupabase();
      if (sb && sb.channels.length > 0) {
        DB = { ...EMPTY_DB, ...sb };
        writeDisk(DB); // cache to disk
        console.log(`[DB] ✅ Loaded ${DB.channels.length} channels from Supabase`);
        return;
      }
    } catch (e) {
      console.warn('[DB] Supabase init failed:', e.message);
    }
  }

  // 2. Try disk (Render persistent disk — survives redeploys if disk exists)
  const disk = readDisk();
  if (disk && disk.channels.length > 0) {
    DB = disk;
    console.log(`[DB] ✅ Loaded ${DB.channels.length} channels from disk`);
    // Push to Supabase in background
    saveToSupabase(DB).catch(() => {});
    return;
  }

  // 3. Start fresh
  DB = { ...EMPTY_DB };
  console.log('[DB] Starting fresh — no existing data found');
}

function readDB() { return DB; }

function writeDB(data) {
  DB = {
    ...EMPTY_DB,
    ...data,
    channels: (data.channels || []).filter(c => {
      if (!c) return false;
      // Must have at least one URL field
      const hasUrl = !!(c.rawUrl || c.url);
      if (!hasUrl) return false;
      // Strip DRM channels
      if (isDRM(c)) return false;
      return true;
    }),
  };
  writeDisk(DB);
}

// Debounced Supabase sync — don't hammer on every request
let sbSyncTimer = null;
function scheduleSbSync() {
  if (!SUPABASE_ON) return;
  if (sbSyncTimer) clearTimeout(sbSyncTimer);
  sbSyncTimer = setTimeout(() => { saveToSupabase(DB).catch(() => {}); }, 5000);
}

// =============================================================================
// HLS REDIRECT-CHAIN DETECTION
// =============================================================================
const HLS_REDIRECT_PATTERNS = [
  /restream/i, /vercel\.app/i, /workers\.dev/i,
  /cloudflare\.com/i, /netlify\.app/i, /pages\.dev/i,
  /stream\.php/i, /get\.php/i, /play\.php/i,
  /live\.php/i, /channel\.php/i,
  /\?id=/i, /\?ch=/i, /\?stream=/i, /\?e=\.m3u8/i, /\?type=m3u8/i,
];

function isHlsRedirectUrl(url) {
  if (!url) return false;
  const u       = url.toLowerCase();
  const noQuery = u.split('?')[0];
  if (noQuery.endsWith('.m3u8') || noQuery.endsWith('.m3u') ||
      noQuery.endsWith('.mpd')  || noQuery.endsWith('.ts')) return false;
  if (u.includes('e=.m3u8') || u.includes('type=m3u8') || u.includes('format=m3u8')) return true;
  return HLS_REDIRECT_PATTERNS.some(p => p.test(url));
}

// =============================================================================
// PIPE-HEADER PARSER
// Handles: https://stream.m3u8?token=abc|User-Agent=VLC|Referer=https://site.com
// =============================================================================
function parsePipeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { url: '', headers: {} };
  const pipeIdx = rawUrl.indexOf('|');
  if (pipeIdx === -1) return { url: rawUrl.trim(), headers: {} };
  const url     = rawUrl.substring(0, pipeIdx).trim();
  const headers = {};
  rawUrl.substring(pipeIdx + 1).split('|').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    headers[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
  });
  return { url, headers };
}

// =============================================================================
// DRM DETECTION
// =============================================================================
function isDRM(ch) {
  if (!ch) return true;
  if (!ch.rawUrl && !ch.url) return true;
  if (ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId || ch.isDrm) return true;
  return false;
}

// =============================================================================
// TAMIL DETECTION
// =============================================================================
const TAMIL_KW = [
  'tamil','tamizh','kollywood','vijay tv','sun tv','kalaignar','jaya tv',
  'raj tv','polimer','puthiya','sirippoli','adithya tv','vendhar','makkal tv',
  'captain tv','colors tamil','star vijay','zee tamil','news18 tamil',
  'news7 tamil','thanthi','sathiyam','chutti tv','isai aruvi','dd tamil',
  'sun music','mega tv','vasanth tv','imayam','kaveri','rainbow','rain bow',
  'tam ','_tam','tam_','-tam','(tam',
];

function isTamil(ch) {
  if (!ch) return false;
  const sv = v => (typeof v === 'string' ? v : String(v || '')).toLowerCase();
  const text = `${sv(ch.name)} ${sv(ch.group)} ${sv(ch.tvgName)} ${sv(ch.language)} ${sv(ch.tvgId)}`;
  return TAMIL_KW.some(k => text.includes(k));
}

// =============================================================================
// M3U GENERATOR
// =============================================================================
function esc(s) {
  return String(s || '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
}

function getPublicBase(req) {
  if (SELF_URL) return SELF_URL.startsWith('http') ? SELF_URL : `https://${SELF_URL}`;
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  const host  = req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function generateM3U(channels, opts = {}) {
  const { tamilOnly = false, req = null } = opts;
  const publicBase = getPublicBase(req);

  const entries = channels.filter(ch => {
    if (isDRM(ch))                 return false;
    if (tamilOnly && !isTamil(ch)) return false;
    if (ch.enabled  === false)     return false;
    if (ch.isActive === false)     return false;
    const u = ch.rawUrl || ch.url || '';
    return !!u;
  });

  const lines = ['#EXTM3U x-tvg-url=""'];

  for (const ch of entries) {
    const tvgId   = ch.tvgId ? ` tvg-id="${esc(ch.tvgId)}"` : '';
    const tvgName = ` tvg-name="${esc(ch.tvgName || ch.name)}"`;
    const logo    = ch.logo  ? ` tvg-logo="${esc(ch.logo)}"` : '';
    const group   = ` group-title="${esc(ch.group || 'General')}"`;
    const tamil   = isTamil(ch) ? ' x-tamil="true"' : '';

    const sourceUrl         = ch.rawUrl || ch.url || '';
    const { url: cleanUrl } = parsePipeUrl(sourceUrl);
    const needsHlsProxy     = isHlsRedirectUrl(cleanUrl);

    // Routing:
    // HLS redirect-chain → /hls/:id/playlist.m3u8 (proxied)
    // Direct stream      → exact rawUrl (pipe headers preserved for players)
    const streamUrl = needsHlsProxy
      ? `${publicBase}/hls/${ch.id}/playlist.m3u8`
      : sourceUrl;

    lines.push(`#EXTINF:-1${tvgId}${tvgName}${logo}${group}${tamil},${esc(ch.name)}`);

    // VLC opts for non-proxy, non-pipe streams
    if (!needsHlsProxy && !sourceUrl.includes('|')) {
      if (ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${ch.userAgent}`);
      if (ch.referer)   lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);
    }

    lines.push(streamUrl);
    lines.push('');
  }

  return lines.join('\r\n');
}

// =============================================================================
// REVERSE PROXY — forward /hls/* to hls-proxy.cjs on port 10001
// =============================================================================
function forwardToHlsProxy(req, res) {
  const options = {
    hostname           : '127.0.0.1',
    port               : HLS_PORT,
    path               : req.url,
    method             : req.method,
    headers            : { ...req.headers, host: `127.0.0.1:${HLS_PORT}` },
    rejectUnauthorized : false,
    timeout            : 30000,
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('[HLS-FWD]', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'HLS proxy unavailable', detail: err.message });
    }
  });

  if (req.body && Object.keys(req.body).length) {
    proxyReq.write(JSON.stringify(req.body));
  }
  proxyReq.end();
}

app.use('/hls', (req, res) => forwardToHlsProxy(req, res));

// =============================================================================
// DEFAULT PLAYLIST BUILDER
// =============================================================================
function buildDefaultPlaylist(db) {
  const playlists = db.playlists || [];
  const channels  = db.channels  || [];

  if (!playlists.length) {
    return channels.filter(c => c.enabled !== false && c.isActive !== false);
  }

  const seen   = new Set();
  const result = [];

  for (const playlist of playlists) {
    const blocked = new Set(playlist.blockedChannels || []);
    const pinned  = playlist.pinnedChannels || [];

    for (const pid of pinned) {
      if (seen.has(pid)) continue;
      const ch = channels.find(c => c.id === pid);
      if (ch && !isDRM(ch) && !blocked.has(ch.id)) { result.push(ch); seen.add(pid); }
    }

    for (const ch of channels) {
      if (seen.has(ch.id) || isDRM(ch) || blocked.has(ch.id)) continue;
      if (ch.enabled === false || ch.isActive === false) continue;
      if (playlist.includeGroups?.length && !playlist.includeGroups.includes(ch.group)) continue;
      if (playlist.tamilOnly && !isTamil(ch)) continue;
      result.push(ch); seen.add(ch.id);
    }
  }

  return result;
}

// =============================================================================
// HEAD HEALTH CHECK
// =============================================================================
function headCheck(rawUrl, timeoutMs = 7000) {
  return new Promise(resolve => {
    const t0    = Date.now();
    let settled = false;
    const done  = r => { if (!settled) { settled = true; resolve(r); } };

    try {
      const { url: cleanUrl } = parsePipeUrl(rawUrl);
      const parsed = new URL(cleanUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(cleanUrl, {
        method             : 'HEAD',
        headers            : { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
        timeout            : timeoutMs,
        rejectUnauthorized : false,
      }, res => {
        const latency = Date.now() - t0;
        const status  = res.statusCode || 0;
        done({ ok: status >= 200 && status < 400, status, latency,
               contentType: res.headers['content-type'] || '' });
        res.resume();
      });

      req.on('error',   e => done({ ok: false, status: 0,   latency: Date.now() - t0, error: e.message }));
      req.on('timeout', () => { req.destroy(); done({ ok: false, status: 408, latency: timeoutMs }); });
      req.end();
    } catch (e) {
      done({ ok: false, status: 0, latency: Date.now() - t0, error: e.message });
    }
  });
}

// =============================================================================
// SERVER-SIDE CORS FETCH (for source imports)
// =============================================================================
function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    try {
      const { url: cleanUrl } = parsePipeUrl(url);
      const parsed = new URL(cleanUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;
      let   hops   = 0;

      const doGet = target => {
        lib.get(target, {
          headers: {
            'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept'         : 'text/plain,application/x-mpegurl,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout            : timeoutMs,
          rejectUnauthorized : false,
        }, res => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && hops < 5) {
            hops++; res.resume(); doGet(res.headers.location); return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
              resolve(Buffer.concat(chunks).toString('utf8'));
            } else {
              reject(new Error(`HTTP ${res.statusCode} from ${target}`));
            }
          });
        }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
      };

      doGet(cleanUrl);
    } catch (e) { reject(e); }
  });
}

// =============================================================================
// AUTH
// =============================================================================
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== (DB.settings?.apiKey || API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized — set X-Api-Key header' });
  }
  next();
}

// =============================================================================
// ROUTES
// =============================================================================

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const chs = DB.channels || [];
  res.json({
    status    : 'ok',
    uptime    : Math.floor(process.uptime()),
    channels  : chs.length,
    sources   : (DB.sources   || []).length,
    playlists : (DB.playlists || []).length,
    groups    : (DB.groups    || []).length,
    tamil     : chs.filter(c => isTamil(c)).length,
    supabase  : SUPABASE_ON,
    hlsProxy  : `port ${HLS_PORT}`,
    version   : '16.0',
    ts        : new Date().toISOString(),
  });
});

// =============================================================================
// PLAYLIST ENDPOINTS
// =============================================================================

app.get('/api/playlist/default.m3u', (req, res) => {
  const chs = buildDefaultPlaylist(DB);
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma',        'no-cache');
  res.setHeader('Expires',       '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Disposition', 'inline; filename="default.m3u"');
  res.send(generateM3U(chs, { req }));
});

app.get('/api/playlist/all.m3u', (req, res) => {
  const chs   = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  const tamil = req.query.tamil === '1';
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(generateM3U(chs, { tamilOnly: tamil, req }));
});

app.get('/api/playlist/tamil.m3u', (req, res) => {
  const chs = (DB.channels || []).filter(c =>
    c.enabled !== false && c.isActive !== false && isTamil(c)
  );
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(generateM3U(chs, { tamilOnly: true, req }));
});

app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const chs = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false && isTamil(c)
  );
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(generateM3U(chs, { tamilOnly: true, req }));
});

app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const source = (DB.sources || []).find(s => s.id === req.params.sourceId);
  const tamil  = req.query.tamil === '1' || !!(source?.tamilFilter);
  const chs    = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false
  );
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(generateM3U(chs, { tamilOnly: tamil, req }));
});

app.get('/api/playlist/:id.m3u', (req, res) => {
  const playlist = (DB.playlists || []).find(p => p.id === req.params.id);
  const tamilQS  = req.query.tamil === '1';

  let chs;
  if (playlist) {
    const chMap   = new Map((DB.channels || []).map(c => [c.id, c]));
    const pinned  = (playlist.pinnedChannels  || []).map(id => chMap.get(id)).filter(Boolean);
    const blocked = new Set(playlist.blockedChannels || []);
    const base    = (DB.channels || []).filter(c =>
      !blocked.has(c.id) &&
      !pinned.find(p => p.id === c.id) &&
      c.enabled  !== false &&
      c.isActive !== false &&
      (!playlist.tamilOnly || isTamil(c)) &&
      (!playlist.includeGroups?.length || playlist.includeGroups.includes(c.group))
    );
    chs = [...pinned, ...base];
  } else {
    chs = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  }

  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(generateM3U(chs, { tamilOnly: tamilQS, req }));
});

// =============================================================================
// REDIRECT — pure 302 to clean URL (strips pipe headers)
// =============================================================================
app.get('/redirect/:id', (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);

  if (!ch)       return res.status(404).json({ error: 'Channel not found' });
  if (isDRM(ch)) return res.status(410).json({ error: 'DRM channel — stripped' });

  const sourceUrl         = ch.rawUrl || ch.url || '';
  if (!sourceUrl) return res.status(400).json({ error: 'No URL' });

  const { url: cleanUrl } = parsePipeUrl(sourceUrl);
  if (!cleanUrl) return res.status(400).json({ error: 'Could not parse URL' });

  // If redirect-chain HLS — forward to HLS proxy
  if (isHlsRedirectUrl(cleanUrl)) {
    const publicBase = getPublicBase(req);
    return res.redirect(302, `${publicBase}/hls/${ch.id}/playlist.m3u8`);
  }

  console.log(`[302] ${ch.name} → ${cleanUrl.substring(0, 120)}`);
  return res.redirect(302, cleanUrl);
});

// =============================================================================
// HEALTH CHECK API
// =============================================================================
app.get('/api/health/:id', async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });

  const sourceUrl         = ch.rawUrl || ch.url || '';
  const { url: cleanUrl } = parsePipeUrl(sourceUrl);
  const needsProxy        = isHlsRedirectUrl(cleanUrl);
  const result            = await headCheck(sourceUrl, 8000);

  // Update in-memory
  ch.lastHealth  = result.ok;
  ch.lastLatency = result.latency;
  ch.lastChecked = new Date().toISOString();
  writeDisk(DB);

  res.json({
    id         : ch.id,
    name       : ch.name,
    ok         : result.ok,
    status     : result.status,
    latency    : result.latency,
    contentType: result.contentType,
    isTamil    : isTamil(ch),
    routing    : needsProxy ? 'hls-proxy' : '302-direct',
    proxyUrl   : needsProxy
      ? `${getPublicBase(req)}/hls/${ch.id}/playlist.m3u8`
      : `/redirect/${ch.id}`,
  });
});

app.post('/api/health/batch', async (req, res) => {
  const ids  = (req.body.ids || []).slice(0, 100);
  const chs  = ids.length
    ? (DB.channels || []).filter(c => ids.includes(c.id) && !isDRM(c))
    : (DB.channels || []).filter(c => !isDRM(c)).slice(0, 50);

  const results = await Promise.all(
    chs.map(async ch => {
      const sourceUrl = ch.rawUrl || ch.url || '';
      const r         = await headCheck(sourceUrl, 6000);
      ch.lastHealth   = r.ok;
      ch.lastLatency  = r.latency;
      ch.lastChecked  = new Date().toISOString();
      return { id: ch.id, name: ch.name, ok: r.ok, status: r.status, latency: r.latency };
    })
  );

  writeDisk(DB);
  const byId = {};
  results.forEach(r => { byId[r.id] = r; });
  res.json({ checked: results.length, results: byId });
});

// =============================================================================
// CORS PROXY (source imports)
// =============================================================================
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: '?url= required' });
  try {
    const text = await fetchText(decodeURIComponent(String(url)));
    res.setHeader('Content-Type',                'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control',               'no-cache');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message, url });
  }
});

// =============================================================================
// SYNC — receives full state from frontend and saves
// =============================================================================
app.post('/api/sync', auth, (req, res) => {
  try {
    const incoming = req.body || {};

    // Merge incoming into existing DB (don't lose server-only data)
    if (Array.isArray(incoming.channels)) {
      incoming.channels = incoming.channels
        .filter(c => c && !isDRM(c) && (c.url || c.rawUrl))
        .map(c => {
          const raw           = c.rawUrl || c.url || '';
          const { url: clean } = parsePipeUrl(raw);
          return { ...c, rawUrl: raw, url: clean };
        });
    }

    const merged = {
      ...EMPTY_DB,
      ...incoming,
      modifications: incoming.modifications || DB.modifications || null,
      settings     : incoming.settings      || DB.settings      || { apiKey: API_KEY },
      savedAt      : Date.now(),
    };

    writeDB(merged);

    // Save to Supabase in background
    scheduleSbSync();

    const chs = DB.channels || [];
    res.json({
      success  : true,
      channels : chs.length,
      tamil    : chs.filter(c => isTamil(c)).length,
      sources  : (DB.sources   || []).length,
      playlists: (DB.playlists || []).length,
      savedAt  : merged.savedAt,
    });
  } catch (e) {
    console.error('[SYNC]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// DB ENDPOINT — returns full DB for frontend startup merge
// =============================================================================
app.get('/api/db', (req, res) => {
  res.setHeader('Cache-Control',               'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    channels     : DB.channels      || [],
    sources      : DB.sources       || [],
    groups       : DB.groups        || [],
    playlists    : DB.playlists     || [],
    modifications: DB.modifications || null,
    savedAt      : DB.savedAt       || 0,
    ts           : Date.now(),
  });
});

app.get('/api/stats', (req, res) => {
  const chs = DB.channels || [];
  res.json({
    channels  : chs.length,
    tamil     : chs.filter(c => isTamil(c)).length,
    sources   : (DB.sources   || []).length,
    groups    : (DB.groups    || []).length,
    playlists : (DB.playlists || []).length,
    uptime    : Math.floor(process.uptime()),
    memory    : Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    supabase  : SUPABASE_ON,
    hlsProxy  : `port ${HLS_PORT}`,
  });
});

// Channels list API
app.get('/api/channels', (req, res) => {
  const page  = parseInt(String(req.query.page  || '1'),   10);
  const limit = parseInt(String(req.query.limit || '100'), 10);
  const q     = String(req.query.q    || '').toLowerCase();
  const group = String(req.query.group || '');
  const tamil = req.query.tamil === '1';
  const publicBase = getPublicBase(req);

  let chs = DB.channels || [];
  if (q)     chs = chs.filter(c => (c.name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q));
  if (group) chs = chs.filter(c => c.group === group);
  if (tamil) chs = chs.filter(c => isTamil(c));

  const total = chs.length;
  const paged = chs.slice((page - 1) * limit, page * limit);

  res.json({
    total, page, limit,
    pages   : Math.ceil(total / limit),
    channels: paged.map(ch => {
      const { url: cleanUrl } = parsePipeUrl(ch.rawUrl || ch.url || '');
      const needsProxy        = isHlsRedirectUrl(cleanUrl);
      return {
        id         : ch.id,
        name       : ch.name,
        group      : ch.group,
        logo       : ch.logo,
        isTamil    : isTamil(ch),
        enabled    : ch.enabled,
        isActive   : ch.isActive,
        lastHealth : ch.lastHealth,
        lastLatency: ch.lastLatency,
        streamType : needsProxy ? 'hls-proxy' : (ch.streamType || 'direct'),
        playUrl    : needsProxy
          ? `${publicBase}/hls/${ch.id}/playlist.m3u8`
          : `/redirect/${ch.id}`,
      };
    }),
  });
});

// Channel CRUD
app.patch('/api/channel/:id', auth, (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  Object.assign(ch, req.body);
  writeDisk(DB); scheduleSbSync();
  res.json({ success: true, channel: ch });
});

app.delete('/api/channel/:id', auth, (req, res) => {
  DB.channels = (DB.channels || []).filter(c => c.id !== req.params.id);
  writeDisk(DB); scheduleSbSync();
  res.json({ success: true });
});

// Source CRUD
app.get('/api/sources',       auth, (req, res) => res.json(DB.sources || []));
app.patch('/api/source/:id',  auth, (req, res) => {
  const src = (DB.sources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  Object.assign(src, req.body);
  writeDisk(DB); scheduleSbSync();
  res.json({ success: true, source: src });
});
app.delete('/api/source/:id', auth, (req, res) => {
  DB.sources  = (DB.sources  || []).filter(s => s.id !== req.params.id);
  DB.channels = (DB.channels || []).filter(c => c.sourceId !== req.params.id);
  writeDisk(DB); scheduleSbSync();
  res.json({ success: true });
});

// Test channel
app.get('/api/test/:id', auth, async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const sourceUrl         = ch.rawUrl || ch.url || '';
  const { url: cleanUrl } = parsePipeUrl(sourceUrl);
  const needsProxy        = isHlsRedirectUrl(cleanUrl);
  const r                 = await headCheck(sourceUrl, 10000);
  const publicBase        = getPublicBase(req);
  res.json({
    success    : r.ok,
    rawUrl     : sourceUrl,
    cleanUrl,
    status     : r.status,
    latency    : r.latency,
    contentType: r.contentType,
    routing    : needsProxy ? 'hls-proxy' : '302-direct',
    playUrl    : needsProxy
      ? `${publicBase}/hls/${ch.id}/playlist.m3u8`
      : `/redirect/${ch.id}`,
  });
});

// Export / Import
app.get('/api/export', auth, (req, res) => {
  res.setHeader('Content-Type',        'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="iptv-backup.json"');
  res.json(DB);
});

app.post('/api/import', auth, (req, res) => {
  try {
    const data = req.body;
    if (!data || !Array.isArray(data.channels)) {
      return res.status(400).json({ error: 'Invalid backup format' });
    }
    writeDB(data);
    scheduleSbSync();
    res.json({ success: true, channels: DB.channels.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// SPA FALLBACK
// =============================================================================
app.get('*', (req, res) => {
  const index = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.send('<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>📺 IPTV Manager starting...</h2></body></html>');
  }
});

// =============================================================================
// KEEPALIVE (Render free tier — ping every 14 min)
// =============================================================================
function startKeepalive() {
  if (!SELF_URL || SELF_URL.includes('localhost')) return;
  const pingUrl = `${SELF_URL.startsWith('http') ? SELF_URL : 'https://' + SELF_URL}/health`;
  const ping    = () => {
    const lib = pingUrl.startsWith('https') ? https : http;
    lib.get(pingUrl, { timeout: 10000 }, r => {
      console.log(`[KEEPALIVE] ✓ ${r.statusCode}`);
      r.resume();
    }).on('error', e => console.warn(`[KEEPALIVE] ✗ ${e.message}`));
  };
  setTimeout(ping, 30000);
  setInterval(ping, 14 * 60 * 1000);
  console.log(`[KEEPALIVE] Pinging ${pingUrl} every 14 min`);
}

// =============================================================================
// START
// =============================================================================
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    const chs = DB.channels || [];
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  📺  IPTV Manager v16 — Production Ready                 ║
╠══════════════════════════════════════════════════════════╣
║  Port      : ${String(PORT).padEnd(43)}║
║  HLS Proxy : ${String(HLS_PORT + ' (port 10001)').padEnd(43)}║
║  Channels  : ${String(chs.length).padEnd(43)}║
║  Tamil     : ${String(chs.filter(c => isTamil(c)).length).padEnd(43)}║
║  Supabase  : ${String(SUPABASE_ON ? 'enabled ✓' : 'disabled (disk only)').padEnd(43)}║
║  DB        : ${String(DB_FILE).substring(0, 43).padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  /api/playlist/all.m3u       → all channels              ║
║  /api/playlist/tamil.m3u     → Tamil only                ║
║  /api/playlist/default.m3u   → smart default             ║
║  /redirect/:id               → pure 302                  ║
║  /hls/:id/playlist.m3u8      → HLS proxy (via 10001)    ║
╚══════════════════════════════════════════════════════════╝
`);
    startKeepalive();
  });
});
