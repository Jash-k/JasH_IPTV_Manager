'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// IPTV Redirect Server v12 — Clean & Simple
//
// Philosophy:
//   • NO proxy logic — server NEVER buffers/pipes stream data
//   • All streams → pure 302 redirect to original URL
//   • DRM channels → stripped at import time, NEVER stored
//   • Multi-source  → HEAD-race all URLs, redirect to fastest live one
//   • Keepalive     → self-ping every 14 min (Render free tier)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { URL } = require('url');

const app  = express();
const PORT = parseInt(process.env.PORT || '10000', 10);
const DB_FILE  = process.env.DB_FILE  || path.join(__dirname, 'db.json');
const DIST_DIR = path.join(__dirname, 'dist');
const API_KEY  = process.env.API_KEY  || 'iptv-secret';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(DIST_DIR));

// ─────────────────────────────────────────────────────────────────────────────
// DB — JSON persistence
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_DB = {
  sources: [], channels: [], groups: [],
  playlists: [], drmProxies: [],
  settings: { apiKey: API_KEY },
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Always strip DRM on load
      if (parsed.channels) parsed.channels = parsed.channels.filter(c => !isDRM(c));
      return { ...EMPTY_DB, ...parsed };
    }
  } catch (e) { console.error('[DB] load error:', e.message); }
  return { ...EMPTY_DB };
}

function saveDB(data) {
  try {
    // Never persist DRM channels
    const clean = {
      ...data,
      channels: (data.channels || []).filter(c => !isDRM(c)),
    };
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(clean, null, 2));
  } catch (e) { console.error('[DB] save error:', e.message); }
}

let DB = loadDB();

// ─────────────────────────────────────────────────────────────────────────────
// DRM Detection — strip these channels completely
// ─────────────────────────────────────────────────────────────────────────────
function isDRM(ch) {
  if (!ch || !ch.url) return true; // no URL = unusable
  if (ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId) return true;
  if (ch.isDrm === true) return true;
  // DASH without explicit DRM fields is fine — only flag if has DRM metadata
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
];

function isTamil(ch) {
  if (!ch) return false;
  const s = v => (typeof v === 'string' ? v : String(v || '')).toLowerCase();
  const text = `${s(ch.name)} ${s(ch.group)} ${s(ch.tvgName)} ${s(ch.language)} ${s(ch.tvgId)}`;
  return TAMIL_KW.some(k => text.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized name for multi-source grouping
// ─────────────────────────────────────────────────────────────────────────────
function normName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function buildCombinedMap() {
  const map = {};
  for (const ch of (DB.channels || [])) {
    if (ch.enabled === false || ch.isActive === false) continue;
    const key = normName(ch.name);
    if (!map[key]) map[key] = [];
    map[key].push(ch);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEAD health check — no stream data downloaded, just headers
// ─────────────────────────────────────────────────────────────────────────────
function headCheck(url, timeoutMs = 7000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };

    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(url, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      }, res => {
        const latency = Date.now() - t0;
        const status  = res.statusCode || 0;
        // 2xx and 3xx = stream reachable
        const ok = status >= 200 && status < 400;
        done({ ok, status, latency, contentType: res.headers['content-type'] || '' });
        res.resume();
      });
      req.on('error', e => done({ ok: false, status: 0, latency: Date.now() - t0, error: e.message }));
      req.on('timeout', () => { req.destroy(); done({ ok: false, status: 408, latency: timeoutMs }); });
      req.end();
    } catch (e) {
      done({ ok: false, status: 0, latency: Date.now() - t0, error: e.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS proxy for frontend source fetching (server-side GET, no CORS issues)
// ─────────────────────────────────────────────────────────────────────────────
function fetchText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      let redirectCount = 0;

      const doGet = target => {
        lib.get(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/plain,application/x-mpegurl,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: timeoutMs,
          rejectUnauthorized: false,
        }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
            redirectCount++;
            res.resume();
            doGet(res.headers.location);
            return;
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
        }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
      };
      doGet(url);
    } catch (e) { reject(e); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// M3U Generator — only 302-redirect streams, no DRM
// ─────────────────────────────────────────────────────────────────────────────
function generateM3U(channels, serverBase, opts = {}) {
  const { tamilOnly = false, kodiMode = false } = opts;

  // Deduplicate by normalized name — one entry per unique channel name
  const seen = new Set();
  const combined = buildCombinedMap();
  const entries = [];

  for (const ch of channels) {
    if (isDRM(ch)) continue;
    if (tamilOnly && !isTamil(ch)) continue;
    const key = normName(ch.name);
    if (seen.has(key)) continue;
    seen.add(key);

    const siblings = combined[key] || [ch];
    const isMulti  = siblings.length > 1;

    entries.push({ ch, isMulti, count: siblings.length });
  }

  const lines = ['#EXTM3U x-tvg-url=""'];

  for (const { ch, isMulti, count } of entries) {
    const tvgId   = ch.tvgId   ? ` tvg-id="${esc(ch.tvgId)}"` : '';
    const tvgName = ` tvg-name="${esc(ch.tvgName || ch.name)}"`;
    const logo    = ch.logo    ? ` tvg-logo="${esc(ch.logo)}"` : '';
    const group   = ` group-title="${esc(ch.group || 'Uncategorized')}"`;
    const multi   = isMulti    ? ` x-multi-source="true" x-link-count="${count}"` : '';
    const tamil   = isTamil(ch)? ` x-tamil="true"` : '';

    // URL: multi-source uses best-link endpoint, single uses per-channel redirect
    const streamUrl = isMulti
      ? `${serverBase}/redirect/best/${encodeURIComponent(ch.name)}`
      : `${serverBase}/redirect/${ch.id}`;

    lines.push(`#EXTINF:-1${tvgId}${tvgName}${logo}${group}${multi}${tamil},${esc(ch.name)}`);

    if (kodiMode) {
      if (ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${ch.userAgent}`);
      if (ch.referer)   lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);
    }

    lines.push(streamUrl);
    lines.push('');
  }

  return lines.join('\r\n');
}

function esc(s) {
  return String(s || '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');
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
  const chs    = DB.channels || [];
  const direct = chs.filter(c => !isDRM(c));
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    channels: { total: chs.length, direct: direct.length, drm: 0 },
    sources:   (DB.sources   || []).length,
    playlists: (DB.playlists || []).length,
    ts: new Date().toISOString(),
  });
});

// ── Playlists ─────────────────────────────────────────────────────────────────

/** ALL channels */
app.get('/api/playlist/all.m3u', (req, res) => {
  const base  = `${req.protocol}://${req.get('host')}`;
  const chs   = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false);
  const tamil = req.query.tamil === '1';
  const kodi  = req.query.kodi  === '1';
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="all.m3u"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, base, { tamilOnly: tamil, kodiMode: kodi }));
});

/** Tamil only */
app.get('/api/playlist/tamil.m3u', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const chs  = (DB.channels || []).filter(c => c.enabled !== false && c.isActive !== false && isTamil(c));
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="tamil.m3u"');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, base, { tamilOnly: true }));
});

/** Named playlist by ID */
app.get('/api/playlist/:id.m3u', (req, res) => {
  const base     = `${req.protocol}://${req.get('host')}`;
  const playlist = (DB.playlists || []).find(p => p.id === req.params.id);
  const kodi     = req.query.kodi  === '1';
  const tamil    = req.query.tamil === '1';
  let chs;

  if (playlist) {
    const chMap   = new Map((DB.channels || []).map(c => [c.id, c]));
    const pinned  = (playlist.pinnedChannels  || []).map(id => chMap.get(id)).filter(Boolean);
    const blocked = new Set(playlist.blockedChannels || []);
    const base_chs = (DB.channels || []).filter(c =>
      !blocked.has(c.id) &&
      !pinned.find(p => p.id === c.id) &&
      c.enabled !== false &&
      (!playlist.tamilOnly || isTamil(c)) &&
      (!playlist.includeGroups?.length || playlist.includeGroups.includes(c.group))
    );
    chs = [...pinned, ...base_chs];
  } else {
    chs = (DB.channels || []).filter(c => c.enabled !== false);
  }

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, base, { tamilOnly: tamil, kodiMode: kodi }));
});

/** Per-source playlist */
app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const base   = `${req.protocol}://${req.get('host')}`;
  const source = (DB.sources || []).find(s => s.id === req.params.sourceId);
  const tamil  = req.query.tamil === '1' || !!(source && source.tamilFilter);
  const chs    = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false
  );
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(generateM3U(chs, base, { tamilOnly: tamil }));
});

/** Per-source Tamil playlist */
app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const chs  = (DB.channels || []).filter(c =>
    c.sourceId === req.params.sourceId && c.enabled !== false && isTamil(c)
  );
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.send(generateM3U(chs, base, { tamilOnly: true }));
});

// ─────────────────────────────────────────────────────────────────────────────
// REDIRECT ENDPOINTS — pure 302, zero stream data through server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single channel redirect
 * GET /redirect/:id → 302 to ch.url
 */
app.get('/redirect/:id', (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);

  if (!ch) {
    return res.status(404).json({ error: 'Channel not found', id: req.params.id });
  }

  if (isDRM(ch)) {
    return res.status(410).json({
      error: 'DRM channel — not available. Only direct streams are supported.',
      channel: ch.name,
    });
  }

  if (!ch.url) {
    return res.status(400).json({ error: 'Channel has no URL', channel: ch.name });
  }

  // Always 302 — player fetches stream directly from source
  console.log(`[302] ${ch.name} → ${ch.url.substring(0, 80)}`);
  return res.redirect(302, ch.url);
});

/**
 * Best-link redirect (multi-source)
 * GET /redirect/best/:name → HEAD-race all URLs → 302 to fastest live link
 */
app.get('/redirect/best/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const key  = normName(name);
  const map  = buildCombinedMap();
  const chs  = (map[key] || []).filter(c => !isDRM(c) && c.url);

  if (chs.length === 0) {
    return res.status(404).json({ error: `No direct streams for: ${name}` });
  }

  // Single source — immediate 302
  if (chs.length === 1) {
    console.log(`[302-SINGLE] ${name} → ${chs[0].url.substring(0, 80)}`);
    return res.redirect(302, chs[0].url);
  }

  // Multi-source — race HEAD checks, redirect to fastest live link
  try {
    console.log(`[RACE] ${name} — checking ${chs.length} links...`);

    const RACE_TIMEOUT = 6000;
    let winner = null;
    let settled = false;

    await new Promise(resolve => {
      // Global timeout
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, RACE_TIMEOUT);

      let pending = chs.length;

      chs.forEach(ch => {
        headCheck(ch.url, RACE_TIMEOUT - 500).then(result => {
          pending--;
          if (result.ok && !winner) {
            winner = ch;
            // Don't settle immediately — wait briefly for potentially faster results
            setTimeout(() => {
              if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
            }, 200);
          }
          if (pending === 0 && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      });
    });

    const best = winner || chs[0]; // fallback to first if none live
    console.log(`[RACE-WIN] ${name} → ${best.url.substring(0, 80)} (source: ${best.sourceId})`);
    return res.redirect(302, best.url);

  } catch (err) {
    console.error(`[RACE-ERR] ${name}:`, err.message);
    return res.redirect(302, chs[0].url); // fallback
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK API — HEAD-only, no stream data
// ─────────────────────────────────────────────────────────────────────────────

/** Single channel health check */
app.get('/api/health/:id', async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });

  if (isDRM(ch)) {
    return res.json({ id: ch.id, name: ch.name, ok: null, note: 'DRM — stripped from server', isDrm: true });
  }

  const result = await headCheck(ch.url, 8000);

  // Persist health result
  ch.lastHealth  = result.ok;
  ch.lastLatency = result.latency;
  ch.lastChecked = new Date().toISOString();
  saveDB(DB);

  res.json({
    id: ch.id, name: ch.name,
    ok: result.ok, status: result.status,
    latency: result.latency,
    contentType: result.contentType,
    isDrm: false, isTamil: isTamil(ch),
    routing: '302-direct',
    url: ch.url,
  });
});

/** Batch health check — up to 100 channels, all parallel HEAD requests */
app.post('/api/health/batch', async (req, res) => {
  const ids = (req.body.ids || []).slice(0, 100);
  const chs = ids.length
    ? (DB.channels || []).filter(c => ids.includes(c.id) && !isDRM(c))
    : (DB.channels || []).filter(c => !isDRM(c)).slice(0, 50);

  const results = await Promise.all(
    chs.map(async ch => {
      const r = await headCheck(ch.url, 6000);
      ch.lastHealth  = r.ok;
      ch.lastLatency = r.latency;
      ch.lastChecked = new Date().toISOString();
      return { id: ch.id, name: ch.name, ok: r.ok, status: r.status, latency: r.latency };
    })
  );

  saveDB(DB);

  // Return as object keyed by id (matches frontend expectation)
  const byId = {};
  results.forEach(r => { byId[r.id] = r; });
  res.json({ checked: results.length, results: byId });
});

/** Get all links for a channel name — ranked by latency */
app.get('/api/bestlink/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const key  = normName(name);
  const map  = buildCombinedMap();
  const chs  = (map[key] || []).filter(c => !isDRM(c));

  if (!chs.length) return res.status(404).json({ error: 'Not found', name });

  const results = await Promise.all(
    chs.map(async ch => {
      const r = await headCheck(ch.url, 6000);
      return {
        id: ch.id, name: ch.name, url: ch.url,
        sourceId: ch.sourceId, group: ch.group,
        ok: r.ok, status: r.status, latency: r.latency,
        redirectUrl: `${req.protocol}://${req.get('host')}/redirect/${ch.id}`,
      };
    })
  );

  results.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || a.latency - b.latency);
  res.json({ name, count: results.length, bestRedirectUrl: `${req.protocol}://${req.get('host')}/redirect/best/${encodeURIComponent(name)}`, results });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORS PROXY — server-side fetch for frontend source imports
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url param required' });

  try {
    const text = await fetchText(url);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: err.message, url });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD API
// ─────────────────────────────────────────────────────────────────────────────

/** Full DB sync from frontend — strips DRM on receive */
app.post('/api/sync', auth, (req, res) => {
  try {
    const incoming = req.body;
    // Strip DRM channels before storing
    if (incoming.channels) {
      incoming.channels = incoming.channels.filter(c => !isDRM(c));
    }
    DB = { ...EMPTY_DB, ...incoming };
    saveDB(DB);

    const chs    = DB.channels || [];
    const tamil  = chs.filter(c => isTamil(c));
    const multi  = buildCombinedMap();
    const multiCnt = Object.values(multi).filter(g => g.length > 1).length;

    res.json({
      success: true,
      channels: chs.length,
      tamil: tamil.length,
      multiSource: multiCnt,
      sources: (DB.sources || []).length,
      drm: 0, // always 0 — DRM stripped
      message: `Stored ${chs.length} direct channels (DRM stripped)`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Stats */
app.get('/api/stats', (req, res) => {
  const chs   = DB.channels || [];
  const tamil = chs.filter(c => isTamil(c));
  const multi = buildCombinedMap();
  res.json({
    channels: chs.length, direct: chs.length, drm: 0,
    tamil: tamil.length,
    multiSource: Object.values(multi).filter(g => g.length > 1).length,
    sources: (DB.sources || []).length,
    groups: (DB.groups || []).length,
    playlists: (DB.playlists || []).length,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

/** Get DB (auth required) */
app.get('/api/db', auth, (req, res) => res.json(DB));

/** Channels list */
app.get('/api/channels', (req, res) => {
  const page  = parseInt(req.query.page  || '1', 10);
  const limit = parseInt(req.query.limit || '100', 10);
  const q     = (req.query.q || '').toLowerCase();
  const group = req.query.group || '';
  const tamil = req.query.tamil === '1';

  let chs = DB.channels || [];
  if (q)     chs = chs.filter(c => (c.name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q));
  if (group) chs = chs.filter(c => c.group === group);
  if (tamil) chs = chs.filter(c => isTamil(c));

  const total = chs.length;
  const paged = chs.slice((page - 1) * limit, page * limit);

  res.json({
    total, page, limit,
    pages: Math.ceil(total / limit),
    channels: paged.map(ch => ({
      id: ch.id, name: ch.name, group: ch.group,
      url: ch.url, logo: ch.logo,
      enabled: ch.enabled, isActive: ch.isActive,
      isTamil: isTamil(ch), isDrm: false,
      multiSource: ch.multiSource,
      lastHealth: ch.lastHealth, lastLatency: ch.lastLatency,
      streamType: ch.streamType, sourceId: ch.sourceId,
      redirectUrl: `/redirect/${ch.id}`,
    })),
  });
});

app.patch('/api/channel/:id', auth, (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  // Reject if update would make it DRM
  const updated = { ...ch, ...req.body };
  if (isDRM(updated)) return res.status(400).json({ error: 'Cannot set DRM fields — DRM channels not supported' });
  Object.assign(ch, req.body);
  saveDB(DB);
  res.json({ success: true, channel: ch });
});

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
  DB.sources   = (DB.sources   || []).filter(s => s.id !== req.params.id);
  DB.channels  = (DB.channels  || []).filter(c => c.sourceId !== req.params.id);
  saveDB(DB);
  res.json({ success: true });
});

/** Test a channel's stream URL */
app.get('/api/test/:id', auth, async (req, res) => {
  const ch = (DB.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  const r = await headCheck(ch.url, 10000);
  res.json({
    success: r.ok, url: ch.url,
    status: r.status, latency: r.latency,
    contentType: r.contentType,
    redirectUrl: `/redirect/${ch.id}`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA fallback
// ─────────────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const index = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.send(`
    <html><body style="background:#111;color:#fff;font-family:monospace;padding:40px">
      <h2>🔄 IPTV Manager starting...</h2>
      <p>Build in progress or dist not found.</p>
    </body></html>
  `);
});

// ─────────────────────────────────────────────────────────────────────────────
// Keepalive — prevents Render free tier from sleeping (pings every 14 min)
// ─────────────────────────────────────────────────────────────────────────────
function startKeepalive() {
  if (!SELF_URL || SELF_URL.includes('localhost')) {
    console.log('[KEEPALIVE] Skipped (no RENDER_EXTERNAL_URL set)');
    return;
  }

  const pingUrl = `${SELF_URL}/health`;
  const interval = 14 * 60 * 1000; // 14 minutes

  const ping = () => {
    const lib = pingUrl.startsWith('https') ? https : http;
    lib.get(pingUrl, { timeout: 10000 }, res => {
      console.log(`[KEEPALIVE] ✓ ${pingUrl} → ${res.statusCode}`);
      res.resume();
    }).on('error', err => {
      console.warn(`[KEEPALIVE] ✗ ${err.message}`);
    });
  };

  setTimeout(ping, 30000); // first ping after 30s
  setInterval(ping, interval);
  console.log(`[KEEPALIVE] Pinging ${pingUrl} every 14 min`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const chs = DB.channels || [];
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  📺  IPTV Redirect Server v12 — No Proxy, Pure 302       ║
╠══════════════════════════════════════════════════════════╣
║  Port     : ${String(PORT).padEnd(44)} ║
║  Channels : ${String(chs.length + ' direct (0 DRM — stripped)').padEnd(44)} ║
║  Sources  : ${String((DB.sources||[]).length).padEnd(44)} ║
║  DB       : ${String(DB_FILE).substring(0, 44).padEnd(44)} ║
╠══════════════════════════════════════════════════════════╣
║  /redirect/:id         → 302 to original URL             ║
║  /redirect/best/:name  → race links, 302 fastest         ║
║  /api/playlist/all.m3u → full playlist                   ║
║  /api/playlist/tamil.m3u → tamil only                    ║
║  /api/health/:id       → HEAD check (no data download)   ║
╚══════════════════════════════════════════════════════════╝
`);
  startKeepalive();
});
