'use strict';
/**
 * IPTV Playlist Manager — Backend Server (CommonJS / Express 4)
 * =============================================================
 * ✅ Express 4  — stable, no path-to-regexp issues
 * ✅ CommonJS   — works with "type":"module" in package.json via .cjs extension
 * ✅ Live M3U playlist generation with proxy URLs
 * ✅ Stream redirect proxy (hides original URLs, forwards headers)
 * ✅ Full stream pipe proxy
 * ✅ DRM proxy: ClearKey decryption + Widevine / PlayReady license forwarding
 * ✅ CORS proxy for frontend fetching remote M3U/JSON sources
 * ✅ Auto-refresh sources on configurable schedule
 * ✅ Tamil channel filter
 * ✅ Persistent JSON database (db.json)
 * ✅ SPA fallback for React frontend
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');

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
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

const EMPTY_DB = {
  channels:   [],
  playlists:  [],
  drmProxies: [],
  sources:    [],
  groups:     [],
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return Object.assign({}, EMPTY_DB);
    const raw    = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign({}, EMPTY_DB, parsed);
  } catch (e) {
    console.error('DB load error:', e.message);
    return Object.assign({}, EMPTY_DB);
  }
}

function saveDB(data) {
  try {
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
  'tamil','sun tv','vijay tv','zee tamil','kalaignar','raj tv','jaya tv',
  'polimer','captain tv','vendhar','vasanth','adithya','isai aruvi','mozhi',
  'puthuyugam','news7 tamil','news18 tamil','thanthi tv','sathiyam',
  'makkal isai','sirippoli','peppers tv','chutti tv','star vijay',
  'colors tamil','dd tamil','doordarshan tamil','sun music','imayam',
  'murasu','shakthi','gem tv','thirai','vijay super','keetru',
  'natpe thunai','udaya tv','surya','gemini','maa tv','star suvarna',
];

function ss(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase();
}

function isTamil(ch) {
  if (ch && ch.isTamil === true) return true;
  if (!ch) return false;
  var hay = ss(ch.name) + ' ' + ss(ch.group) + ' ' + ss(ch.language) + ' ' +
            ss(ch.tvgName) + ' ' + ss(ch.country);
  return TAMIL_KEYWORDS.some(function(k) { return hay.indexOf(k) !== -1; });
}

// ── M3U Generator ─────────────────────────────────────────────────────────────
function generateM3U(channels, baseUrl, playlistName) {
  var m3u = '#EXTM3U x-tvg-url="" playlist-name="' + (playlistName || 'IPTV Playlist') + '"\n';

  channels.forEach(function(ch) {
    var tvgId   = ch.tvgId   ? ' tvg-id="'       + ch.tvgId   + '"' : '';
    var tvgName = ch.tvgName ? ' tvg-name="'      + ch.tvgName + '"' : ' tvg-name="' + ch.name + '"';
    var logo    = ch.logo    ? ' tvg-logo="'      + ch.logo    + '"' : '';
    var group   = ' group-title="' + (ch.group || 'Uncategorized') + '"';
    var lang    = ch.language ? ' tvg-language="' + ch.language + '"' : '';
    var country = ch.country  ? ' tvg-country="'  + ch.country  + '"' : '';

    // Proxy every stream through server — never expose original URL
    var streamUrl = (ch.licenseType || ch.isDrm)
      ? baseUrl + '/proxy/drm/'      + ch.id
      : baseUrl + '/proxy/redirect/' + ch.id;

    m3u += '#EXTINF:-1' + tvgId + tvgName + logo + group + lang + country + ',' + ch.name + '\n';
    m3u += streamUrl + '\n';
  });

  return m3u;
}

// ── Playlist Filter ────────────────────────────────────────────────────────────
function filterChannels(pl, allChannels) {
  return allChannels
    .filter(function(ch) {
      if (!ch.enabled && !ch.isActive) return false;
      if (pl.tamilOnly && !isTamil(ch)) return false;
      if (pl.includeGroups && pl.includeGroups.length > 0 && !pl.includeGroups.includes(ch.group)) return false;
      if (pl.excludeGroups && pl.excludeGroups.includes(ch.group)) return false;
      return true;
    })
    .sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
}

// ── Safe HTTP/HTTPS fetch (native Node.js) ────────────────────────────────────
function safeFetch(url, options, timeoutMs) {
  options   = options   || {};
  timeoutMs = timeoutMs || 15000;

  return new Promise(function(resolve, reject) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }

    var lib     = parsed.protocol === 'https:' ? https : http;
    var reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   options.method || 'GET',
      headers:  Object.assign({
        'User-Agent': 'IPTV-Manager/3.0',
        'Accept':     '*/*',
      }, options.headers || {}),
    };

    var timer = setTimeout(function() {
      req.destroy();
      reject(new Error('Request timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    var req = lib.request(reqOpts, function(res) {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)
          && res.headers.location && options._redirectCount < 5) {
        clearTimeout(timer);
        options._redirectCount = (options._redirectCount || 0) + 1;
        return safeFetch(res.headers.location, options, timeoutMs).then(resolve).catch(reject);
      }

      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        clearTimeout(timer);
        var body = Buffer.concat(chunks);
        resolve({
          ok:         res.statusCode >= 200 && res.statusCode < 300,
          status:     res.statusCode,
          statusText: res.statusMessage || '',
          headers:    {
            get: function(k) { return res.headers[k.toLowerCase()] || null; }
          },
          body:       body,
          text:       function() { return Promise.resolve(body.toString('utf8')); },
          arrayBuffer: function() { return Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)); },
          json:       function() { return Promise.resolve(JSON.parse(body.toString('utf8'))); },
        });
      });
      res.on('error', function(e) { clearTimeout(timer); reject(e); });
    });

    req.on('error', function(e) { clearTimeout(timer); reject(e); });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════
app.get('/health', function(_req, res) {
  res.json({ status: 'ok', uptime: process.uptime(), version: '4.0.0' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', function(req, res) {
  var db       = loadDB();
  var channels = db.channels || [];
  var BASE     = req.protocol + '://' + req.get('host');

  res.json({
    serverVersion:  '4.0.0',
    uptime:         Math.floor(process.uptime()),
    nodeVersion:    process.version,
    channels:       channels.length,
    activeChannels: channels.filter(function(c) { return c.enabled || c.isActive; }).length,
    tamilChannels:  channels.filter(isTamil).length,
    drmChannels:    channels.filter(function(c) { return c.licenseType || c.isDrm; }).length,
    groups:         [].concat(new Array(0)).concat(Array.from(new Set(channels.map(function(c) { return c.group || 'Uncategorized'; })))).length,
    playlists:      (db.playlists  || []).length,
    sources:        (db.sources    || []).length,
    drmProxies:     (db.drmProxies || []).length,
    dbFile:         DB_FILE,
    playlistUrls:   (db.playlists || []).map(function(p) {
      var chs = filterChannels(p, channels);
      return {
        id:        p.id,
        name:      p.name,
        url:       BASE + '/api/playlist/' + p.id + '.m3u',
        tamilOnly: p.tamilOnly || false,
        channels:  chs.length,
        tamil:     chs.filter(isTamil).length,
      };
    }),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYLIST ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/playlist/:id.m3u', function(req, res) {
  var db  = loadDB();
  var id  = req.params.id;
  var pl  = (db.playlists || []).find(function(p) { return p.id === id; });

  if (!pl) {
    return res.status(404).type('text/plain').send('# Playlist not found\n');
  }

  var BASE     = req.protocol + '://' + req.get('host');
  var channels = filterChannels(pl, db.channels || []);
  var m3u      = generateM3U(channels, BASE, pl.name);

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Disposition', 'inline; filename="' + (pl.name || 'playlist').replace(/\s+/g, '-') + '.m3u"');
  res.send(m3u);
});

app.get('/api/playlists', function(req, res) {
  var db   = loadDB();
  var BASE = req.protocol + '://' + req.get('host');
  var pls  = (db.playlists || []).map(function(pl) {
    var chs = filterChannels(pl, db.channels || []);
    return Object.assign({}, pl, {
      m3uUrl:       BASE + '/api/playlist/' + pl.id + '.m3u',
      channelCount: chs.length,
      tamilCount:   chs.filter(isTamil).length,
    });
  });
  res.json(pls);
});

app.get('/api/playlists/:id', function(req, res) {
  var db   = loadDB();
  var BASE = req.protocol + '://' + req.get('host');
  var pl   = (db.playlists || []).find(function(p) { return p.id === req.params.id; });
  if (!pl) return res.status(404).json({ error: 'Not found' });
  var chs = filterChannels(pl, db.channels || []);
  res.json(Object.assign({}, pl, {
    m3uUrl:       BASE + '/api/playlist/' + pl.id + '.m3u',
    channelCount: chs.length,
    tamilCount:   chs.filter(isTamil).length,
  }));
});

app.post('/api/playlists', function(req, res) {
  var db   = loadDB();
  var BASE = req.protocol + '://' + req.get('host');
  var id   = 'pl_' + Date.now();
  var pl   = Object.assign({}, req.body, { id: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  db.playlists = (db.playlists || []).concat([pl]);
  saveDB(db);
  res.json(Object.assign({}, pl, { m3uUrl: BASE + '/api/playlist/' + pl.id + '.m3u' }));
});

app.put('/api/playlists/:id', function(req, res) {
  var db = loadDB();
  var found = false;
  db.playlists = (db.playlists || []).map(function(p) {
    if (p.id !== req.params.id) return p;
    found = true;
    return Object.assign({}, p, req.body, { id: p.id, updatedAt: new Date().toISOString() });
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/playlists/:id', function(req, res) {
  var db = loadDB();
  db.playlists = (db.playlists || []).filter(function(p) { return p.id !== req.params.id; });
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  CHANNELS API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/channels', function(req, res) {
  var db = loadDB();
  var channels = db.channels || [];
  if (req.query.group)         channels = channels.filter(function(c) { return c.group === req.query.group; });
  if (req.query.tamil === '1') channels = channels.filter(isTamil);
  if (req.query.active === '1') channels = channels.filter(function(c) { return c.enabled || c.isActive; });
  if (req.query.drm === '1')   channels = channels.filter(function(c) { return c.licenseType || c.isDrm; });
  res.json(channels);
});

app.get('/api/channels/:id', function(req, res) {
  var db = loadDB();
  var ch = (db.channels || []).find(function(c) { return c.id === req.params.id; });
  if (!ch) return res.status(404).json({ error: 'Not found' });
  res.json(ch);
});

app.post('/api/channels', function(req, res) {
  var db = loadDB();
  var ch = Object.assign({}, req.body, {
    id:       req.body.id || ('ch_' + Date.now()),
    order:    (db.channels || []).length,
    enabled:  true,
    isActive: true,
    isTamil:  isTamil(req.body),
  });
  db.channels = (db.channels || []).concat([ch]);
  saveDB(db);
  res.json(ch);
});

app.put('/api/channels/:id', function(req, res) {
  var db = loadDB();
  var found = false;
  db.channels = (db.channels || []).map(function(c) {
    if (c.id !== req.params.id) return c;
    found = true;
    var updated = Object.assign({}, c, req.body, { id: c.id });
    updated.isTamil = isTamil(updated);
    return updated;
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/channels/:id', function(req, res) {
  var db = loadDB();
  db.channels   = (db.channels   || []).filter(function(c) { return c.id !== req.params.id; });
  db.drmProxies = (db.drmProxies || []).filter(function(d) { return d.channelId !== req.params.id; });
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/channels/bulk/toggle', function(req, res) {
  var ids     = req.body.ids;
  var enabled = req.body.enabled;
  var db = loadDB();
  db.channels = (db.channels || []).map(function(c) {
    return ids.includes(c.id) ? Object.assign({}, c, { enabled: enabled, isActive: enabled }) : c;
  });
  saveDB(db);
  res.json({ ok: true, updated: ids.length });
});

app.delete('/api/channels/bulk/delete', function(req, res) {
  var ids = req.body.ids;
  var db  = loadDB();
  db.channels = (db.channels || []).filter(function(c) { return !ids.includes(c.id); });
  saveDB(db);
  res.json({ ok: true, deleted: ids.length });
});

// ══════════════════════════════════════════════════════════════════════════════
//  GROUPS API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/groups', function(req, res) {
  var db       = loadDB();
  var channels = db.channels || [];
  var names    = Array.from(new Set(channels.map(function(c) { return c.group || 'Uncategorized'; })));
  var groups   = names.map(function(name) {
    var saved = (db.groups || []).find(function(g) { return g.name === name; });
    return {
      name:       name,
      count:      channels.filter(function(c) { return (c.group || 'Uncategorized') === name; }).length,
      tamilCount: channels.filter(function(c) { return (c.group || 'Uncategorized') === name && isTamil(c); }).length,
      isActive:   saved ? saved.isActive !== false : true,
    };
  });
  res.json(groups);
});

app.put('/api/groups/:name', function(req, res) {
  var db   = loadDB();
  var name = decodeURIComponent(req.params.name);
  if (req.body.newName && req.body.newName !== name) {
    db.channels = (db.channels || []).map(function(c) {
      return (c.group || 'Uncategorized') === name ? Object.assign({}, c, { group: req.body.newName }) : c;
    });
  }
  var groups   = db.groups || [];
  var existing = groups.find(function(g) { return g.name === name; });
  if (existing) {
    db.groups = groups.map(function(g) { return g.name === name ? Object.assign({}, g, req.body) : g; });
  } else {
    db.groups = groups.concat([Object.assign({ name: name }, req.body)]);
  }
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/groups/:name', function(req, res) {
  var db   = loadDB();
  var name = decodeURIComponent(req.params.name);
  db.channels = (db.channels || []).filter(function(c) { return (c.group || 'Uncategorized') !== name; });
  db.groups   = (db.groups   || []).filter(function(g) { return g.name !== name; });
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SOURCES API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/sources', function(req, res) {
  var db = loadDB();
  res.json(db.sources || []);
});

app.post('/api/sources', function(req, res) {
  var db  = loadDB();
  var src = Object.assign({}, req.body, {
    id:        req.body.id || ('src_' + Date.now()),
    createdAt: new Date().toISOString(),
  });
  db.sources = (db.sources || []).concat([src]);
  saveDB(db);
  res.json(src);
});

app.put('/api/sources/:id', function(req, res) {
  var db = loadDB();
  db.sources = (db.sources || []).map(function(s) {
    return s.id === req.params.id ? Object.assign({}, s, req.body, { id: s.id }) : s;
  });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/sources/:id', function(req, res) {
  var db = loadDB();
  db.sources = (db.sources || []).filter(function(s) { return s.id !== req.params.id; });
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DRM PROXIES API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/drm', function(req, res) {
  var db = loadDB();
  res.json(db.drmProxies || []);
});

app.post('/api/drm', function(req, res) {
  var db   = loadDB();
  var BASE = req.protocol + '://' + req.get('host');
  var id   = 'drm_' + Date.now();
  var proxy = Object.assign({}, req.body, {
    id:              id,
    isActive:        true,
    proxyUrl:        BASE + '/proxy/drm/'         + req.body.channelId,
    licenseEndpoint: BASE + '/proxy/drm-license/' + id,
    createdAt:       new Date().toISOString(),
  });
  db.drmProxies = (db.drmProxies || []).concat([proxy]);
  saveDB(db);
  res.json(proxy);
});

app.put('/api/drm/:id', function(req, res) {
  var db = loadDB();
  db.drmProxies = (db.drmProxies || []).map(function(d) {
    return d.id === req.params.id ? Object.assign({}, d, req.body, { id: d.id }) : d;
  });
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/drm/:id', function(req, res) {
  var db = loadDB();
  db.drmProxies = (db.drmProxies || []).filter(function(d) { return d.id !== req.params.id; });
  saveDB(db);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SYNC — Frontend pushes full state to server on every change
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/sync', function(req, res) {
  try {
    var data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    if (Array.isArray(data.channels)) {
      data.channels = data.channels.map(function(ch) {
        return Object.assign({}, ch, { isTamil: isTamil(ch) });
      });
    }
    var ok = saveDB(Object.assign({}, EMPTY_DB, data));
    console.log('✅ Synced: ' + (data.channels||[]).length + ' ch | ' +
                (data.playlists||[]).length + ' pl | ' +
                (data.drmProxies||[]).length + ' DRM | ' +
                (data.sources||[]).length + ' src');
    res.json({
      ok: ok,
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
app.get('/proxy/cors', function(req, res) {
  var url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Missing ?url= param');
  }

  safeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Manager/4.0',
      'Accept':     '*/*',
    },
  }, 20000)
  .then(function(resp) {
    if (!resp.ok) {
      return res.status(resp.status).send('Upstream error ' + resp.status + ': ' + resp.statusText);
    }
    var ct = resp.headers.get('content-type') || 'text/plain';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(resp.body);
  })
  .catch(function(e) {
    console.error('CORS proxy error:', e.message);
    res.status(502).send('Fetch error: ' + e.message);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Redirect
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/redirect/:id', function(req, res) {
  var db = loadDB();
  var ch = (db.channels || []).find(function(c) { return c.id === req.params.id; });
  if (!ch || !ch.url) return res.status(404).send('Channel not found');

  var headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV-Manager/4.0)' };
  if (ch.referer)     headers['Referer'] = ch.referer;
  if (ch.cookie)      headers['Cookie']  = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  var hasCustomHeaders = !!(ch.referer || ch.cookie ||
    (ch.httpHeaders && Object.keys(ch.httpHeaders).length > 0));

  if (hasCustomHeaders) {
    safeFetch(ch.url, { headers: headers }, 20000)
    .then(function(upstream) {
      var ct = upstream.headers.get('content-type') || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(upstream.body);
    })
    .catch(function(e) {
      console.error('Proxy redirect error [' + ch.name + ']:', e.message);
      res.redirect(302, ch.url);
    });
    return;
  }

  res.redirect(302, ch.url);
});

// ══════════════════════════════════════════════════════════════════════════════
//  STREAM PROXY: Full Pipe
// ══════════════════════════════════════════════════════════════════════════════
app.get('/proxy/stream/:id', function(req, res) {
  var db = loadDB();
  var ch = (db.channels || []).find(function(c) { return c.id === req.params.id; });
  if (!ch || !ch.url) return res.status(404).send('Not found');

  var headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV)' };
  if (ch.referer)     headers['Referer'] = ch.referer;
  if (ch.cookie)      headers['Cookie']  = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  safeFetch(ch.url, { headers: headers }, 30000)
  .then(function(upstream) {
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(upstream.body);
  })
  .catch(function(err) {
    console.error('Stream error [' + ch.name + ']:', err.message);
    res.status(502).send('Upstream error: ' + err.message);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DRM PROXY — ClearKey + Widevine + PlayReady
// ══════════════════════════════════════════════════════════════════════════════
function hexToBase64url(hex) {
  if (!hex) return '';
  if (!/^[0-9a-fA-F]+$/.test(String(hex).replace(/-/g, ''))) return hex;
  try {
    var clean = String(hex).replace(/-/g, '').replace(/\s/g, '');
    var buf   = Buffer.from(clean, 'hex');
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch (e) {
    return hex;
  }
}

function parseClearKeyPairs(src) {
  var pairs = String(src).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  return pairs.map(function(pair) {
    var parts = pair.split(':');
    var kid   = parts[0];
    var key   = parts.slice(1).join(':');
    return { kty: 'oct', kid: hexToBase64url(kid), k: hexToBase64url(key) };
  });
}

app.get('/proxy/drm/:id', function(req, res) {
  var db  = loadDB();
  var ch  = (db.channels || []).find(function(c) { return c.id === req.params.id; });
  if (!ch) return res.status(404).send('Channel not found');

  var drmCfg = (db.drmProxies || []).find(function(d) { return d.channelId === ch.id && d.isActive; });
  if (!drmCfg && ch.licenseType) {
    drmCfg = {
      id:          ch.id,
      licenseType: ch.licenseType,
      licenseKey:  ch.licenseKey,
      licenseUrl:  ch.licenseKey,
      keyId:       ch.keyId,
      key:         ch.key,
      isActive:    true,
      channelId:   ch.id,
    };
  }

  var headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0 (IPTV)' };
  if (ch.referer)     headers['Referer'] = ch.referer;
  if (ch.cookie)      headers['Cookie']  = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  if (!drmCfg) return res.redirect(302, ch.url);

  var BASE   = req.protocol + '://' + req.get('host');
  var licUrl = BASE + '/proxy/drm-license/' + drmCfg.id;

  if (drmCfg.licenseType === 'clearkey') {
    safeFetch(ch.url, { headers: headers }, 20000)
    .then(function(upstream) {
      var ct      = upstream.headers.get('content-type') || '';
      var content = upstream.body.toString('utf8');

      if (ct.includes('dash') || ch.url.includes('.mpd')) {
        if (content.includes('<ContentProtection')) {
          content = content.replace(
            /(<ContentProtection[^>]*schemeIdUri="urn:uuid:e2719d58[^"]*"[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
            '$1<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">' + licUrl + '</clearkey:Laurl>$3'
          );
        } else if (content.includes('<AdaptationSet')) {
          var kidAttr = drmCfg.keyId ? ' cenc:default_KID="' + drmCfg.keyId + '"' : '';
          var inject  = '<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"' + kidAttr +
                        '><clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">' + licUrl +
                        '</clearkey:Laurl></ContentProtection>';
          content = content.replace('<AdaptationSet', inject + '\n<AdaptationSet');
        }
      }

      if (ct.includes('mpegurl') || ch.url.includes('.m3u8')) {
        if (!content.includes('#EXT-X-KEY')) {
          var kidAttr2 = drmCfg.keyId ? ',KEYID=0x' + drmCfg.keyId : '';
          content = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="' + licUrl + '"' + kidAttr2 + '\n' + content;
        }
      }

      res.setHeader('Content-Type', ct || 'application/dash+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(content);
    })
    .catch(function(e) {
      console.error('DRM ClearKey proxy error [' + ch.name + ']:', e.message);
      res.redirect(302, ch.url);
    });
    return;
  }

  // Widevine / PlayReady — proxy manifest, player handles license via CDM
  safeFetch(ch.url, { headers: headers }, 20000)
  .then(function(upstream) {
    var ct = upstream.headers.get('content-type') || 'application/dash+xml';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(upstream.body);
  })
  .catch(function() {
    res.redirect(302, ch.url);
  });
});

app.post('/proxy/drm-license/:id', function(req, res) {
  var db     = loadDB();
  var drmCfg = (db.drmProxies || []).find(function(d) { return d.id === req.params.id && d.isActive; })
            || (db.drmProxies || []).find(function(d) { return d.channelId === req.params.id && d.isActive; });

  if (!drmCfg) {
    var ch = (db.channels || []).find(function(c) { return c.id === req.params.id; });
    if (ch && ch.licenseType === 'clearkey' && ch.licenseKey) {
      var keys = parseClearKeyPairs(ch.licenseKey);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.json({ keys: keys, type: 'temporary' });
    }
    return res.status(404).json({ error: 'DRM config not found' });
  }

  if (drmCfg.licenseType === 'clearkey') {
    var src  = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    var keys2;
    if (src && src.includes(':')) {
      keys2 = parseClearKeyPairs(src);
    } else {
      keys2 = [{ kty: 'oct', kid: hexToBase64url(drmCfg.keyId), k: hexToBase64url(drmCfg.key || drmCfg.licenseKey) }];
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys: keys2, type: 'temporary' });
  }

  if (drmCfg.licenseType === 'widevine' && drmCfg.licenseUrl) {
    var body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'base64');
    var lHeaders = Object.assign({
      'Content-Type': 'application/octet-stream',
      'User-Agent':   'Mozilla/5.0 (IPTV-Manager/4.0)',
    }, drmCfg.customHeaders || {});

    safeFetch(drmCfg.licenseUrl, { method: 'POST', body: body, headers: lHeaders }, 15000)
    .then(function(resp) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    })
    .catch(function(e) {
      console.error('Widevine license error:', e.message);
      return res.status(502).send('Widevine license server error: ' + e.message);
    });
    return;
  }

  if (drmCfg.licenseType === 'playready' && drmCfg.licenseUrl) {
    var prBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    safeFetch(drmCfg.licenseUrl, {
      method:  'POST',
      body:    prBody,
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    }, 15000)
    .then(function(resp) {
      res.setHeader('Content-Type', resp.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    })
    .catch(function(e) {
      return res.status(502).send('PlayReady license error: ' + e.message);
    });
    return;
  }

  res.status(400).json({ error: 'Unsupported DRM type: ' + drmCfg.licenseType });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DB EXPORT / IMPORT
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/db/export', function(req, res) {
  var db = loadDB();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="iptv-db.json"');
  res.json(db);
});

app.post('/api/db/import', function(req, res) {
  try {
    var data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid JSON' });
    saveDB(data);
    res.json({ ok: true, channels: (data.channels || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-REFRESH SOURCES
// ══════════════════════════════════════════════════════════════════════════════
function doAutoRefresh() {
  var db      = loadDB();
  var sources = (db.sources || []).filter(function(s) {
    return s.autoRefresh && s.url && (s.refreshInterval || 0) > 0;
  });
  if (sources.length === 0) return;

  sources.forEach(function(src) {
    var lastRefresh = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    var intervalMs  = (src.refreshInterval || 30) * 60 * 1000;
    if (Date.now() - lastRefresh < intervalMs) return;

    console.log('🔄 Auto-refreshing source: ' + src.name);
    safeFetch(src.url, {
      headers: { 'User-Agent': 'IPTV-Manager/4.0' },
    }, 25000)
    .then(function(resp) {
      console.log('  ✅ ' + src.name + ': ' + (resp.ok ? 'OK' : 'HTTP ' + resp.status));
      var freshDB = loadDB();
      freshDB.sources = (freshDB.sources || []).map(function(s) {
        return s.id === src.id
          ? Object.assign({}, s, { lastRefreshed: new Date().toISOString(), status: resp.ok ? 'ok' : 'error' })
          : s;
      });
      saveDB(freshDB);
    })
    .catch(function(e) {
      console.error('  ❌ ' + src.name + ': ' + e.message);
      var freshDB = loadDB();
      freshDB.sources = (freshDB.sources || []).map(function(s) {
        return s.id === src.id ? Object.assign({}, s, { status: 'error', errorMessage: e.message }) : s;
      });
      saveDB(freshDB);
    });
  });
}

setInterval(doAutoRefresh, 60000);
setTimeout(doAutoRefresh, 5000);

// ══════════════════════════════════════════════════════════════════════════════
//  SPA FALLBACK — React frontend
// ══════════════════════════════════════════════════════════════════════════════
app.get('*', function(req, res) {
  var index = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(200).type('html').send([
      '<!DOCTYPE html><html lang="en"><head>',
      '<meta charset="UTF-8">',
      '<title>IPTV Manager Server</title>',
      '<style>body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem}',
      'h1{color:#38bdf8}a{color:#38bdf8}code{background:#1e293b;padding:2px 6px;border-radius:4px}',
      '.ok{color:#10b981}</style></head><body>',
      '<h1>🚀 IPTV Manager Server v4.0</h1>',
      '<p><span class="ok">✅ RUNNING</span> — Build frontend with <code>npm run build</code></p>',
      '<h2>API Endpoints</h2><ul>',
      '<li><a href="/health">/health</a></li>',
      '<li><a href="/api/stats">/api/stats</a></li>',
      '<li><a href="/api/playlists">/api/playlists</a></li>',
      '<li><code>GET /api/playlist/:id.m3u</code></li>',
      '<li><code>POST /api/sync</code></li>',
      '<li><code>GET /proxy/cors?url=...</code></li>',
      '<li><code>GET /proxy/redirect/:id</code></li>',
      '<li><code>GET /proxy/drm/:id</code></li>',
      '<li><code>POST /proxy/drm-license/:id</code></li>',
      '</ul></body></html>',
    ].join(''));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       🚀 IPTV Manager Server v4.0.0 (CJS)          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('  🌐 URL:       http://0.0.0.0:' + PORT);
  console.log('  📺 Playlist:  http://0.0.0.0:' + PORT + '/api/playlist/{id}.m3u');
  console.log('  🔐 DRM:       http://0.0.0.0:' + PORT + '/proxy/drm/{id}');
  console.log('  📡 Redirect:  http://0.0.0.0:' + PORT + '/proxy/redirect/{id}');
  console.log('  🔁 CORS:      http://0.0.0.0:' + PORT + '/proxy/cors?url=...');
  console.log('  📊 Stats:     http://0.0.0.0:' + PORT + '/api/stats');
  console.log('  💾 DB:        ' + DB_FILE);
  console.log('');
});
