#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║           JASH ADDON — Backend Server v6.0                               ║
 * ║   Stremio IPTV Addon · Samsung Tizen HLS Extraction Engine              ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  ARCHITECTURE:                                                           ║
 * ║  • Reads streams-config.json on EVERY request (always fresh)            ║
 * ║  • Works immediately on first deploy — no sync needed                   ║
 * ║  • Sync from frontend just writes the JSON file                         ║
 * ║  • Multi-quality streams → combined into one catalog entry              ║
 * ║  • Custom combined streams → one entry with manual name                 ║
 * ║  • Alphabetical sort within groups                                      ║
 * ║  • Full HLS master→variant→segment extraction (Samsung Tizen fix)       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

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
const REQ_TIMEOUT = 12000;
const CACHE_TTL   = 5 * 60 * 1000; // 5 min

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}] [JASH]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DBG]`, ...a);
const error = (...a) => console.error(`[${ts()}] [ERR]`, ...a);

// ─── Stream Resolution Cache ──────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG LOADING — reads JSON file on every call (always fresh, no restart needed)
// ═══════════════════════════════════════════════════════════════════════════════

function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) {
      return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() };
    }
    const raw = fs.readFileSync(CFG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    error('loadConfig:', e.message);
    return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() };
  }
}

function defaultSettings() {
  return {
    addonId            : 'jash-iptv-addon',
    addonName          : 'Jash IPTV',
    combineMultiQuality: true,
    sortAlphabetically : true,
  };
}

/**
 * Get all enabled streams, sorted by:
 *  1. Manual order (order field) if sortAlphabetically is OFF
 *  2. Group title A→Z then Channel name A→Z if sortAlphabetically is ON
 */
function getEnabledStreams() {
  const cfg      = loadConfig();
  const settings = cfg.settings || defaultSettings();
  const streams  = (cfg.streams || []).filter(s => s.enabled !== false);

  if (settings.sortAlphabetically) {
    return streams.sort((a, b) => {
      const ga = (a.group || 'Uncategorized').toLowerCase();
      const gb = (b.group || 'Uncategorized').toLowerCase();
      if (ga < gb) return -1;
      if (ga > gb) return  1;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
  }

  // Manual order
  return streams.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Get groups — from config or derived from streams.
 * Always sorted alphabetically by group name.
 */
function getGroups() {
  const cfg     = loadConfig();
  const streams = getEnabledStreams();

  if (cfg.groups && cfg.groups.length) {
    return cfg.groups
      .filter(g => g.enabled !== false && streams.some(s => (s.group || 'Uncategorized') === g.name))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  // Derive from streams
  const seen = new Set();
  const out  = [];
  for (const s of streams) {
    const g = s.group || 'Uncategorized';
    if (!seen.has(g)) { seen.add(g); out.push({ id: `g_${out.length}`, name: g }); }
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function getSettings() {
  return { ...defaultSettings(), ...(loadConfig().settings || {}) };
}

/**
 * Get custom combined channels — streams manually combined under one name.
 * Returns array of: { id, name, group, logo, streamUrls: [url, ...] }
 */
function getCombinedChannels() {
  const cfg = loadConfig();
  return (cfg.combinedChannels || []).filter(c => c.enabled !== false);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHANNEL GROUPING — for multi-quality support
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Group streams by name+group into channel entries.
 * Each channel entry may have multiple quality streams.
 * Returns Map<key, { id, name, group, logo, streams[] }>
 */
function groupByChannel(streams, combineMultiQuality) {
  const map = new Map();

  for (const s of streams) {
    const group = s.group || 'Uncategorized';
    const key   = combineMultiQuality ? `${group}||${s.name}` : s.id;

    if (!map.has(key)) {
      map.set(key, {
        id     : 'jash:' + encodeId(s.url),  // Primary stream URL as ID
        name   : s.name,
        group,
        logo   : s.logo  || '',
        tvgId  : s.tvgId || '',
        streams: [],
      });
    }
    map.get(key).streams.push(s);
  }

  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANIFEST — built dynamically on each request, always reflects current config
// ═══════════════════════════════════════════════════════════════════════════════

function buildManifest() {
  const settings  = getSettings();
  const groups    = getGroups();
  const streams   = getEnabledStreams();
  const combined  = getCombinedChannels();
  const addonId   = settings.addonId   || 'jash-iptv-addon';
  const addonName = settings.addonName || 'Jash IPTV';

  // Version is based on config file mtime — changes whenever config is written
  let version = '2.0';
  try {
    const stat = fs.statSync(CFG_FILE);
    version = `2.${Math.floor(stat.mtimeMs / 1000)}`;
  } catch { /* first run, no file yet */ }

  // Build catalogs: one per group (alphabetically sorted)
  const catalogs = groups.map((g, i) => ({
    type : 'tv',
    id   : `jash_cat_${i}`,
    name : g.name,
    extra: [{ name: 'search', isRequired: false }],
  }));

  // Add combined channels catalog if any exist
  if (combined.length > 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_cat_combined',
      name : '⭐ Combined Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  // Fallback placeholder so Stremio accepts the manifest even with no streams
  if (!catalogs.length) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_cat_default',
      name : 'IPTV Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  return {
    id           : addonId,
    version,
    name         : addonName,
    description  : `${addonName} · Samsung Tizen Optimized IPTV · ${streams.length} channels · HLS Extraction`,
    logo         : `${PUBLIC_URL}/favicon.ico`,
    transportUrl : `${PUBLIC_URL}/manifest.json`,
    resources    : ['catalog', 'meta', 'stream'],
    types        : ['tv'],
    idPrefixes   : ['jash:'],
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

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOG HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleCatalog(catId, extra) {
  const groups   = getGroups();
  const streams  = getEnabledStreams();
  const settings = getSettings();
  const combined = getCombinedChannels();

  // ── Combined channels catalog ─────────────────────────────────────────────
  if (catId === 'jash_cat_combined') {
    let list = combined;
    if (extra && extra.search) {
      const q = extra.search.toLowerCase();
      list    = list.filter(c => c.name.toLowerCase().includes(q));
    }
    const metas = list.map(c => ({
      id         : `jash:combined:${c.id}`,
      type       : 'tv',
      name       : c.name,
      poster     : c.logo || null,
      background : c.logo || null,
      logo       : c.logo || null,
      description: `${c.group || 'Combined'} · ${c.streamUrls.length} stream${c.streamUrls.length > 1 ? 's' : ''}`,
      genres     : [c.group || 'Combined'],
    }));
    debug(`[CATALOG] Combined → ${metas.length} channels`);
    return { metas };
  }

  // ── Normal group catalog ──────────────────────────────────────────────────
  let group;
  const idxMatch = catId.match(/^jash_cat_(\d+)$/);
  if (idxMatch) {
    group = groups[parseInt(idxMatch[1], 10)];
  } else {
    group = groups.find(g => g.id === catId || g.name === catId);
  }

  if (!group) {
    debug(`[CATALOG] Unknown catId: ${catId} (groups: ${groups.map(g => g.id).join(', ')})`);
    return { metas: [] };
  }

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    list    = list.filter(s => s.name.toLowerCase().includes(q));
  }

  const channelMap = groupByChannel(list, settings.combineMultiQuality !== false);
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

// ═══════════════════════════════════════════════════════════════════════════════
// META HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleMeta(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* keep as-is */ }

  // Combined channel meta
  if (id.startsWith('jash:combined:')) {
    const cId     = id.replace('jash:combined:', '');
    const combined = getCombinedChannels();
    const c       = combined.find(ch => ch.id === cId);
    if (!c) return { meta: null };
    return {
      meta: {
        id,
        type        : 'tv',
        name        : c.name,
        poster      : c.logo || null,
        logo        : c.logo || null,
        description : `${c.group || 'Combined'} · ${c.streamUrls.length} streams`,
        genres      : [c.group || 'Combined'],
        releaseInfo : 'LIVE',
      },
    };
  }

  // Normal stream meta
  const rawUrl = decodeId(id.replace('jash:', ''));
  const all    = getEnabledStreams();
  const s      = all.find(st => st.url === rawUrl) || all.find(st => st.url.startsWith(rawUrl.slice(0, 40)));

  if (!s) return { meta: null };

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
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAM HANDLER — Core HLS Extraction (Samsung Tizen Fix)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* keep as-is */ }

  const settings  = getSettings();
  const addonName = settings.addonName || 'Jash IPTV';

  // ── Combined channel ───────────────────────────────────────────────────────
  if (id.startsWith('jash:combined:')) {
    const cId     = id.replace('jash:combined:', '');
    const combined = getCombinedChannels();
    const c       = combined.find(ch => ch.id === cId);

    if (!c || !c.streamUrls || !c.streamUrls.length) return { streams: [] };

    log(`[STREAM] Combined channel: "${c.name}" (${c.streamUrls.length} streams)`);
    return resolveAndReturn(
      c.streamUrls.map((url, i) => ({ name: c.streamUrls.length > 1 ? `${c.name} #${i + 1}` : c.name, url })),
      addonName
    );
  }

  // ── Normal channel ─────────────────────────────────────────────────────────
  if (!id.startsWith('jash:')) return { streams: [] };

  const primaryUrl = decodeId(id.replace('jash:', ''));
  if (!primaryUrl) return { streams: [] };

  const all     = getEnabledStreams();
  const primary = all.find(s => s.url === primaryUrl);

  if (!primary) {
    log(`[STREAM] Not in config — serving directly: ${primaryUrl.slice(0, 60)}`);
    return resolveAndReturn([{ name: 'Live', url: primaryUrl }], addonName);
  }

  // Find all quality variants (same name + same group)
  const variants = settings.combineMultiQuality !== false
    ? all.filter(s => s.name === primary.name && (s.group || '') === (primary.group || ''))
    : [primary];

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
      error(`[STREAM] Resolve failed for ${v.url.slice(0, 50)}:`, e.message);
      // Fallback — still return original URL so Stremio can try
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

// ═══════════════════════════════════════════════════════════════════════════════
// HLS EXTRACTION — Your exact Samsung Tizen algorithm
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveStreamUrl(playlistUrl) {
  // Cache check
  const cached = getCached(playlistUrl);
  if (cached) {
    log(`[STREAM] ⚡ Cache hit: ${playlistUrl.slice(0, 50)}`);
    return { url: cached };
  }

  // Only run HLS extraction on HLS streams
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

  log(`[STREAM] Fetching HLS playlist: ${playlistUrl.slice(0, 70)}…`);

  let content;
  try {
    content = await fetchPlaylist(playlistUrl);
  } catch (e) {
    log(`[STREAM] Fetch failed (${e.message}) — using original URL as fallback`);
    return { url: playlistUrl };
  }

  log(`[STREAM] Playlist fetched (${content.length} bytes)`);

  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
    debug('[STREAM] Not an M3U8 response — treating as direct stream');
    return { url: playlistUrl };
  }

  const realUrl = extractRealStreamUrl(content, playlistUrl);

  if (!realUrl) {
    log('[STREAM] extractRealStreamUrl returned null — using original playlist URL');
    return { url: playlistUrl };
  }

  log(`[STREAM] ✅ Real URL: ${realUrl.slice(0, 70)}…`);
  setCache(playlistUrl, realUrl);
  return { url: realUrl };
}

/**
 * extractRealStreamUrl — Samsung Tizen HLS fix.
 *
 * This is your exact working algorithm:
 *   Master playlist → sort variants by BANDWIDTH → pick MIDDLE index
 *   Media playlist  → return first .ts/.m4s segment URL
 *
 * WHY MIDDLE?
 *   Highest bandwidth → Samsung TV buffers (max bitrate too heavy)
 *   Lowest bandwidth  → Poor video quality
 *   Middle bandwidth  → Best stability + quality balance on Tizen
 */
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

      if (!variants.length) {
        debug('[EXTRACT] No variants found in master playlist');
        return null;
      }

      // Sort by bandwidth descending (highest first)
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // ★ KEY: Pick MIDDLE quality for Samsung TV stability
      const idx      = Math.floor(variants.length / 2);
      const selected = variants[idx];

      debug(`[EXTRACT] ${variants.length} variants → selected [${idx}] ${selected.resolution} @ ${selected.bandwidth}bps`);

      // Resolve relative URL
      let vUrl = selected.url;
      if (!vUrl.startsWith('http')) {
        vUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + vUrl;
      }
      return vUrl;

    } else {
      // Media playlist — find first segment URL
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
          debug(`[EXTRACT] Segment found: ${segUrl.slice(0, 70)}`);
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

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH PLAYLIST — with Samsung Tizen User-Agent & redirect following
// ═══════════════════════════════════════════════════════════════════════════════

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
      },
    }, (res) => {
      clearTimeout(timeout);
      if (timedOut) return;

      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redir = new urlMod.URL(res.headers.location, playlistUrl).href;
          debug(`[FETCH] Redirect (${res.statusCode}) → ${redir.slice(0, 70)}`);
          fetchPlaylist(redir, redirectCount + 1).then(resolve).catch(reject);
        } catch (e) { reject(e); }
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} from ${playlistUrl.slice(0, 60)}`));
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

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age',       '86400');
}

function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma',        'no-cache');
  res.setHeader('Expires',       '0');
}

function json(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type'               : 'application/json; charset=utf-8',
    'Content-Length'             : Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control'              : 'no-cache, no-store',
  });
  res.end(body);
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); return res.end('Not found');
  }
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
    '.txt'  : 'text/plain',
  }[ext] || 'application/octet-stream';

  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type' : mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
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

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = urlMod.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const query    = parsed.query;

  debug(`${req.method} ${pathname}`);

  // ── /health ────────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    noCache(res);
    const streams  = getEnabledStreams();
    const groups   = getGroups();
    const settings = getSettings();
    return json(res, {
      status     : 'ok',
      addon      : settings.addonName || 'Jash IPTV',
      streams    : streams.length,
      groups     : groups.length,
      cache      : streamCache.size,
      uptime     : Math.round(process.uptime()),
      publicUrl  : PUBLIC_URL,
      manifestUrl: `${PUBLIC_URL}/manifest.json`,
    });
  }

  // ── /api/sync (POST) ────────────────────────────────────────────────────────
  // Frontend pushes config here. We just write the file — next request picks it up.
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg   = JSON.parse(body);
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');

        // Clear resolution cache so next play re-extracts fresh HLS URLs
        streamCache.clear();

        const count    = (cfg.streams || []).filter(s => s.enabled !== false).length;
        const combined = (cfg.combinedChannels || []).length;

        log(`[SYNC] ✅ ${count} streams, ${combined} combined channels`);

        // Return the new manifest version so frontend can confirm
        let version = '2.0';
        try {
          const stat = fs.statSync(CFG_FILE);
          version    = `2.${Math.floor(stat.mtimeMs / 1000)}`;
        } catch { /* ignore */ }

        return json(res, { ok: true, streams: count, combined, version });
      } catch (e) {
        error('[SYNC]', e.message);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── /api/config (GET) ───────────────────────────────────────────────────────
  if (pathname === '/api/config' && req.method === 'GET') {
    noCache(res);
    return json(res, loadConfig());
  }

  // ── /api/cache (DELETE) ─────────────────────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const n = streamCache.size;
    streamCache.clear();
    log(`[CACHE] Cleared ${n} entries`);
    return json(res, { ok: true, cleared: n });
  }

  // ── /manifest.json ──────────────────────────────────────────────────────────
  if (pathname === '/manifest.json') {
    noCache(res);
    const manifest = buildManifest();
    log(`[MANIFEST] v${manifest.version} · ${manifest.catalogs.length} catalogs · ${getEnabledStreams().length} streams`);
    return json(res, manifest);
  }

  // ── /catalog/tv/:catId[/extra].json ─────────────────────────────────────────
  const catM = pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    noCache(res);
    const catId = decodeURIComponent(catM[1]);
    let   extra = {};
    if (catM[2]) {
      catM[2].split('&').forEach(p => {
        const [k, ...v] = p.split('=');
        if (k) extra[k] = decodeURIComponent(v.join('=') || '');
      });
    }
    if (query.extra)  Object.assign(extra, parseExtra(query.extra));
    if (query.search) extra.search = query.search;

    return json(res, handleCatalog(catId, extra));
  }

  // ── /meta/tv/:id.json ────────────────────────────────────────────────────────
  const metaM = pathname.match(/^\/meta\/tv\/([^/]+)\.json$/);
  if (metaM) {
    return json(res, handleMeta(metaM[1]));
  }

  // ── /stream/tv/:id.json ──────────────────────────────────────────────────────
  const streamM = pathname.match(/^\/stream\/tv\/([^/]+)\.json$/);
  if (streamM) {
    noCache(res);
    log(`[STREAM] Request: ${streamM[1].slice(0, 80)}`);
    try {
      return json(res, await handleStream(streamM[1]));
    } catch (e) {
      error('[STREAM] Unhandled error:', e.message);
      return json(res, { streams: [] });
    }
  }

  // ── /configure → redirect to SPA ────────────────────────────────────────────
  if (pathname === '/configure') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // ── Static files / SPA fallback ─────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const safePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

    // Path traversal guard
    if (!path.resolve(safePath).startsWith(path.resolve(DIST_DIR))) {
      res.writeHead(403); return res.end('Forbidden');
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return serveStatic(res, safePath);
    }

    // SPA fallback — return index.html for all unknown paths
    return serveStatic(res, path.join(DIST_DIR, 'index.html'));
  }

  // No build yet — info page
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Jash Addon</title>
  <style>
    body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem;max-width:640px;margin:0 auto}
    h1{color:#a78bfa}a{color:#818cf8}
    code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:.9em}
    .ok{color:#34d399}.warn{color:#fbbf24}
    pre{background:#1e293b;padding:1rem;border-radius:8px;overflow-x:auto;font-size:.8em}
    hr{border-color:#334155;margin:1.5rem 0}
  </style>
</head>
<body>
  <h1>🚀 Jash Addon — Backend v6.0</h1>
  <p class="warn">⚠️ Frontend not built yet.</p>
  <p>Run: <code>npm run build</code> then restart the server.</p>
  <hr>
  <p>📋 Manifest : <a href="/manifest.json">/manifest.json</a></p>
  <p>❤️ Health   : <a href="/health">/health</a></p>
  <p class="ok">✅ Backend API is running correctly.</p>
</body>
</html>`);
});

// ─── Process Guards ───────────────────────────────────────────────────────────
process.on('uncaughtException',  e => error('Uncaught:', e.message));
process.on('unhandledRejection', r => error('Unhandled:', r));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    error(`Port ${PORT} already in use — set PORT env var to a different port`);
    process.exit(1);
  }
  error('Server error:', e.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const settings = getSettings();

  log('═══════════════════════════════════════════════════════════════');
  log(`🚀  ${settings.addonName} — Jash Addon Backend v6.0`);
  log(`📡  Listening  : http://0.0.0.0:${PORT}`);
  log(`🌐  Public URL : ${PUBLIC_URL}`);
  log(`📋  Manifest   : ${PUBLIC_URL}/manifest.json`);
  log(`⚙️   Config UI  : ${PUBLIC_URL}/`);
  log(`❤️   Health    : ${PUBLIC_URL}/health`);
  log(`📺  Stremio    : stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`);
  log('═══════════════════════════════════════════════════════════════');

  if (streams.length) {
    log(`📺  Loaded: ${streams.length} streams | ${groups.length} groups from config file`);
    log(`🔤  Sort: ${settings.sortAlphabetically ? 'Alphabetical (group → name)' : 'Manual order'}`);
    log(`🎬  Multi-quality combine: ${settings.combineMultiQuality !== false ? 'ON' : 'OFF'}`);
  } else {
    log(`ℹ️   No streams yet — open ${PUBLIC_URL} to add sources and sync`);
  }
});
