'use strict';

// =============================================================================
// IPTV Redirect Server v15
//
// Routing:
//   Normal streams    → exact rawUrl in M3U (pipe headers preserved)
//   /redirect/:id     → pure 302 to clean URL (pipe headers stripped)
//   Redirect-chain HLS → /hls/:id/playlist.m3u8 (proxied via hls-proxy.cjs)
//   /hls/*            → forwarded to hls-proxy.cjs on port 10001
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
const DB_FILE  = process.env.DB_FILE  || (fs.existsSync('/data') ? '/data/db/db.json' : path.join(__dirname, 'db.json'));
const DIST_DIR = path.join(__dirname, 'dist');
const API_KEY  = process.env.API_KEY  || 'iptv-secret';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(DIST_DIR));

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
  const u = url.toLowerCase();
  const noQuery = u.split('?')[0];
  // Already a direct stream file — no proxy needed
  if (noQuery.endsWith('.m3u8') || noQuery.endsWith('.m3u') || noQuery.endsWith('.mpd') || noQuery.endsWith('.ts')) return false;
  // Has m3u8 in query string → redirect chain
  if (u.includes('e=.m3u8') || u.includes('type=m3u8') || u.includes('format=m3u8')) return true;
  return HLS_REDIRECT_PATTERNS.some(p => p.test(url));
}

// =============================================================================
// DB
// =============================================================================
const EMPTY_DB = {
  sources: [], channels: [], groups: [],
  playlists: [], modifications: null,
  settings: { apiKey: API_KEY },
};

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed.channels) parsed.channels = parsed.channels.filter(c => !isDRM(c));
      return { ...EMPTY_DB, ...parsed };
    }
  } catch (e) { console.error('[DB] load error:', e.message); }
  return { ...EMPTY_DB };
}

function writeDB(data) {
  try {
    const clean = { ...data, channels: (data.channels || []).filter(c => !isDRM(c)) };
    const dir   = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(clean, null, 2));
  } catch (e) { console.error('[DB] save error:', e.message); }
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
// DRM DETECTION — strip completely
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
//
// Smart URL routing:
//   1. Redirect-chain HLS → /hls/:id/playlist.m3u8 (served by hls-proxy)
//   2. All other streams  → exact rawUrl (with pipe headers preserved)
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
    if (!u) return false;
    return true;
  });

  const lines = ['#EXTM3U x-tvg-url=""'];

  for (const ch of entries) {
    const tvgId   = ch.tvgId ? ` tvg-id="${esc(ch.tvgId)}"` : '';
    const tvgName = ` tvg-name="${esc(ch.tvgName || ch.name)}"`;
    const logo    = ch.logo  ? ` tvg-logo="${esc(ch.logo)}"` : '';
    const group   = ` group-title="${esc(ch.group || 'General')}"`;
    const tamil   = isTamil(ch) ? ' x-tamil="true"' : '';

    const sourceUrl          = ch.rawUrl || ch.url || '';
    const { url: cleanUrl }  = parsePipeUrl(sourceUrl);
    const needsHlsProxy      = isHlsRedirectUrl(cleanUrl);

    // Choose stream URL based on type
    let streamUrl;
    if (needsHlsProxy) {
      // Redirect-chain → HLS proxy rewrites manifest + segments
      streamUrl = `${publicBase}/hls/${ch.id}/playlist.m3u8`;
    } else {
      // Direct stream → exact original URL with pipe headers preserved
      streamUrl = sourceUrl;
    }

    lines.push(`#EXTINF:-1${tvgId}${tvgName}${logo}${group}${tamil},${esc(ch.name)}`);

    // VLC opts for non-pipe-header direct streams
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
  const targetPath = req.url; // includes /hls/...
  const options = {
    hostname           : '127.0.0.1',
    port               : HLS_PORT,
    path               : targetPath,
    method             : req.method,
    headers            : { ...req.headers, host: `127.0.0.1:${HLS_PORT}` },
    rejectUnauthorized : false,
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('error', err => {
      console.error('[HLS-FWD] Upstream error:', err.message);
    });
  });

  proxyReq.on('error', err => {
    console.error('[HLS-FWD] Proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'HLS proxy unavailable', detail: err.message });
    }
  });

  if (req.body) proxyReq.write(JSON.stringify(req.body));
  proxyReq.end();
}

// Forward all /hls/* requests to hls-proxy.cjs
app.use('/hls', (req, res) => {
  forwardToHlsProxy(req, res);
});

// =============================================================================
// DEFAULT PLAYLIST BUILDER
// =============================================================================
function buildDefaultPlaylist(db) {
  const playlists = db.playlists || [];
  const channels  = db.channels  || [];

  if (playlists.length === 0) {
    return channels.filter(c => c.enabled !== false && c.isActive !== false);
  }

  const seen   = new Set();
  const result = [];

  for (const playlist of playlists) {
    const blocked = new Set(playlist.blockedChannels || []);
    const pinned  = playlist.pinnedChannels || [];

    for (const pid of pinned) {
      if (!seen.has(pid)) {
        const ch = channels.find(c => c.id === pid);
        if (ch && !isDRM(ch) && !blocked.has(ch.id)) {
          result.push(ch);
          seen.add(pid);
        }
      }
    }

    for (const ch of channels) {
      if (seen.has(ch.id) || isDRM(ch) || blocked.has(ch.id)) continue;
      if (ch.enabled === false || ch.isActive === false) continue;
      if (playlist.includeGroups?.length && !playlist.includeGroups.includes(ch.group)) continue;
      if (playlist.tamilOnly && !isTamil(ch)) continue;
      result.push(ch);
      seen.add(ch.id);
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
        done({ ok: status >= 200 && status < 400, status, latency, contentType: res.headers['content-type'] || '' });
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
          res.on('end',  () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
              resolve(Buffer.concat(chunks).toString('utf8'));
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
      };

      doGet(cleanUrl);
    } catch (e) { reject(e); }
  });
}

// =============================================================================
// AUTH MIDDLEWARE
// =============================================================================
function auth(req, res, next) {
  const db  = readDB();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== (db.settings?.apiKey || API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized — set X-Api-Key header' });
  }
  next();
}

// =============================================================================
// ROUTES
// =============================================================================

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const db  = readDB();
  const chs = db.channels || [];
  res.json({
    status    : 'ok',
    uptime    : Math.floor(process.uptime()),
    channels  : chs.length,
    sources   : (db.sources   || []).length,
    playlists : (db.playlists || []).length,
    groups    : (db.groups    || []).length,
    tamil     : chs.filter(c => isTamil(c)).length,
    hlsProxy  : `http://127.0.0.1:${HLS_PORT}`,
    version   : '15.0',
    ts        : new Date().toISOString(),
  });
});

// =============================================================================
// PLAYLIST ENDPOINTS
// =============================================================================

app.get('/api/playlist/default.m3u', (req, res) => {
  const db  = readDB();
  const chs = buildDefaultPlaylist(db);
  res.setHeader('Content-Type',     'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control',    'no-cache, no-store');
  res.setHeader('Content-Disposition', 'inline; filename="default.m3u"');
  res.send(generateM3U(chs, { req }));
});

app.get('/api/playlist/all.m3u', (req, res) => {
  const db    = readDB();
  const chs   = (db.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  const tamil = req.query.tamil === '1';
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamil, req }));
});

app.get('/api/playlist/tamil.m3u', (req, res) => {
  const db  = readDB();
  const chs = (db.channels || []).filter(c => c.enabled !== false && c.isActive !== false && isTamil(c));
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: true, req }));
});

app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const db  = readDB();
  const chs = (db.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false && isTamil(c)
  );
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: true, req }));
});

app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const db     = readDB();
  const source = (db.sources || []).find(s => s.id === req.params.sourceId);
  const tamil  = req.query.tamil === '1' || !!(source?.tamilFilter);
  const chs    = (db.channels || []).filter(c => c.sourceId === req.params.sourceId && c.enabled !== false);
  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamil, req }));
});

app.get('/api/playlist/:id.m3u', (req, res) => {
  const db       = readDB();
  const playlist = (db.playlists || []).find(p => p.id === req.params.id);
  const tamilQS  = req.query.tamil === '1';

  let chs;
  if (playlist) {
    const chMap   = new Map((db.channels || []).map(c => [c.id, c]));
    const pinned  = (playlist.pinnedChannels  || []).map(id => chMap.get(id)).filter(Boolean);
    const blocked = new Set(playlist.blockedChannels || []);
    const baseChs = (db.channels || []).filter(c =>
      !blocked.has(c.id) &&
      !pinned.find(p => p.id === c.id) &&
      c.enabled  !== false &&
      c.isActive !== false &&
      (!playlist.tamilOnly || isTamil(c)) &&
      (!playlist.includeGroups?.length || playlist.includeGroups.includes(c.group))
    );
    chs = [...pinned, ...baseChs];
  } else {
    const db2 = readDB();
    chs = (db2.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  }

  res.setHeader('Content-Type',  'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamilQS, req }));
});

// =============================================================================
// REDIRECT — pure 302 to clean URL (strips pipe headers)
// =============================================================================
app.get('/redirect/:id', (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);

  if (!ch)      return res.status(404).json({ error: 'Channel not found' });
  if (isDRM(ch)) return res.status(410).json({ error: 'DRM channel — stripped' });

  const sourceUrl           = ch.rawUrl || ch.url || '';
  if (!sourceUrl) return res.status(400).json({ error: 'No URL' });

  const { url: cleanUrl }   = parsePipeUrl(sourceUrl);
  if (!cleanUrl) return res.status(400).json({ error: 'Could not parse URL' });

  // If this is a redirect-chain HLS, forward to HLS proxy instead of 302
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
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  if (isDRM(ch)) return res.json({ id: ch.id, name: ch.name, ok: null, note: 'DRM — stripped' });

  const sourceUrl          = ch.rawUrl || ch.url || '';
  const { url: cleanUrl }  = parsePipeUrl(sourceUrl);
  const needsProxy         = isHlsRedirectUrl(cleanUrl);
  const result             = await headCheck(sourceUrl, 8000);

  ch.lastHealth  = result.ok;
  ch.lastLatency = result.latency;
  ch.lastChecked = new Date().toISOString();
  writeDB(db);

  res.json({
    id          : ch.id,
    name        : ch.name,
    ok          : result.ok,
    status      : result.status,
    latency     : result.latency,
    contentType : result.contentType,
    isTamil     : isTamil(ch),
    routing     : needsProxy ? 'hls-proxy' : '302-direct',
    proxyUrl    : needsProxy ? `/hls/${ch.id}/playlist.m3u8` : `/redirect/${ch.id}`,
  });
});

app.post('/api/health/batch', async (req, res) => {
  const db  = readDB();
  const ids = (req.body.ids || []).slice(0, 100);
  const chs = ids.length
    ? (db.channels || []).filter(c => ids.includes(c.id) && !isDRM(c))
    : (db.channels || []).filter(c => !isDRM(c)).slice(0, 50);

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

  writeDB(db);
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
    const text = await fetchText(decodeURIComponent(url));
    res.setHeader('Content-Type',                'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control',               'no-cache');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message, url });
  }
});

// =============================================================================
// API — CRUD
// =============================================================================
app.post('/api/sync', auth, (req, res) => {
  try {
    const incoming = req.body;
    const db       = readDB();

    if (incoming.channels) {
      incoming.channels = incoming.channels
        .filter(c => !isDRM(c))
        .map(c => {
          const raw              = c.rawUrl || c.url || '';
          const { url: cleanUrl } = parsePipeUrl(raw);
          return { ...c, rawUrl: raw, url: cleanUrl };
        });
    }

    const merged = {
      ...EMPTY_DB,
      ...incoming,
      modifications: incoming.modifications || db.modifications || null,
      settings     : incoming.settings      || db.settings      || { apiKey: API_KEY },
    };

    writeDB(merged);

    const chs = merged.channels || [];
    res.json({
      success  : true,
      channels : chs.length,
      tamil    : chs.filter(c => isTamil(c)).length,
      sources  : (merged.sources   || []).length,
      message  : `Synced ${chs.length} channels`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/db', (req, res) => {
  const db = readDB();
  res.setHeader('Cache-Control',               'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    channels      : db.channels      || [],
    sources       : db.sources       || [],
    groups        : db.groups        || [],
    playlists     : db.playlists     || [],
    modifications : db.modifications || null,
    ts            : Date.now(),
  });
});

app.get('/api/stats', (req, res) => {
  const db  = readDB();
  const chs = db.channels || [];
  res.json({
    channels  : chs.length,
    tamil     : chs.filter(c => isTamil(c)).length,
    sources   : (db.sources   || []).length,
    groups    : (db.groups    || []).length,
    playlists : (db.playlists || []).length,
    uptime    : Math.floor(process.uptime()),
    memory    : Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    hlsProxy  : `port ${HLS_PORT}`,
  });
});

app.get('/api/channels', (req, res) => {
  const db    = readDB();
  const page  = parseInt(req.query.page  || '1',   10);
  const limit = parseInt(req.query.limit || '100', 10);
  const q     = (req.query.q    || '').toLowerCase();
  const group = req.query.group || '';
  const tamil = req.query.tamil === '1';

  let chs = db.channels || [];
  if (q)     chs = chs.filter(c => (c.name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q));
  if (group) chs = chs.filter(c => c.group === group);
  if (tamil) chs = chs.filter(c => isTamil(c));

  const total = chs.length;
  const paged = chs.slice((page - 1) * limit, page * limit);
  const publicBase = getPublicBase(req);

  res.json({
    total, page, limit,
    pages   : Math.ceil(total / limit),
    channels: paged.map(ch => {
      const { url: cleanUrl } = parsePipeUrl(ch.rawUrl || ch.url || '');
      const needsProxy        = isHlsRedirectUrl(cleanUrl);
      return {
        id          : ch.id,
        name        : ch.name,
        group       : ch.group,
        url         : ch.url,
        rawUrl      : ch.rawUrl,
        logo        : ch.logo,
        enabled     : ch.enabled,
        isActive    : ch.isActive,
        isTamil     : isTamil(ch),
        lastHealth  : ch.lastHealth,
        lastLatency : ch.lastLatency,
        streamType  : needsProxy ? 'hls-proxy' : (ch.streamType || 'direct'),
        sourceId    : ch.sourceId,
        playUrl     : needsProxy
          ? `${publicBase}/hls/${ch.id}/playlist.m3u8`
          : `/redirect/${ch.id}`,
      };
    }),
  });
});

app.patch('/api/channel/:id', auth, (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  if (isDRM({ ...ch, ...req.body })) return res.status(400).json({ error: 'Cannot set DRM fields' });
  Object.assign(ch, req.body);
  writeDB(db);
  res.json({ success: true, channel: ch });
});

app.delete('/api/channel/:id', auth, (req, res) => {
  const db    = readDB();
  db.channels = (db.channels || []).filter(c => c.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/sources',       auth, (req, res) => { const db = readDB(); res.json(db.sources || []); });
app.patch('/api/source/:id',  auth, (req, res) => {
  const db  = readDB();
  const src = (db.sources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  Object.assign(src, req.body);
  writeDB(db);
  res.json({ success: true, source: src });
});
app.delete('/api/source/:id', auth, (req, res) => {
  const db    = readDB();
  db.sources  = (db.sources  || []).filter(s => s.id !== req.params.id);
  db.channels = (db.channels || []).filter(c => c.sourceId !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

app.get('/api/test/:id', auth, async (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const sourceUrl          = ch.rawUrl || ch.url || '';
  const { url: cleanUrl }  = parsePipeUrl(sourceUrl);
  const needsProxy         = isHlsRedirectUrl(cleanUrl);
  const r                  = await headCheck(sourceUrl, 10000);
  const publicBase         = getPublicBase(req);
  res.json({
    success     : r.ok,
    rawUrl      : sourceUrl,
    cleanUrl,
    status      : r.status,
    latency     : r.latency,
    contentType : r.contentType,
    routing     : needsProxy ? 'hls-proxy' : '302-direct',
    playUrl     : needsProxy ? `${publicBase}/hls/${ch.id}/playlist.m3u8` : `/redirect/${ch.id}`,
  });
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
// KEEPALIVE (Render free tier)
// =============================================================================
function startKeepalive() {
  if (!SELF_URL || SELF_URL.includes('localhost')) {
    console.log('[KEEPALIVE] Skipped — no RENDER_EXTERNAL_URL');
    return;
  }
  const pingUrl = `${SELF_URL.startsWith('http') ? SELF_URL : 'https://' + SELF_URL}/health`;
  const ping    = () => {
    const lib = pingUrl.startsWith('https') ? https : http;
    lib.get(pingUrl, { timeout: 10000 }, r => { console.log(`[KEEPALIVE] ✓ ${r.statusCode}`); r.resume(); })
       .on('error', e => console.warn(`[KEEPALIVE] ✗ ${e.message}`));
  };
  setTimeout(ping, 30000);
  setInterval(ping, 14 * 60 * 1000);
  console.log(`[KEEPALIVE] Pinging ${pingUrl} every 14 min`);
}

// =============================================================================
// START
// =============================================================================
app.listen(PORT, '0.0.0.0', () => {
  const db  = readDB();
  const chs = db.channels || [];
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  📺  IPTV Manager v15 — Smart Routing                    ║
╠══════════════════════════════════════════════════════════╣
║  Main Port : ${String(PORT).padEnd(43)}║
║  HLS Proxy : ${String(HLS_PORT + ' (via /hls/* forwarding)').padEnd(43)}║
║  Channels  : ${String(chs.length).padEnd(43)}║
║  Tamil     : ${String(chs.filter(c => isTamil(c)).length).padEnd(43)}║
║  DB        : ${String(DB_FILE).substring(0, 43).padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  Direct streams  → rawUrl with pipe headers preserved    ║
║  HLS redirects   → /hls/:id/playlist.m3u8 (proxy)       ║
║  /redirect/:id   → clean 302 (pipe headers stripped)     ║
╚══════════════════════════════════════════════════════════╝
`);
  startKeepalive();
});
