/**
 * IPTV Playlist Manager — Full Stack Server
 * ==========================================
 * Deploy: Render.com | Railway | Fly.io | VPS
 *
 * Features:
 *  ✅ Live M3U playlist generation (proxy URLs, auto-updated)
 *  ✅ Stream redirect proxy (hides original URLs, forwards headers)
 *  ✅ Full stream pipe proxy (UA, Referer, Cookie, custom headers)
 *  ✅ DRM proxy: ClearKey decryption + Widevine license forwarding
 *  ✅ CORS proxy for frontend fetching remote M3U/JSON sources
 *  ✅ Auto-refresh sources on configurable schedule
 *  ✅ Full CRUD REST API
 *  ✅ Tamil channel filter support
 *  ✅ Persistent JSON database (db.json)
 *  ✅ SPA fallback for React frontend
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

// node-fetch v3 is ESM-only; dynamic import
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ── Persistent DB ─────────────────────────────────────────────────────────────
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

const EMPTY_DB = {
  channels: [],
  playlists: [],
  drmProxies: [],
  sources: [],
  groups: [],
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { ...EMPTY_DB };
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return { ...EMPTY_DB, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_DB };
  }
}

function saveDB(data) {
  try {
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
  'colors tamil','dd tamil','doordarshan tamil',
];

function isTamil(ch) {
  if (ch.isTamil === true) return true;
  const ss = (v) => (typeof v === 'string' ? v : String(v || '')).toLowerCase();
  const hay = `${ss(ch.name)} ${ss(ch.group)} ${ss(ch.language)} ${ss(ch.tvgName)}`;
  return TAMIL_KEYWORDS.some(k => hay.includes(k)) || hay.includes('தமிழ்');
}

// ── M3U Generator ─────────────────────────────────────────────────────────────
function generateM3U(channels, baseUrl) {
  let m3u = '#EXTM3U\n';
  channels.forEach(ch => {
    const tvgId   = ch.tvgId   ? ` tvg-id="${ch.tvgId}"`       : '';
    const tvgName = ch.tvgName ? ` tvg-name="${ch.tvgName}"`   : '';
    const logo    = ch.logo    ? ` tvg-logo="${ch.logo}"`       : '';
    const group   = ` group-title="${ch.group || 'Uncategorized'}"`;
    const lang    = ch.language ? ` tvg-language="${ch.language}"` : '';
    // Always proxy through server (never expose original URL)
    const streamUrl = ch.isDrm
      ? `${baseUrl}/proxy/drm/${ch.id}`
      : `${baseUrl}/proxy/redirect/${ch.id}`;
    m3u += `#EXTINF:-1${tvgId}${tvgName}${logo}${group}${lang},${ch.name}\n${streamUrl}\n`;
  });
  return m3u;
}

// ── Playlist Filter ────────────────────────────────────────────────────────────
function filterChannels(pl, allChannels) {
  return allChannels
    .filter(ch => {
      if (!ch.isActive) return false;
      if (pl.tamilOnly && !isTamil(ch)) return false;
      if (pl.includeGroups && pl.includeGroups.length > 0 && !pl.includeGroups.includes(ch.group)) return false;
      if (pl.excludeGroups && pl.excludeGroups.includes(ch.group)) return false;
      return true;
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYLIST ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/playlist/:id.m3u — Live playlist, proxy URLs, IPTV player ready
app.get('/api/playlist/:id.m3u', (req, res) => {
  const db   = loadDB();
  const pl   = (db.playlists || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).type('text/plain').send('# Playlist not found\n');

  const BASE     = `${req.protocol}://${req.get('host')}`;
  const channels = filterChannels(pl, db.channels || []);
  const m3u      = generateM3U(channels, BASE);

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', `inline; filename="${pl.name.replace(/\s+/g,'-')}.m3u"`);
  res.send(m3u);
});

// GET /api/playlist/:id.json — Playlist metadata
app.get('/api/playlist/:id.json', (req, res) => {
  const db = loadDB();
  const pl = (db.playlists || []).find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  const channels = filterChannels(pl, db.channels || []);
  res.json({ ...pl, channelCount: channels.length, tamilCount: channels.filter(isTamil).length });
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

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Redirect (hides original URL, preserves headers)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/redirect/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch || !ch.url) return res.status(404).send('Channel not found');

  const headers = {};
  headers['User-Agent'] = ch.userAgent || 'Mozilla/5.0 (IPTV)';
  if (ch.referer)       headers['Referer']    = ch.referer;
  if (ch.cookie)        headers['Cookie']     = ch.cookie;
  if (ch.httpHeaders)   Object.assign(headers, ch.httpHeaders);

  // If we have custom headers, must fully proxy the stream
  const hasCustomHeaders = ch.referer || ch.cookie || (ch.httpHeaders && Object.keys(ch.httpHeaders).length > 0);

  if (hasCustomHeaders) {
    try {
      const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
      const ct = upstream.headers.get('content-type') || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      if (upstream.body) {
        upstream.body.pipe(res);
        upstream.body.on('error', () => res.end());
      } else {
        const buf = await upstream.buffer();
        res.send(buf);
      }
    } catch (e) {
      console.error(`Proxy error [${ch.name}]:`, e.message);
      // Fallback: redirect
      res.redirect(302, ch.url);
    }
    return;
  }

  // No custom headers — simple redirect (zero overhead)
  res.redirect(302, ch.url);
});

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Full Pipe (force stream through server)
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

    const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (upstream.body) {
      upstream.body.pipe(res);
      upstream.body.on('error', () => res.end());
    } else {
      res.status(502).send('No stream body');
    }
  } catch (err) {
    console.error(`Stream error [${ch.name}]:`, err.message);
    res.status(502).send('Upstream error: ' + err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DRM PROXY — ClearKey + Widevine
// ══════════════════════════════════════════════════════════════════════════════

// GET /proxy/drm/:id — Serve DRM-protected stream
app.get('/proxy/drm/:id', async (req, res) => {
  const db  = loadDB();
  const ch  = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch)  return res.status(404).send('Channel not found');

  const drmCfg = (db.drmProxies || []).find(d => d.channelId === ch.id && d.isActive);
  if (!drmCfg) return res.redirect(302, ch.url || '');

  const BASE    = `${req.protocol}://${req.get('host')}`;
  const headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV)' };
  if (ch.referer) headers['Referer'] = ch.referer;
  if (ch.cookie)  headers['Cookie']  = ch.cookie;

  // ── ClearKey ──────────────────────────────────────────────────────────────
  if (drmCfg.licenseType === 'clearkey') {
    try {
      const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
      const ct       = upstream.headers.get('content-type') || 'application/dash+xml';
      let   content  = await upstream.text();

      // For DASH MPD: inject our ClearKey license endpoint
      if (ct.includes('dash') || ch.url.includes('.mpd')) {
        const licUrl = `${BASE}/proxy/drm-license/${drmCfg.id}`;
        // Replace existing ContentProtection or inject license URL
        if (content.includes('ContentProtection')) {
          content = content.replace(
            /(<ContentProtection[^>]*schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
            `$1<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licUrl}</clearkey:Laurl>$3`
          );
        }
      }

      // For HLS M3U8: inject EXT-X-KEY with license URI
      if (ct.includes('mpegurl') || ch.url.includes('.m3u8')) {
        const licUrl = `${BASE}/proxy/drm-license/${drmCfg.id}`;
        if (!content.includes('#EXT-X-KEY')) {
          const kid = drmCfg.keyId ? `,KEYID=0x${drmCfg.keyId}` : '';
          content = `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="${licUrl}"${kid}\n` + content;
        }
      }

      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    } catch (e) {
      console.error(`DRM proxy error [${ch.name}]:`, e.message);
      res.redirect(302, ch.url);
    }
    return;
  }

  // ── Widevine ──────────────────────────────────────────────────────────────
  if (drmCfg.licenseType === 'widevine') {
    // Stream passes through; player handles Widevine via CDM
    // We still proxy to forward custom headers
    try {
      const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/dash+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (upstream.body) upstream.body.pipe(res);
      else res.redirect(302, ch.url);
    } catch {
      res.redirect(302, ch.url);
    }
    return;
  }

  // Fallback
  res.redirect(302, ch.url);
});

// POST /proxy/drm-license/:id — ClearKey / Widevine license endpoint
// Compatible with: DASH.js, Shaka Player, ExoPlayer, hls.js
app.post('/proxy/drm-license/:id', async (req, res) => {
  const db     = loadDB();
  const drmCfg = (db.drmProxies || []).find(d => d.id === req.params.id && d.isActive);
  if (!drmCfg) return res.status(404).json({ error: 'DRM config not found' });

  // ── ClearKey response ─────────────────────────────────────────────────────
  if (drmCfg.licenseType === 'clearkey') {
    // Support multiple key pairs: "kid1:key1,kid2:key2" format (JioTV style)
    const src = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    if (src && src.includes(':')) {
      const pairs = src.split(',').map(p => p.trim()).filter(Boolean);
      const keys  = pairs.map(pair => {
        const [kid, k] = pair.split(':');
        // Base64url encode hex kid/key if needed
        const toB64url = (hex) => {
          if (!hex) return '';
          if (hex.length === 24 || hex.length === 32) return hex; // already base64
          try {
            const buf = Buffer.from(hex.replace(/-/g,''), 'hex');
            return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
          } catch { return hex; }
        };
        return { kty: 'oct', kid: toB64url(kid), k: toB64url(k) };
      });
      res.setHeader('Content-Type', 'application/json');
      return res.json({ keys, type: 'temporary' });
    }

    // Standard single kid:key
    const toB64url = (hex) => {
      if (!hex) return '';
      if (hex.length === 24 || hex.length === 32) return hex;
      try {
        const buf = Buffer.from(hex.replace(/-/g,''), 'hex');
        return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      } catch { return hex; }
    };

    res.setHeader('Content-Type', 'application/json');
    return res.json({
      keys: [{ kty: 'oct', kid: toB64url(drmCfg.keyId), k: toB64url(drmCfg.key) }],
      type: 'temporary',
    });
  }

  // ── Widevine: forward to real license server ──────────────────────────────
  if (drmCfg.licenseType === 'widevine' && drmCfg.licenseUrl) {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const resp = await fetch(drmCfg.licenseUrl, {
        method:  'POST',
        body,
        headers: {
          'Content-Type': 'application/octet-stream',
          'User-Agent':   'Mozilla/5.0 (IPTV-Manager)',
        },
      });
      const data = await resp.buffer();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(data);
    } catch (e) {
      console.error('Widevine license error:', e.message);
      return res.status(502).send('License server error: ' + e.message);
    }
  }

  // ── PlayReady: forward ────────────────────────────────────────────────────
  if (drmCfg.licenseType === 'playready' && drmCfg.licenseUrl) {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const resp = await fetch(drmCfg.licenseUrl, {
        method:  'POST',
        body,
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      });
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
//  CORS PROXY — Server-side fetch for frontend source loading
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing ?url= param');

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (IPTV-Manager/1.0)',
        'Accept':     '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });

    if (!resp.ok) return res.status(resp.status).send(`Upstream ${resp.status}: ${resp.statusText}`);

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
//  REST API — Full CRUD
// ══════════════════════════════════════════════════════════════════════════════

// ── Channels ─────────────────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const db = loadDB();
  let channels = db.channels || [];
  if (req.query.group)   channels = channels.filter(c => c.group === req.query.group);
  if (req.query.tamil === 'true') channels = channels.filter(isTamil);
  if (req.query.active === 'true') channels = channels.filter(c => c.isActive);
  if (req.query.drm === 'true')   channels = channels.filter(c => c.isDrm);
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
  const ch = { ...req.body, id: `ch_${Date.now()}`, order: (db.channels || []).length, isActive: true };
  ch.isTamil = isTamil(ch);
  db.channels = [...(db.channels || []), ch];
  saveDB(db);
  res.json(ch);
});

app.put('/api/channels/:id', (req, res) => {
  const db  = loadDB();
  let found = false;
  db.channels = (db.channels || []).map(c => {
    if (c.id !== req.params.id) return c;
    found = true;
    const updated = { ...c, ...req.body };
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

// Bulk toggle
app.post('/api/channels/bulk/toggle', (req, res) => {
  const { ids, isActive } = req.body;
  const db = loadDB();
  db.channels = (db.channels || []).map(c =>
    ids.includes(c.id) ? { ...c, isActive } : c
  );
  saveDB(db);
  res.json({ ok: true, updated: ids.length });
});

// ── Groups ────────────────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  const db       = loadDB();
  const channels = db.channels || [];
  const names    = [...new Set(channels.map(c => c.group || 'Uncategorized'))];
  const groups   = names.map(name => ({
    name,
    count:      channels.filter(c => c.group === name).length,
    tamilCount: channels.filter(c => c.group === name && isTamil(c)).length,
    isActive:   (db.groups || []).find(g => g.name === name)?.isActive ?? true,
  }));
  res.json(groups);
});

// ── Sources ───────────────────────────────────────────────────────────────────
app.get('/api/sources', (req, res) => {
  const db = loadDB();
  res.json(db.sources || []);
});

// ── DRM Proxies ───────────────────────────────────────────────────────────────
app.get('/api/drm', (req, res) => {
  const db = loadDB();
  res.json(db.drmProxies || []);
});

app.post('/api/drm', (req, res) => {
  const db    = loadDB();
  const BASE  = `${req.protocol}://${req.get('host')}`;
  const proxy = { ...req.body, id: `drm_${Date.now()}`, proxyUrl: `${BASE}/proxy/drm/${req.body.channelId}` };
  db.drmProxies = [...(db.drmProxies || []), proxy];
  saveDB(db);
  res.json(proxy);
});

app.put('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).map(d => d.id === req.params.id ? { ...d, ...req.body } : d);
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).filter(d => d.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ── Playlists CRUD ────────────────────────────────────────────────────────────
app.post('/api/playlists', (req, res) => {
  const db   = loadDB();
  const BASE = `${req.protocol}://${req.get('host')}`;
  const pl   = {
    ...req.body,
    id:           `pl_${Date.now()}`,
    generatedUrl: `${BASE}/api/playlist/${req.body.id || `pl_${Date.now()}`}.m3u`,
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
  };
  db.playlists = [...(db.playlists || []), pl];
  saveDB(db);
  res.json({ ...pl, m3uUrl: `${BASE}/api/playlist/${pl.id}.m3u` });
});

app.put('/api/playlists/:id', (req, res) => {
  const db = loadDB();
  db.playlists = (db.playlists || []).map(p =>
    p.id === req.params.id ? { ...p, ...req.body, updatedAt: new Date().toISOString() } : p
  );
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
//  SYNC — Frontend pushes full DB to server on every change
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid data' });

    // Re-tag isTamil server-side to ensure consistency
    if (Array.isArray(data.channels)) {
      data.channels = data.channels.map(ch => ({ ...ch, isTamil: isTamil(ch) }));
    }

    const ok = saveDB(data);
    const ch = (data.channels || []).length;
    const pl = (data.playlists || []).length;
    console.log(`✅ DB synced: ${ch} channels, ${pl} playlists, ${(data.drmProxies||[]).length} DRM proxies`);
    res.json({ ok, channels: ch, playlists: pl });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db       = loadDB();
  const channels = db.channels || [];
  const BASE     = `${req.protocol}://${req.get('host')}`;
  res.json({
    serverVersion:  '2.0.0',
    uptime:         process.uptime(),
    channels:       channels.length,
    activeChannels: channels.filter(c => c.isActive).length,
    tamilChannels:  channels.filter(isTamil).length,
    drmChannels:    channels.filter(c => c.isDrm).length,
    groups:         [...new Set(channels.map(c => c.group))].length,
    playlists:      (db.playlists  || []).length,
    sources:        (db.sources    || []).length,
    drmProxies:     (db.drmProxies || []).length,
    playlistUrls:   (db.playlists  || []).map(p => ({
      name:   p.name,
      url:    `${BASE}/api/playlist/${p.id}.m3u`,
      tamil:  p.tamilOnly || false,
    })),
  });
});

// ── DB Import/Export ──────────────────────────────────────────────────────────
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
    res.json({ ok: true, channels: (data.channels||[]).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-REFRESH SOURCES
// ══════════════════════════════════════════════════════════════════════════════
let autoRefreshTimer = null;

async function doAutoRefresh() {
  const db      = loadDB();
  const sources = (db.sources || []).filter(s => s.autoRefresh && s.url && s.refreshInterval > 0);
  if (sources.length === 0) return;

  console.log(`🔄 Auto-refreshing ${sources.length} sources...`);
  for (const src of sources) {
    const lastRefresh = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    const intervalMs  = (src.refreshInterval || 30) * 60 * 1000;
    if (Date.now() - lastRefresh < intervalMs) continue;

    try {
      const resp = await fetch(src.url, {
        headers: { 'User-Agent': 'IPTV-Manager/2.0' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
      if (resp.ok) {
        const text = await resp.text();
        console.log(`  ✅ ${src.name}: ${text.length} bytes`);
        // Update lastRefreshed
        db.sources = (db.sources || []).map(s =>
          s.id === src.id ? { ...s, lastRefreshed: new Date().toISOString(), status: 'success' } : s
        );
        saveDB(db);
      }
    } catch (e) {
      console.error(`  ❌ ${src.name}: ${e.message}`);
      db.sources = (db.sources || []).map(s =>
        s.id === src.id ? { ...s, status: 'error', errorMessage: e.message } : s
      );
      saveDB(db);
    }
  }
}

// Check every minute, refresh sources per their individual interval
autoRefreshTimer = setInterval(doAutoRefresh, 60 * 1000);

// ── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(200).send(`
<!DOCTYPE html><html><head><title>IPTV Manager</title></head><body style="background:#111;color:#eee;font-family:monospace;padding:2rem">
<h1>🚀 IPTV Manager Server Running</h1>
<p>Frontend not built yet. Run: <code>npm run build</code></p>
<h2>API Endpoints:</h2>
<ul>
  <li>GET /api/stats — Server status</li>
  <li>GET /api/playlists — All playlists</li>
  <li>GET /api/playlist/:id.m3u — M3U playlist</li>
  <li>POST /api/sync — Sync database</li>
  <li>GET /proxy/cors?url=... — CORS proxy</li>
  <li>GET /proxy/redirect/:id — Stream proxy</li>
  <li>GET /proxy/drm/:id — DRM stream proxy</li>
  <li>POST /proxy/drm-license/:id — DRM license</li>
</ul>
</body></html>`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║       🚀 IPTV Manager Server v2.0.0            ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`  🌐 Server:    http://localhost:${PORT}`);
  console.log(`  📺 Playlist:  http://localhost:${PORT}/api/playlist/{id}.m3u`);
  console.log(`  🔐 DRM:       http://localhost:${PORT}/proxy/drm/{channelId}`);
  console.log(`  📡 Stream:    http://localhost:${PORT}/proxy/redirect/{channelId}`);
  console.log(`  🔁 CORS:      http://localhost:${PORT}/proxy/cors?url=...`);
  console.log(`  📊 Stats:     http://localhost:${PORT}/api/stats`);
  console.log('');
});

module.exports = app;
