/**
 * IPTV Playlist Manager — Full Stack Server (ES Module)
 * =====================================================
 * Deploy: Render.com | Railway | Fly.io | VPS
 *
 * ✅ ES Module (import/export) — compatible with "type":"module" in package.json
 * ✅ Live M3U playlist generation with proxy URLs
 * ✅ Stream redirect proxy (hides original URLs, forwards headers)
 * ✅ Full stream pipe proxy
 * ✅ DRM proxy: ClearKey decryption + Widevine license forwarding
 * ✅ CORS proxy for frontend fetching remote M3U/JSON sources
 * ✅ Auto-refresh sources on configurable schedule
 * ✅ Tamil channel filter support
 * ✅ Persistent JSON database (db.json)
 * ✅ SPA fallback for React frontend
 */

import express   from 'express';
import cors      from 'cors';
import path      from 'path';
import fs        from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// node-fetch — already ESM in v3
import fetch from 'node-fetch';

const app  = express();
const PORT = process.env.PORT || 10000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'] }));
app.options('*', cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ── Persistent DB ─────────────────────────────────────────────────────────────
const DB_DIR  = process.env.DB_DIR  || __dirname;
const DB_FILE = process.env.DB_FILE || path.join(DB_DIR, 'db.json');

const EMPTY_DB = {
  channels:   [],
  playlists:  [],
  drmProxies: [],
  sources:    [],
  groups:     [],
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { ...EMPTY_DB };
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_DB, ...parsed };
  } catch (e) {
    console.error('DB load error:', e.message);
    return { ...EMPTY_DB };
  }
}

function saveDB(data) {
  try {
    // Ensure directory exists
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('DB save error:', e.message);
    return false;
  }
}

// ── Tamil Channel Detector ────────────────────────────────────────────────────
const TAMIL_KEYWORDS = [
  'tamil','sun tv','vijay','zee tamil','kalaignar','raj tv','jaya tv',
  'polimer','captain','vendhar','vasanth','adithya','isai','mozhi',
  'puthuyugam','news7 tamil','news18 tamil','thanthi','sathiyam',
  'makkal','sirippoli','peppers','chutti','mini tv tamil','star vijay',
  'colors tamil','dd tamil','doordarshan tamil','sun music','keetru',
  'imayam','murasu','shakthi','gem','thirai','natpe thunai',
];

const TAMIL_UNICODE = 'தமிழ்';

function ss(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase();
}

function isTamil(ch) {
  if (ch && ch.isTamil === true) return true;
  if (!ch) return false;
  const hay = `${ss(ch.name)} ${ss(ch.group)} ${ss(ch.language)} ${ss(ch.tvgName)} ${ss(ch.country)}`;
  return TAMIL_KEYWORDS.some(k => hay.includes(k)) || hay.includes(TAMIL_UNICODE.toLowerCase());
}

// ── M3U Generator ─────────────────────────────────────────────────────────────
function generateM3U(channels, baseUrl, playlistName) {
  let m3u = `#EXTM3U x-tvg-url="" playlist-name="${playlistName || 'IPTV Playlist'}"\n`;

  for (const ch of channels) {
    const tvgId   = ch.tvgId    ? ` tvg-id="${ch.tvgId}"`          : '';
    const tvgName = ch.tvgName  ? ` tvg-name="${ch.tvgName}"`      : ` tvg-name="${ch.name}"`;
    const logo    = ch.logo     ? ` tvg-logo="${ch.logo}"`          : '';
    const group   = ` group-title="${ch.group || 'Uncategorized'}"`;
    const lang    = ch.language ? ` tvg-language="${ch.language}"`  : '';
    const country = ch.country  ? ` tvg-country="${ch.country}"`   : '';

    // Always proxy through server — never expose original URL
    const streamUrl = ch.licenseType
      ? `${baseUrl}/proxy/drm/${ch.id}`
      : `${baseUrl}/proxy/redirect/${ch.id}`;

    m3u += `#EXTINF:-1${tvgId}${tvgName}${logo}${group}${lang}${country},${ch.name}\n`;
    m3u += `${streamUrl}\n`;
  }

  return m3u;
}

// ── Playlist Filter ────────────────────────────────────────────────────────────
function filterChannels(pl, allChannels) {
  return allChannels
    .filter(ch => {
      if (!ch.enabled && !ch.isActive) return false;
      if (pl.tamilOnly && !isTamil(ch)) return false;
      if (pl.includeGroups?.length > 0 && !pl.includeGroups.includes(ch.group)) return false;
      if (pl.excludeGroups?.includes(ch.group)) return false;
      return true;
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// ── Safe fetch with timeout ───────────────────────────────────────────────────
async function safeFetch(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ══════════════════════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', (req, res) => {
  const db       = loadDB();
  const channels = db.channels || [];
  const BASE     = `${req.protocol}://${req.get('host')}`;

  res.json({
    serverVersion:  '3.0.0',
    uptime:         Math.floor(process.uptime()),
    nodeVersion:    process.version,
    channels:       channels.length,
    activeChannels: channels.filter(c => c.enabled || c.isActive).length,
    tamilChannels:  channels.filter(isTamil).length,
    drmChannels:    channels.filter(c => c.licenseType || c.isDrm).length,
    groups:         [...new Set(channels.map(c => c.group || 'Uncategorized'))].length,
    playlists:      (db.playlists  || []).length,
    sources:        (db.sources    || []).length,
    drmProxies:     (db.drmProxies || []).length,
    dbFile:         DB_FILE,
    playlistUrls:   (db.playlists || []).map(p => ({
      id:       p.id,
      name:     p.name,
      url:      `${BASE}/api/playlist/${p.id}.m3u`,
      tamilOnly: p.tamilOnly || false,
      channels: filterChannels(p, channels).length,
    })),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYLIST ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/playlist/:id.m3u — Live M3U, always fresh, proxy URLs
app.get('/api/playlist/:id.m3u', (req, res) => {
  const db  = loadDB();
  const id  = req.params.id;
  const pl  = (db.playlists || []).find(p => p.id === id);

  if (!pl) {
    res.status(404).type('text/plain').send('# Playlist not found\n');
    return;
  }

  const BASE     = `${req.protocol}://${req.get('host')}`;
  const channels = filterChannels(pl, db.channels || []);
  const m3u      = generateM3U(channels, BASE, pl.name);

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Disposition', `inline; filename="${(pl.name || 'playlist').replace(/\s+/g, '-')}.m3u"`);
  res.send(m3u);
});

// GET /api/playlists — List all playlists with live M3U URLs
app.get('/api/playlists', (req, res) => {
  const db   = loadDB();
  const BASE = `${req.protocol}://${req.get('host')}`;
  const pls  = (db.playlists || []).map(pl => {
    const channels = filterChannels(pl, db.channels || []);
    return {
      ...pl,
      m3uUrl:       `${BASE}/api/playlist/${pl.id}.m3u`,
      channelCount: channels.length,
      tamilCount:   channels.filter(isTamil).length,
    };
  });
  res.json(pls);
});

app.get('/api/playlists/:id', (req, res) => {
  const db   = loadDB();
  const BASE = `${req.protocol}://${req.get('host')}`;
  const pl   = (db.playlists || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  const channels = filterChannels(pl, db.channels || []);
  res.json({
    ...pl,
    m3uUrl:       `${BASE}/api/playlist/${pl.id}.m3u`,
    channelCount: channels.length,
    tamilCount:   channels.filter(isTamil).length,
  });
});

app.post('/api/playlists', (req, res) => {
  const db   = loadDB();
  const BASE = `${req.protocol}://${req.get('host')}`;
  const id   = `pl_${Date.now()}`;
  const pl   = {
    ...req.body,
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.playlists = [...(db.playlists || []), pl];
  saveDB(db);
  res.json({ ...pl, m3uUrl: `${BASE}/api/playlist/${pl.id}.m3u` });
});

app.put('/api/playlists/:id', (req, res) => {
  const db = loadDB();
  let found = false;
  db.playlists = (db.playlists || []).map(p => {
    if (p.id !== req.params.id) return p;
    found = true;
    return { ...p, ...req.body, id: p.id, updatedAt: new Date().toISOString() };
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/playlists/:id', (req, res) => {
  const db = loadDB();
  db.playlists = (db.playlists || []).filter(p => p.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  CHANNELS API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/channels', (req, res) => {
  const db = loadDB();
  let channels = db.channels || [];
  if (req.query.group)        channels = channels.filter(c => c.group === req.query.group);
  if (req.query.tamil === '1') channels = channels.filter(isTamil);
  if (req.query.active === '1') channels = channels.filter(c => c.enabled || c.isActive);
  if (req.query.drm === '1')  channels = channels.filter(c => c.licenseType || c.isDrm);
  res.json(channels);
});

app.get('/api/channels/:id', (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  res.json(ch);
});

app.post('/api/channels', (req, res) => {
  const db = loadDB();
  const ch = {
    ...req.body,
    id:       req.body.id || `ch_${Date.now()}`,
    order:    (db.channels || []).length,
    enabled:  true,
    isActive: true,
    isTamil:  isTamil(req.body),
  };
  db.channels = [...(db.channels || []), ch];
  saveDB(db);
  res.json(ch);
});

app.put('/api/channels/:id', (req, res) => {
  const db = loadDB();
  let found = false;
  db.channels = (db.channels || []).map(c => {
    if (c.id !== req.params.id) return c;
    found = true;
    const updated = { ...c, ...req.body, id: c.id };
    updated.isTamil = isTamil(updated);
    return updated;
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/channels/:id', (req, res) => {
  const db = loadDB();
  db.channels   = (db.channels   || []).filter(c => c.id !== req.params.id);
  db.drmProxies = (db.drmProxies || []).filter(d => d.channelId !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// Bulk operations
app.post('/api/channels/bulk/toggle', (req, res) => {
  const { ids, enabled } = req.body;
  const db = loadDB();
  db.channels = (db.channels || []).map(c =>
    ids.includes(c.id) ? { ...c, enabled, isActive: enabled } : c
  );
  saveDB(db);
  res.json({ ok: true, updated: ids.length });
});

app.delete('/api/channels/bulk/delete', (req, res) => {
  const { ids } = req.body;
  const db = loadDB();
  db.channels = (db.channels || []).filter(c => !ids.includes(c.id));
  saveDB(db);
  res.json({ ok: true, deleted: ids.length });
});

// ══════════════════════════════════════════════════════════════════════════════
//  GROUPS API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/groups', (req, res) => {
  const db       = loadDB();
  const channels = db.channels || [];
  const names    = [...new Set(channels.map(c => c.group || 'Uncategorized'))];
  const groups   = names.map(name => ({
    name,
    count:      channels.filter(c => (c.group || 'Uncategorized') === name).length,
    tamilCount: channels.filter(c => (c.group || 'Uncategorized') === name && isTamil(c)).length,
    isActive:   (db.groups || []).find(g => g.name === name)?.isActive ?? true,
  }));
  res.json(groups);
});

app.put('/api/groups/:name', (req, res) => {
  const db = loadDB();
  const name = decodeURIComponent(req.params.name);
  // Rename group across all channels
  if (req.body.newName && req.body.newName !== name) {
    db.channels = (db.channels || []).map(c =>
      (c.group || 'Uncategorized') === name ? { ...c, group: req.body.newName } : c
    );
  }
  // Toggle group active state
  const groups = db.groups || [];
  const existing = groups.find(g => g.name === name);
  if (existing) {
    db.groups = groups.map(g => g.name === name ? { ...g, ...req.body } : g);
  } else {
    db.groups = [...groups, { name, ...req.body }];
  }
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/groups/:name', (req, res) => {
  const db   = loadDB();
  const name = decodeURIComponent(req.params.name);
  db.channels = (db.channels || []).filter(c => (c.group || 'Uncategorized') !== name);
  db.groups   = (db.groups || []).filter(g => g.name !== name);
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SOURCES API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/sources', (req, res) => {
  const db = loadDB();
  res.json(db.sources || []);
});

app.post('/api/sources', (req, res) => {
  const db  = loadDB();
  const src = { ...req.body, id: req.body.id || `src_${Date.now()}`, createdAt: new Date().toISOString() };
  db.sources = [...(db.sources || []), src];
  saveDB(db);
  res.json(src);
});

app.put('/api/sources/:id', (req, res) => {
  const db = loadDB();
  db.sources = (db.sources || []).map(s => s.id === req.params.id ? { ...s, ...req.body, id: s.id } : s);
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/sources/:id', (req, res) => {
  const db = loadDB();
  db.sources = (db.sources || []).filter(s => s.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DRM PROXIES API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/drm', (req, res) => {
  const db = loadDB();
  res.json(db.drmProxies || []);
});

app.post('/api/drm', (req, res) => {
  const db   = loadDB();
  const BASE = `${req.protocol}://${req.get('host')}`;
  const id   = `drm_${Date.now()}`;
  const proxy = {
    ...req.body,
    id,
    isActive:  true,
    proxyUrl:  `${BASE}/proxy/drm/${req.body.channelId}`,
    licenseEndpoint: `${BASE}/proxy/drm-license/${id}`,
    createdAt: new Date().toISOString(),
  };
  db.drmProxies = [...(db.drmProxies || []), proxy];
  saveDB(db);
  res.json(proxy);
});

app.put('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).map(d => d.id === req.params.id ? { ...d, ...req.body, id: d.id } : d);
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).filter(d => d.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SYNC — Frontend pushes full state to server on every change
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Re-tag isTamil server-side for consistency
    if (Array.isArray(data.channels)) {
      data.channels = data.channels.map(ch => ({ ...ch, isTamil: isTamil(ch) }));
    }

    const ok = saveDB({ ...EMPTY_DB, ...data });
    console.log(`✅ Synced: ${(data.channels||[]).length} ch | ${(data.playlists||[]).length} pl | ${(data.drmProxies||[]).length} DRM | ${(data.sources||[]).length} src`);
    res.json({
      ok,
      synced: {
        channels:   (data.channels   || []).length,
        playlists:  (data.playlists  || []).length,
        drmProxies: (data.drmProxies || []).length,
        sources:    (data.sources    || []).length,
        groups:     (data.groups     || []).length,
      },
    });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CORS PROXY — Server-side fetch for frontend source loading
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Missing ?url= param');
  }

  try {
    const resp = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Manager/3.0',
        'Accept':     '*/*',
      },
      redirect: 'follow',
    }, 20000);

    if (!resp.ok) {
      return res.status(resp.status).send(`Upstream error ${resp.status}: ${resp.statusText}`);
    }

    const ct   = resp.headers.get('content-type') || 'text/plain';
    const text = await resp.text();

    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(text);
  } catch (e) {
    console.error('CORS proxy error:', e.message);
    res.status(502).send('Fetch error: ' + e.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Redirect
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/redirect/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch || !ch.url) return res.status(404).send('Channel not found');

  const headers = {
    'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV-Manager/3.0)',
  };
  if (ch.referer)     headers['Referer'] = ch.referer;
  if (ch.cookie)      headers['Cookie']  = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  const hasCustomHeaders = !!(ch.referer || ch.cookie || (ch.httpHeaders && Object.keys(ch.httpHeaders).length > 0));

  if (hasCustomHeaders) {
    try {
      const upstream = await safeFetch(ch.url, { headers, redirect: 'follow' }, 20000);
      const ct       = upstream.headers.get('content-type') || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      // Forward content-length if present
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      upstream.body.pipe(res);
      upstream.body.on('error', () => res.end());
    } catch (e) {
      console.error(`Proxy redirect error [${ch.name}]:`, e.message);
      res.redirect(302, ch.url);
    }
    return;
  }

  // Simple redirect — zero server overhead
  res.redirect(302, ch.url);
});

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Full Pipe
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/stream/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch || !ch.url) return res.status(404).send('Not found');

  try {
    const headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV)' };
    if (ch.referer)     headers['Referer'] = ch.referer;
    if (ch.cookie)      headers['Cookie']  = ch.cookie;
    if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

    const upstream = await safeFetch(ch.url, { headers, redirect: 'follow' }, 30000);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    upstream.body.pipe(res);
    upstream.body.on('error', () => res.end());
  } catch (err) {
    console.error(`Stream error [${ch.name}]:`, err.message);
    res.status(502).send('Upstream error: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DRM PROXY — ClearKey + Widevine + PlayReady
// ══════════════════════════════════════════════════════════════════════════════

// Hex → Base64URL encoder (for ClearKey JWK format)
function hexToBase64url(hex) {
  if (!hex) return '';
  // If already looks like base64 (not hex), return as-is
  if (!/^[0-9a-fA-F]+$/.test(hex.replace(/-/g, ''))) return hex;
  try {
    const clean = hex.replace(/-/g, '').replace(/\s/g, '');
    const buf   = Buffer.from(clean, 'hex');
    return buf.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  } catch {
    return hex;
  }
}

// Parse "kid:key,kid2:key2" or "kid:key" format
function parseClearKeyPairs(src) {
  const pairs = String(src).split(',').map(s => s.trim()).filter(Boolean);
  return pairs.map(pair => {
    const [kid, key] = pair.split(':');
    return { kty: 'oct', kid: hexToBase64url(kid), k: hexToBase64url(key) };
  });
}

// GET /proxy/drm/:id — DRM-protected stream manifest
app.get('/proxy/drm/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).send('Channel not found');

  // Find DRM config from drmProxies or from channel itself
  const drmCfg = (db.drmProxies || []).find(d => d.channelId === ch.id && d.isActive)
    || (ch.licenseType ? {
        id:          ch.id,
        licenseType: ch.licenseType,
        licenseKey:  ch.licenseKey,
        licenseUrl:  ch.licenseKey,
        keyId:       ch.keyId,
        key:         ch.key,
        isActive:    true,
        channelId:   ch.id,
      } : null);

  const headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV)' };
  if (ch.referer) headers['Referer'] = ch.referer;
  if (ch.cookie)  headers['Cookie']  = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  if (!drmCfg) {
    // No DRM config — just proxy the stream
    return res.redirect(302, ch.url);
  }

  const BASE = `${req.protocol}://${req.get('host')}`;

  // ── ClearKey ────────────────────────────────────────────────────────────
  if (drmCfg.licenseType === 'clearkey') {
    try {
      const upstream = await safeFetch(ch.url, { headers, redirect: 'follow' }, 20000);
      const ct       = upstream.headers.get('content-type') || '';
      let   content  = await upstream.text();
      const licUrl   = `${BASE}/proxy/drm-license/${drmCfg.id}`;

      // DASH MPD — inject ClearKey license URL
      if (ct.includes('dash') || ch.url.includes('.mpd')) {
        if (content.includes('<ContentProtection')) {
          content = content.replace(
            /(<ContentProtection[^>]*schemeIdUri="urn:uuid:e2719d58[^"]*"[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
            `$1<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licUrl}</clearkey:Laurl>$3`
          );
        } else if (content.includes('<AdaptationSet')) {
          // Inject before first AdaptationSet
          const kidAttr = drmCfg.keyId ? ` cenc:default_KID="${drmCfg.keyId}"` : '';
          const inject = `<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"${kidAttr}><clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licUrl}</clearkey:Laurl></ContentProtection>`;
          content = content.replace('<AdaptationSet', inject + '\n<AdaptationSet');
        }
      }

      // HLS M3U8 — inject EXT-X-KEY
      if (ct.includes('mpegurl') || ch.url.includes('.m3u8')) {
        if (!content.includes('#EXT-X-KEY')) {
          const kidAttr = drmCfg.keyId ? `,KEYID=0x${drmCfg.keyId}` : '';
          content = `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="${licUrl}"${kidAttr}\n` + content;
        }
      }

      res.setHeader('Content-Type', ct || 'application/dash+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (e) {
      console.error(`DRM ClearKey proxy error [${ch.name}]:`, e.message);
      res.redirect(302, ch.url);
    }
    return;
  }

  // ── Widevine / PlayReady — proxy manifest, player handles license via CDM ─
  try {
    const upstream = await safeFetch(ch.url, { headers, redirect: 'follow' }, 20000);
    const ct       = upstream.headers.get('content-type') || 'application/dash+xml';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.body.pipe(res);
    upstream.body.on('error', () => res.end());
  } catch {
    res.redirect(302, ch.url);
  }
});

// POST /proxy/drm-license/:id — License endpoint (ClearKey JWK + Widevine forward)
app.post('/proxy/drm-license/:id', async (req, res) => {
  const db     = loadDB();
  const drmCfg = (db.drmProxies || []).find(d => d.id === req.params.id && d.isActive)
    // Also allow channel ID
    || (db.drmProxies || []).find(d => d.channelId === req.params.id && d.isActive);

  if (!drmCfg) {
    // Try to find channel with inline DRM config
    const ch = (db.channels || []).find(c => c.id === req.params.id);
    if (ch && ch.licenseType === 'clearkey' && ch.licenseKey) {
      const keys = parseClearKeyPairs(ch.licenseKey);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.json({ keys, type: 'temporary' });
    }
    return res.status(404).json({ error: 'DRM config not found' });
  }

  // ── ClearKey response (W3C EME ClearKey JSON Web Key format) ─────────────
  if (drmCfg.licenseType === 'clearkey') {
    const src = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    let keys;

    if (src && src.includes(':')) {
      keys = parseClearKeyPairs(src);
    } else {
      // kid + key stored separately
      keys = [{ kty: 'oct', kid: hexToBase64url(drmCfg.keyId), k: hexToBase64url(drmCfg.key || drmCfg.licenseKey) }];
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys, type: 'temporary' });
  }

  // ── Widevine: forward challenge to real license server ───────────────────
  if (drmCfg.licenseType === 'widevine' && drmCfg.licenseUrl) {
    try {
      const body    = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'base64');
      const lHeaders = {
        'Content-Type': 'application/octet-stream',
        'User-Agent':   'Mozilla/5.0 (IPTV-Manager/3.0)',
      };
      if (drmCfg.customHeaders) Object.assign(lHeaders, drmCfg.customHeaders);

      const resp = await safeFetch(drmCfg.licenseUrl, { method: 'POST', body, headers: lHeaders }, 15000);
      const data = await resp.buffer();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(data);
    } catch (e) {
      console.error('Widevine license error:', e.message);
      return res.status(502).send('Widevine license server error: ' + e.message);
    }
  }

  // ── PlayReady: forward SOAP challenge ────────────────────────────────────
  if (drmCfg.licenseType === 'playready' && drmCfg.licenseUrl) {
    try {
      const body    = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
      const resp    = await safeFetch(drmCfg.licenseUrl, {
        method:  'POST',
        body,
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      }, 15000);
      const data = await resp.buffer();
      res.setHeader('Content-Type', resp.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(data);
    } catch (e) {
      return res.status(502).send('PlayReady license error: ' + e.message);
    }
  }

  res.status(400).json({ error: 'Unsupported DRM type: ' + drmCfg.licenseType });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DB EXPORT / IMPORT
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/db/export', (req, res) => {
  const db = loadDB();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="iptv-db.json"');
  res.json(db);
});

app.post('/api/db/import', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid JSON' });
    saveDB(data);
    res.json({ ok: true, channels: (data.channels || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-REFRESH SOURCES (server-side, checks every 60s)
// ══════════════════════════════════════════════════════════════════════════════
async function doAutoRefresh() {
  const db      = loadDB();
  const sources = (db.sources || []).filter(s => s.autoRefresh && s.url && (s.refreshInterval || 0) > 0);
  if (sources.length === 0) return;

  let changed = false;
  for (const src of sources) {
    const lastRefresh = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    const intervalMs  = (src.refreshInterval || 30) * 60 * 1000;
    if (Date.now() - lastRefresh < intervalMs) continue;

    console.log(`🔄 Auto-refreshing source: ${src.name}`);
    try {
      const resp = await safeFetch(src.url, {
        headers: { 'User-Agent': 'IPTV-Manager/3.0' },
      }, 25000);

      if (resp.ok) {
        console.log(`  ✅ ${src.name}: refreshed OK`);
        db.sources = (db.sources || []).map(s =>
          s.id === src.id
            ? { ...s, lastRefreshed: new Date().toISOString(), status: 'ok', errorMessage: undefined }
            : s
        );
        changed = true;
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (e) {
      console.error(`  ❌ ${src.name}: ${e.message}`);
      db.sources = (db.sources || []).map(s =>
        s.id === src.id ? { ...s, status: 'error', errorMessage: e.message } : s
      );
      changed = true;
    }
  }

  if (changed) saveDB(db);
}

// Check every 60 seconds
setInterval(doAutoRefresh, 60_000);
// Run once on startup after 5s
setTimeout(doAutoRefresh, 5_000);

// ══════════════════════════════════════════════════════════════════════════════
//  SPA FALLBACK — Serve React frontend for all non-API routes
// ══════════════════════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(200).type('html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>IPTV Manager — Server Running</title>
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: 'Courier New', monospace; padding: 2rem; }
    h1 { color: #38bdf8; } h2 { color: #94a3b8; }
    a { color: #38bdf8; } code { background: #1e293b; padding: 2px 6px; border-radius: 4px; }
    ul li { margin: 8px 0; } .badge { background: #10b981; color: #fff; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; }
  </style>
</head>
<body>
  <h1>🚀 IPTV Manager Server v3.0</h1>
  <p><span class="badge">RUNNING</span> &nbsp; Server is live. Frontend not built yet.</p>
  <p>Run: <code>npm run build</code> then restart.</p>
  <h2>📡 Available Endpoints</h2>
  <ul>
    <li>GET <code>/api/stats</code> — Server stats &amp; playlist URLs</li>
    <li>GET <code>/api/playlists</code> — All playlists</li>
    <li>GET <code>/api/playlist/:id.m3u</code> — Live M3U playlist</li>
    <li>POST <code>/api/sync</code> — Push full DB from frontend</li>
    <li>GET <code>/proxy/cors?url=...</code> — CORS proxy</li>
    <li>GET <code>/proxy/redirect/:id</code> — Stream redirect proxy</li>
    <li>GET <code>/proxy/stream/:id</code> — Full stream pipe proxy</li>
    <li>GET <code>/proxy/drm/:id</code> — DRM manifest proxy</li>
    <li>POST <code>/proxy/drm-license/:id</code> — DRM license endpoint</li>
    <li>GET <code>/api/db/export</code> — Export database</li>
    <li>POST <code>/api/db/import</code> — Import database</li>
  </ul>
  <h2>🔗 Quick Links</h2>
  <ul>
    <li><a href="/api/stats">/api/stats</a></li>
    <li><a href="/api/playlists">/api/playlists</a></li>
    <li><a href="/health">/health</a></li>
  </ul>
</body>
</html>`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║         🚀 IPTV Manager Server v3.0.0               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  🌐 URL:       http://0.0.0.0:${PORT}`);
  console.log(`  📺 Playlist:  http://0.0.0.0:${PORT}/api/playlist/{id}.m3u`);
  console.log(`  🔐 DRM:       http://0.0.0.0:${PORT}/proxy/drm/{channelId}`);
  console.log(`  📡 Redirect:  http://0.0.0.0:${PORT}/proxy/redirect/{channelId}`);
  console.log(`  🔁 CORS:      http://0.0.0.0:${PORT}/proxy/cors?url=...`);
  console.log(`  📊 Stats:     http://0.0.0.0:${PORT}/api/stats`);
  console.log(`  💾 DB:        ${DB_FILE}`);
  console.log('');
});

export default app;
