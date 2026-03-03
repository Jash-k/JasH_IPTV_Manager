'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// IPTV Redirect Server v14
//
// Philosophy:
//   • Generated playlist contains EXACT original URLs from source (rawUrl)
//   • Pipe-headers preserved in M3U (|User-Agent=...|Referer=...)
//   • /redirect/:id — 302 to clean URL (strips pipe headers at runtime)
//   • DRM channels → stripped at import time, NEVER stored
//   • Keepalive → self-ping every 14 min (Render free tier)
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const https    = require('https');
const { URL }  = require('url');

const app      = express();
const PORT     = parseInt(process.env.PORT || '10000', 10);
const DB_FILE  = process.env.DB_FILE  || path.join(__dirname, 'db.json');
const DIST_DIR = path.join(__dirname, 'dist');
const API_KEY  = process.env.API_KEY  || 'iptv-secret';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(DIST_DIR));

// ─────────────────────────────────────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_DB = {
  sources: [], channels: [], groups: [],
  playlists: [], settings: { apiKey: API_KEY },
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed.channels) parsed.channels = parsed.channels.filter(c => !isDRM(c));
      return { ...EMPTY_DB, ...parsed };
    }
  } catch (e) { console.error('[DB] load error:', e.message); }
  return { ...EMPTY_DB };
}

function saveDB(data) {
  try {
    const clean = { ...data, channels: (data.channels || []).filter(c => !isDRM(c)) };
    const dir   = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(clean, null, 2));
  } catch (e) { console.error('[DB] save error:', e.message); }
}

let DB = loadDB();

// ─────────────────────────────────────────────────────────────────────────────
// URL PIPE-HEADER PARSER
//
// Many M3U sources append headers using pipe separator:
//   https://stream.m3u8?token=abc|User-Agent=ReactNativeVideo/9.3.0 (Linux;Android 13) AndroidXMedia3/1.6.1&Referer=https://fancode.com/
//   https://stream.m3u8?token=abc|User-Agent=VLC|Referer=https://site.com|Cookie=abc=123
//
// parsePipeUrl(rawUrl) → { url: cleanUrl, headers: { 'User-Agent': ..., 'Referer': ... } }
// ─────────────────────────────────────────────────────────────────────────────
function parsePipeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { url: '', headers: {} };

  const pipeIdx = rawUrl.indexOf('|');
  if (pipeIdx === -1) return { url: rawUrl.trim(), headers: {} };

  const url     = rawUrl.substring(0, pipeIdx).trim();
  const headers = {};
  const rest    = rawUrl.substring(pipeIdx + 1);

  rest.split('|').forEach(part => {
    const eq  = part.indexOf('=');
    if (eq === -1) return;
    const key = part.substring(0, eq).trim();
    const val = part.substring(eq + 1).trim();
    if (key && val) headers[key] = val;
  });

  return { url, headers };
}

// ─────────────────────────────────────────────────────────────────────────────
// DRM Detection — strip completely, never serve
// ─────────────────────────────────────────────────────────────────────────────
function isDRM(ch) {
  if (!ch) return true;
  const raw = ch.rawUrl || ch.url || '';
  if (!raw) return true;
  if (ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId) return true;
  if (ch.isDrm === true) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tamil Detection
// ─────────────────────────────────────────────────────────────────────────────
const TAMIL_KW = [
  'tamil','tamizh','kollywood','vijay tv','sun tv','kalaignar','jaya tv',
  'raj tv','polimer','puthiya','sirippoli','adithya tv','vendhar','makkal tv',
  'captain tv','colors tamil','star vijay','zee tamil','news18 tamil',
  'news7 tamil','thanthi','sathiyam','chutti tv','isai aruvi','dd tamil',
  'sun music','mega tv','vasanth tv','imayam','kaveri','rain bow','rainbow',
  'tam ','_tam','tam_','-tam','(tam',
];

function isTamil(ch) {
  if (!ch) return false;
  const sv = v => (typeof v === 'string' ? v : String(v || '')).toLowerCase();
  const text = `${sv(ch.name)} ${sv(ch.group)} ${sv(ch.tvgName)} ${sv(ch.language)} ${sv(ch.tvgId)}`;
  return TAMIL_KW.some(k => text.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────────
// M3U Generator
//
// KEY RULE: Use ch.rawUrl (exact original URL with pipe headers) in playlist.
//           If rawUrl not available, fall back to ch.url.
//
// This means the generated playlist contains the EXACT URL from the source,
// including |User-Agent=...|Referer=... pipe headers.
//
// Example output:
//   #EXTINF:-1 tvg-name="FanCode Match" group-title="Sports",FanCode Match
//   https://in-mc-flive.fancode.com/.../360p.m3u8?hdntl=...~|User-Agent=ReactNativeVideo/9.3.0 (Linux;Android 13) AndroidXMedia3/1.6.1&Referer=https://fancode.com/
//
// Players that support pipe-headers (TiviMate, IPTV Smarters, Kodi, VLC) will
// use the headers automatically. Players that don't will use the clean URL.
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
}

function getStreamUrl(ch) {
  // Always prefer rawUrl — exact original URL from source with pipe headers
  return ch.rawUrl || ch.url || '';
}

function generateM3U(channels, opts = {}) {
  const { tamilOnly = false } = opts;

  const entries = channels.filter(ch => {
    if (isDRM(ch))                   return false;
    if (tamilOnly && !isTamil(ch))   return false;
    if (ch.enabled  === false)       return false;
    if (ch.isActive === false)       return false;
    if (!getStreamUrl(ch))           return false;
    return true;
  });

  const lines = ['#EXTM3U x-tvg-url=""'];

  for (const ch of entries) {
    const tvgId   = ch.tvgId   ? ` tvg-id="${esc(ch.tvgId)}"`           : '';
    const tvgName = ` tvg-name="${esc(ch.tvgName || ch.name)}"`;
    const logo    = ch.logo    ? ` tvg-logo="${esc(ch.logo)}"`           : '';
    const group   = ` group-title="${esc(ch.group || 'General')}"`;
    const tamil   = isTamil(ch) ? ' x-tamil="true"'                     : '';

    // EXACT original URL — includes pipe headers if present in source
    const streamUrl = getStreamUrl(ch);

    lines.push(`#EXTINF:-1${tvgId}${tvgName}${logo}${group}${tamil},${esc(ch.name)}`);

    // Emit #EXTVLCOPT for players that prefer explicit header directives
    // (Only when rawUrl does NOT already contain pipe headers)
    const hasPipe = streamUrl.includes('|');
    if (!hasPipe) {
      if (ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${ch.userAgent}`);
      if (ch.referer)   lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);
    }

    lines.push(streamUrl);
    lines.push('');
  }

  return lines.join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Playlist Builder
// ─────────────────────────────────────────────────────────────────────────────
function buildDefaultPlaylist() {
  const playlists = DB.playlists || [];
  const channels  = DB.channels  || [];

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
      if (seen.has(ch.id))       continue;
      if (isDRM(ch))             continue;
      if (blocked.has(ch.id))   continue;
      if (ch.enabled  === false) continue;
      if (ch.isActive === false) continue;

      if (playlist.includeGroups && playlist.includeGroups.length > 0) {
        if (!playlist.includeGroups.includes(ch.group)) continue;
      }
      if (playlist.tamilOnly && !isTamil(ch)) continue;

      result.push(ch);
      seen.add(ch.id);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEAD health check — no stream data downloaded
// ─────────────────────────────────────────────────────────────────────────────
function headCheck(rawUrl, timeoutMs = 7000) {
  return new Promise(resolve => {
    const t0    = Date.now();
    let settled = false;
    const done  = r => { if (!settled) { settled = true; resolve(r); } };

    try {
      // Always strip pipe headers for health check
      const { url: cleanUrl } = parsePipeUrl(rawUrl);
      const parsed = new URL(cleanUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(cleanUrl, {
        method  : 'HEAD',
        headers : {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept'    : '*/*',
        },
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

// ─────────────────────────────────────────────────────────────────────────────
// Server-side CORS fetch (for source imports)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// AUTH middleware
// ─────────────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== (DB.settings?.apiKey || API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized — set X-Api-Key header' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

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
    keepalive : !!(SELF_URL && !SELF_URL.includes('localhost')),
    version   : '14.0',
    ts        : new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PLAYLIST ENDPOINTS — all use raw original URLs
// ─────────────────────────────────────────────────────────────────────────────

/** DEFAULT playlist — combines all created playlists */
app.get('/api/playlist/default.m3u', (req, res) => {
  const chs = buildDefaultPlaylist();
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="default.m3u"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs));
});

/** ALL channels */
app.get('/api/playlist/all.m3u', (req, res) => {
  const chs   = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  const tamil = req.query.tamil === '1';
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="all.m3u"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamil }));
});

/** Tamil only */
app.get('/api/playlist/tamil.m3u', (req, res) => {
  const chs = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false && isTamil(c));
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="tamil.m3u"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: true }));
});

/** Named playlist by ID */
app.get('/api/playlist/:id.m3u', (req, res) => {
  const playlist = (DB.playlists || []).find(p => p.id === req.params.id);
  const tamilQS  = req.query.tamil === '1';

  let chs;
  if (playlist) {
    const chMap   = new Map((DB.channels || []).map(c => [c.id, c]));
    const pinned  = (playlist.pinnedChannels  || []).map(id => chMap.get(id)).filter(Boolean);
    const blocked = new Set(playlist.blockedChannels || []);

    const baseChs = (DB.channels || []).filter(c =>
      !blocked.has(c.id) &&
      !pinned.find(p => p.id === c.id) &&
      c.enabled  !== false &&
      c.isActive !== false &&
      (!playlist.tamilOnly || isTamil(c)) &&
      (!playlist.includeGroups?.length || playlist.includeGroups.includes(c.group))
    );
    chs = [...pinned, ...baseChs];
  } else {
    chs = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  }

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamilQS }));
});

/** Per-source playlist */
app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const source = (DB.sources || []).find(s => s.id === req.params.sourceId);
  const tamil  = req.query.tamil === '1' || !!(source && source.tamilFilter);
  const chs    = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false
  );
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, { tamilOnly: tamil }));
});

/** Per-source Tamil playlist */
app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const chs = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false && isTamil(c)
  );
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.send(generateM3U(chs, { tamilOnly: true }));
});

// ─────────────────────────────────────────────────────────────────────────────
// REDIRECT — strips pipe headers, pure 302 to clean URL
//
// This endpoint is for players that DON'T support pipe-header syntax.
// Players that DO support it (TiviMate, Smarters, Kodi) can use rawUrl directly.
//
// FanCode example:
//   rawUrl: https://in-mc-flive.fancode.com/.../360p.m3u8?hdntl=...~|User-Agent=ReactNativeVideo/9.3.0
//   302 → : https://in-mc-flive.fancode.com/.../360p.m3u8?hdntl=...~
// ─────────────────────────────────────────────────────────────────────────────
app.get('/redirect/:id', (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);

  if (!ch) {
    return res.status(404).json({ error: 'Channel not found', id: req.params.id });
  }

  if (isDRM(ch)) {
    return res.status(410).json({ error: 'DRM channel — stripped', channel: ch.name });
  }

  // Use rawUrl first, fall back to url
  const sourceUrl = ch.rawUrl || ch.url || '';
  if (!sourceUrl) {
    return res.status(400).json({ error: 'Channel has no URL', channel: ch.name });
  }

  // Strip pipe headers → clean URL for 302
  const { url: cleanUrl } = parsePipeUrl(sourceUrl);
  if (!cleanUrl) {
    return res.status(400).json({ error: 'Could not parse channel URL', channel: ch.name });
  }

  console.log(`[302] ${ch.name} → ${cleanUrl.substring(0, 120)}`);
  return res.redirect(302, cleanUrl);
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK API
// ─────────────────────────────────────────────────────────────────────────────

/** Single channel health check */
app.get('/api/health/:id', async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });

  if (isDRM(ch)) {
    return res.json({ id: ch.id, name: ch.name, ok: null, note: 'DRM — stripped' });
  }

  const sourceUrl = ch.rawUrl || ch.url || '';
  const result    = await headCheck(sourceUrl, 8000);

  ch.lastHealth  = result.ok;
  ch.lastLatency = result.latency;
  ch.lastChecked = new Date().toISOString();
  saveDB(DB);

  res.json({
    id          : ch.id,
    name        : ch.name,
    ok          : result.ok,
    status      : result.status,
    latency     : result.latency,
    contentType : result.contentType,
    isTamil     : isTamil(ch),
    routing     : '302-direct',
    redirectUrl : `/redirect/${ch.id}`,
    rawUrl      : sourceUrl.substring(0, 100) + (sourceUrl.length > 100 ? '...' : ''),
  });
});

/** Batch health check */
app.post('/api/health/batch', async (req, res) => {
  const ids = (req.body.ids || []).slice(0, 100);
  const chs = ids.length
    ? (DB.channels || []).filter(c => ids.includes(c.id) && !isDRM(c))
    : (DB.channels || []).filter(c => !isDRM(c)).slice(0, 50);

  const results = await Promise.all(
    chs.map(async ch => {
      const sourceUrl = ch.rawUrl || ch.url || '';
      const r = await headCheck(sourceUrl, 6000);
      ch.lastHealth  = r.ok;
      ch.lastLatency = r.latency;
      ch.lastChecked = new Date().toISOString();
      return { id: ch.id, name: ch.name, ok: r.ok, status: r.status, latency: r.latency };
    })
  );

  saveDB(DB);

  const byId = {};
  results.forEach(r => { byId[r.id] = r; });
  res.json({ checked: results.length, results: byId });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS PROXY — server-side GET for source imports
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: '?url= param required' });
  try {
    const text = await fetchText(decodeURIComponent(url));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message, url });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API — CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/sync — push all data from frontend
 *
 * IMPORTANT: rawUrl is stored AS-IS (with pipe headers).
 * url is stored as the clean version (pipe headers stripped).
 * Both are preserved so:
 *   - generateM3U() uses rawUrl → exact original URL in playlist
 *   - /redirect/:id uses url   → clean 302 redirect
 */
app.post('/api/sync', auth, (req, res) => {
  try {
    const incoming = req.body;

    if (incoming.channels) {
      incoming.channels = incoming.channels
        .filter(c => !isDRM(c))
        .map(c => {
          // If rawUrl is present (set by frontend parser), keep both
          // If only url is present, check if it has pipe headers
          const raw = c.rawUrl || c.url || '';
          const { url: cleanUrl } = parsePipeUrl(raw);

          return {
            ...c,
            rawUrl : raw,       // EXACT original URL with pipe headers
            url    : cleanUrl,  // Clean URL for redirect
          };
        });
    }

    DB = { ...EMPTY_DB, ...incoming };
    saveDB(DB);

    const chs   = DB.channels || [];
    const tamil = chs.filter(c => isTamil(c));

    res.json({
      success  : true,
      channels : chs.length,
      tamil    : tamil.length,
      sources  : (DB.sources   || []).length,
      drm      : 0,
      message  : `Stored ${chs.length} channels — playlist uses exact source URLs`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Stats */
app.get('/api/stats', (req, res) => {
  const chs = DB.channels || [];
  res.json({
    channels  : chs.length,
    direct    : chs.length,
    drm       : 0,
    tamil     : chs.filter(c => isTamil(c)).length,
    sources   : (DB.sources   || []).length,
    groups    : (DB.groups    || []).length,
    playlists : (DB.playlists || []).length,
    uptime    : Math.floor(process.uptime()),
    memory    : Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

/** DB dump */
app.get('/api/db', auth, (req, res) => res.json(DB));

/** Channel list */
app.get('/api/channels', (req, res) => {
  const page  = parseInt(req.query.page  || '1',   10);
  const limit = parseInt(req.query.limit || '100', 10);
  const q     = (req.query.q     || '').toLowerCase();
  const group = req.query.group  || '';
  const tamil = req.query.tamil  === '1';

  let chs = DB.channels || [];
  if (q)     chs = chs.filter(c => (c.name  || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q));
  if (group) chs = chs.filter(c => c.group === group);
  if (tamil) chs = chs.filter(c => isTamil(c));

  const total = chs.length;
  const paged = chs.slice((page - 1) * limit, page * limit);

  res.json({
    total, page, limit,
    pages   : Math.ceil(total / limit),
    channels: paged.map(ch => ({
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
      streamType  : ch.streamType,
      sourceId    : ch.sourceId,
      redirectUrl : `/redirect/${ch.id}`,
    })),
  });
});

/** Patch channel */
app.patch('/api/channel/:id', auth, (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const updated = { ...ch, ...req.body };
  if (isDRM(updated)) return res.status(400).json({ error: 'Cannot set DRM fields' });
  Object.assign(ch, req.body);
  saveDB(DB);
  res.json({ success: true, channel: ch });
});

/** Delete channel */
app.delete('/api/channel/:id', auth, (req, res) => {
  DB.channels = (DB.channels || []).filter(c => c.id !== req.params.id);
  saveDB(DB);
  res.json({ success: true });
});

/** Sources */
app.get('/api/sources', auth, (req, res) => res.json(DB.sources || []));

app.patch('/api/source/:id', auth, (req, res) => {
  const src = (DB.sources || []).find(s => s.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  Object.assign(src, req.body);
  saveDB(DB);
  res.json({ success: true, source: src });
});

app.delete('/api/source/:id', auth, (req, res) => {
  DB.sources  = (DB.sources  || []).filter(s => s.id !== req.params.id);
  DB.channels = (DB.channels || []).filter(c => c.sourceId !== req.params.id);
  saveDB(DB);
  res.json({ success: true });
});

/** Test single channel */
app.get('/api/test/:id', auth, async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const sourceUrl = ch.rawUrl || ch.url || '';
  const r = await headCheck(sourceUrl, 10000);
  res.json({
    success     : r.ok,
    rawUrl      : sourceUrl,
    cleanUrl    : parsePipeUrl(sourceUrl).url,
    status      : r.status,
    latency     : r.latency,
    contentType : r.contentType,
    redirectUrl : `/redirect/${ch.id}`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA Fallback
// ─────────────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const index = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(200).send(`
      <html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px">
        <h2>📺 IPTV Manager — starting...</h2>
        <p>Build not found.</p>
      </body></html>
    `);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Keepalive — prevents Render free tier sleeping
// ─────────────────────────────────────────────────────────────────────────────
function startKeepalive() {
  if (!SELF_URL || SELF_URL.includes('localhost')) {
    console.log('[KEEPALIVE] Skipped — no RENDER_EXTERNAL_URL set');
    return;
  }
  const pingUrl  = `${SELF_URL}/health`;
  const interval = 14 * 60 * 1000;

  const ping = () => {
    const lib = pingUrl.startsWith('https') ? https : http;
    lib.get(pingUrl, { timeout: 10000 }, res => {
      console.log(`[KEEPALIVE] ✓ ${res.statusCode}`);
      res.resume();
    }).on('error', e => console.warn(`[KEEPALIVE] ✗ ${e.message}`));
  };

  setTimeout(ping, 30000);
  setInterval(ping, interval);
  console.log(`[KEEPALIVE] Pinging ${pingUrl} every 14 min`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const chs = DB.channels || [];
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  📺  IPTV Redirect Server v14 — Raw URL Passthrough      ║
╠══════════════════════════════════════════════════════════╣
║  Port      : ${String(PORT).padEnd(43)}║
║  Channels  : ${String(chs.length + ' (DRM stripped)').padEnd(43)}║
║  Tamil     : ${String(chs.filter(c => isTamil(c)).length).padEnd(43)}║
║  DB        : ${String(DB_FILE).substring(0,43).padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  Playlist uses EXACT source URLs (rawUrl preserved)      ║
║  Pipe headers |User-Agent=...|Referer=... kept as-is     ║
║  /redirect/:id strips pipe headers → clean 302           ║
╠══════════════════════════════════════════════════════════╣
║  GET /api/playlist/default.m3u → combined default        ║
║  GET /api/playlist/all.m3u     → all channels            ║
║  GET /api/playlist/tamil.m3u   → tamil only              ║
║  GET /api/playlist/:id.m3u     → named playlist          ║
║  GET /redirect/:id             → clean 302 redirect      ║
║  GET /api/health/:id           → HEAD check              ║
║  POST /api/sync                → push data from UI       ║
╚══════════════════════════════════════════════════════════╝
`);
  startKeepalive();
});
