#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         JASH IPTV ADDON — Backend Server v15.0                          ║
 * ║                                                                          ║
 * ║  ┌─────────────────────────────────────────────────────────────────┐    ║
 * ║  │          ClearKey DRM Proxy Architecture                         │    ║
 * ║  │                                                                   │    ║
 * ║  │  Player → GET /play/:id                                          │    ║
 * ║  │         ← Modified MPD (license URL injected)                   │    ║
 * ║  │  Player → GET /license/:id                                       │    ║
 * ║  │         ← ClearKey JSON {keys:[{kid,k}]}                        │    ║
 * ║  │  Player → GET /seg/:id?u=...                                     │    ║
 * ║  │         ← Proxied segment with auth headers                      │    ║
 * ║  └─────────────────────────────────────────────────────────────────┘    ║
 * ║                                                                          ║
 * ║  Stremio → /manifest.json → /catalog → /meta → /stream                 ║
 * ║  TiviMate/OTT → /drm-playlist.m3u or /p.m3u                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const urlMod = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '7000', 10);
const DEBUG       = process.env.DEBUG === 'true';
const PUBLIC_URL  = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR    = path.join(__dirname, '..', 'dist');
const CFG_FILE    = path.join(__dirname, 'streams-config.json');
const REQ_TIMEOUT = 25000;
const CACHE_TTL   = 5 * 60 * 1000;  // 5 min HLS resolution cache
const SEG_CACHE_TTL = 30 * 1000;    // 30 sec segment URL cache

// ─── Addon Identity ────────────────────────────────────────────────────────────
const ADDON_ID   = process.env.ADDON_ID   || 'community.jash-iptv';
const ADDON_NAME = process.env.ADDON_NAME || 'Jash IPTV';
const VER_BASE   = '1.0';

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DBG]`, ...a);
const err   = (...a) => console.error(`[${ts()}] [ERR]`, ...a);

// ─── Caches ───────────────────────────────────────────────────────────────────
const hlsCache = new Map();   // HLS extracted URL cache
const segCache = new Map();   // Segment proxy URL cache

function getCached(map, k) {
  const c = map.get(k);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.v;
  map.delete(k);
  return null;
}
function setCache(map, k, v, ttl) {
  map.set(k, { v, ts: Date.now(), ttl: ttl || CACHE_TTL });
}

// ─── ID Helpers ───────────────────────────────────────────────────────────────
const encodeId = s => Buffer.from(String(s), 'utf8').toString('base64url');
const decodeId = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } };

// ═══════════════════════════════════════════════════════════════════════════════
// ██  DRM CHANNEL REGISTRY
//     Stores all DRM channels: kid, key, url, cookie, userAgent per channel ID
// ═══════════════════════════════════════════════════════════════════════════════

const drmRegistry = new Map();   // id → { url, kid, key, cookie, userAgent, name, logo }

function registerDRMChannel(stream) {
  if (!stream.licenseKey || !stream.url) return null;
  const id = stream.tvgId || stream.id || encodeId(stream.url).slice(0, 16);
  const [kid, key] = (stream.licenseKey || '').split(':');
  if (!kid || !key) return null;

  drmRegistry.set(String(id), {
    id,
    name      : stream.name      || 'Unknown',
    logo      : stream.logo      || '',
    url       : stream.url,
    kid       : kid.trim().toLowerCase(),
    key       : key.trim().toLowerCase(),
    cookie    : stream.cookie    || '',
    userAgent : stream.userAgent || DEFAULT_UA,
    referer   : stream.referer   || '',
    group     : stream.group     || 'Uncategorized',
  });
  return String(id);
}

// ─── Default User-Agent (Samsung Tizen) ──────────────────────────────────────
const DEFAULT_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36';

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CONFIG LOADER
// ═══════════════════════════════════════════════════════════════════════════════

function defaultSettings() {
  return {
    addonId            : ADDON_ID,
    addonName          : ADDON_NAME,
    combineMultiQuality: true,
    sortAlphabetically : true,
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) return { streams: [], groups: [], settings: defaultSettings() };
    const raw = fs.readFileSync(CFG_FILE, 'utf8').trim();
    if (!raw || raw === '{}' || raw === '[]') return { streams: [], groups: [], settings: defaultSettings() };
    const cfg = JSON.parse(raw);
    return {
      streams : Array.isArray(cfg.streams) ? cfg.streams : [],
      groups  : Array.isArray(cfg.groups)  ? cfg.groups  : [],
      sources : Array.isArray(cfg.sources) ? cfg.sources : [],
      settings: { ...defaultSettings(), ...(cfg.settings || {}) },
    };
  } catch(e) { err('loadConfig:', e.message); return { streams: [], groups: [], settings: defaultSettings() }; }
}

function getSettings() { return { ...defaultSettings(), ...(loadConfig().settings || {}) }; }

function getEnabledStreams() {
  const { streams, settings } = loadConfig();
  const enabled = streams.filter(s => s.enabled !== false);
  if (settings.sortAlphabetically !== false) {
    return [...enabled].sort((a, b) => {
      const ga = (a.group || 'Uncategorized').toLowerCase();
      const gb = (b.group || 'Uncategorized').toLowerCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
  }
  return [...enabled].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
}

function getGroups() {
  const { groups: stored, settings } = loadConfig();
  const streams = getEnabledStreams();
  const names   = [...new Set(streams.map(s => s.group || 'Uncategorized'))];
  if (settings.sortAlphabetically !== false) names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const storedMap = new Map(stored.map(g => [g.name, g]));
  return names
    .map((name, idx) => ({
      id     : storedMap.get(name)?.id || `grp_${idx}`,
      name,
      enabled: storedMap.get(name)?.enabled !== false,
    }))
    .filter(g => g.enabled);
}

function getVersion() {
  try {
    if (fs.existsSync(CFG_FILE)) {
      const patch = Math.floor(fs.statSync(CFG_FILE).mtimeMs / 1000) % 100000;
      return `${VER_BASE}.${patch}`;
    }
  } catch { /* ok */ }
  return `${VER_BASE}.0`;
}

// ─── Rebuild DRM Registry from config on startup ─────────────────────────────
function rebuildDRMRegistry() {
  drmRegistry.clear();
  const { streams } = loadConfig();
  let count = 0;
  for (const s of streams) {
    if (s.licenseKey && s.url) {
      if (registerDRMChannel(s)) count++;
    }
  }
  if (count > 0) log(`[DRM] Registry built: ${count} DRM channels`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  STREAM TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectType(stream) {
  if (stream.streamType) return stream.streamType;
  const u = (stream.url || '').toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest(format=mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('index.m3u')) return 'hls';
  return 'direct';
}

function hasDRM(s) { return !!(s.licenseType || s.licenseKey); }

// ═══════════════════════════════════════════════════════════════════════════════
// ██  ClearKey HEX → BASE64URL CONVERTER
// ═══════════════════════════════════════════════════════════════════════════════

function hexToBase64Url(hex) {
  // Remove any dashes (UUID format) and whitespace
  const clean = hex.replace(/[-\s]/g, '');
  const buf   = Buffer.from(clean, 'hex');
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Build ClearKey license response JSON per EME spec
function buildClearKeyResponse(kid, key) {
  return {
    keys: [{
      kty: 'oct',
      kid: hexToBase64Url(kid),
      k  : hexToBase64Url(key),
    }],
    type: 'temporary',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MPD MODIFIER
//     Injects ClearKey license URL into the MPD XML and rewrites segment URLs
// ═══════════════════════════════════════════════════════════════════════════════

function modifyMPD(mpdContent, channelId, baseUrl) {
  let modified = mpdContent;

  // 1. Inject ClearKey ContentProtection element
  const licenseUrl = `${PUBLIC_URL}/license/${channelId}`;

  // Remove existing ContentProtection elements (replace or inject)
  // First check if there's an AdaptationSet we can inject into
  const clearKeyBlock =
    `<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e">` +
    `<cenc:pssh>AAAAB3NzYWdl</cenc:pssh></ContentProtection>` +
    `<ContentProtection schemeIdUri="urn:ietf:params:rfc:5646">` +
    `<clearkey:Laurl Lic_type="EME-1.0">${licenseUrl}</clearkey:Laurl>` +
    `</ContentProtection>`;

  // Strategy A: Replace existing ContentProtection blocks
  if (modified.includes('<ContentProtection')) {
    // Keep first ContentProtection structure, inject license URL
    modified = modified.replace(
      /<ContentProtection[^>]*schemeIdUri="urn:uuid[^"]*"[^>]*>[\s\S]*?<\/ContentProtection>/gi,
      clearKeyBlock,
    );
  } else if (modified.includes('<AdaptationSet')) {
    // Inject before first AdaptationSet closing or its content start
    modified = modified.replace(
      /(<AdaptationSet[^>]*>)/i,
      `$1\n  ${clearKeyBlock}\n`,
    );
  }

  // 2. Rewrite segment/chunk URLs to go through our proxy
  //    Only rewrite relative URLs — absolute URLs with different host go through proxy
  const segProxy = `${PUBLIC_URL}/seg/${channelId}?u=`;

  // Rewrite BaseURL elements
  modified = modified.replace(
    /<BaseURL>(https?:\/\/[^<]+)<\/BaseURL>/gi,
    (_, url) => `<BaseURL>${segProxy}${encodeURIComponent(url)}</BaseURL>`,
  );

  // Rewrite SegmentTemplate media/initialization attributes if they're full URLs
  modified = modified.replace(
    /((?:media|initialization)=")(https?:\/\/[^"]+)(")/gi,
    (_, pre, url, post) => `${pre}${segProxy}${encodeURIComponent(url)}${post}`,
  );

  // Make relative BaseURLs absolute using the MPD base URL, then proxy them
  const mpdBase = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

  // Handle relative SegmentTemplate — make absolute first
  modified = modified.replace(
    /(<BaseURL>)(?!https?:\/\/)([^<]+)(<\/BaseURL>)/gi,
    (_, open, relUrl, close) => {
      const absUrl = relUrl.startsWith('/') ? new urlMod.URL(relUrl, baseUrl).href : mpdBase + relUrl;
      return `${open}${segProxy}${encodeURIComponent(absUrl)}${close}`;
    },
  );

  return modified;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTTP FETCH — Direct only, no proxy servers
//     Samsung Tizen UA, follow redirects, custom headers
// ═══════════════════════════════════════════════════════════════════════════════

function fetchUrl(url, customHeaders, redirects) {
  redirects     = redirects || 0;
  customHeaders = customHeaders || {};

  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new urlMod.URL(url); }
    catch { return reject(new Error('Invalid URL: ' + url)); }

    const lib   = parsed.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => reject(new Error('Request timeout')), REQ_TIMEOUT);

    const headers = {
      'User-Agent'   : customHeaders['User-Agent'] || DEFAULT_UA,
      'Accept'       : '*/*',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
      ...customHeaders,
    };

    const options = {
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      method  : 'GET',
      headers,
      timeout : REQ_TIMEOUT,
    };

    const req = lib.request(options, res => {
      clearTimeout(timer);

      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const redir = new urlMod.URL(res.headers.location, url).href;
        debug(`[FETCH] Redirect ${res.statusCode} → ${redir.slice(0, 80)}`);
        return fetchUrl(redir, customHeaders, redirects + 1).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = res.headers['content-type'] || '';
      const chunks      = [];
      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   () => resolve({ body: Buffer.concat(chunks), contentType, statusCode: res.statusCode, headers: res.headers }));
      res.on('error', reject);
    });

    req.on('error',   e => { clearTimeout(timer); reject(e); });
    req.on('timeout', () => { clearTimeout(timer); req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Returns UTF-8 text body
async function fetchText(url, customHeaders) {
  const r = await fetchUrl(url, customHeaders || {});
  return (r.body || Buffer.alloc(0)).toString('utf8');
}

// Returns raw Buffer (for segments)
async function fetchBuffer(url, customHeaders) {
  const r = await fetchUrl(url, customHeaders || {});
  return r.body || Buffer.alloc(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTML → JSON/M3U EXTRACTOR
//     Handles Cloudflare Workers pages that embed JSON in <pre> or <body>
// ═══════════════════════════════════════════════════════════════════════════════

function htmlDecode(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .trim();
}

function extractFromHtml(html) {
  // 1. <pre> tags — CF Workers JSON viewer / paste sites
  const preRe = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let preM;
  while ((preM = preRe.exec(html)) !== null) {
    const inner = htmlDecode(preM[1].replace(/<[^>]+>/g, ''));
    const t = inner.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(inner); return inner; } catch { return inner; }
    }
    if (inner.includes('#EXTM3U') || inner.includes('#EXTINF')) return inner;
  }

  // 2. <script> JSON assignments
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptM;
  while ((scriptM = scriptRe.exec(html)) !== null) {
    const inner = scriptM[1].trim();
    if (!inner || inner.length < 10) continue;
    const jsonM = inner.match(/(?:var\s+\w+|window\.\w+|\w+)\s*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;?\s*$/);
    if (jsonM) { try { JSON.parse(jsonM[1]); return jsonM[1]; } catch { /* */ } }
  }

  // 3. Body content
  const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyM) {
    const text = htmlDecode(bodyM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text.includes('#EXTM3U') || text.includes('#EXTINF')) return text;
    const jStart = text.search(/[\[{]/);
    if (jStart !== -1) {
      const candidate = text.slice(jStart);
      try { JSON.parse(candidate); return candidate; } catch { /* */ }
      const arrM = text.match(/(\[[\s\S]*\])/);
      if (arrM) { try { JSON.parse(arrM[1]); return arrM[1]; } catch { /* */ } }
      const objM = text.match(/(\{[\s\S]*\})/);
      if (objM) { try { JSON.parse(objM[1]); return objM[1]; } catch { /* */ } }
    }
  }

  // 4. Full stripped
  const stripped = htmlDecode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  if (stripped.includes('#EXTM3U') || stripped.includes('#EXTINF')) return stripped;
  if (stripped.startsWith('[') || stripped.startsWith('{')) return stripped;

  return null;
}

function isHtml(contentType, bodyStr) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const t = (bodyStr || '').trimStart().toLowerCase().slice(0, 50);
  return t.startsWith('<!doctype') || t.startsWith('<html');
}

// Smart fetch: direct only, but extracts JSON/M3U from HTML responses
async function smartFetch(url, customHeaders) {
  const normalized = normalizeSourceUrl(url);
  const { body, contentType } = await fetchUrl(normalized, customHeaders || {});
  const bodyStr = body.toString('utf8');

  if (isHtml(contentType, bodyStr)) {
    debug(`[SMART] HTML response from ${normalized.slice(0, 60)} — extracting…`);
    const extracted = extractFromHtml(bodyStr);
    if (extracted) {
      log(`[SMART] ✓ Extracted ${extracted.length} bytes from HTML response`);
      return extracted;
    }
    // Return stripped text as fallback
    return bodyStr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return bodyStr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  URL NORMALIZER
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeSourceUrl(url) {
  if (!url) return url;
  let u = url.trim();

  const ghBlob = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (ghBlob) return `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;

  const paste = u.match(/^https?:\/\/pastebin\.com\/(?!raw\/)([a-zA-Z0-9]+)$/);
  if (paste) return `https://pastebin.com/raw/${paste[1]}`;

  const gdrive = u.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdrive) return `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;

  if (u.includes('dropbox.com')) {
    u = u.replace(/[?&]dl=\d/g, '');
    return u + (u.includes('?') ? '&dl=1' : '?dl=1');
  }

  if (u.includes('onedrive.live.com/redir')) return u.replace('/redir?', '/download?');

  return u;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HLS EXTRACTION — Samsung Tizen middle-quality fix
// ═══════════════════════════════════════════════════════════════════════════════

async function extractHLS(playlistUrl, streamMeta) {
  log(`[HLS] ${playlistUrl.slice(0, 80)}…`);
  const headers = buildHeaders(streamMeta || {});

  let content;
  try { content = await fetchText(playlistUrl, headers); }
  catch(e) { log(`[HLS] fetch failed: ${e.message}`); return null; }

  if (!content || (!content.includes('#EXTM3U') && !content.includes('#EXT-X-'))) {
    debug('[HLS] response is not M3U8'); return null;
  }

  const lines    = content.split('\n').map(l => l.trim()).filter(Boolean);
  const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));

  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('#EXT-X-STREAM-INF')) continue;
      const bw  = (lines[i].match(/BANDWIDTH=(\d+)/)      || [])[1];
      const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          variants.push({ url: lines[j], bw: bw ? parseInt(bw) : 0, res: res || '?' });
          break;
        }
      }
    }
    if (!variants.length) return null;
    variants.sort((a, b) => b.bw - a.bw);
    // ★ Pick MIDDLE quality — best Samsung TV stability
    const idx      = Math.floor(variants.length / 2);
    const selected = variants[idx];
    debug(`[HLS] ${variants.length} variants → [${idx}] ${selected.res} @${selected.bw}bps`);
    let vUrl = selected.url;
    if (!vUrl.startsWith('http')) {
      vUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1) + vUrl;
    }
    return vUrl;
  } else {
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      if (line.includes('.ts') || line.includes('.m4s') || line.includes('.m3u8') || line.includes('.mp4')) {
        let segUrl = line;
        if (!segUrl.startsWith('http')) {
          segUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1) + line;
        }
        return segUrl;
      }
    }
    return null;
  }
}

function buildHeaders(s) {
  const h = { 'User-Agent': s.userAgent || DEFAULT_UA };
  if (s.cookie)      h['Cookie']  = s.cookie;
  if (s.referer)     h['Referer'] = s.referer;
  if (s.httpHeaders) Object.entries(s.httpHeaders).forEach(([k, v]) => { if (!h[k]) h[k] = v; });
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CHANNEL NAME NORMALIZER (precise — strips quality/region only)
// ═══════════════════════════════════════════════════════════════════════════════

const STRIP_TOKENS = new Set([
  'hd','sd','fhd','uhd','4k','2k','8k','1080p','720p','480p','360p','2160p',
  'vip','plus','premium','backup','mirror','alt','alternate',
  'usa','uk','us','ca','au',
  'live','stream','online','channel',
]);

function normalizeKey(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')
    .replace(/[\-_\/\\|:]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STRIP_TOKENS.has(w))
    .join(' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  AUTO-COMBINE: same channel from multiple sources → ⭐ Best Streams
// ═══════════════════════════════════════════════════════════════════════════════

function buildAutoCombined(streams) {
  const map = new Map();
  for (const s of streams) {
    const key = normalizeKey(s.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { name: s.name, streams: [], sourceIds: new Set() });
    const e = map.get(key);
    e.streams.push(s);
    e.sourceIds.add(s.sourceId || 'unknown');
    if ((s.name || '').length < (e.name || '').length) e.name = s.name;
  }
  return [...map.entries()]
    .filter(([, e]) => e.sourceIds.size >= 2)
    .map(([key, e]) => ({ key, name: e.name, streams: e.streams, sourceCount: e.sourceIds.size }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MANIFEST BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildManifest() {
  const settings = getSettings();
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const autoComb = buildAutoCombined(streams);
  const version  = getVersion();
  const catalogs = [];

  if (autoComb.length > 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_best',
      name : '⭐ Best Streams',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  groups.forEach((g, i) => {
    catalogs.push({
      type : 'tv',
      id   : `jash_cat_${i}`,
      name : g.name,
      extra: [{ name: 'search', isRequired: false }],
    });
  });

  if (catalogs.length === 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_cat_default',
      name : `${settings.addonName} Channels`,
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  return {
    id         : ADDON_ID,
    version,
    name       : settings.addonName || ADDON_NAME,
    description: [
      settings.addonName || ADDON_NAME,
      streams.length ? `${streams.length.toLocaleString()} channels` : 'Open configurator to add sources',
      groups.length  ? `${groups.length} groups` : '',
      'HLS · DASH · DRM Proxy · Samsung Tizen',
    ].filter(Boolean).join(' · '),
    logo       : `${PUBLIC_URL}/logo.png`,
    resources  : [
      { name: 'catalog', types: ['tv'], idPrefixes: ['jash'] },
      { name: 'meta',    types: ['tv'], idPrefixes: ['jash'] },
      { name: 'stream',  types: ['tv'], idPrefixes: ['jash'] },
    ],
    types        : ['tv'],
    idPrefixes   : ['jash'],
    catalogs,
    behaviorHints: {
      adult               : false,
      p2p                 : false,
      configurable        : true,
      configurationRequired: false,
    },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CATALOG HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleCatalog(catId, extra) {
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const settings = getSettings();
  const search   = (extra.search || '').toLowerCase().trim();
  const skip     = parseInt(extra.skip || '0', 10) || 0;
  const PAGE     = 100;

  if (catId === 'jash_best') {
    let list = buildAutoCombined(streams);
    if (search) list = list.filter(c => c.name.toLowerCase().includes(search));
    const metas = list.slice(skip, skip + PAGE).map(c => {
      const logo = c.streams.find(s => s.logo)?.logo || null;
      return {
        id         : `jashauto${encodeId(c.key)}`,
        type       : 'tv',
        name       : c.name,
        poster     : logo,
        background : logo,
        logo,
        description: `${c.sourceCount} sources · ${c.streams.length} streams available`,
        genres     : [...new Set(c.streams.map(s => s.group).filter(Boolean))],
      };
    });
    return { metas };
  }

  if (catId === 'jash_cat_default') return { metas: [] };

  const m = catId.match(/^jash_cat_(\d+)$/);
  if (!m) return { metas: [] };
  const group = groups[parseInt(m[1], 10)];
  if (!group) return { metas: [] };

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);
  if (search) list = list.filter(s => s.name.toLowerCase().includes(search));

  const combined = settings.combineMultiQuality !== false;
  const seen     = new Map();
  for (const s of list) {
    const key = combined ? s.name.toLowerCase().trim() : s.id;
    if (!seen.has(key)) seen.set(key, { rep: s, all: [] });
    seen.get(key).all.push(s);
  }

  const metas = [...seen.values()].slice(skip, skip + PAGE).map(({ rep, all }) => ({
    id         : `jash${encodeId(rep.url)}`,
    type       : 'tv',
    name       : rep.name,
    poster     : rep.logo || null,
    background : rep.logo || null,
    logo       : rep.logo || null,
    description: all.length > 1 ? `${group.name} · ${all.length} streams` : group.name,
    genres     : [group.name],
  }));

  return { metas };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  META HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleMeta(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }

  const streams  = getEnabledStreams();
  const settings = getSettings();
  const name     = settings.addonName || ADDON_NAME;

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { meta: null };
    const logo = c.streams.find(s => s.logo)?.logo || null;
    return {
      meta: {
        id, type: 'tv', name: c.name,
        poster     : logo, logo,
        description: `${c.sourceCount} sources · ${c.streams.length} streams · ${name}`,
        genres     : [...new Set(c.streams.map(s => s.group).filter(Boolean))],
        releaseInfo: 'LIVE',
      },
    };
  }

  const url = decodeId(id.replace(/^jash/, ''));
  if (!url) return { meta: null };
  const s = streams.find(x => x.url === url);
  if (!s) return { meta: null };
  return {
    meta: {
      id, type: 'tv', name: s.name,
      poster     : s.logo || null,
      background : s.logo || null,
      logo       : s.logo || null,
      description: `${s.group || 'Uncategorized'} · ${name}`,
      genres     : [s.group || 'Uncategorized'],
      releaseInfo: 'LIVE',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  STREAM HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }

  const streams  = getEnabledStreams();
  const settings = getSettings();
  const name     = settings.addonName || ADDON_NAME;
  debug(`[STREAM] id=${id.slice(0, 80)}`);

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { streams: [] };
    log(`[STREAM] auto-combined "${c.name}" → ${c.streams.length} streams`);
    return resolveVariants(c.streams, name, settings);
  }

  if (!id.startsWith('jash')) return { streams: [] };
  const url     = decodeId(id.replace(/^jash/, ''));
  if (!url) return { streams: [] };
  const primary = streams.find(s => s.url === url);

  if (!primary) return resolveVariants([{ url, name: 'Live', group: '' }], name, settings);

  const variants = settings.combineMultiQuality !== false
    ? streams.filter(s =>
        s.name.toLowerCase().trim() === primary.name.toLowerCase().trim() &&
        (s.group || '') === (primary.group || ''))
    : [primary];

  log(`[STREAM] "${primary.name}" → ${variants.length} variant(s)`);
  return resolveVariants(variants, name, settings);
}

async function resolveVariants(variants, addonName, settings) {
  const results = [];

  for (let i = 0; i < variants.length; i++) {
    const s     = variants[i];
    const type  = detectType(s);
    const isDRM = hasDRM(s);
    const label = variants.length > 1 ? `[${i + 1}/${variants.length}] ${s.name || 'Stream'}` : (s.name || 'Live');

    // ── DRM DASH: route through our proxy ───────────────────────────────────
    if (isDRM && type === 'dash') {
      const drmId = registerDRMChannel(s) || encodeId(s.url).slice(0, 16);
      const proxyUrl = `${PUBLIC_URL}/play/${drmId}`;
      log(`[DRM] "${s.name}" → proxy /play/${drmId}`);
      results.push({
        url  : proxyUrl,
        name : addonName,
        title: `🔴 ${label} [🔐 ClearKey DASH]`,
        behaviorHints: { notWebReady: true },
      });
      continue;
    }

    // ── DRM HLS: pass-through with key info ─────────────────────────────────
    if (isDRM && type === 'hls') {
      results.push({
        url  : s.url,
        name : addonName,
        title: `🔴 ${label} [🔐 ${(s.licenseType || 'DRM').toUpperCase()}]`,
        behaviorHints: {
          notWebReady : true,
          proxyHeaders: { request: buildHeaders(s) },
        },
      });
      continue;
    }

    // ── HLS: extract real stream URL ─────────────────────────────────────────
    let resolved = s.url;
    if (type === 'hls') {
      try {
        const cached = getCached(hlsCache, s.url);
        if (cached) {
          resolved = cached;
          debug(`[HLS] ⚡ cache hit`);
        } else {
          const extracted = await extractHLS(s.url, s);
          if (extracted && extracted !== s.url) {
            setCache(hlsCache, s.url, extracted);
            resolved = extracted;
          }
        }
      } catch(e) { err(`[HLS] extraction: ${e.message}`); }
    }

    const headers = buildHeaders(s);
    let title = `🔴 ${label}`;
    if (type === 'dash') title += ` [DASH]`;

    results.push({
      url  : resolved,
      name : addonName,
      title,
      behaviorHints: {
        notWebReady : true,
        proxyHeaders: { request: headers },
      },
    });
  }

  return { streams: results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  M3U PARSER  (precise title extraction, all metadata)
// ═══════════════════════════════════════════════════════════════════════════════

// Extract last unquoted comma name — handles commas inside tvg-logo="a,b,c.jpg"
function extractM3UName(line) {
  let inQ = false, qChar = '', lastComma = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!inQ && (c === '"' || c === "'")) { inQ = true;  qChar = c; }
    else if (inQ  && c === qChar)         { inQ = false; }
    else if (!inQ && c === ',')           { lastComma = i; }
  }
  return lastComma !== -1 ? line.slice(lastComma + 1).trim() : '';
}

// Strip quality tokens from end of name: "(1080p)", "[HD]", "(720p)" etc.
function stripQuality(name) {
  return (name || '').replace(/\s*[\[(]?\s*(UHD|4K|FHD|1080p|720p|480p|360p|240p|HD|SD|2K|8K)\s*[\])]?\s*$/i, '').trim();
}

function parseM3UContent(text, sourceId) {
  const streams = [];
  // Normalise line endings + remove BOM
  const lines   = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let   meta    = {};
  let   idx     = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === '#EXTM3U' || line.startsWith('#EXTM3U ')) continue;

    // ── #EXTINF ──────────────────────────────────────────────────────────
    if (line.startsWith('#EXTINF:')) {
      const commaName = extractM3UName(line);

      // Use tvg-name as primary — it's always the correct channel name
      // Fall back to comma-extracted name only if tvg-name is absent
      const tvgNameRaw = (line.match(/tvg-name="([^"]*)"/)    || [])[1] || '';
      const tvgName    = tvgNameRaw.trim() || commaName;

      meta = {
        name       : tvgName || commaName || 'Unknown',
        tvgId      : (line.match(/tvg-id="([^"]*)"/)      || [])[1] || '',
        logo       : (line.match(/tvg-logo="([^"]*)"/)    || [])[1] || '',
        group      : (line.match(/group-title="([^"]*)"/) || [])[1] || 'Uncategorized',
      };
      continue;
    }

    // ── DRM ───────────────────────────────────────────────────────────────
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
      meta.licenseType = line.slice(line.indexOf('=') + 1).trim(); continue;
    }
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      meta.licenseKey = line.slice(line.indexOf('=') + 1).trim(); continue;
    }

    // ── VLC opts ──────────────────────────────────────────────────────────
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice(11).trim();
      if (/^http-user-agent=/i.test(opt))   meta.userAgent = opt.slice(opt.indexOf('=') + 1).trim();
      if (/^http-re?ferr?er=/i.test(opt))   meta.referer   = opt.slice(opt.indexOf('=') + 1).trim();
      continue;
    }

    // ── EXTHTTP ───────────────────────────────────────────────────────────
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.slice(9).trim());
        if (h.cookie       || h.Cookie)       meta.cookie    = h.cookie    || h.Cookie;
        if (h.Referer      || h.referer)       meta.referer   = h.Referer   || h.referer;
        if (h['User-Agent']|| h['user-agent']) meta.userAgent = h['User-Agent'] || h['user-agent'];
      } catch { /* ignore */ }
      continue;
    }

    // ── Other comments — skip, but preserve meta for next URL ────────────
    if (line.startsWith('#')) continue;

    // ── URL detection — accept http/https/rtmp/rtsp + known extensions ───
    const isUrl =
      /^https?:\/\//i.test(line) ||
      /^rtmps?:\/\//i.test(line) ||
      /^rtsps?:\/\//i.test(line) ||
      /\.(m3u8|mpd|ts|mp4|mkv)(\?|$)/i.test(line);

    if (!isUrl) {
      // Not a URL — reset state
      meta = {};
      continue;
    }

    const urlLow     = line.toLowerCase();
    const streamType = urlLow.includes('.mpd') ? 'dash' : urlLow.includes('.m3u8') ? 'hls' : 'direct';

    streams.push({
      id        : `${sourceId}_${idx++}`,
      name      : meta.name || `Stream ${idx}`,
      url       : line,
      tvgId     : meta.tvgId  || '',
      logo      : meta.logo   || '',
      group     : meta.group  || 'Uncategorized',
      sourceId,
      enabled   : true,
      status    : 'unknown',
      streamType,
      ...(meta.licenseType ? { licenseType: meta.licenseType } : {}),
      ...(meta.licenseKey  ? { licenseKey:  meta.licenseKey  } : {}),
      ...(meta.userAgent   ? { userAgent:   meta.userAgent   } : {}),
      ...(meta.cookie      ? { cookie:      meta.cookie      } : {}),
      ...(meta.referer     ? { referer:     meta.referer     } : {}),
    });
    meta = {};
  }
  return streams;
}

function parseJsonContent(text, sourceId) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }

  let items = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === 'object') {
    const arrKey = ['channels','streams','data','items','list','results','playlist'].find(k => Array.isArray(data[k]));
    if (arrKey) {
      items = data[arrKey];
    } else {
      const keys = Object.keys(data);
      if (keys.length > 0 && keys.every(k => data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]))) {
        items = keys.map(k => ({ _id: k, ...data[k] }));
      } else {
        items = [data];
      }
    }
  }

  const streams = [];
  let   idx     = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url =
      item.link || item.url || item.stream || item.src ||
      item.streamUrl || item.stream_url || item.playbackUrl ||
      item.playback_url || item.videoUrl || item.video_url ||
      item.hls || item.mpd || item.source || '';
    if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
    idx++;

    const name  = item.name || item.title || item.channel || item.channelName || item.channel_name || item.label || `Stream ${idx}`;
    const logo  = item.logo || item.icon  || item.image   || item.thumbnail   || item.poster       || '';
    const group = item.group || item.category || item.genre || item['group-title'] || item.group_title || 'Uncategorized';

    let licenseType = item.licenseType || item.license_type || item.drmScheme || item.drm_scheme || '';
    let licenseKey  = item.licenseKey  || item.license_key  || item.drmLicense || '';
    if (!licenseKey && item.clearkey) {
      const ck = item.clearkey;
      if (ck.kid && ck.key) { licenseKey = `${ck.kid}:${ck.key}`; licenseType = licenseType || 'clearkey'; }
    }
    if (licenseType) {
      const lt = licenseType.toLowerCase();
      licenseType = (lt.includes('clear') && !lt.includes('widevine')) ? 'clearkey' : 'org.w3.clearkey';
    }

    const userAgent = item.userAgent || item.user_agent  || item['user-agent'] || '';
    const cookie    = item.cookie    || item.Cookie      || '';
    const referer   = item.referer   || item.Referer     || '';
    const urlLow    = url.toLowerCase();
    const streamType = urlLow.includes('.mpd') ? 'dash' : urlLow.includes('.m3u8') ? 'hls' : 'direct';

    streams.push({
      id  : `${sourceId}_json_${idx}_${Date.now()}`,
      name: String(name), url, logo: String(logo), group: String(group),
      sourceId, enabled: true, status: 'unknown', streamType,
      ...(licenseType ? { licenseType } : {}),
      ...(licenseKey  ? { licenseKey  } : {}),
      ...(userAgent   ? { userAgent   } : {}),
      ...(cookie      ? { cookie      } : {}),
      ...(referer     ? { referer     } : {}),
    });
  }
  return streams;
}

function parseUniversalContent(content, sourceId) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const s = parseJsonContent(content, sourceId);
    if (s.length > 0) return { streams: s, format: 'json' };
  }
  if (trimmed.includes('#EXTM3U') || trimmed.includes('#EXTINF')) {
    const s = parseM3UContent(content, sourceId);
    if (s.length > 0) return { streams: s, format: 'm3u' };
  }
  try {
    const s = parseJsonContent(content, sourceId);
    if (s.length > 0) return { streams: s, format: 'json' };
  } catch { /* */ }
  const s = parseM3UContent(content, sourceId);
  return { streams: s, format: 'm3u' };
}

async function fetchAndParseSource(sourceUrl, sourceId, sourceName) {
  const normalized = normalizeSourceUrl(sourceUrl);
  log(`[SOURCE] Fetching: ${normalized.slice(0, 80)}`);
  try {
    const content = await smartFetch(normalized, {});
    if (!content || content.trim().length < 10) {
      log(`[SOURCE] Empty response from ${normalized.slice(0, 60)}`);
      return [];
    }
    const { streams, format } = parseUniversalContent(content, sourceId);
    const tagged = streams.map(s => ({ ...s, group: s.group || sourceName }));
    log(`[SOURCE] ✅ ${tagged.length} streams (${format}) from "${sourceName}"`);
    return tagged;
  } catch(e) {
    err(`[SOURCE] Failed "${sourceName}": ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  M3U PLAYLIST GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function generateM3U(streams, playlistName, useDRMProxy) {
  const settings = getSettings();
  const lines    = [`#EXTM3U x-playlist-name="${playlistName || settings.addonName || ADDON_NAME}"`];

  for (const s of streams) {
    const parts = ['#EXTINF:-1'];
    if (s.tvgId) parts.push(`tvg-id="${s.tvgId}"`);
    parts.push(`tvg-name="${(s.name || '').replace(/"/g, '')}"`);
    if (s.logo)  parts.push(`tvg-logo="${s.logo}"`);
    parts.push(`group-title="${(s.group || 'Uncategorized').replace(/"/g, '')}"`);
    lines.push(`${parts.join(' ')},${s.name}`);

    const isDRM  = hasDRM(s);
    const isDAsh = detectType(s) === 'dash';

    if (useDRMProxy && isDRM && isDAsh) {
      // Route through DRM proxy
      const drmId = registerDRMChannel(s) || encodeId(s.url).slice(0, 16);
      lines.push(`${PUBLIC_URL}/play/${drmId}`);
    } else {
      if (isDRM && s.licenseType && s.licenseKey) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTTP RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma',  'no-cache');
  res.setHeader('Expires', '0');
}
function json(res, data, code) {
  const body = JSON.stringify(data);
  res.writeHead(code || 200, {
    'Content-Type'               : 'application/json; charset=utf-8',
    'Content-Length'             : Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control'              : 'no-cache, no-store',
  });
  res.end(body);
}
function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('404 Not Found'); }
  const ext  = path.extname(filePath).toLowerCase();
  const mime = {
    '.html':'.html', '.js':'application/javascript', '.css':'text/css',
    '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
    '.svg':'image/svg+xml', '.ico':'image/x-icon',
    '.woff':'font/woff', '.woff2':'font/woff2', '.webp':'image/webp',
    '.txt':'text/plain',
  };
  const mimeType = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.webp': 'image/webp',
    '.txt':  'text/plain',
  }[ext] || 'application/octet-stream';

  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type' : mimeType,
    'Cache-Control': mimeType.includes('html') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(content);
}

function parseExtra(str) {
  const out = {};
  try {
    decodeURIComponent(String(str || '')).split('&').forEach(p => {
      const [k, ...v] = p.split('=');
      if (k) out[k] = v.join('=') || '';
    });
  } catch { /* ok */ }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  INSTALL PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function installPage() {
  const manifest = buildManifest();
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const autoComb = buildAutoCombined(streams);
  const host     = PUBLIC_URL.replace(/^https?:\/\//, '');
  const drmCount = streams.filter(hasDRM).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jash IPTV Addon — Install</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .wrap{max-width:700px;width:100%}
    .card{background:#1e293b;border:1px solid #334155;border-radius:1.5rem;padding:2rem;margin-bottom:1.5rem;box-shadow:0 25px 50px rgba(0,0,0,.5)}
    h1{color:#a78bfa;font-size:2rem;font-weight:800;text-align:center;margin-bottom:.25rem}
    .sub{color:#64748b;text-align:center;font-size:.9rem;margin-bottom:1.5rem}
    .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem;margin-bottom:1.5rem}
    .stat{background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:.75rem;text-align:center}
    .stat .val{font-size:1.4rem;font-weight:800;color:#a78bfa}
    .stat .lbl{font-size:.6rem;color:#64748b;margin-top:.2rem}
    .url-box{background:#0f172a;border:1px solid #334155;border-radius:.75rem;padding:1rem;margin-bottom:.75rem}
    .url-box .lbl{color:#64748b;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem}
    .url-box .val{color:#818cf8;font-family:monospace;font-size:.8rem;word-break:break-all}
    .btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;padding:.875rem;border-radius:.875rem;font-weight:700;font-size:.95rem;cursor:pointer;text-decoration:none;border:none;margin-bottom:.75rem}
    .btn-violet{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff}
    .btn-blue{background:linear-gradient(135deg,#1e40af,#1d4ed8);color:#fff}
    .btn-green{background:linear-gradient(135deg,#065f46,#047857);color:#fff}
    .btn-sm{background:#1e293b;border:1px solid #475569;color:#cbd5e1;font-size:.8rem;padding:.5rem .875rem;border-radius:.5rem;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem;margin:.25rem}
    .step{display:flex;gap:.75rem;margin-bottom:.75rem;align-items:flex-start}
    .step-n{background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;width:1.75rem;height:1.75rem;min-width:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700}
    .step-t{color:#94a3b8;font-size:.85rem;padding-top:.25rem}.step-t strong{color:#e2e8f0}
    .badge{display:inline-flex;align-items:center;gap:.3rem;padding:.2rem .6rem;border-radius:9999px;font-size:.7rem;font-weight:700}
    .badge-green{background:#14532d;color:#4ade80}.badge-red{background:#7f1d1d;color:#f87171}
    .section-title{color:#94a3b8;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem}
    .drm-box{background:#1c1235;border:1px solid #4c1d95;border-radius:.75rem;padding:1rem;margin-bottom:.75rem}
    .drm-box .drm-title{color:#a78bfa;font-weight:700;font-size:.85rem;margin-bottom:.5rem}
    footer{text-align:center;color:#475569;font-size:.75rem;padding-top:1rem}
    @media(max-width:520px){.stats{grid-template-columns:repeat(3,1fr)}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div style="font-size:3.5rem;text-align:center;margin-bottom:.75rem">📡</div>
    <h1>Jash IPTV Addon</h1>
    <p class="sub">HLS · DASH · ClearKey DRM Proxy · Samsung Tizen <span class="badge badge-green">● LIVE</span></p>
    <div class="stats">
      <div class="stat"><div class="val">${streams.length.toLocaleString()}</div><div class="lbl">Channels</div></div>
      <div class="stat"><div class="val">${groups.length}</div><div class="lbl">Groups</div></div>
      <div class="stat"><div class="val">${autoComb.length}</div><div class="lbl">Combined</div></div>
      <div class="stat"><div class="val">${drmCount}</div><div class="lbl">DRM</div></div>
      <div class="stat"><div class="val">v${manifest.version}</div><div class="lbl">Version</div></div>
    </div>

    ${drmCount > 0 ? `
    <div class="drm-box">
      <div class="drm-title">🔐 ClearKey DRM Proxy Active — ${drmCount} encrypted channels</div>
      <div style="color:#7c3aed;font-family:monospace;font-size:.75rem">${PUBLIC_URL}/play/:id → Modified MPD → ${PUBLIC_URL}/license/:id → Keys</div>
    </div>` : ''}

    <div class="url-box">
      <div class="lbl">📋 Stremio Manifest URL</div>
      <div class="val">${PUBLIC_URL}/manifest.json</div>
    </div>
    <a href="stremio://${host}/manifest.json" class="btn btn-violet">📺 Install in Stremio App</a>
    <a href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}" class="btn btn-blue" target="_blank">🌐 Install via Stremio Web</a>

    <div style="margin:1.25rem 0">
      <div class="section-title">📻 M3U Playlist (TiviMate · OTT Navigator · VLC)</div>
      <div class="url-box">
        <div class="lbl">Standard M3U (with DRM keys inline)</div>
        <div class="val">${PUBLIC_URL}/p.m3u</div>
      </div>
      <div class="url-box">
        <div class="lbl">🔐 DRM Proxy M3U (for players that can't handle DRM keys — recommended)</div>
        <div class="val">${PUBLIC_URL}/drm-playlist.m3u</div>
      </div>
      <div style="display:flex;flex-wrap:wrap">
        <a href="/drm-playlist.m3u" class="btn-sm">🔐 /drm-playlist.m3u</a>
        <a href="/p.m3u" class="btn-sm">⬇️ /p.m3u</a>
        <a href="/playlist.m3u" class="btn-sm">⬇️ /playlist.m3u</a>
        <a href="/iptv.m3u" class="btn-sm">⬇️ /iptv.m3u</a>
        <a href="/live.m3u" class="btn-sm">⬇️ /live.m3u</a>
      </div>
    </div>

    <div style="margin-bottom:1.25rem">
      <div class="section-title">🚀 Quick Start</div>
      <div class="step"><div class="step-n">1</div><div class="step-t"><strong>Install addon</strong> — click the violet button above</div></div>
      <div class="step"><div class="step-n">2</div><div class="step-t"><strong>Open Configurator</strong> at <a href="/" style="color:#a78bfa">${PUBLIC_URL}/</a></div></div>
      <div class="step"><div class="step-n">3</div><div class="step-t"><strong>Add sources</strong> — paste any M3U/JSON URL, auto-detected</div></div>
      <div class="step"><div class="step-n">4</div><div class="step-t"><strong>Sync to Backend</strong> — DRM channels registered automatically</div></div>
      <div class="step"><div class="step-n">5</div><div class="step-t"><strong>Samsung TV</strong> — Stremio → ☰ → Addons → paste manifest URL</div></div>
    </div>

    <div style="display:flex;flex-wrap:wrap">
      <a href="/" class="btn-sm">⚙️ Configurator</a>
      <a href="/health" class="btn-sm">❤️ Health</a>
      <a href="/manifest.json" class="btn-sm" target="_blank">📋 Manifest</a>
      <a href="/drm-playlist.m3u" class="btn-sm">🔐 DRM M3U</a>
      <a href="/api/drm" class="btn-sm">🔑 DRM Registry</a>
    </div>
  </div>
  <footer>Jash IPTV v${manifest.version} · ${ADDON_ID} · ClearKey DRM Proxy</footer>
</div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MAIN HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = urlMod.parse(req.url, true);
  const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  const query    = parsed.query;
  debug(`${req.method} ${pathname}`);

  // ══════════════════════════════════════════════════════════════════════════
  // ██  DRM PROXY ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // ── /play/:id — Fetch MPD, inject license URL, return modified MPD ────────
  // id can be either:
  //   A) A registered DRM registry key (from Stremio stream handler)
  //   B) A base64url-encoded JSON payload from the frontend player:
  //      btoa(JSON.stringify({url,kid,key})) with +→- /→_ =removed
  const playM = pathname.match(/^\/play\/([^/]+)$/);
  if (playM) {
    const channelId = playM[1];
    let ch = drmRegistry.get(channelId);

    // If not in registry, try to decode as base64url JSON payload (from frontend)
    if (!ch) {
      try {
        // Restore base64 padding and standard chars
        const b64 = channelId.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        const payload = JSON.parse(decoded);
        if (payload.url && payload.kid && payload.key) {
          ch = {
            id      : channelId,
            name    : payload.name || 'Stream',
            logo    : payload.logo || '',
            url     : payload.url,
            kid     : payload.kid.trim().toLowerCase(),
            key     : payload.key.trim().toLowerCase(),
            cookie  : payload.cookie  || '',
            userAgent: payload.userAgent || DEFAULT_UA,
            referer : payload.referer || '',
            group   : payload.group  || 'Uncategorized',
          };
          // Cache it in registry for subsequent /license/:id and /seg/:id calls
          drmRegistry.set(channelId, ch);
          log(`[PLAY] Decoded frontend payload for "${ch.name}"`);
        }
      } catch (_) {
        // Not a valid base64url JSON — fall through to 404
      }
    }

    if (!ch) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`Channel ${channelId} not found in DRM registry. Sync from configurator first.`);
    }

    try {
      log(`[PLAY] ${channelId} → ${ch.url.slice(0, 80)}`);
      const headers = {
        'User-Agent': ch.userAgent || DEFAULT_UA,
        'Accept'    : 'application/dash+xml, application/xml, */*',
      };
      if (ch.cookie)  headers['Cookie']  = ch.cookie;
      if (ch.referer) headers['Referer'] = ch.referer;

      const mpdContent = await fetchText(ch.url, headers);

      if (!mpdContent || (!mpdContent.includes('<MPD') && !mpdContent.includes('<?xml'))) {
        log(`[PLAY] Not a valid MPD response for ${channelId}`);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        return res.end('Invalid MPD response from origin');
      }

      const modified = modifyMPD(mpdContent, channelId, ch.url);
      log(`[PLAY] ✅ MPD modified for "${ch.name}" (${modified.length} bytes)`);

      res.writeHead(200, {
        'Content-Type'               : 'application/dash+xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control'              : 'no-cache, no-store',
        'X-Channel-Name'             : ch.name,
      });
      return res.end(modified);
    } catch(e) {
      err(`[PLAY] Error for ${channelId}: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end(`Error fetching stream: ${e.message}`);
    }
  }

  // ── /license/:id — Return ClearKey JSON license response ─────────────────
  const licM = pathname.match(/^\/license\/([^/]+)$/);
  if (licM) {
    const channelId = licM[1];
    let ch = drmRegistry.get(channelId);

    // Try decoding base64url JSON payload if not in registry
    if (!ch) {
      try {
        const b64    = channelId.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        if (payload.url && payload.kid && payload.key) {
          ch = {
            id      : channelId,
            name    : payload.name || 'Stream',
            url     : payload.url,
            kid     : payload.kid.trim().toLowerCase(),
            key     : payload.key.trim().toLowerCase(),
            cookie  : payload.cookie   || '',
            userAgent: payload.userAgent || DEFAULT_UA,
            referer : payload.referer  || '',
            group   : payload.group    || 'Uncategorized',
          };
          drmRegistry.set(channelId, ch);
        }
      } catch (_) { /* not a payload */ }
    }

    if (!ch) {
      res.writeHead(404, {
        'Content-Type'               : 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(JSON.stringify({ error: `Channel ${channelId} not in DRM registry` }));
    }

    try {
      const licenseResponse = buildClearKeyResponse(ch.kid, ch.key);
      log(`[LICENSE] ✅ Keys for "${ch.name}" (${channelId})`);
      debug(`[LICENSE] kid=${ch.kid.slice(0, 8)}… key=${ch.key.slice(0, 8)}…`);

      // Accept body if POST (license request body — we don't need to parse it for ClearKey)
      if (req.method === 'POST') {
        req.resume(); // Drain body
      }

      res.writeHead(200, {
        'Content-Type'               : 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, *',
        'Cache-Control'              : 'no-cache',
      });
      return res.end(JSON.stringify(licenseResponse));
    } catch(e) {
      err(`[LICENSE] Error for ${channelId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ── /seg/:id — Proxy DASH segments with auth headers ─────────────────────
  const segM = pathname.match(/^\/seg\/([^/]+)$/);
  if (segM) {
    const channelId = segM[1];
    const segUrl    = query.u ? decodeURIComponent(String(query.u)) : '';

    if (!segUrl) {
      res.writeHead(400); return res.end('Missing ?u= segment URL');
    }

    const ch = drmRegistry.get(channelId);
    const headers = {
      'User-Agent': (ch?.userAgent || DEFAULT_UA),
      'Accept'    : '*/*',
    };
    if (ch?.cookie)  headers['Cookie']  = ch.cookie;
    if (ch?.referer) headers['Referer'] = ch.referer;

    try {
      debug(`[SEG] ${channelId} → ${segUrl.slice(0, 80)}`);
      const { body: segBody, headers: resHeaders } = await fetchUrl(segUrl, headers);
      const ct = resHeaders['content-type'] || 'video/mp4';
      res.writeHead(200, {
        'Content-Type'               : ct,
        'Content-Length'             : segBody.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control'              : 'public, max-age=300',
      });
      return res.end(segBody);
    } catch(e) {
      err(`[SEG] Error: ${e.message}`);
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      return res.end('Segment fetch failed: ' + e.message);
    }
  }

  // ── /api/drm — DRM registry info ─────────────────────────────────────────
  if (pathname === '/api/drm') {
    noCache(res);
    const channels = [...drmRegistry.entries()].map(([id, ch]) => ({
      id,
      name    : ch.name,
      logo    : ch.logo,
      group   : ch.group,
      hasKey  : !!(ch.kid && ch.key),
      playUrl : `${PUBLIC_URL}/play/${id}`,
      licenseUrl: `${PUBLIC_URL}/license/${id}`,
    }));
    return json(res, { count: channels.length, channels });
  }

  // ── /api/drm-register (POST) ─────────────────────────────────────────────
  if (pathname === '/api/drm-register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const ch = JSON.parse(body);
        const id = registerDRMChannel(ch);
        if (!id) return json(res, { ok: false, error: 'Invalid DRM channel — need url + licenseKey (kid:key)' }, 400);
        return json(res, { ok: true, id, playUrl: `${PUBLIC_URL}/play/${id}`, licenseUrl: `${PUBLIC_URL}/license/${id}` });
      } catch(e) {
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  API ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // ── /health ───────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    noCache(res);
    const streams  = getEnabledStreams();
    const groups   = getGroups();
    const autoComb = buildAutoCombined(streams);
    const manifest = buildManifest();
    return json(res, {
      status      : 'ok',
      uptime      : Math.round(process.uptime()),
      publicUrl   : PUBLIC_URL,
      version     : manifest.version,
      streams     : streams.length,
      groups      : groups.length,
      autoCombined: autoComb.length,
      catalogs    : manifest.catalogs.length,
      drmChannels : drmRegistry.size,
      cacheSize   : hlsCache.size,
      manifestUrl : `${PUBLIC_URL}/manifest.json`,
      installUrl  : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`,
      drmProxyUrl : `${PUBLIC_URL}/play/:id`,
      streamTypes : {
        hls   : streams.filter(s => detectType(s) === 'hls').length,
        dash  : streams.filter(s => detectType(s) === 'dash').length,
        drm   : streams.filter(hasDRM).length,
        direct: streams.filter(s => detectType(s) === 'direct').length,
      },
    });
  }

  // ── /api/sync (POST) ──────────────────────────────────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body);

        if (Array.isArray(cfg.sources)) {
          cfg.sources = cfg.sources.map(s => s.url ? { ...s, url: normalizeSourceUrl(s.url) } : s);
        }
        if (!Array.isArray(cfg.streams)) {
          return json(res, { ok: false, error: 'streams must be an array' }, 400);
        }

        // Re-fetch URL sources that returned 0 streams from the frontend
        let serverFetched = 0;
        if (Array.isArray(cfg.sources)) {
          for (const src of cfg.sources) {
            if (!src.url || src.type === 'file' || src.type === 'manual') continue;
            if (src.enabled === false) continue;
            const srcStreams = cfg.streams.filter(s => s.sourceId === src.id);
            if (srcStreams.length === 0) {
              log(`[SYNC] Server-fetch "${src.name || src.url}"`);
              const fetched = await fetchAndParseSource(src.url, src.id, src.name || src.url);
              if (fetched.length > 0) {
                cfg.streams = cfg.streams.filter(s => s.sourceId !== src.id).concat(fetched);
                serverFetched += fetched.length;
              }
            }
          }
        }

        // Write config
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        hlsCache.clear();

        // Rebuild DRM registry from new config
        rebuildDRMRegistry();

        const enabled  = cfg.streams.filter(s => s.enabled !== false);
        const autoComb = buildAutoCombined(enabled);
        const manifest = buildManifest();
        log(`[SYNC] ✅ ${enabled.length} streams | ${drmRegistry.size} DRM | v${manifest.version} | ${autoComb.length} combined | +${serverFetched} server-fetched`);

        return json(res, {
          ok          : true,
          streams     : enabled.length,
          autoCombined: autoComb.length,
          groups      : getGroups().length,
          drmChannels : drmRegistry.size,
          version     : manifest.version,
          manifestUrl : `${PUBLIC_URL}/manifest.json`,
          installUrl  : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`,
          playlistUrl : `${PUBLIC_URL}/p.m3u`,
          drmPlaylist : `${PUBLIC_URL}/drm-playlist.m3u`,
          serverFetched,
        });
      } catch(e) {
        err('[SYNC]', e.message);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── /api/fetch-source (POST) ──────────────────────────────────────────────
  // Returns raw content so frontend can parse it locally.
  // This is the ONLY fetch path — no browser-side CORS proxies needed.
  if (pathname === '/api/fetch-source' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) return json(res, { error: 'url is required' }, 400);

        const normalized = normalizeSourceUrl(url.trim());
        const lower = normalized.toLowerCase();
        log(`[FETCH-SOURCE] ${normalized.slice(0, 80)}`);

        // Fetch directly — no CORS proxy, direct server-to-server request
        const { body: rawBuf, contentType, headers: resHeaders } = await fetchUrl(normalized, {
          'User-Agent': DEFAULT_UA,
          'Accept'    : 'text/plain, application/json, application/x-mpegurl, */*',
        });
        const rawStr = rawBuf.toString('utf8');

        // Extract from HTML if needed
        let content = rawStr;
        let extractedFrom = 'direct';
        if (isHtml(contentType, rawStr)) {
          const extracted = extractFromHtml(rawStr);
          if (extracted) {
            content = extracted;
            extractedFrom = 'html-extracted';
            log(`[FETCH-SOURCE] Extracted ${content.length} bytes from HTML`);
          } else {
            content = rawStr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            extractedFrom = 'html-stripped';
          }
        }

        // Detect format
        const trimmed = content.trimStart();
        let format = 'unknown';
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try { JSON.parse(content); format = 'json'; } catch { format = 'json'; }
        } else if (
          trimmed.startsWith('#EXTM3U') ||
          trimmed.startsWith('#EXTINF') ||
          trimmed.startsWith('#EXT-X-') ||
          content.includes('#EXTINF')
        ) {
          format = 'm3u';
        } else if (/\.(m3u8?)(\?|$)/i.test(lower)) {
          format = 'm3u';
        } else if (/\.json(\?|$)/i.test(lower)) {
          format = 'json';
        }

        log(`[FETCH-SOURCE] ✅ ${content.length} bytes | format=${format} | from=${extractedFrom}`);

        return json(res, {
          content,
          format,
          finalUrl   : resHeaders['x-final-url'] || normalized,
          contentType: contentType || '',
          extractedFrom,
          size       : content.length,
        });
      } catch(e) {
        err('[FETCH-SOURCE]', e.message);
        return json(res, { error: e.message }, 502);
      }
    });
    return;
  }

  // ── /api/config ───────────────────────────────────────────────────────────
  if (pathname === '/api/config') {
    noCache(res);
    return json(res, loadConfig());
  }

  // ── /api/cache (DELETE) ───────────────────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const n = hlsCache.size;
    hlsCache.clear();
    log(`[CACHE] Cleared ${n} HLS entries`);
    return json(res, { ok: true, cleared: n });
  }

  // ── /api/install ──────────────────────────────────────────────────────────
  if (pathname === '/api/install') {
    noCache(res);
    const manifest = buildManifest();
    const host     = PUBLIC_URL.replace(/^https?:\/\//, '');
    return json(res, {
      manifestUrl   : `${PUBLIC_URL}/manifest.json`,
      stremioUrl    : `stremio://${host}/manifest.json`,
      webInstallUrl : `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}`,
      configureUrl  : `${PUBLIC_URL}/`,
      installPageUrl: `${PUBLIC_URL}/install`,
      playlistUrl   : `${PUBLIC_URL}/playlist.m3u`,
      drmPlaylistUrl: `${PUBLIC_URL}/drm-playlist.m3u`,
      shortUrls: {
        m3u     : `${PUBLIC_URL}/p.m3u`,
        iptv    : `${PUBLIC_URL}/iptv.m3u`,
        live    : `${PUBLIC_URL}/live.m3u`,
        channels: `${PUBLIC_URL}/channels.m3u`,
      },
      version     : manifest.version,
      streams     : getEnabledStreams().length,
      groups      : getGroups().length,
      drmChannels : drmRegistry.size,
    });
  }

  // ── /api/playlist-info ────────────────────────────────────────────────────
  if (pathname === '/api/playlist-info') {
    noCache(res);
    const streams = getEnabledStreams();
    const groups  = getGroups();
    return json(res, {
      total      : streams.length,
      groups     : groups.length,
      drmChannels: drmRegistry.size,
      playlistUrl: `${PUBLIC_URL}/playlist.m3u`,
      shortUrls  : {
        all     : `${PUBLIC_URL}/playlist.m3u`,
        short   : `${PUBLIC_URL}/p.m3u`,
        iptv    : `${PUBLIC_URL}/iptv.m3u`,
        live    : `${PUBLIC_URL}/live.m3u`,
        channels: `${PUBLIC_URL}/channels.m3u`,
        drm     : `${PUBLIC_URL}/drm-playlist.m3u`,
      },
      groupUrls: groups.map(g => ({
        group: g.name,
        url  : `${PUBLIC_URL}/playlist/${encodeURIComponent(g.name)}.m3u`,
        count: streams.filter(s => (s.group || 'Uncategorized') === g.name).length,
      })),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  STREMIO ADDON ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  if (pathname === '/manifest.json') {
    noCache(res);
    const m = buildManifest();
    log(`[MANIFEST] v${m.version} | ${m.catalogs.length} catalogs | ${getEnabledStreams().length} streams | ${drmRegistry.size} DRM`);
    return json(res, m);
  }

  const catM = pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    noCache(res);
    const catId = decodeURIComponent(catM[1]);
    const extra = {};
    if (catM[2]) {
      catM[2].split('/').forEach(seg => {
        const [k, ...v] = seg.split('=');
        if (k) extra[k] = decodeURIComponent(v.join('=') || '');
      });
    }
    if (query.extra)  Object.assign(extra, parseExtra(String(query.extra)));
    if (query.search) extra.search = String(query.search);
    if (query.skip)   extra.skip   = String(query.skip);
    return json(res, handleCatalog(catId, extra));
  }

  const metaM = pathname.match(/^\/meta\/tv\/(.+)\.json$/);
  if (metaM) {
    noCache(res);
    return json(res, handleMeta(metaM[1]));
  }

  const streamM = pathname.match(/^\/stream\/tv\/(.+)\.json$/);
  if (streamM) {
    noCache(res);
    try {
      return json(res, await handleStream(streamM[1]));
    } catch(e) {
      err('[STREAM]', e.message);
      return json(res, { streams: [] });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  M3U PLAYLIST ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const PLAYLIST_ALIASES    = ['/playlist.m3u', '/p.m3u', '/iptv.m3u', '/live.m3u', '/channels.m3u'];
  const groupPlaylistM      = pathname.match(/^\/playlist\/(.+)\.m3u$/);
  const isDRMPlaylist       = pathname === '/drm-playlist.m3u';

  if (PLAYLIST_ALIASES.includes(pathname) || groupPlaylistM || isDRMPlaylist) {
    const filterGroup = groupPlaylistM ? decodeURIComponent(groupPlaylistM[1]) : null;
    const allStreams   = getEnabledStreams();
    const filtered    = filterGroup
      ? allStreams.filter(s => (s.group || 'Uncategorized') === filterGroup)
      : allStreams;
    const settings    = getSettings();
    const pName       = filterGroup ? `${settings.addonName} - ${filterGroup}` : settings.addonName;
    const useDRMProxy = isDRMPlaylist;

    if (!filtered.length) {
      res.writeHead(filterGroup ? 404 : 200, { 'Content-Type': 'text/plain;charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(filterGroup
        ? `# Group "${filterGroup}" not found.`
        : '#EXTM3U\n# No streams yet. Open the configurator and add sources.'
      );
    }

    const content = generateM3U(filtered, pName, useDRMProxy);
    const fname   = filterGroup ? `${filterGroup.replace(/\s+/g, '-')}.m3u` : (isDRMPlaylist ? 'drm-playlist.m3u' : 'playlist.m3u');

    res.writeHead(200, {
      'Content-Type'               : 'application/x-mpegurl;charset=utf-8',
      'Content-Disposition'        : `inline;filename="${fname}"`,
      'Content-Length'             : Buffer.byteLength(content, 'utf8'),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control'              : 'no-cache,no-store',
      'X-Stream-Count'             : String(filtered.length),
      'X-DRM-Channels'             : String(filtered.filter(hasDRM).length),
    });
    log(`[M3U] ${filtered.length} streams → ${pathname}${useDRMProxy ? ' [DRM-PROXY]' : ''}`);
    return res.end(content);
  }

  // ── Logo / Favicon ────────────────────────────────────────────────────────
  if (pathname === '/logo.png' || pathname === '/favicon.ico') {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#4F46E5"/>` +
      `</linearGradient></defs>` +
      `<rect width="200" height="200" rx="40" fill="url(#g)"/>` +
      `<text x="100" y="128" font-size="90" text-anchor="middle" fill="white">📡</text>` +
      `<text x="100" y="175" font-size="22" font-family="Arial,sans-serif" font-weight="bold" text-anchor="middle" fill="rgba(255,255,255,0.85)">JASH</text>` +
      `</svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public,max-age=86400' });
    return res.end(svg);
  }

  // ── /install ──────────────────────────────────────────────────────────────
  if (pathname === '/install' || pathname === '/addon') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(installPage());
  }

  if (pathname === '/configure') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // ── Static files / SPA ────────────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const reqPath  = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const safePath = path.resolve(DIST_DIR, reqPath);
    if (!safePath.startsWith(path.resolve(DIST_DIR))) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return serveFile(res, safePath);
    }
    return serveFile(res, path.join(DIST_DIR, 'index.html'));
  }

  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(installPage());
});

// ─── Error handling ───────────────────────────────────────────────────────────
process.on('uncaughtException',  e => err('Uncaught:', e.message));
process.on('unhandledRejection', r => err('Unhandled:', String(r)));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { err(`Port ${PORT} in use`); process.exit(1); }
  err('Server error:', e.message);
});

// ─── TCP keepalive ────────────────────────────────────────────────────────────
server.on('connection', socket => {
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(120_000);
  socket.on('timeout', () => socket.destroy());
});

// ═══════════════════════════════════════════════════════════════════════════════
// ██  SELF-PING KEEPALIVE (prevents Render/Koyeb free tier sleep)
// ═══════════════════════════════════════════════════════════════════════════════

function startKeepalive() {
  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  const pingUrl  = `${PUBLIC_URL}/health`;
  setInterval(() => {
    const lib = pingUrl.startsWith('https') ? https : http;
    const req  = lib.get(pingUrl, { timeout: 10000 }, res => {
      res.resume();
      debug(`[KEEPALIVE] ✓ ${res.statusCode}`);
    });
    req.on('error',   e => debug(`[KEEPALIVE] ✗ ${e.message}`));
    req.on('timeout', () => { req.destroy(); });
  }, INTERVAL);
  log(`[KEEPALIVE] Active — every 14 min → ${pingUrl}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  START
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  // Build DRM registry from existing config
  rebuildDRMRegistry();

  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const autoComb = buildAutoCombined(streams);
  const manifest = buildManifest();
  const host     = PUBLIC_URL.replace(/^https?:\/\//, '');

  log('═══════════════════════════════════════════════════════════════════');
  log(`🚀  Jash IPTV Addon v15.0 — ClearKey DRM Proxy`);
  log(`📡  Port        : ${PORT}`);
  log(`🌐  Public URL  : ${PUBLIC_URL}`);
  log('───────────────────────────────────────────────────────────────────');
  log(`📺  Manifest    : ${PUBLIC_URL}/manifest.json`);
  log(`🔌  Install     : stremio://${host}/manifest.json`);
  log(`⚙️   Configurator: ${PUBLIC_URL}/`);
  log(`❤️   Health     : ${PUBLIC_URL}/health`);
  log(`📻  M3U         : ${PUBLIC_URL}/p.m3u`);
  log(`🔐  DRM M3U     : ${PUBLIC_URL}/drm-playlist.m3u`);
  log(`🔑  DRM Proxy   : ${PUBLIC_URL}/play/:id → MPD | ${PUBLIC_URL}/license/:id → Keys`);
  log('───────────────────────────────────────────────────────────────────');
  log(`📊  Streams     : ${streams.length} | Groups: ${groups.length} | Combined: ${autoComb.length}`);
  log(`🔐  DRM Channels: ${drmRegistry.size} registered`);
  log(`📋  Catalogs    : ${manifest.catalogs.length} | Version: ${manifest.version}`);
  log(`🔍  Types       : HLS=${streams.filter(s=>detectType(s)==='hls').length} DASH=${streams.filter(s=>detectType(s)==='dash').length} DRM=${streams.filter(hasDRM).length}`);
  log('═══════════════════════════════════════════════════════════════════');

  if (!PUBLIC_URL.includes('localhost') && !PUBLIC_URL.includes('127.0.0.1')) {
    startKeepalive();
  } else {
    log('[KEEPALIVE] Disabled on localhost');
  }
});
