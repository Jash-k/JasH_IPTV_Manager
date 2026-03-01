'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  JASH IPTV — Backend Server v17.0                                       ║
 * ║                                                                          ║
 * ║  Built-in MediaFlow-style proxy — no external service needed:           ║
 * ║                                                                          ║
 * ║  DASH+DRM Pipeline:                                                      ║
 * ║  Player → /proxy/mpd/:id  → fetch MPD → convert to HLS master          ║
 * ║         → /proxy/playlist/:id/:repId.m3u8 → HLS media playlist         ║
 * ║         → /proxy/init/:id?u=  → fetch+decrypt init segment             ║
 * ║         → /proxy/seg/:id?u=   → fetch+decrypt media segment            ║
 * ║                                                                          ║
 * ║  HLS Pipeline:                                                           ║
 * ║  Player → /proxy/hls/:id  → fetch M3U8 → rewrite segment URLs          ║
 * ║         → /proxy/seg/:id?u=  → proxy segment with auth headers         ║
 * ║                                                                          ║
 * ║  Stremio: /manifest.json + /catalog + /meta + /stream                  ║
 * ║  IPTV:    /p.m3u  /drm-playlist.m3u  /proxy/playlist.m3u              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const urlMod  = require('url');
const { decryptSegment, processInitSegment } = require('./drm/mp4decrypt');
const { parseMPD, buildHlsMaster, buildHlsMediaPlaylist } = require('./drm/mpdToHls');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '7000', 10);
const DEBUG       = process.env.DEBUG === 'true';
const PUBLIC_URL  = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR    = path.join(__dirname, '..', 'dist');
const CFG_FILE    = path.join(__dirname, 'streams-config.json');
const REQ_TIMEOUT = 20000;
const CACHE_TTL   = 5 * 60 * 1000;

// ─── Addon Identity ───────────────────────────────────────────────────────────
const ADDON_ID   = process.env.ADDON_ID   || 'community.jash-iptv';
const ADDON_NAME = process.env.ADDON_NAME || 'Jash IPTV';
const VER_BASE   = '1.0';

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}][DBG]`, ...a);
const err   = (...a) => console.error(`[${ts()}][ERR]`, ...a);

// ─── Caches ───────────────────────────────────────────────────────────────────
const hlsCache  = new Map(); // url → { v, ts }
const mpdCache  = new Map(); // channelId → { profiles, isLive, ts }
const initCache = new Map(); // initUrl+kid → decrypted Buffer

function getCached(map, k) {
  const c = map.get(k);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.v;
  map.delete(k); return null;
}
function setCache(map, k, v) { map.set(k, { v, ts: Date.now() }); }

// ─── ID Helpers ───────────────────────────────────────────────────────────────
const encodeId = s => Buffer.from(String(s), 'utf8').toString('base64url');
const decodeId = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } };

// ─── Default UA ───────────────────────────────────────────────────────────────
const SAMSUNG_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36';
const JIOTV_UA   = 'plaYtv/7.1.3 (Linux;Android 13) ygx/69.1 ExoPlayerLib/824.0';

// ─── Channel Registry ─────────────────────────────────────────────────────────
// channelId → { url, kid, key, cookie, userAgent, referer, name, logo, group }
const channelReg = new Map();

function registerChannel(stream) {
  if (!stream.url) return null;
  const id = stream.tvgId || stream.id || encodeId(stream.url).slice(0, 20);
  const [kid, key] = (stream.licenseKey || '').split(':');
  channelReg.set(String(id), {
    id, name: stream.name || 'Unknown', logo: stream.logo || '',
    url: stream.url, group: stream.group || 'Uncategorized',
    kid: (kid || '').trim().toLowerCase(),
    key: (key || '').trim().toLowerCase(),
    cookie: stream.cookie || '',
    userAgent: stream.userAgent || JIOTV_UA,
    referer: stream.referer || 'https://www.jiotv.com/',
  });
  return String(id);
}

function decodeChannelPayload(encodedId) {
  try {
    const b64    = encodedId.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch { return null; }
}

function resolveChannel(id) {
  if (channelReg.has(id)) return channelReg.get(id);
  const payload = decodeChannelPayload(id);
  if (payload && payload.url) {
    const ch = {
      id, name: payload.name || 'Stream', logo: payload.logo || '',
      url: payload.url, group: payload.group || '',
      kid: (payload.kid || '').trim().toLowerCase(),
      key: (payload.key || '').trim().toLowerCase(),
      cookie: payload.cookie || '',
      userAgent: payload.userAgent || JIOTV_UA,
      referer: payload.referer || 'https://www.jiotv.com/',
    };
    channelReg.set(id, ch);
    return ch;
  }
  return null;
}

// ─── HTTP Fetch (direct, no proxy) ────────────────────────────────────────────
function fetchUrl(url, customHeaders, redirects, returnBuffer) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new urlMod.URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    const lib     = parsed.protocol === 'https:' ? https : http;
    const timer   = setTimeout(() => reject(new Error('Request timeout')), REQ_TIMEOUT);
    const headers = {
      'User-Agent'   : customHeaders?.['User-Agent']    || SAMSUNG_UA,
      'Accept'       : customHeaders?.['Accept']        || '*/*',
      'Cache-Control': 'no-cache',
      ...customHeaders,
    };
    const req = lib.request({
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : 'GET', headers, timeout: REQ_TIMEOUT,
    }, res => {
      clearTimeout(timer);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchUrl(new urlMod.URL(res.headers.location, url).href, customHeaders, redirects + 1, returnBuffer).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url.slice(0,80)}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end',  () => resolve({
        body: Buffer.concat(chunks),
        contentType: res.headers['content-type'] || '',
        statusCode: res.statusCode,
        headers: res.headers,
      }));
      res.on('error', reject);
    });
    req.on('error',   e => { clearTimeout(timer); reject(e); });
    req.on('timeout', () => { clearTimeout(timer); req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchText(url, headers) {
  const r = await fetchUrl(url, headers || {});
  return r.body.toString('utf8');
}

async function fetchBuf(url, headers) {
  const r = await fetchUrl(url, headers || {});
  return r.body;
}

function buildHeaders(ch) {
  const h = { 'User-Agent': ch.userAgent || JIOTV_UA };
  if (ch.cookie)  h['Cookie']  = ch.cookie;
  if (ch.referer) h['Referer'] = ch.referer;
  return h;
}

// ─── HTML Extraction ──────────────────────────────────────────────────────────
function htmlDecode(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
}
function extractFromHtml(html) {
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let m;
  while ((m = preRe.exec(html)) !== null) {
    const inner = htmlDecode(m[1].replace(/<[^>]+>/g,''));
    const t = inner.trimStart();
    if (t.startsWith('{') || t.startsWith('[') || t.includes('#EXTM3U') || t.includes('#EXTINF')) return inner;
  }
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(html)) !== null) {
    const inner = m[1].trim();
    const jm = inner.match(/(?:var\s+\w+|window\.\w+|\w+)\s*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;?\s*$/);
    if (jm) { try { JSON.parse(jm[1]); return jm[1]; } catch { /**/ } }
  }
  const bm = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bm) {
    const text = htmlDecode(bm[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    if (text.includes('#EXTM3U') || text.includes('#EXTINF')) return text;
    const j = text.search(/[\[{]/);
    if (j !== -1) { try { JSON.parse(text.slice(j)); return text.slice(j); } catch { /**/ } }
  }
  const stripped = htmlDecode(html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
  if (stripped.includes('#EXTM3U') || stripped.startsWith('[') || stripped.startsWith('{')) return stripped;
  return null;
}
function isHtml(ct, body) {
  if ((ct || '').toLowerCase().includes('text/html')) return true;
  const t = (body || '').trimStart().toLowerCase().slice(0, 50);
  return t.startsWith('<!doctype') || t.startsWith('<html');
}
async function smartFetch(url, headers) {
  const { body, contentType } = await fetchUrl(normalizeSourceUrl(url), headers || {});
  const bodyStr = body.toString('utf8');
  if (isHtml(contentType, bodyStr)) {
    const extracted = extractFromHtml(bodyStr);
    return extracted || bodyStr.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  }
  return bodyStr;
}

// ─── URL Normalizer ───────────────────────────────────────────────────────────
function normalizeSourceUrl(url) {
  if (!url) return url;
  let u = url.trim();
  const gh = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  const pb = u.match(/^https?:\/\/pastebin\.com\/(?!raw\/)([a-zA-Z0-9]+)$/);
  if (pb) return `https://pastebin.com/raw/${pb[1]}`;
  const gd = u.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gd) return `https://drive.google.com/uc?export=download&id=${gd[1]}`;
  if (u.includes('dropbox.com')) { u = u.replace(/[?&]dl=\d/g, ''); return u + (u.includes('?') ? '&dl=1' : '?dl=1'); }
  if (u.includes('onedrive.live.com/redir')) return u.replace('/redir?', '/download?');
  return u;
}

// ─── Config ───────────────────────────────────────────────────────────────────
function defaultSettings() {
  return { addonId: ADDON_ID, addonName: ADDON_NAME, combineMultiQuality: true, sortAlphabetically: true };
}
function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) return { streams:[], groups:[], settings: defaultSettings() };
    const raw = fs.readFileSync(CFG_FILE,'utf8').trim();
    if (!raw || raw==='{}'||raw==='[]') return { streams:[], groups:[], settings: defaultSettings() };
    const cfg = JSON.parse(raw);
    return { streams: Array.isArray(cfg.streams)?cfg.streams:[], groups: Array.isArray(cfg.groups)?cfg.groups:[], sources: Array.isArray(cfg.sources)?cfg.sources:[], settings: { ...defaultSettings(), ...(cfg.settings||{}) } };
  } catch(e) { err('loadConfig:', e.message); return { streams:[], groups:[], settings: defaultSettings() }; }
}
function getSettings() { return { ...defaultSettings(), ...(loadConfig().settings||{}) }; }
function getEnabledStreams() {
  const { streams, settings } = loadConfig();
  const enabled = streams.filter(s => s.enabled !== false);
  if (settings.sortAlphabetically !== false) {
    return [...enabled].sort((a,b) => {
      const ga=(a.group||'Uncategorized').toLowerCase(), gb=(b.group||'Uncategorized').toLowerCase();
      if (ga!==gb) return ga<gb?-1:1;
      return (a.name||'').toLowerCase().localeCompare((b.name||'').toLowerCase());
    });
  }
  return [...enabled].sort((a,b)=>(a.order??9999)-(b.order??9999));
}
function getGroups() {
  const { groups: stored, settings } = loadConfig();
  const streams = getEnabledStreams();
  const names   = [...new Set(streams.map(s=>s.group||'Uncategorized'))];
  if (settings.sortAlphabetically!==false) names.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
  const storedMap = new Map(stored.map(g=>[g.name,g]));
  return names.map((name,i)=>({ id: storedMap.get(name)?.id||`grp_${i}`, name, enabled: storedMap.get(name)?.enabled!==false })).filter(g=>g.enabled);
}
function getVersion() {
  try { if (fs.existsSync(CFG_FILE)) return `${VER_BASE}.${Math.floor(fs.statSync(CFG_FILE).mtimeMs/1000)%100000}`; } catch {}
  return `${VER_BASE}.0`;
}
function rebuildRegistry() {
  channelReg.clear();
  for (const s of loadConfig().streams) registerChannel(s);
  log(`[REG] ${channelReg.size} channels registered`);
}

// ─── Stream Type Detection ────────────────────────────────────────────────────
function detectType(s) {
  if (s.streamType) return s.streamType;
  const u = (s.url||'').toLowerCase();
  if (u.includes('.mpd')||u.includes('/dash/')||u.includes('format=mpd')) return 'dash';
  if (u.includes('.m3u8')||u.includes('/hls/')||u.includes('index.m3u')) return 'hls';
  return 'direct';
}
function hasDRM(s) { return !!(s.licenseType||s.licenseKey||s.kid); }

// ─── Auto-Combine ─────────────────────────────────────────────────────────────
const STRIP_TOKENS = new Set(['hd','sd','fhd','uhd','4k','2k','8k','1080p','720p','480p','360p','2160p','vip','plus','premium','backup','mirror','alt','usa','uk','us','ca','au','live','stream','online','channel']);
function normalizeKey(name) {
  return (name||'').toLowerCase().replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g,' ').replace(/[-_\/\\|:]+/g,' ').replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>0&&!STRIP_TOKENS.has(w)).join(' ').trim();
}
function buildAutoCombined(streams) {
  const map = new Map();
  for (const s of streams) {
    const key = normalizeKey(s.name); if (!key) continue;
    if (!map.has(key)) map.set(key, { name: s.name, streams:[], sourceIds: new Set() });
    const e = map.get(key); e.streams.push(s); e.sourceIds.add(s.sourceId||'unknown');
    if ((s.name||'').length < (e.name||'').length) e.name = s.name;
  }
  return [...map.entries()].filter(([,e])=>e.sourceIds.size>=2).map(([key,e])=>({ key, name:e.name, streams:e.streams, sourceCount:e.sourceIds.size })).sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// ─── HLS Extraction (Samsung middle-quality fix) ──────────────────────────────
async function extractHLS(url, hdrs) {
  let txt;
  try { txt = await fetchText(url, hdrs); } catch(e) { return null; }
  if (!txt||(!txt.includes('#EXTM3U')&&!txt.includes('#EXT-X-'))) return null;
  const lines = txt.split('\n').map(l=>l.trim()).filter(Boolean);
  if (lines.some(l=>l.includes('#EXT-X-STREAM-INF'))) {
    const variants = [];
    for (let i=0;i<lines.length;i++) {
      if (!lines[i].includes('#EXT-X-STREAM-INF')) continue;
      const bw=(lines[i].match(/BANDWIDTH=(\d+)/)||[])[1];
      for (let j=i+1;j<lines.length;j++) {
        if (!lines[j].startsWith('#')) {
          let u=lines[j]; if(!u.startsWith('http')) u=url.substring(0,url.lastIndexOf('/')+1)+u;
          variants.push({ url:u, bw: bw?parseInt(bw):0 }); break;
        }
      }
    }
    if (!variants.length) return null;
    variants.sort((a,b)=>b.bw-a.bw);
    return variants[Math.floor(variants.length/2)].url;
  }
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (/\.(ts|m4s|m3u8|mp4)(\?|$)/i.test(line)||line.startsWith('http')) {
      let u=line; if(!u.startsWith('http')) u=url.substring(0,url.lastIndexOf('/')+1)+u;
      return u;
    }
  }
  return null;
}

// ─── M3U Rewriter (HLS Proxy) ─────────────────────────────────────────────────
function rewriteM3U8(content, originalUrl, proxyBase, channelId) {
  const lines = content.split('\n');
  const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  const result  = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { result.push(''); continue; }

    // Rewrite URI= in tags
    if (line.startsWith('#') && line.includes('URI="')) {
      const rewritten = line.replace(/URI="([^"]+)"/g, (_, u) => {
        const abs = /^https?:\/\//i.test(u) ? u : (u.startsWith('/') ? new urlMod.URL(u, originalUrl).href : baseUrl + u);
        return `URI="${proxyBase}/proxy/seg/${channelId}?u=${encodeURIComponent(abs)}"`;
      });
      result.push(rewritten);
      continue;
    }

    // Rewrite segment URLs
    if (!line.startsWith('#')) {
      const abs = /^https?:\/\//i.test(line) ? line : (line.startsWith('/') ? new urlMod.URL(line, originalUrl).href : baseUrl + line);
      result.push(`${proxyBase}/proxy/seg/${channelId}?u=${encodeURIComponent(abs)}`);
      continue;
    }

    result.push(line);
  }
  return result.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  BUILT-IN PROXY HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * /proxy/mpd/:id
 * Fetch DASH MPD → convert to HLS master playlist
 * Player gets a standard HLS master — no DASH support needed
 */
async function handleProxyMpd(req, res, channelId, query) {
  const ch = resolveChannel(channelId);
  if (!ch) { res.writeHead(404); return res.end('Channel not found'); }

  // Allow override URL/DRM via query params for direct use
  const url    = query.d ? decodeURIComponent(query.d) : ch.url;
  const keyId  = query.key_id || ch.kid  || '';
  const key    = query.key    || ch.key  || '';
  const hasDRM_  = !!(keyId && key);

  const hdrs = buildHeaders(ch);
  hdrs['Accept'] = 'application/dash+xml, */*';

  let mpdXml;
  try { mpdXml = await fetchText(url, hdrs); }
  catch(e) { res.writeHead(502); return res.end('MPD fetch failed: ' + e.message); }

  if (!mpdXml.includes('<MPD') && !mpdXml.includes('<?xml')) {
    res.writeHead(502); return res.end('Invalid MPD: not XML');
  }

  const { master, profiles } = buildHlsMaster(mpdXml, url, PUBLIC_URL, channelId, keyId, key);

  // Cache profiles for subsequent playlist requests
  setCache(mpdCache, channelId, { profiles, isLive: mpdXml.includes('type="dynamic"'), mpdUrl: url });

  debug(`[PROXY-MPD] ${ch.name} → ${profiles.length} profiles | DRM=${hasDRM_}`);

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  return res.end(master);
}

/**
 * /proxy/playlist/:id/:repId.m3u8
 * Return HLS media playlist for a specific representation
 */
async function handleProxyPlaylist(req, res, channelId, repId, query) {
  const ch      = resolveChannel(channelId);
  const keyId   = query.key_id || ch?.kid || '';
  const key     = query.key    || ch?.key || '';

  let cached = getCached(mpdCache, channelId);
  if (!cached && ch) {
    // Re-fetch MPD if not cached
    try {
      const hdrs  = buildHeaders(ch);
      const mpdXml = await fetchText(ch.url, hdrs);
      const parsed = parseMPD(mpdXml, ch.url);
      setCache(mpdCache, channelId, parsed);
      cached = parsed;
    } catch(e) { res.writeHead(502); return res.end('MPD re-fetch failed'); }
  }

  if (!cached) { res.writeHead(404); return res.end('MPD not cached — request /proxy/mpd/:id first'); }

  const profile = cached.profiles.find(p => p.id === repId);
  if (!profile)  { res.writeHead(404); return res.end(`Profile ${repId} not found`); }

  const playlist = buildHlsMediaPlaylist(profile, PUBLIC_URL, channelId, keyId, key, cached.isLive);

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  return res.end(playlist);
}

/**
 * /proxy/hls/:id
 * Fetch HLS M3U8 and rewrite all segment URLs through our proxy
 */
async function handleProxyHls(req, res, channelId, query) {
  const ch  = resolveChannel(channelId);
  const url = query.d ? decodeURIComponent(query.d) : ch?.url;
  if (!url) { res.writeHead(404); return res.end('No URL'); }

  const hdrs = ch ? buildHeaders(ch) : {};
  let content;
  try { content = await fetchText(url, hdrs); }
  catch(e) { res.writeHead(502); return res.end('HLS fetch failed: ' + e.message); }

  if (!content.includes('#EXTM3U') && !content.includes('#EXTINF')) {
    // Maybe it's a direct redirect to a segment — just proxy it
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
    return res.end(content);
  }

  const rewritten = rewriteM3U8(content, url, PUBLIC_URL, channelId);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  return res.end(rewritten);
}

/**
 * /proxy/init/:id
 * Fetch init segment (moov box), optionally decrypt, cache it
 */
async function handleProxyInit(req, res, channelId, query) {
  const ch    = resolveChannel(channelId);
  const url   = query.u ? decodeURIComponent(query.u) : ch?.url;
  const keyId = query.key_id || ch?.kid || '';
  const key   = query.key    || ch?.key || '';
  const hasDRM_ = !!(keyId && key);

  if (!url) { res.writeHead(400); return res.end('Missing ?u= init URL'); }

  const cacheKey = `${url}|${keyId}`;
  let initBuf = initCache.get(cacheKey);

  if (!initBuf) {
    const hdrs = ch ? buildHeaders(ch) : {};
    try { initBuf = await fetchBuf(url, hdrs); }
    catch(e) { res.writeHead(502); return res.end('Init fetch failed: ' + e.message); }

    if (hasDRM_) {
      try {
        initBuf = processInitSegment(initBuf, keyId, key);
        debug(`[INIT] Decrypted init for ${ch?.name||channelId}`);
      } catch(e) {
        err(`[INIT] Decrypt failed: ${e.message} — serving raw`);
      }
    }
    initCache.set(cacheKey, initBuf);
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': initBuf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  });
  return res.end(initBuf);
}

/**
 * /proxy/seg/:id
 * Fetch a segment, optionally decrypt using CENC decrypter, return bytes
 */
async function handleProxySeg(req, res, channelId, query) {
  const ch     = resolveChannel(channelId);
  const url    = query.u    ? decodeURIComponent(query.u)    : '';
  const initUrl= query.init ? decodeURIComponent(query.init) : '';
  const keyId  = query.key_id || ch?.kid || '';
  const key    = query.key    || ch?.key || '';
  const hasDRM_= !!(keyId && key);

  if (!url) { res.writeHead(400); return res.end('Missing ?u= segment URL'); }

  const hdrs = ch ? buildHeaders(ch) : {};

  try {
    // Fetch segment
    const segBuf = await fetchBuf(url, hdrs);

    if (hasDRM_) {
      // Get init segment (from cache or fetch)
      const initKey = `${initUrl}|${keyId}`;
      let initBuf   = initCache.get(initKey) || Buffer.alloc(0);

      if (!initBuf.length && initUrl) {
        try { initBuf = await fetchBuf(initUrl, hdrs); }
        catch(e) { debug(`[SEG] Init fetch failed: ${e.message}`); }
      }

      try {
        const decrypted = decryptSegment(initBuf, segBuf, keyId, key, false);
        debug(`[SEG] ✅ Decrypted ${segBuf.length} → ${decrypted.length} bytes`);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': decrypted.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        });
        return res.end(decrypted);
      } catch(decErr) {
        err(`[SEG] Decrypt failed: ${decErr.message} — serving raw`);
        // Fall through to serve raw
      }
    }

    // No DRM or decrypt failed — serve raw
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': segBuf.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    });
    return res.end(segBuf);
  } catch(e) {
    err(`[SEG] Fetch failed: ${e.message}`);
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Segment fetch failed: ' + e.message);
  }
}

/**
 * /proxy/stream/:id
 * Direct stream proxy — fetches and pipes with auth headers
 */
async function handleProxyStream(req, res, channelId, query) {
  const ch  = resolveChannel(channelId);
  const url = query.d ? decodeURIComponent(query.d) : ch?.url;
  if (!url) { res.writeHead(400); return res.end('Missing URL'); }

  const hdrs = ch ? buildHeaders(ch) : {};

  try {
    const { body, contentType, headers: resHdrs } = await fetchUrl(url, hdrs);
    res.writeHead(200, {
      'Content-Type': resHdrs['content-type'] || contentType || 'application/octet-stream',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(body);
  } catch(e) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Stream proxy failed: ' + e.message);
  }
}

// ─── Proxy Playlist URL builder ───────────────────────────────────────────────
function buildProxyUrl(s) {
  const type  = detectType(s);
  const isDRM = hasDRM(s);
  const id    = registerChannel(s) || encodeId(s.url).slice(0, 20);
  const kid   = (s.kid || (s.licenseKey||'').split(':')[0] || '').trim();
  const key   = (s.key || (s.licenseKey||'').split(':')[1] || '').trim();

  if (type === 'dash') {
    const base = `${PUBLIC_URL}/proxy/mpd/${id}`;
    return isDRM ? `${base}?key_id=${kid}&key=${key}` : base;
  }
  if (type === 'hls') {
    return `${PUBLIC_URL}/proxy/hls/${id}`;
  }
  return `${PUBLIC_URL}/proxy/stream/${id}`;
}

// ─── Stremio stream resolver ──────────────────────────────────────────────────
async function resolveVariants(variants, addonName) {
  const results = [];
  for (let i = 0; i < variants.length; i++) {
    const s     = variants[i];
    const type  = detectType(s);
    const isDRM_= hasDRM(s);
    const label = variants.length > 1 ? `[${i+1}/${variants.length}] ${s.name}` : (s.name || 'Live');

    if (type === 'dash' || isDRM_) {
      // Route through our built-in proxy — returns HLS for any player
      const proxyUrl = buildProxyUrl(s);
      results.push({
        url: proxyUrl, name: addonName,
        title: `🔴 ${label} ${isDRM_ ? '[🔐 Decrypted]' : '[DASH→HLS]'}`,
        behaviorHints: { notWebReady: false }, // HLS output is web-ready
      });
    } else if (type === 'hls') {
      let streamUrl = s.url;
      try {
        const cached = getCached(hlsCache, s.url);
        if (cached) { streamUrl = cached; }
        else {
          const extracted = await extractHLS(s.url, buildHeaders(s));
          if (extracted && extracted !== s.url) { setCache(hlsCache, s.url, extracted); streamUrl = extracted; }
        }
      } catch(e) { err(`[HLS] ${e.message}`); }
      results.push({
        url: streamUrl, name: addonName,
        title: `🔴 ${label}`,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: buildHeaders(s) } },
      });
    } else {
      results.push({
        url: s.url, name: addonName,
        title: `🔴 ${label}`,
        behaviorHints: { notWebReady: true },
      });
    }
  }
  return { streams: results };
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
function buildManifest() {
  const settings  = getSettings();
  const streams   = getEnabledStreams();
  const groups    = getGroups();
  const autoComb  = buildAutoCombined(streams);
  const version   = getVersion();
  const catalogs  = [];

  if (autoComb.length > 0)
    catalogs.push({ type:'tv', id:'jash_best', name:'⭐ Best Streams', extra:[{ name:'search', isRequired:false }] });

  groups.forEach((g,i) =>
    catalogs.push({ type:'tv', id:`jash_cat_${i}`, name:g.name, extra:[{ name:'search', isRequired:false }] }));

  if (catalogs.length === 0)
    catalogs.push({ type:'tv', id:'jash_cat_default', name:`${settings.addonName} Channels`, extra:[{ name:'search', isRequired:false }] });

  return {
    id: ADDON_ID, version,
    name: settings.addonName || ADDON_NAME,
    description: [
      settings.addonName || ADDON_NAME,
      streams.length ? `${streams.length.toLocaleString()} channels` : 'Open configurator to add sources',
      `${groups.length} groups`,
      'Built-in DASH+DRM Proxy',
      'Samsung Tizen',
    ].filter(Boolean).join(' · '),
    logo: `${PUBLIC_URL}/logo.png`,
    resources: [
      { name:'catalog', types:['tv'], idPrefixes:['jash'] },
      { name:'meta',    types:['tv'], idPrefixes:['jash'] },
      { name:'stream',  types:['tv'], idPrefixes:['jash'] },
    ],
    types:['tv'], idPrefixes:['jash'], catalogs,
    behaviorHints: { adult:false, p2p:false, configurable:true, configurationRequired:false },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
function handleCatalog(catId, extra) {
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const settings = getSettings();
  const search   = (extra.search||'').toLowerCase().trim();
  const skip     = parseInt(extra.skip||'0',10)||0;
  const PAGE     = 100;

  if (catId === 'jash_best') {
    let list = buildAutoCombined(streams);
    if (search) list = list.filter(c=>c.name.toLowerCase().includes(search));
    return { metas: list.slice(skip, skip+PAGE).map(c => {
      const logo = c.streams.find(s=>s.logo)?.logo || null;
      return { id:`jashauto${encodeId(c.key)}`, type:'tv', name:c.name, poster:logo, background:logo, logo, description:`${c.sourceCount} sources · ${c.streams.length} streams`, genres:[...new Set(c.streams.map(s=>s.group).filter(Boolean))] };
    }) };
  }
  if (catId === 'jash_cat_default') return { metas:[] };

  const m = catId.match(/^jash_cat_(\d+)$/);
  if (!m) return { metas:[] };
  const group = groups[parseInt(m[1],10)];
  if (!group) return { metas:[] };

  let list = streams.filter(s=>(s.group||'Uncategorized')===group.name);
  if (search) list = list.filter(s=>s.name.toLowerCase().includes(search));

  const combined = settings.combineMultiQuality !== false;
  const seen = new Map();
  for (const s of list) {
    const key = combined ? s.name.toLowerCase().trim() : s.id;
    if (!seen.has(key)) seen.set(key, { rep:s, all:[] });
    seen.get(key).all.push(s);
  }
  return { metas: [...seen.values()].slice(skip, skip+PAGE).map(({rep, all})=>({
    id:`jash${encodeId(rep.url)}`, type:'tv', name:rep.name,
    poster:rep.logo||null, background:rep.logo||null, logo:rep.logo||null,
    description: all.length>1 ? `${group.name} · ${all.length} qualities` : group.name,
    genres:[group.name],
  })) };
}

// ─── Meta ─────────────────────────────────────────────────────────────────────
function handleMeta(rawId) {
  let id = rawId; try { id = decodeURIComponent(rawId); } catch {}
  const streams  = getEnabledStreams();
  const settings = getSettings();
  const name     = settings.addonName || ADDON_NAME;

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto',''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x=>x.key===key);
    if (!c) return { meta:null };
    const logo = c.streams.find(s=>s.logo)?.logo || null;
    return { meta:{ id, type:'tv', name:c.name, poster:logo, logo, description:`${c.sourceCount} sources · ${c.streams.length} streams`, genres:[...new Set(c.streams.map(s=>s.group).filter(Boolean))], releaseInfo:'LIVE' } };
  }
  const url = decodeId(id.replace(/^jash/,''));
  if (!url) return { meta:null };
  const s = streams.find(x=>x.url===url);
  if (!s) return { meta:null };
  return { meta:{ id, type:'tv', name:s.name, poster:s.logo||null, background:s.logo||null, logo:s.logo||null, description:`${s.group||'Uncategorized'} · ${name}`, genres:[s.group||'Uncategorized'], releaseInfo:'LIVE' } };
}

// ─── Stream Handler ───────────────────────────────────────────────────────────
async function handleStream(rawId) {
  let id = rawId; try { id = decodeURIComponent(rawId); } catch {}
  const streams  = getEnabledStreams();
  const settings = getSettings();
  const name     = settings.addonName || ADDON_NAME;
  debug(`[STREAM] id=${id.slice(0,80)}`);

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto',''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x=>x.key===key);
    if (!c) return { streams:[] };
    log(`[STREAM] auto-combined "${c.name}" → ${c.streams.length} streams`);
    return resolveVariants(c.streams, name);
  }

  if (!id.startsWith('jash')) return { streams:[] };
  const url = decodeId(id.replace(/^jash/,''));
  if (!url) return { streams:[] };
  const primary = streams.find(s=>s.url===url);
  if (!primary) return resolveVariants([{ url, name:'Live', group:'' }], name);

  const variants = settings.combineMultiQuality !== false
    ? streams.filter(s => s.name.toLowerCase().trim() === primary.name.toLowerCase().trim() && (s.group||'') === (primary.group||''))
    : [primary];

  log(`[STREAM] "${primary.name}" → ${variants.length} variant(s)`);
  return resolveVariants(variants, name);
}

// ─── M3U Parsers ──────────────────────────────────────────────────────────────
function extractM3UName(line) {
  let inQ=false, qChar='', lastComma=-1;
  for (let i=0;i<line.length;i++) {
    const c=line[i];
    if (!inQ&&(c==='"'||c==="'")) { inQ=true; qChar=c; }
    else if (inQ&&c===qChar)      { inQ=false; }
    else if (!inQ&&c===',')       { lastComma=i; }
  }
  return lastComma!==-1 ? line.slice(lastComma+1).trim() : '';
}

function parseM3UContent(text, sourceId) {
  const streams=[]; const lines=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  let meta={}; let idx=0;
  for (const rawLine of lines) {
    const line=rawLine.trim();
    if (!line||line==='#EXTM3U'||line.startsWith('#EXTM3U ')) continue;
    if (line.startsWith('#EXTINF:')) {
      const commaName = extractM3UName(line);
      const tvgNameRaw= (line.match(/tvg-name="([^"]*)"/) || [])[1] || '';
      meta={
        name: (tvgNameRaw.trim() || commaName || 'Unknown'),
        tvgId:(line.match(/tvg-id="([^"]*)"/)      ||[])[1]||'',
        logo :(line.match(/tvg-logo="([^"]*)"/)    ||[])[1]||'',
        group:(line.match(/group-title="([^"]*)"/) ||[])[1]||'Uncategorized',
      }; continue;
    }
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) { meta.licenseType=line.slice(line.indexOf('=')+1).trim(); continue; }
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key='))  { meta.licenseKey =line.slice(line.indexOf('=')+1).trim(); continue; }
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt=line.slice(11).trim();
      if (/^http-user-agent=/i.test(opt)) meta.userAgent=opt.slice(opt.indexOf('=')+1).trim();
      if (/^http-re?ferr?er=/i.test(opt)) meta.referer  =opt.slice(opt.indexOf('=')+1).trim();
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      try { const h=JSON.parse(line.slice(9).trim()); if(h.cookie||h.Cookie) meta.cookie=h.cookie||h.Cookie; if(h.Referer||h.referer) meta.referer=h.Referer||h.referer; if(h['User-Agent']||h['user-agent']) meta.userAgent=h['User-Agent']||h['user-agent']; } catch {}
      continue;
    }
    if (line.startsWith('#')) continue;
    const isUrl=/^https?:\/\//i.test(line)||/^rtmps?:\/\//i.test(line)||/\.(m3u8|mpd|ts|mp4|mkv)(\?|$)/i.test(line);
    if (!isUrl) { meta={}; continue; }
    const urlLow=line.toLowerCase();
    const streamType=urlLow.includes('.mpd')?'dash':urlLow.includes('.m3u8')?'hls':'direct';
    streams.push({
      id:`${sourceId}_${idx++}`,
      name:meta.name||`Stream ${idx}`, url:line, tvgId:meta.tvgId||'', logo:meta.logo||'',
      group:meta.group||'Uncategorized', sourceId, enabled:true, status:'unknown', streamType,
      ...(meta.licenseType?{licenseType:meta.licenseType}:{}),
      ...(meta.licenseKey ?{licenseKey :meta.licenseKey }:{}),
      ...(meta.userAgent  ?{userAgent  :meta.userAgent  }:{}),
      ...(meta.cookie     ?{cookie     :meta.cookie     }:{}),
      ...(meta.referer    ?{referer    :meta.referer    }:{}),
    });
    meta={};
  }
  return streams;
}

function parseJsonContent(text, sourceId) {
  let data; try { data=JSON.parse(text); } catch { return []; }
  let items=[];
  if (Array.isArray(data)) { items=data; }
  else if (data&&typeof data==='object') {
    const arrKey=['channels','streams','data','items','list','results','playlist'].find(k=>Array.isArray(data[k]));
    if (arrKey) { items=data[arrKey]; }
    else {
      const keys=Object.keys(data);
      if (keys.length>0&&keys.every(k=>data[k]&&typeof data[k]==='object'&&!Array.isArray(data[k])))
        items=keys.map(k=>({ _id:k, ...data[k] }));
      else items=[data];
    }
  }
  const streams=[]; let idx=0;
  for (const item of items) {
    if (!item||typeof item!=='object') continue;
    const url=item.link||item.url||item.stream||item.src||item.streamUrl||item.stream_url||item.playbackUrl||item.playback_url||item.videoUrl||item.video_url||item.hls||item.mpd||item.source||'';
    if (!url||typeof url!=='string'||!url.startsWith('http')) continue;
    idx++;
    const name =item.name||item.title||item.channel||item.channelName||item.channel_name||item.label||`Stream ${idx}`;
    const logo =item.logo||item.icon||item.image||item.thumbnail||item.poster||'';
    const group=item.group||item.category||item.genre||item['group-title']||item.group_title||'Uncategorized';
    let licenseType=item.licenseType||item.license_type||item.drmScheme||item.drm_scheme||'';
    let licenseKey =item.licenseKey||item.license_key||item.drmLicense||'';
    if (!licenseKey&&item.clearkey) { const ck=item.clearkey; if(ck.kid&&ck.key){licenseKey=`${ck.kid}:${ck.key}`;licenseType=licenseType||'clearkey';} }
    if (licenseType) { const lt=licenseType.toLowerCase(); licenseType=lt.includes('clear')&&!lt.includes('widevine')?'clearkey':'org.w3.clearkey'; }
    const userAgent=item.userAgent||item.user_agent||item['user-agent']||'';
    const cookie   =item.cookie||item.Cookie||'';
    const referer  =item.referer||item.Referer||'';
    const urlLow   =url.toLowerCase();
    const streamType=urlLow.includes('.mpd')?'dash':urlLow.includes('.m3u8')?'hls':'direct';
    streams.push({ id:`${sourceId}_json_${idx}`, name:String(name), url, logo:String(logo), group:String(group), sourceId, enabled:true, status:'unknown', streamType, ...(licenseType?{licenseType}:{}), ...(licenseKey?{licenseKey}:{}), ...(userAgent?{userAgent}:{}), ...(cookie?{cookie}:{}), ...(referer?{referer}:{}) });
  }
  return streams;
}

function parseUniversalContent(content, sourceId) {
  const t=content.trimStart();
  if (t.startsWith('[')||t.startsWith('{')) { const s=parseJsonContent(content,sourceId); if(s.length>0) return { streams:s, format:'json' }; }
  if (t.includes('#EXTM3U')||t.includes('#EXTINF')) { const s=parseM3UContent(content,sourceId); if(s.length>0) return { streams:s, format:'m3u' }; }
  try { const s=parseJsonContent(content,sourceId); if(s.length>0) return { streams:s, format:'json' }; } catch {}
  return { streams:parseM3UContent(content,sourceId), format:'m3u' };
}

async function fetchAndParseSource(sourceUrl, sourceId, sourceName) {
  const normalized=normalizeSourceUrl(sourceUrl);
  log(`[SOURCE] Fetching: ${normalized.slice(0,80)}`);
  try {
    const content=await smartFetch(normalized,{});
    if (!content||content.trim().length<10) { log(`[SOURCE] Empty: ${normalized.slice(0,60)}`); return []; }
    const { streams, format }=parseUniversalContent(content, sourceId);
    const tagged=streams.map(s=>({ ...s, group:s.group||sourceName }));
    log(`[SOURCE] ✅ ${tagged.length} streams (${format}) from "${sourceName}"`);
    return tagged;
  } catch(e) { err(`[SOURCE] Failed "${sourceName}": ${e.message}`); return []; }
}

// ─── M3U Generator ────────────────────────────────────────────────────────────
function generateM3U(streams, playlistName, useProxy) {
  const settings=getSettings();
  const lines=[`#EXTM3U x-playlist-name="${playlistName||settings.addonName||ADDON_NAME}"`];
  for (const s of streams) {
    const parts=['#EXTINF:-1'];
    if (s.tvgId) parts.push(`tvg-id="${s.tvgId}"`);
    parts.push(`tvg-name="${(s.name||'').replace(/"/g,'')}"`);
    if (s.logo)  parts.push(`tvg-logo="${s.logo}"`);
    parts.push(`group-title="${(s.group||'Uncategorized').replace(/"/g,'')}"`);
    lines.push(`${parts.join(' ')},${s.name}`);

    if (useProxy) {
      // All streams through our built-in proxy
      lines.push(buildProxyUrl(s));
    } else {
      if (hasDRM(s) && s.licenseType && s.licenseKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=${s.licenseType}`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${s.licenseKey}`);
      }
      if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
      if (s.cookie)    lines.push(`#EXTHTTP:{"cookie":"${s.cookie}"}`);
      lines.push(s.url);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept, Origin, Authorization');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age','86400');
}
function noCache(res) { res.setHeader('Cache-Control','no-cache, no-store, must-revalidate'); res.setHeader('Pragma','no-cache'); res.setHeader('Expires','0'); }
function json(res, data, code) {
  const body=JSON.stringify(data);
  res.writeHead(code||200, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache, no-store' });
  res.end(body);
}
function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('404'); }
  const ext=path.extname(filePath).toLowerCase();
  const mime={ '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.webp':'image/webp', '.txt':'text/plain' }[ext]||'application/octet-stream';
  const content=fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type':mime, 'Cache-Control':mime.includes('html')?'no-cache':'public, max-age=3600' });
  res.end(content);
}
function parseExtra(str) {
  const out={};
  try { decodeURIComponent(String(str||'')).split('&').forEach(p=>{ const [k,...v]=p.split('='); if(k) out[k]=v.join('=')||''; }); } catch {}
  return out;
}

// ─── Install Page ─────────────────────────────────────────────────────────────
function installPage() {
  const manifest=buildManifest(); const streams=getEnabledStreams(); const groups=getGroups(); const drmCount=streams.filter(hasDRM).length; const host=PUBLIC_URL.replace(/^https?:\/\//,'');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jash IPTV — Install</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f172a;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}.wrap{max-width:680px;width:100%}.card{background:#1e293b;border:1px solid #334155;border-radius:1.5rem;padding:2rem;margin-bottom:1.5rem}h1{color:#a78bfa;font-size:2rem;font-weight:800;text-align:center;margin-bottom:.5rem}.sub{color:#64748b;text-align:center;font-size:.9rem;margin-bottom:1.5rem}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin-bottom:1.5rem}.stat{background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:.75rem;text-align:center}.stat .val{font-size:1.4rem;font-weight:800;color:#a78bfa}.stat .lbl{font-size:.65rem;color:#64748b;margin-top:.2rem}.url-box{background:#0f172a;border:1px solid #334155;border-radius:.75rem;padding:1rem;margin-bottom:.75rem}.url-box .lbl{color:#64748b;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem}.url-box .val{color:#818cf8;font-family:monospace;font-size:.8rem;word-break:break-all}.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;padding:.875rem;border-radius:.875rem;font-weight:700;font-size:.95rem;text-decoration:none;margin-bottom:.75rem}.btn-v{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff}.btn-b{background:linear-gradient(135deg,#1e40af,#1d4ed8);color:#fff}.btn-sm{background:#1e293b;border:1px solid #475569;color:#cbd5e1;font-size:.8rem;padding:.5rem .875rem;border-radius:.5rem;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem;margin:.25rem}.proxy-box{background:#0c1225;border:1px solid #1e40af;border-radius:.75rem;padding:1rem;margin-bottom:.75rem}.proxy-title{color:#60a5fa;font-weight:700;font-size:.85rem;margin-bottom:.35rem}footer{text-align:center;color:#475569;font-size:.75rem;padding-top:1rem}</style></head>
<body><div class="wrap"><div class="card"><div style="font-size:3rem;text-align:center;margin-bottom:.75rem">📡</div><h1>Jash IPTV Addon</h1><p class="sub">Built-in DASH+DRM Proxy · Samsung Tizen Optimized</p>
<div class="stats"><div class="stat"><div class="val">${streams.length.toLocaleString()}</div><div class="lbl">Channels</div></div><div class="stat"><div class="val">${groups.length}</div><div class="lbl">Groups</div></div><div class="stat"><div class="val">${drmCount}</div><div class="lbl">DRM</div></div><div class="stat"><div class="val">v${manifest.version}</div><div class="lbl">Version</div></div></div>
<div class="proxy-box"><div class="proxy-title">🔐 Built-in ClearKey DRM Proxy (No External Service Required)</div>
<div style="color:#93c5fd;font-size:.75rem">MPD fetch → CENC decrypt (AES-CTR/CBC) → HLS output → Any player plays ✅</div>
<div style="color:#60a5fa;font-size:.7rem;margin-top:.4rem">Supports: cenc · cens · cbc1 · cbcs · Multi-track · Sub-sample encryption</div></div>
<div class="url-box"><div class="lbl">📋 Stremio Manifest URL</div><div class="val">${PUBLIC_URL}/manifest.json</div></div>
<a href="stremio://${host}/manifest.json" class="btn btn-v">📺 Install in Stremio App</a>
<a href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}" class="btn btn-b" target="_blank">🌐 Install via Stremio Web</a>
<div style="margin:1.25rem 0"><div style="color:#94a3b8;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem">📻 M3U Playlist URLs</div>
<div class="url-box"><div class="lbl">🔐 Proxy M3U (DASH+DRM → HLS — recommended for TiviMate/OTT Navigator)</div><div class="val">${PUBLIC_URL}/proxy/playlist.m3u</div></div>
<div class="url-box"><div class="lbl">Standard M3U (with DRM keys inline)</div><div class="val">${PUBLIC_URL}/p.m3u</div></div>
<div style="display:flex;flex-wrap:wrap"><a href="/proxy/playlist.m3u" class="btn-sm">🔐 /proxy/playlist.m3u</a><a href="/p.m3u" class="btn-sm">⬇️ /p.m3u</a><a href="/playlist.m3u" class="btn-sm">⬇️ /playlist.m3u</a><a href="/iptv.m3u" class="btn-sm">⬇️ /iptv.m3u</a></div></div>
<div style="display:flex;flex-wrap:wrap"><a href="/" class="btn-sm">⚙️ Configurator</a><a href="/health" class="btn-sm">❤️ Health</a><a href="/manifest.json" class="btn-sm" target="_blank">📋 Manifest</a><a href="/install" class="btn-sm">📦 Install</a></div>
</div><footer>Jash IPTV v${manifest.version} · ${ADDON_ID} · Built-in DASH+DRM Proxy</footer></div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const parsed   = urlMod.parse(req.url, true);
  const pathname = (parsed.pathname||'/').replace(/\/+$/,'')||'/';
  const query    = parsed.query;
  debug(`${req.method} ${pathname}`);

  // ── Built-in Proxy Routes ──────────────────────────────────────────────────

  // /proxy/mpd/:id — DASH MPD → HLS master
  const proxyMpdM = pathname.match(/^\/proxy\/mpd\/([^/]+)$/);
  if (proxyMpdM) return handleProxyMpd(req, res, proxyMpdM[1], query);

  // /proxy/playlist/:id/:repId.m3u8 — HLS media playlist
  const proxyPlM = pathname.match(/^\/proxy\/playlist\/([^/]+)\/([^/]+)\.m3u8$/);
  if (proxyPlM) return handleProxyPlaylist(req, res, proxyPlM[1], proxyPlM[2], query);

  // /proxy/hls/:id — HLS M3U8 rewriter
  const proxyHlsM = pathname.match(/^\/proxy\/hls\/([^/]+)$/);
  if (proxyHlsM) return handleProxyHls(req, res, proxyHlsM[1], query);

  // /proxy/init/:id — init segment (moov) with optional decrypt
  const proxyInitM = pathname.match(/^\/proxy\/init\/([^/]+)$/);
  if (proxyInitM) return handleProxyInit(req, res, proxyInitM[1], query);

  // /proxy/seg/:id — segment proxy with optional CENC decrypt
  const proxySegM = pathname.match(/^\/proxy\/seg\/([^/]+)$/);
  if (proxySegM) return handleProxySeg(req, res, proxySegM[1], query);

  // /proxy/stream/:id — raw stream proxy
  const proxyStrM = pathname.match(/^\/proxy\/stream\/([^/]+)$/);
  if (proxyStrM) return handleProxyStream(req, res, proxyStrM[1], query);

  // /proxy/playlist.m3u — full proxy M3U playlist
  if (pathname === '/proxy/playlist.m3u') {
    const streams  = getEnabledStreams();
    const settings = getSettings();
    if (!streams.length) {
      res.writeHead(200,{ 'Content-Type':'text/plain','Access-Control-Allow-Origin':'*' });
      return res.end('#EXTM3U\n# No streams yet. Open configurator and add sources.');
    }
    const content = generateM3U(streams, settings.addonName, true); // true = use proxy URLs
    res.writeHead(200, { 'Content-Type':'application/x-mpegurl;charset=utf-8', 'Content-Disposition':'inline;filename="proxy-playlist.m3u"', 'Content-Length':Buffer.byteLength(content,'utf8'), 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache,no-store', 'X-Stream-Count':String(streams.length), 'X-Proxy':'builtin-drm' });
    log(`[M3U] proxy playlist → ${streams.length} streams`);
    return res.end(content);
  }

  // ── API Routes ─────────────────────────────────────────────────────────────

  if (pathname==='/health'||pathname==='/api/health') {
    noCache(res);
    const streams=getEnabledStreams(); const groups=getGroups(); const autoComb=buildAutoCombined(streams); const manifest=buildManifest();
    return json(res, {
      status:'ok', uptime:Math.round(process.uptime()), publicUrl:PUBLIC_URL,
      version:manifest.version, streams:streams.length, groups:groups.length,
      autoCombined:autoComb.length, catalogs:manifest.catalogs.length, channelRegistry:channelReg.size,
      cacheSize:hlsCache.size, mpdCacheSize:mpdCache.size, initCacheSize:initCache.size,
      streamTypes:{ hls:streams.filter(s=>detectType(s)==='hls').length, dash:streams.filter(s=>detectType(s)==='dash').length, drm:streams.filter(hasDRM).length, direct:streams.filter(s=>detectType(s)==='direct').length },
      proxyEndpoints:{ mpd:`${PUBLIC_URL}/proxy/mpd/:id`, hls:`${PUBLIC_URL}/proxy/hls/:id`, seg:`${PUBLIC_URL}/proxy/seg/:id`, init:`${PUBLIC_URL}/proxy/init/:id`, playlist:`${PUBLIC_URL}/proxy/playlist.m3u` },
      manifestUrl:`${PUBLIC_URL}/manifest.json`,
      installUrl:`stremio://${PUBLIC_URL.replace(/^https?:\/\//,'')}/manifest.json`,
    });
  }

  if (pathname==='/api/sync' && req.method==='POST') {
    let body=''; req.on('data',c=>{body+=c;}); req.on('end',async()=>{
      try {
        const cfg=JSON.parse(body);
        if (Array.isArray(cfg.sources)) cfg.sources=cfg.sources.map(s=>s.url?{...s,url:normalizeSourceUrl(s.url)}:s);
        if (!Array.isArray(cfg.streams)) return json(res,{ok:false,error:'streams must be array'},400);

        let serverFetched=0;
        if (Array.isArray(cfg.sources)) {
          for (const src of cfg.sources) {
            if (!src.url||src.type==='file'||src.type==='manual'||src.enabled===false) continue;
            const srcStreams=cfg.streams.filter(s=>s.sourceId===src.id);
            if (srcStreams.length===0) {
              const fetched=await fetchAndParseSource(src.url,src.id,src.name||src.url);
              if (fetched.length>0) { cfg.streams=cfg.streams.filter(s=>s.sourceId!==src.id).concat(fetched); serverFetched+=fetched.length; }
            }
          }
        }

        fs.writeFileSync(CFG_FILE,JSON.stringify(cfg,null,2),'utf8');
        hlsCache.clear(); mpdCache.clear(); initCache.clear();
        rebuildRegistry();

        const enabled=cfg.streams.filter(s=>s.enabled!==false); const autoComb=buildAutoCombined(enabled); const manifest=buildManifest();
        log(`[SYNC] ✅ ${enabled.length} streams | DRM=${enabled.filter(hasDRM).length} | v${manifest.version}`);

        return json(res, { ok:true, streams:enabled.length, autoCombined:autoComb.length, groups:getGroups().length, drmChannels:enabled.filter(hasDRM).length, version:manifest.version, manifestUrl:`${PUBLIC_URL}/manifest.json`, installUrl:`stremio://${PUBLIC_URL.replace(/^https?:\/\//,'')}/manifest.json`, playlistUrl:`${PUBLIC_URL}/p.m3u`, proxyPlaylist:`${PUBLIC_URL}/proxy/playlist.m3u`, serverFetched });
      } catch(e) { err('[SYNC]',e.message); return json(res,{ok:false,error:e.message},400); }
    }); return;
  }

  if (pathname==='/api/fetch-source' && req.method==='POST') {
    let body=''; req.on('data',c=>{body+=c;}); req.on('end',async()=>{
      try {
        const { url }=JSON.parse(body); if (!url) return json(res,{error:'url required'},400);
        const normalized=normalizeSourceUrl(url.trim());
        const { body:rawBuf, contentType }=await fetchUrl(normalized,{ 'User-Agent':SAMSUNG_UA, 'Accept':'text/plain, application/json, application/x-mpegurl, */*' });
        const rawStr=rawBuf.toString('utf8');
        let content=rawStr, extractedFrom='direct';
        if (isHtml(contentType,rawStr)) { const ex=extractFromHtml(rawStr); if(ex){content=ex;extractedFrom='html';} else {content=rawStr.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();extractedFrom='html-stripped';} }
        const t=content.trimStart();
        let format='unknown';
        if (t.startsWith('[')||t.startsWith('{')) format='json';
        else if (t.startsWith('#EXTM3U')||t.startsWith('#EXTINF')||content.includes('#EXTINF')) format='m3u';
        else if (/\.(m3u8?)/i.test(normalized)) format='m3u';
        else if (/\.json/i.test(normalized)) format='json';
        return json(res,{content,format,finalUrl:normalized,contentType:contentType||'',extractedFrom,size:content.length});
      } catch(e) { err('[FETCH-SOURCE]',e.message); return json(res,{error:e.message},502); }
    }); return;
  }

  if (pathname==='/api/config') { noCache(res); return json(res,loadConfig()); }
  if (pathname==='/api/cache'&&req.method==='DELETE') { const n=hlsCache.size+mpdCache.size+initCache.size; hlsCache.clear();mpdCache.clear();initCache.clear(); return json(res,{ok:true,cleared:n}); }
  if (pathname==='/api/install') {
    noCache(res);
    const manifest=buildManifest(); const host=PUBLIC_URL.replace(/^https?:\/\//,'');
    return json(res,{ manifestUrl:`${PUBLIC_URL}/manifest.json`, stremioUrl:`stremio://${host}/manifest.json`, webInstallUrl:`https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}`, configureUrl:`${PUBLIC_URL}/`, proxyPlaylist:`${PUBLIC_URL}/proxy/playlist.m3u`, playlistUrl:`${PUBLIC_URL}/p.m3u`, version:manifest.version, streams:getEnabledStreams().length, groups:getGroups().length, drmChannels:getEnabledStreams().filter(hasDRM).length });
  }

  // ── Stremio Addon Routes ──────────────────────────────────────────────────

  if (pathname==='/manifest.json') {
    noCache(res); const m=buildManifest();
    log(`[MANIFEST] v${m.version} | ${m.catalogs.length} catalogs | ${getEnabledStreams().length} streams`);
    return json(res,m);
  }

  const catM=pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    noCache(res); const catId=decodeURIComponent(catM[1]); const extra={};
    if (catM[2]) catM[2].split('/').forEach(seg=>{ const[k,...v]=seg.split('='); if(k) extra[k]=decodeURIComponent(v.join('=')||''); });
    if (query.extra) Object.assign(extra,parseExtra(String(query.extra)));
    if (query.search) extra.search=String(query.search);
    if (query.skip)   extra.skip=String(query.skip);
    return json(res,handleCatalog(catId,extra));
  }

  const metaM=pathname.match(/^\/meta\/tv\/(.+)\.json$/);
  if (metaM) { noCache(res); return json(res,handleMeta(metaM[1])); }

  const streamM=pathname.match(/^\/stream\/tv\/(.+)\.json$/);
  if (streamM) { noCache(res); try { return json(res,await handleStream(streamM[1])); } catch(e) { err('[STREAM]',e.message); return json(res,{streams:[]}); } }

  // ── M3U Playlist Routes ───────────────────────────────────────────────────

  const PLAYLIST_ALIASES=['/playlist.m3u','/p.m3u','/iptv.m3u','/live.m3u','/channels.m3u'];
  const groupPlaylistM=pathname.match(/^\/playlist\/(.+)\.m3u$/);

  if (PLAYLIST_ALIASES.includes(pathname)||groupPlaylistM) {
    const filterGroup=groupPlaylistM?decodeURIComponent(groupPlaylistM[1]):null;
    const allStreams=getEnabledStreams();
    const filtered=filterGroup?allStreams.filter(s=>(s.group||'Uncategorized')===filterGroup):allStreams;
    const settings=getSettings();
    if (!filtered.length) { res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'}); return res.end('#EXTM3U\n# No streams yet.'); }
    const content=generateM3U(filtered,filterGroup?`${settings.addonName} - ${filterGroup}`:settings.addonName,false);
    res.writeHead(200,{'Content-Type':'application/x-mpegurl;charset=utf-8','Content-Disposition':'inline;filename="playlist.m3u"','Content-Length':Buffer.byteLength(content,'utf8'),'Access-Control-Allow-Origin':'*','Cache-Control':'no-cache,no-store'});
    log(`[M3U] ${filtered.length} streams → ${pathname}`);
    return res.end(content);
  }

  // ── Logo / Favicon ────────────────────────────────────────────────────────
  if (pathname==='/logo.png'||pathname==='/favicon.ico') {
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#4F46E5"/></linearGradient></defs><rect width="200" height="200" rx="40" fill="url(#g)"/><text x="100" y="128" font-size="90" text-anchor="middle" fill="white">📡</text><text x="100" y="175" font-size="22" font-family="Arial,sans-serif" font-weight="bold" text-anchor="middle" fill="rgba(255,255,255,0.85)">JASH</text></svg>`;
    res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    return res.end(svg);
  }

  if (pathname==='/install'||pathname==='/addon') { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-cache'}); return res.end(installPage()); }
  if (pathname==='/configure') { res.writeHead(302,{Location:'/'}); return res.end(); }

  // ── Static Files / SPA ────────────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const reqPath=pathname==='/'?'index.html':pathname.replace(/^\//,'');
    const safePath=path.resolve(DIST_DIR,reqPath);
    if (!safePath.startsWith(path.resolve(DIST_DIR))) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(safePath)&&fs.statSync(safePath).isFile()) return serveFile(res,safePath);
    return serveFile(res,path.join(DIST_DIR,'index.html'));
  }

  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  res.end(installPage());
});

// ─── Error Handling ───────────────────────────────────────────────────────────
process.on('uncaughtException',  e => err('Uncaught:',  e.message));
process.on('unhandledRejection', r => err('Unhandled:', String(r)));
server.on('error', e => { if (e.code==='EADDRINUSE') { err(`Port ${PORT} in use`); process.exit(1); } err('Server error:',e.message); });

// ─── TCP Keepalive ────────────────────────────────────────────────────────────
server.on('connection', socket => { socket.setKeepAlive(true,30000); socket.setTimeout(120000); socket.on('timeout',()=>socket.destroy()); });

// ─── Self-Ping Keepalive (Render/Koyeb free tier) ─────────────────────────────
function startKeepalive() {
  const pingUrl=`${PUBLIC_URL}/health`;
  setInterval(()=>{
    const lib=pingUrl.startsWith('https')?https:http;
    const req=lib.get(pingUrl,{timeout:10000},res=>{res.resume();debug(`[PING] ${res.statusCode}`);});
    req.on('error',e=>debug(`[PING] ✗ ${e.message}`));
    req.on('timeout',()=>req.destroy());
  }, 14*60*1000);
  log('[KEEPALIVE] Active — every 14 min');
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT,'0.0.0.0',()=>{
  rebuildRegistry();
  const streams=getEnabledStreams(); const groups=getGroups(); const manifest=buildManifest(); const host=PUBLIC_URL.replace(/^https?:\/\//,'');
  log('═══════════════════════════════════════════════════════════════════');
  log(`🚀  Jash IPTV Server v17.0`);
  log(`📡  Port       : ${PORT}`);
  log(`🌐  Public URL : ${PUBLIC_URL}`);
  log('───────────────────────────────────────────────────────────────────');
  log(`📺  Manifest   : ${PUBLIC_URL}/manifest.json`);
  log(`🔌  Install    : stremio://${host}/manifest.json`);
  log(`⚙️   Config    : ${PUBLIC_URL}/`);
  log(`❤️   Health    : ${PUBLIC_URL}/health`);
  log(`📻  M3U        : ${PUBLIC_URL}/p.m3u`);
  log(`🔐  Proxy M3U  : ${PUBLIC_URL}/proxy/playlist.m3u`);
  log('───────────────────────────────────────────────────────────────────');
  log(`🔐  DRM Proxy  : /proxy/mpd/:id → MPD+Decrypt → HLS`);
  log(`🎬  Segments   : /proxy/seg/:id → CENC Decrypt → Raw MP4`);
  log(`📦  Init Segs  : /proxy/init/:id → Strip Encryption Boxes`);
  log(`🔁  HLS Proxy  : /proxy/hls/:id → Rewrite Segment URLs`);
  log('───────────────────────────────────────────────────────────────────');
  log(`📊  Streams    : ${streams.length} | Groups: ${groups.length}`);
  log(`🔐  DRM        : ${streams.filter(hasDRM).length} encrypted channels`);
  log(`📋  Catalogs   : ${manifest.catalogs.length} | Version: ${manifest.version}`);
  log('═══════════════════════════════════════════════════════════════════');
  if (!PUBLIC_URL.includes('localhost')&&!PUBLIC_URL.includes('127.0.0.1')) startKeepalive();
});
