#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         JASH ADDON — IPTV Backend Server v13.0                          ║
 * ║   IPTV Addon  →  /manifest.json  (ready to install in Stremio)          ║
 * ║   HLS/DASH/DRM stream extraction · Samsung Tizen optimized              ║
 * ║   M3U playlist · Keepalive · Auto-combine same channels                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const urlMod = require('url');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '7000', 10);
const DEBUG       = process.env.DEBUG === 'true';
const PUBLIC_URL  = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR    = path.join(__dirname, '..', 'dist');
const CFG_FILE    = path.join(__dirname, 'streams-config.json');
const REQ_TIMEOUT = 20000;
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

// ─── Addon Identity ────────────────────────────────────────────────────────────
const ADDON_ID   = process.env.ADDON_ID   || 'community.jash-iptv';
const ADDON_NAME = process.env.ADDON_NAME || 'Jash IPTV';
const VER_BASE   = '1.0';

// ─── Logger ────────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DBG]`, ...a);
const err   = (...a) => console.error(`[${ts()}] [ERR]`, ...a);

// ─── Stream Cache ──────────────────────────────────────────────────────────────
const streamCache = new Map();
function getCached(k)   { const c = streamCache.get(k); if (c && Date.now() - c.ts < CACHE_TTL) return c.v; streamCache.delete(k); return null; }
function setCache(k, v) { streamCache.set(k, { v, ts: Date.now() }); }

// ─── ID helpers ────────────────────────────────────────────────────────────────
const encodeId = s => Buffer.from(String(s), 'utf8').toString('base64url');
const decodeId = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } };

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CONFIG LOADER
// ═══════════════════════════════════════════════════════════════════════════════

function defaultSettings() {
  return {
    addonId           : ADDON_ID,
    addonName         : ADDON_NAME,
    combineMultiQuality: true,
    sortAlphabetically : true,
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() };
    const raw = fs.readFileSync(CFG_FILE, 'utf8').trim();
    if (!raw || raw === '{}' || raw === '[]') return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() };
    const cfg = JSON.parse(raw);
    return {
      streams         : Array.isArray(cfg.streams)          ? cfg.streams          : [],
      groups          : Array.isArray(cfg.groups)           ? cfg.groups           : [],
      combinedChannels: Array.isArray(cfg.combinedChannels) ? cfg.combinedChannels : [],
      settings        : { ...defaultSettings(), ...(cfg.settings || {}) },
    };
  } catch(e) { err('loadConfig:', e.message); return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() }; }
}

function getSettings()      { return { ...defaultSettings(), ...(loadConfig().settings || {}) }; }

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

// ─── Version from file mtime ───────────────────────────────────────────────────
function getVersion() {
  try {
    if (fs.existsSync(CFG_FILE)) {
      const patch = Math.floor(fs.statSync(CFG_FILE).mtimeMs / 1000) % 100000;
      return `${VER_BASE}.${patch}`;
    }
  } catch { /* ok */ }
  return `${VER_BASE}.0`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  STREAM TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectType(stream) {
  if (stream.streamType) return stream.streamType;
  const u = (stream.url || '').toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('index.m3u')) return 'hls';
  return 'direct';
}

function hasDRM(s) { return !!(s.licenseType || s.licenseKey); }

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CHANNEL NAME NORMALIZER
// Precise — strips ONLY quality/region suffixes, NEVER language/brand words
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
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')  // remove brackets
    .replace(/[\-_\/\\|:]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STRIP_TOKENS.has(w))
    .join(' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  AUTO-COMBINE: same channel from multiple sources → "⭐ Best Streams"
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
    // prefer shortest clean name
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
  const settings  = getSettings();
  const streams   = getEnabledStreams();
  const groups    = getGroups();
  const autoComb  = buildAutoCombined(streams);
  const version   = getVersion();
  const catalogs  = [];

  // ── ⭐ Best Streams (auto-combined from 2+ sources) ────────────────────────
  if (autoComb.length > 0) {
    const bestGenres = [...new Set(autoComb.flatMap(c => c.streams.map(s => s.group)).filter(Boolean))].sort().slice(0, 20);
    catalogs.push({
      type : 'tv',
      id   : 'jash_best',
      name : '⭐ Best Streams',
      extra: [
        { name: 'search', isRequired: false },
        ...(bestGenres.length ? [{ name: 'genre', isRequired: false, options: bestGenres }] : []),
      ],
    });
  }

  // ── One catalog per group ──────────────────────────────────────────────────
  groups.forEach((g, i) => {
    catalogs.push({
      type : 'tv',
      id   : `jash_cat_${i}`,
      name : g.name,
      extra: [{ name: 'search', isRequired: false }],
    });
  });

  // ── Placeholder when no streams yet ───────────────────────────────────────
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
      streams.length  ? `${streams.length.toLocaleString()} channels` : 'Open configurator to add sources',
      groups.length   ? `${groups.length} groups`                    : '',
      'HLS · DASH · DRM · Samsung Tizen',
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
  const genre    = (extra.genre  || '').trim();
  const skip     = parseInt(extra.skip || '0', 10) || 0;
  const PAGE     = 100;

  // ── ⭐ Best Streams catalog ────────────────────────────────────────────────
  if (catId === 'jash_best') {
    let list = buildAutoCombined(streams);
    if (search) list = list.filter(c => c.name.toLowerCase().includes(search));
    if (genre)  list = list.filter(c => c.streams.some(s => s.group === genre));
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

  // ── Placeholder catalog ───────────────────────────────────────────────────
  if (catId === 'jash_cat_default') return { metas: [] };

  // ── Per-group catalog ─────────────────────────────────────────────────────
  const m = catId.match(/^jash_cat_(\d+)$/);
  if (!m) return { metas: [] };
  const group = groups[parseInt(m[1], 10)];
  if (!group) return { metas: [] };

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);
  if (search) list = list.filter(s => s.name.toLowerCase().includes(search));
  if (genre)  list = list.filter(s => s.group === genre);

  // Combine same-name channels (multi-quality) into one entry
  const combined  = settings.combineMultiQuality !== false;
  const seen      = new Map();
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
    description: all.length > 1
      ? `${group.name} · ${all.length} quality options`
      : group.name,
    genres: [group.name],
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

  // Auto-combined channel
  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { meta: null };
    const logo = c.streams.find(s => s.logo)?.logo || null;
    return {
      meta: {
        id, type: 'tv', name: c.name,
        poster     : logo,
        logo,
        description: `${c.sourceCount} sources · ${c.streams.length} streams · ${name}`,
        genres     : [...new Set(c.streams.map(s => s.group).filter(Boolean))],
        releaseInfo: 'LIVE',
      },
    };
  }

  // Single channel
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
// ██  STREAM HANDLER  (with HLS extraction + DRM passthrough + DASH passthrough)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }

  const streams  = getEnabledStreams();
  const settings = getSettings();
  const name     = settings.addonName || ADDON_NAME;
  debug(`[STREAM] id=${id.slice(0, 80)}`);

  // ── Auto-combined channel ──────────────────────────────────────────────────
  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { streams: [] };
    log(`[STREAM] auto-combined "${c.name}" → ${c.streams.length} streams`);
    return resolveVariants(c.streams, name, settings);
  }

  // ── Single / multi-quality channel ────────────────────────────────────────
  if (!id.startsWith('jash')) return { streams: [] };
  const url     = decodeId(id.replace(/^jash/, ''));
  if (!url) return { streams: [] };
  const primary = streams.find(s => s.url === url);

  if (!primary) {
    // Fallback: stream URL not found in config, try direct playback
    return resolveVariants([{ url, name: 'Live', group: '' }], name, settings);
  }

  // Gather all quality variants for this channel
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
    const s      = variants[i];
    const type   = detectType(s);
    const isDRM  = hasDRM(s);
    const label  = variants.length > 1
      ? `[${i + 1}/${variants.length}] ${s.name || 'Stream'}`
      : (s.name || 'Live');

    let resolved = s.url;

    // ── HLS extraction (not DRM, not DASH) ──────────────────────────────────
    if (!isDRM && type === 'hls') {
      try {
        const cached = getCached(s.url);
        if (cached) {
          resolved = cached;
          debug(`[RESOLVE] ⚡ cache hit`);
        } else {
          const extracted = await extractHLS(s.url, s);
          if (extracted && extracted !== s.url) {
            setCache(s.url, extracted);
            resolved = extracted;
          }
        }
      } catch(e) { err(`[RESOLVE] HLS extraction: ${e.message}`); }
    }
    // ── DASH / DRM → pass through with headers ─────────────────────────────
    // (no extraction — Stremio handles MPD parsing + DRM via proxyHeaders)

    const headers = buildHeaders(s);
    let title = `🔴 ${label}`;
    if (isDRM)           title += ` [🔐 ${(s.licenseType || 'DRM').toUpperCase()}]`;
    if (type === 'dash') title += ` [DASH]`;

    const entry = {
      url  : resolved,
      name : addonName,
      title,
      behaviorHints: {
        notWebReady  : true,
        proxyHeaders : { request: headers },
      },
    };

    // DRM key info in description (so Stremio/player can pick it up)
    if (isDRM && s.licenseKey) {
      entry.description = `DRM: ${s.licenseType} | Key: ${s.licenseKey.substring(0, 60)}`;
    }

    results.push(entry);
  }
  return { streams: results };
}

function buildHeaders(s) {
  const ua = s.userAgent ||
    'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36';
  const h = { 'User-Agent': ua };
  if (s.cookie)      h['Cookie']  = s.cookie;
  if (s.referer)     h['Referer'] = s.referer;
  if (s.httpHeaders) Object.entries(s.httpHeaders).forEach(([k, v]) => { if (!h[k]) h[k] = v; });
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HLS EXTRACTION — Samsung Tizen fix
//     Fetches master playlist → picks middle quality variant for stability
// ═══════════════════════════════════════════════════════════════════════════════

async function extractHLS(playlistUrl, streamMeta) {
  log(`[HLS] Fetching: ${playlistUrl.slice(0, 70)}…`);
  const customHeaders = {};
  if (streamMeta?.userAgent)   customHeaders['User-Agent'] = streamMeta.userAgent;
  if (streamMeta?.cookie)      customHeaders['Cookie']     = streamMeta.cookie;
  if (streamMeta?.referer)     customHeaders['Referer']    = streamMeta.referer;
  if (streamMeta?.httpHeaders) Object.assign(customHeaders, streamMeta.httpHeaders);

  let content;
  try { content = await fetchUrl(playlistUrl, customHeaders); }
  catch(e) { log(`[HLS] fetch failed: ${e.message}`); return null; }

  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
    debug('[HLS] response is not M3U8');
    return null;
  }

  return extractRealStreamUrl(content, playlistUrl);
}

function extractRealStreamUrl(content, baseUrl) {
  try {
    const lines    = content.split('\n').map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));

    if (isMaster) {
      // ── Master playlist: extract all variants ──────────────────────────────
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('#EXT-X-STREAM-INF')) continue;
        const bw  = (lines[i].match(/BANDWIDTH=(\d+)/)    || [])[1];
        const res = (lines[i].match(/RESOLUTION=(\d+x\d+)/) || [])[1];
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            variants.push({ url: lines[j], bw: bw ? parseInt(bw) : 0, res: res || '?' });
            break;
          }
        }
      }
      if (!variants.length) return null;

      // Sort highest → lowest bandwidth
      variants.sort((a, b) => b.bw - a.bw);

      // ★ Pick MIDDLE quality — best Samsung TV stability (not too high, not too low)
      const idx      = Math.floor(variants.length / 2);
      const selected = variants[idx];
      debug(`[EXTRACT] ${variants.length} variants → [${idx}] ${selected.res} @${selected.bw}bps`);

      let vUrl = selected.url;
      if (!vUrl.startsWith('http')) {
        vUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + vUrl;
      }
      return vUrl;

    } else {
      // ── Media playlist: find first segment URL ────────────────────────────
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (
          line.includes('.ts')   ||
          line.includes('.m4s')  ||
          line.includes('.m3u8') ||
          line.includes('.mp4')
        ) {
          let segUrl = line;
          if (!segUrl.startsWith('http')) {
            segUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + line;
          }
          debug(`[EXTRACT] segment: ${segUrl.slice(0, 60)}…`);
          return segUrl;
        }
      }
      return null;
    }
  } catch(e) { err('[EXTRACT]', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTTP FETCH  (with redirect support + Samsung UA)
// ═══════════════════════════════════════════════════════════════════════════════

function fetchUrl(url, customHeaders, redirects) {
  redirects     = redirects || 0;
  customHeaders = customHeaders || {};
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new urlMod.URL(url); }
    catch { return reject(new Error('Invalid URL: ' + url)); }

    const lib   = parsed.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => reject(new Error('Request timeout')), REQ_TIMEOUT);

    const reqHeaders = {
      'User-Agent': customHeaders['User-Agent'] ||
        'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
      'Accept'       : '*/*',
      'Cache-Control': 'no-cache',
      ...customHeaders,
    };
    if (!reqHeaders['Referer']) reqHeaders['Referer'] = `${parsed.protocol}//${parsed.hostname}`;

    const req = lib.get({
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      headers : reqHeaders,
    }, res => {
      clearTimeout(timer);
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = new urlMod.URL(res.headers.location, url).href;
        fetchUrl(redir, customHeaders, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data',  c => { data += c; });
      res.on('end',   () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  M3U PLAYLIST GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function generateM3U(streams, playlistName) {
  const lines = [`#EXTM3U x-playlist-name="${playlistName || ADDON_NAME}"`];
  for (const s of streams) {
    const parts = ['#EXTINF:-1'];
    if (s.tvgId) parts.push(`tvg-id="${s.tvgId}"`);
    parts.push(`tvg-name="${(s.tvgName || s.name || '').replace(/"/g, '')}"`);
    if (s.logo) parts.push(`tvg-logo="${s.logo}"`);
    parts.push(`group-title="${(s.group || 'Uncategorized').replace(/"/g, '')}"`);
    lines.push(`${parts.join(' ')},${s.name}`);
    if (s.licenseType && s.licenseKey) {
      lines.push(`#KODIPROP:inputstream.adaptive.license_type=${s.licenseType}`);
      lines.push(`#KODIPROP:inputstream.adaptive.license_key=${s.licenseKey}`);
    }
    if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
    if (s.cookie)    lines.push(`#EXTHTTP:{"cookie":"${s.cookie}"}`);
    lines.push(s.url);
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
    '.html': 'text/html; charset=utf-8',
    '.js'  : 'application/javascript',
    '.css' : 'text/css',
    '.json': 'application/json',
    '.png' : 'image/png',
    '.jpg' : 'image/jpeg',
    '.svg' : 'image/svg+xml',
    '.ico' : 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
    '.txt' : 'text/plain',
  }[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type' : mime,
    'Cache-Control': mime.includes('html') ? 'no-cache' : 'public, max-age=3600',
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
// ██  INSTALL PAGE  (shown when dist/ not built yet or at /install)
// ═══════════════════════════════════════════════════════════════════════════════

function installPage() {
  const manifest = buildManifest();
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const autoComb = buildAutoCombined(streams);
  const host     = PUBLIC_URL.replace(/^https?:\/\//, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jash IPTV Addon — Install</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .wrap{max-width:680px;width:100%}
    .card{background:#1e293b;border:1px solid #334155;border-radius:1.5rem;padding:2rem;margin-bottom:1.5rem;box-shadow:0 25px 50px rgba(0,0,0,.5)}
    h1{color:#a78bfa;font-size:2rem;font-weight:800;text-align:center;margin-bottom:.25rem}
    .sub{color:#64748b;text-align:center;font-size:.9rem;margin-bottom:1.5rem}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin-bottom:1.5rem}
    .stat{background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:.75rem;text-align:center}
    .stat .val{font-size:1.5rem;font-weight:800;color:#a78bfa}
    .stat .lbl{font-size:.65rem;color:#64748b;margin-top:.2rem}
    .url-box{background:#0f172a;border:1px solid #334155;border-radius:.75rem;padding:1rem;margin-bottom:1rem}
    .url-box .lbl{color:#64748b;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem}
    .url-box .val{color:#818cf8;font-family:monospace;font-size:.8rem;word-break:break-all}
    .btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;padding:.875rem 1rem;border-radius:.875rem;font-weight:700;font-size:.95rem;cursor:pointer;text-decoration:none;border:none;margin-bottom:.75rem;transition:all .15s}
    .btn-primary{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff}
    .btn-secondary{background:linear-gradient(135deg,#1e40af,#1d4ed8);color:#fff}
    .btn-sm{background:#1e293b;border:1px solid #475569;color:#cbd5e1;font-size:.8rem;padding:.5rem .875rem;border-radius:.5rem;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem;margin-right:.5rem;margin-bottom:.5rem}
    .step{display:flex;gap:.75rem;margin-bottom:.75rem;align-items:flex-start}
    .step-n{background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;width:1.75rem;height:1.75rem;min-width:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700}
    .step-t{color:#94a3b8;font-size:.85rem;padding-top:.25rem} .step-t strong{color:#e2e8f0}
    .badge{display:inline-flex;align-items:center;gap:.3rem;padding:.2rem .6rem;border-radius:9999px;font-size:.7rem;font-weight:700}
    .badge-green{background:#14532d;color:#4ade80}
    .section-title{color:#94a3b8;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem}
    footer{text-align:center;color:#475569;font-size:.75rem;padding-top:1rem}
    @media(max-width:480px){.stats{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div style="font-size:3.5rem;text-align:center;margin-bottom:.75rem">📡</div>
    <h1>Jash IPTV Addon</h1>
    <p class="sub">HLS · DASH · DRM · Samsung Tizen Optimized <span class="badge badge-green">● LIVE</span></p>

    <div class="stats">
      <div class="stat"><div class="val">${streams.length.toLocaleString()}</div><div class="lbl">Channels</div></div>
      <div class="stat"><div class="val">${groups.length}</div><div class="lbl">Groups</div></div>
      <div class="stat"><div class="val">${autoComb.length}</div><div class="lbl">Auto-Combined</div></div>
      <div class="stat"><div class="val">v${manifest.version}</div><div class="lbl">Version</div></div>
    </div>

    <div class="url-box">
      <div class="lbl">📋 Manifest URL (paste in Stremio)</div>
      <div class="val">${PUBLIC_URL}/manifest.json</div>
    </div>

    <a href="stremio://${host}/manifest.json" class="btn btn-primary">
      📺 Install in Stremio App
    </a>
    <a href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}" class="btn btn-secondary" target="_blank">
      🌐 Install via Stremio Web
    </a>

    <div style="margin:1.25rem 0">
      <div class="section-title">📻 M3U Playlist (Tivimate · OTT Navigator · VLC)</div>
      <div class="url-box">
        <div class="lbl">Shortest URL</div>
        <div class="val">${PUBLIC_URL}/p.m3u</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:.5rem">
        <a href="/p.m3u"        class="btn-sm">⬇️ /p.m3u</a>
        <a href="/playlist.m3u" class="btn-sm">⬇️ /playlist.m3u</a>
        <a href="/iptv.m3u"     class="btn-sm">⬇️ /iptv.m3u</a>
        <a href="/live.m3u"     class="btn-sm">⬇️ /live.m3u</a>
      </div>
    </div>

    <div style="margin-bottom:1.25rem">
      <div class="section-title">🚀 Quick Start</div>
      <div class="step"><div class="step-n">1</div><div class="step-t"><strong>Install the addon</strong> — click the button above in Stremio app or web</div></div>
      <div class="step"><div class="step-n">2</div><div class="step-t"><strong>Open Configurator</strong> at <a href="/" style="color:#a78bfa">${PUBLIC_URL}/</a> — add M3U/JSON sources</div></div>
      <div class="step"><div class="step-n">3</div><div class="step-t"><strong>Sync to Backend</strong> — click "Sync to Backend" in the Backend tab</div></div>
      <div class="step"><div class="step-n">4</div><div class="step-t"><strong>Channels auto-appear</strong> in Stremio — no reinstall needed for changes</div></div>
      <div class="step"><div class="step-n">5</div><div class="step-t"><strong>Samsung TV</strong> — navigate to Stremio → ☰ Menu → Addons → paste manifest URL</div></div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:.5rem">
      <a href="/"                class="btn-sm">⚙️ Configurator</a>
      <a href="/health"          class="btn-sm">❤️ Health</a>
      <a href="/manifest.json"   class="btn-sm" target="_blank">📋 Manifest JSON</a>
      <a href="/p.m3u"           class="btn-sm">📻 M3U Playlist</a>
      <a href="/api/playlist-info" class="btn-sm">📊 Playlist Info</a>
    </div>
  </div>
  <footer>Jash IPTV v${manifest.version} · ${ADDON_ID} · ${PUBLIC_URL}</footer>
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

  // ── /health ──────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    noCache(res);
    const streams  = getEnabledStreams();
    const groups   = getGroups();
    const autoComb = buildAutoCombined(streams);
    const manifest = buildManifest();
    return json(res, {
      status     : 'ok',
      uptime     : Math.round(process.uptime()),
      publicUrl  : PUBLIC_URL,
      version    : manifest.version,
      streams    : streams.length,
      groups     : groups.length,
      autoCombined: autoComb.length,
      catalogs   : manifest.catalogs.length,
      cacheSize  : streamCache.size,
      manifestUrl: `${PUBLIC_URL}/manifest.json`,
      installUrl : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`,
      streamTypes: {
        hls   : streams.filter(s => detectType(s) === 'hls').length,
        dash  : streams.filter(s => detectType(s) === 'dash').length,
        drm   : streams.filter(s => hasDRM(s)).length,
        direct: streams.filter(s => detectType(s) === 'direct').length,
      },
    });
  }

  // ── /api/sync (POST) ─────────────────────────────────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (!Array.isArray(cfg.streams)) {
          return json(res, { ok: false, error: 'streams must be an array' }, 400);
        }
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        streamCache.clear(); // clear cache so next play re-extracts
        const enabled  = cfg.streams.filter(s => s.enabled !== false);
        const autoComb = buildAutoCombined(enabled);
        const manifest = buildManifest();
        log(`[SYNC] ✅ ${enabled.length} streams | v${manifest.version} | ${autoComb.length} auto-combined`);
        return json(res, {
          ok          : true,
          streams     : enabled.length,
          autoCombined: autoComb.length,
          groups      : getGroups().length,
          version     : manifest.version,
          manifestUrl : `${PUBLIC_URL}/manifest.json`,
          installUrl  : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`,
          playlistUrl : `${PUBLIC_URL}/p.m3u`,
        });
      } catch(e) {
        err('[SYNC]', e.message);
        return json(res, { ok: false, error: e.message }, 400);
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
    const n = streamCache.size;
    streamCache.clear();
    log(`[CACHE] Cleared ${n} entries`);
    return json(res, { ok: true, cleared: n });
  }

  // ── /api/install ──────────────────────────────────────────────────────────
  if (pathname === '/api/install') {
    noCache(res);
    const manifest = buildManifest();
    const host     = PUBLIC_URL.replace(/^https?:\/\//, '');
    return json(res, {
      manifestUrl  : `${PUBLIC_URL}/manifest.json`,
      stremioUrl   : `stremio://${host}/manifest.json`,
      webInstallUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}`,
      configureUrl : `${PUBLIC_URL}/`,
      installPageUrl: `${PUBLIC_URL}/install`,
      playlistUrl  : `${PUBLIC_URL}/playlist.m3u`,
      shortUrls    : {
        m3u     : `${PUBLIC_URL}/p.m3u`,
        iptv    : `${PUBLIC_URL}/iptv.m3u`,
        live    : `${PUBLIC_URL}/live.m3u`,
        channels: `${PUBLIC_URL}/channels.m3u`,
      },
      version : manifest.version,
      streams : getEnabledStreams().length,
      groups  : getGroups().length,
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
      playlistUrl: `${PUBLIC_URL}/playlist.m3u`,
      shortUrls  : {
        all     : `${PUBLIC_URL}/playlist.m3u`,
        short   : `${PUBLIC_URL}/p.m3u`,
        iptv    : `${PUBLIC_URL}/iptv.m3u`,
        live    : `${PUBLIC_URL}/live.m3u`,
        channels: `${PUBLIC_URL}/channels.m3u`,
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

  // /manifest.json
  if (pathname === '/manifest.json') {
    noCache(res);
    const m = buildManifest();
    log(`[MANIFEST] v${m.version} | ${m.catalogs.length} catalogs | ${getEnabledStreams().length} streams`);
    return json(res, m);
  }

  // /catalog/tv/:id[/:extra].json
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
    if (query.genre)  extra.genre  = String(query.genre);
    if (query.skip)   extra.skip   = String(query.skip);
    debug(`[CATALOG] ${catId} search="${extra.search || ''}" skip=${extra.skip || 0}`);
    return json(res, handleCatalog(catId, extra));
  }

  // /meta/tv/:id.json
  const metaM = pathname.match(/^\/meta\/tv\/(.+)\.json$/);
  if (metaM) {
    noCache(res);
    return json(res, handleMeta(metaM[1]));
  }

  // /stream/tv/:id.json
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

  const PLAYLIST_ALIASES = ['/playlist.m3u', '/p.m3u', '/iptv.m3u', '/live.m3u', '/channels.m3u'];
  const groupPlaylistM   = pathname.match(/^\/playlist\/(.+)\.m3u$/);

  if (PLAYLIST_ALIASES.includes(pathname) || groupPlaylistM) {
    const filterGroup = groupPlaylistM ? decodeURIComponent(groupPlaylistM[1]) : null;
    const allStreams   = getEnabledStreams();
    const filtered    = filterGroup
      ? allStreams.filter(s => (s.group || 'Uncategorized') === filterGroup)
      : allStreams;
    const settings    = getSettings();
    const pName       = filterGroup
      ? `${settings.addonName} - ${filterGroup}`
      : settings.addonName;

    if (!filtered.length) {
      res.writeHead(filterGroup ? 404 : 200, { 'Content-Type': 'text/plain;charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(filterGroup
        ? `# Group "${filterGroup}" not found or has no streams.`
        : '#EXTM3U\n# No streams yet. Open the configurator and add sources.'
      );
    }

    const content = generateM3U(filtered, pName);
    const fname   = filterGroup ? `${filterGroup.replace(/\s+/g, '-')}.m3u` : 'playlist.m3u';
    res.writeHead(200, {
      'Content-Type'               : 'application/x-mpegurl;charset=utf-8',
      'Content-Disposition'        : `inline;filename="${fname}"`,
      'Content-Length'             : Buffer.byteLength(content, 'utf8'),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control'              : 'no-cache,no-store',
      'X-Stream-Count'             : String(filtered.length),
    });
    log(`[M3U] ${filtered.length} streams → ${pathname}`);
    return res.end(content);
  }

  // ── Logo / Favicon ────────────────────────────────────────────────────────
  if (pathname === '/logo.png' || pathname === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">` +
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

  // ── Static files / SPA ───────────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const reqPath  = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const safePath = path.resolve(DIST_DIR, reqPath);
    // Security: block path traversal
    if (!safePath.startsWith(path.resolve(DIST_DIR))) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return serveFile(res, safePath);
    }
    // SPA fallback
    return serveFile(res, path.join(DIST_DIR, 'index.html'));
  }

  // ── No dist build yet → show install page ────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(installPage());
});

// ─── Error handling ────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => err('Uncaught:', e.message));
process.on('unhandledRejection', r => err('Unhandled:', String(r)));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { err(`Port ${PORT} is already in use`); process.exit(1); }
  err('Server error:', e.message);
});

// ─── TCP keepalive ────────────────────────────────────────────────────────────
server.on('connection', socket => {
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(120_000);
  socket.on('timeout', () => socket.destroy());
});

// ═══════════════════════════════════════════════════════════════════════════════
// ██  SELF-PING KEEPALIVE  (prevents Render/Koyeb free tier from sleeping)
// ═══════════════════════════════════════════════════════════════════════════════

function startKeepalive() {
  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  const pingUrl  = `${PUBLIC_URL}/health`;
  setInterval(() => {
    debug(`[KEEPALIVE] → ${pingUrl}`);
    const lib = pingUrl.startsWith('https') ? https : http;
    const req = lib.get(pingUrl, { timeout: 10000 }, res => {
      debug(`[KEEPALIVE] ✓ ${res.statusCode}`);
      res.resume();
    });
    req.on('error',   e => debug(`[KEEPALIVE] ✗ ${e.message}`));
    req.on('timeout', () => { req.destroy(); debug('[KEEPALIVE] timeout'); });
  }, INTERVAL);
  log(`[KEEPALIVE] Active — self-ping every 14 min → ${pingUrl}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  START
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const autoComb = buildAutoCombined(streams);
  const manifest = buildManifest();
  const host     = PUBLIC_URL.replace(/^https?:\/\//, '');

  log('═══════════════════════════════════════════════════════════════');
  log(`🚀  Jash IPTV Addon v13.0`);
  log(`📡  Port       : ${PORT}`);
  log(`🌐  Public URL : ${PUBLIC_URL}`);
  log('───────────────────────────────────────────────────────────────');
  log(`📺  Manifest   : ${PUBLIC_URL}/manifest.json`);
  log(`🔌  Install    : stremio://${host}/manifest.json`);
  log(`⚙️   Configurator: ${PUBLIC_URL}/`);
  log(`🛠️   Install Page: ${PUBLIC_URL}/install`);
  log(`❤️   Health    : ${PUBLIC_URL}/health`);
  log(`📻  Playlist  : ${PUBLIC_URL}/p.m3u`);
  log('───────────────────────────────────────────────────────────────');
  log(`📊  Streams    : ${streams.length} | Groups: ${groups.length} | Auto-Combined: ${autoComb.length}`);
  log(`📋  Catalogs   : ${manifest.catalogs.length} | Version: ${manifest.version}`);
  log(`💾  Stream types: HLS=${streams.filter(s=>detectType(s)==='hls').length} DASH=${streams.filter(s=>detectType(s)==='dash').length} DRM=${streams.filter(s=>hasDRM(s)).length} Direct=${streams.filter(s=>detectType(s)==='direct').length}`);
  log('═══════════════════════════════════════════════════════════════');

  if (!PUBLIC_URL.includes('localhost') && !PUBLIC_URL.includes('127.0.0.1')) {
    startKeepalive();
  } else {
    log('[KEEPALIVE] Disabled on localhost');
  }
});
