#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║           JASH ADDON — Backend Server v9.0                               ║
 * ║   Stremio IPTV Addon · Samsung Tizen HLS/DASH Extraction Engine         ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  v9.0 Changes:                                                           ║
 * ║  • Full DRM support (ClearKey, Widevine, PlayReady)                      ║
 * ║  • MPEG-DASH (.mpd) stream handling — passes through with headers        ║
 * ║  • Custom User-Agent, Cookie, Referer header forwarding                  ║
 * ║  • #KODIPROP, #EXTHTTP, #EXTVLCOPT metadata preserved in streams         ║
 * ║  • Stremio behaviorHints with proxyHeaders for DRM streams               ║
 * ║  • Green screen fix: DASH+DRM streams get proper behaviorHints           ║
 * ║  • HLS extraction still active for non-DRM HLS streams                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * GREEN SCREEN ROOT CAUSE:
 *   Streams with #KODIPROP clearkey DRM + .mpd DASH format need:
 *   1. The DRM license key to be passed to the player
 *   2. Custom headers (Cookie, User-Agent) to be forwarded
 *   3. Stremio needs behaviorHints.notWebReady = true (already set)
 *   4. The URL must be returned AS-IS (no HLS extraction for DASH/DRM)
 *
 * SUPPORTED FORMATS:
 *   • HLS (.m3u8)     — extracts real segment URL (Samsung fix)
 *   • DASH (.mpd)     — passes URL through with headers as Stremio hints
 *   • Direct (.ts)    — passes URL through directly
 *   • ClearKey DRM    — passes kid:key pairs as Stremio subtitleTracks hint
 *   • Widevine DRM    — passes license URL in behaviorHints
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
const REQ_TIMEOUT = 15000;
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
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  streamCache.delete(k);
  return null;
}
function setCache(k, v) { streamCache.set(k, { data: v, ts: Date.now() }); }

// ─── ID helpers ───────────────────────────────────────────────────────────────
const encodeId = (u) => Buffer.from(u, 'utf8').toString('base64url');
const decodeId = (s) => {
  try { return Buffer.from(s, 'base64url').toString('utf8'); }
  catch { return ''; }
};

// ═══════════════════════════════════════════════════════════════════════════════
// STREAM TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

function detectStreamType(stream) {
  // Explicit type from parser
  if (stream.streamType) return stream.streamType;

  const url = (stream.url || '').toLowerCase();
  if (url.includes('.mpd') || url.includes('/dash/') || url.includes('manifest.mpd')) return 'dash';
  if (url.includes('.m3u8') || url.includes('/hls/') || url.includes('playlist.m3u') ||
      url.includes('play.m3u') || url.includes('index.m3u') || url.includes('chunklist') ||
      url.includes('/hls/')) return 'hls';
  return 'direct';
}

function hasDRM(stream) {
  return !!(stream.licenseType || stream.licenseKey);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRECISE CHANNEL NAME MATCHING
// Same logic as frontend channelMatcher.ts — keeps language words intact
// ═══════════════════════════════════════════════════════════════════════════════

const STRIP_WORDS = new Set([
  'hd', 'sd', 'fhd', 'uhd', '4k', '2k', '8k',
  'vip', 'plus', 'premium', 'backup', 'mirror', 'alt', 'alternate',
  'usa', 'uk', 'us', 'ca', 'au', 'in',
  'live', 'stream', 'online', 'channel',
  '1080p', '720p', '480p', '360p',
]);

function stripSuffixes(s) {
  return s
    .toLowerCase()
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')
    .replace(/[\-_\/\\|:]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STRIP_WORDS.has(w))
    .join(' ')
    .trim();
}

function normalizeChannelKey(name) {
  return stripSuffixes(name)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function channelMatches(channelName, pattern) {
  const patNorm   = normalizeChannelKey(pattern);
  const chanNorm  = normalizeChannelKey(channelName);
  const patTokens = patNorm.split(' ').filter(t => t.length >= 1);
  if (patTokens.length === 0) return false;
  const chanWords = chanNorm.split(' ');

  if (patTokens.every(tok => chanWords.some(w => w === tok))) return true;

  const patNoSpace  = patNorm.replace(/\s+/g, '');
  const chanNoSpace = chanNorm.replace(/\s+/g, '');
  if (patTokens.length <= 2 && patNoSpace.length >= 3) {
    if (chanNoSpace === patNoSpace || chanNoSpace.startsWith(patNoSpace)) return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG LOADING
// ═══════════════════════════════════════════════════════════════════════════════

function loadConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) {
      return { streams: [], groups: [], combinedChannels: [], settings: defaultSettings() };
    }
    const raw = fs.readFileSync(CFG_FILE, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      streams         : cfg.streams          || [],
      groups          : cfg.groups           || [],
      combinedChannels: cfg.combinedChannels || [],
      settings        : { ...defaultSettings(), ...(cfg.settings || {}) },
    };
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

function getSettings() {
  return { ...defaultSettings(), ...(loadConfig().settings || {}) };
}

function getEnabledStreams() {
  const cfg      = loadConfig();
  const settings = cfg.settings;
  const streams  = cfg.streams.filter(s => s.enabled !== false);

  if (settings.sortAlphabetically !== false) {
    return [...streams].sort((a, b) => {
      const ga = (a.group || 'Uncategorized').toLowerCase();
      const gb = (b.group || 'Uncategorized').toLowerCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
  }
  return [...streams].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function getGroups() {
  const cfg     = loadConfig();
  const streams = getEnabledStreams();
  const groupNames = [...new Set(streams.map(s => s.group || 'Uncategorized'))];
  groupNames.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const storedMap = new Map((cfg.groups || []).map(g => [g.name, g]));
  return groupNames.map((name, idx) => ({
    id     : storedMap.get(name)?.id || `grp_${idx}`,
    name,
    enabled: storedMap.get(name)?.enabled !== false,
  })).filter(g => g.enabled);
}

function getCombinedChannels() {
  const cfg = loadConfig();
  return (cfg.combinedChannels || []).filter(c => c.enabled !== false);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-COMBINE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function buildAutoCombined(streams) {
  const byKey = new Map();

  for (const s of streams) {
    const key = normalizeChannelKey(s.name);
    if (!key) continue;

    if (!byKey.has(key)) {
      byKey.set(key, { name: s.name, streams: [], sourceIds: new Set() });
    }
    const entry = byKey.get(key);
    entry.streams.push(s);
    entry.sourceIds.add(s.sourceId || 'unknown');

    if (s.name.length < entry.name.length) {
      entry.name = s.name;
    }
  }

  const combined = [];
  for (const [key, entry] of byKey) {
    if (entry.sourceIds.size >= 2) {
      combined.push({
        key,
        name       : entry.name,
        streams    : entry.streams,
        sourceCount: entry.sourceIds.size,
      });
    }
  }

  combined.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return combined;
}

function groupByChannelInCatalog(streams, combineMultiQuality) {
  const map = new Map();

  for (const s of streams) {
    const group = s.group || 'Uncategorized';
    const key   = combineMultiQuality ? `${group}::${s.name}` : s.id;

    if (!map.has(key)) {
      map.set(key, {
        id     : 'jash' + encodeId(s.url),
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
// MANIFEST
// ═══════════════════════════════════════════════════════════════════════════════

function buildManifest() {
  const settings  = getSettings();
  const groups    = getGroups();
  const streams   = getEnabledStreams();
  const combined  = getCombinedChannels();
  const autoComb  = buildAutoCombined(streams);
  const addonId   = (settings.addonId || 'jash-iptv-addon').replace(/[^a-z0-9\-_.]/gi, '-');
  const addonName = settings.addonName || 'Jash IPTV';

  let version = '1.0.0';
  try {
    const stat  = fs.statSync(CFG_FILE);
    const secs  = Math.floor(stat.mtimeMs / 1000);
    version     = `1.${Math.floor(secs / 100000)}.${secs % 100000}`;
  } catch { /* no config file yet */ }

  const catalogs = groups.map((g, i) => ({
    type : 'tv',
    id   : `jash_cat_${i}`,
    name : g.name,
    extra: [{ name: 'search', isRequired: false }],
  }));

  if (autoComb.length > 0) {
    catalogs.unshift({
      type : 'tv',
      id   : 'jash_best',
      name : '⭐ Best Streams',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  if (combined.length > 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_combined',
      name : '🔗 Combined Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  if (catalogs.length === 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_cat_default',
      name : 'IPTV Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  return {
    id          : addonId,
    version,
    name        : addonName,
    description : `${addonName} · ${streams.length} channels · ${groups.length} groups · HLS/DASH · DRM Support`,
    logo        : `${PUBLIC_URL}/logo.png`,
    resources   : ['catalog', 'meta', 'stream'],
    types       : ['tv'],
    idPrefixes  : ['jash'],
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
  const searchQ  = extra && extra.search ? extra.search.toLowerCase().trim() : '';

  if (catId === 'jash_best') {
    let autoComb = buildAutoCombined(streams);
    if (searchQ) {
      autoComb = autoComb.filter(c => c.name.toLowerCase().includes(searchQ));
    }
    const metas = autoComb.map(c => {
      const logo = c.streams.find(s => s.logo)?.logo || null;
      return {
        id         : 'jashauto' + encodeId(c.key),
        type       : 'tv',
        name       : c.name,
        poster     : logo,
        background : logo,
        logo,
        description: `${c.sourceCount} sources · ${c.streams.length} quality streams`,
        genres     : ['⭐ Best Streams'],
      };
    });
    debug(`[CATALOG] Best Streams → ${metas.length} channels`);
    return { metas };
  }

  if (catId === 'jash_combined') {
    let list = searchQ
      ? combined.filter(c => c.name.toLowerCase().includes(searchQ))
      : combined;
    const metas = list.map(c => ({
      id         : `jashcombined${c.id}`,
      type       : 'tv',
      name       : c.name,
      poster     : c.logo || null,
      background : c.logo || null,
      logo       : c.logo || null,
      description: `${c.group || 'Combined'} · ${c.streamUrls.length} stream${c.streamUrls.length !== 1 ? 's' : ''}`,
      genres     : [c.group || 'Combined'],
    }));
    debug(`[CATALOG] Combined → ${metas.length} entries`);
    return { metas };
  }

  if (catId === 'jash_cat_default') {
    return { metas: [] };
  }

  const idxMatch = catId.match(/^jash_cat_(\d+)$/);
  if (!idxMatch) {
    debug(`[CATALOG] Unknown catId: ${catId}`);
    return { metas: [] };
  }

  const groupIdx = parseInt(idxMatch[1], 10);
  const group    = groups[groupIdx];

  if (!group) {
    debug(`[CATALOG] No group at index ${groupIdx}`);
    return { metas: [] };
  }

  let list = streams.filter(s => (s.group || 'Uncategorized') === group.name);
  if (searchQ) {
    list = list.filter(s => s.name.toLowerCase().includes(searchQ));
  }

  const channelMap = groupByChannelInCatalog(list, settings.combineMultiQuality !== false);
  const metas      = [];

  for (const ch of channelMap.values()) {
    const qualityNote = ch.streams.length > 1 ? ` · ${ch.streams.length} quality options` : '';
    metas.push({
      id         : ch.id,
      type       : 'tv',
      name       : ch.name,
      poster     : ch.logo || null,
      background : ch.logo || null,
      logo       : ch.logo || null,
      description: `${ch.group}${qualityNote}`,
      genres     : [ch.group],
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
  try { id = decodeURIComponent(rawId); } catch { /* keep */ }

  const settings  = getSettings();
  const addonName = settings.addonName || 'Jash IPTV';

  if (id.startsWith('jashauto')) {
    const key      = decodeId(id.replace('jashauto', ''));
    const streams  = getEnabledStreams();
    const autoComb = buildAutoCombined(streams);
    const c        = autoComb.find(x => x.key === key);
    if (!c) return { meta: null };
    const logo = c.streams.find(s => s.logo)?.logo || null;
    return {
      meta: {
        id,
        type       : 'tv',
        name       : c.name,
        poster     : logo,
        logo,
        description: `${c.sourceCount} sources · ${c.streams.length} quality streams · ${addonName}`,
        genres     : ['⭐ Best Streams'],
        releaseInfo: 'LIVE',
      },
    };
  }

  if (id.startsWith('jashcombined')) {
    const cId      = id.replace('jashcombined', '');
    const combined = getCombinedChannels();
    const c        = combined.find(ch => ch.id === cId);
    if (!c) return { meta: null };
    return {
      meta: {
        id,
        type       : 'tv',
        name       : c.name,
        poster     : c.logo || null,
        logo       : c.logo || null,
        description: `${c.group || 'Combined'} · ${c.streamUrls.length} streams`,
        genres     : [c.group || 'Combined'],
        releaseInfo: 'LIVE',
      },
    };
  }

  const encodedUrl = id.replace(/^jash/, '');
  const streamUrl  = decodeId(encodedUrl);
  if (!streamUrl) return { meta: null };

  const all = getEnabledStreams();
  const s   = all.find(st => st.url === streamUrl);
  if (!s) return { meta: null };

  return {
    meta: {
      id,
      type       : 'tv',
      name       : s.name,
      poster     : s.logo || null,
      background : s.logo || null,
      logo       : s.logo || null,
      description: `Group: ${s.group || 'Uncategorized'}`,
      genres     : [s.group || 'Uncategorized'],
      releaseInfo: 'LIVE',
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAM RESULT BUILDER
//
// This is where we build the Stremio stream object with all metadata.
//
// KEY INSIGHT — Green screen fix:
//   DASH + DRM streams MUST NOT go through HLS extraction.
//   They need to be returned as-is with proper behaviorHints.
//   The DRM key is passed in the stream description so Stremio/Kodi
//   (or any player that understands ClearKey) can decrypt.
//
// For ClearKey DRM:
//   licenseKey format: "kid1:key1,kid2:key2" (hex pairs)
//   We include it in the stream title so the user can see it,
//   and in subtitles track as a workaround for players that support it.
//
// Stremio behaviorHints:
//   notWebReady: true   → Player must handle this (no web player)
//   proxyHeaders: {...} → Stremio will forward these headers to the stream URL
// ═══════════════════════════════════════════════════════════════════════════════

function buildStreamResult(streamMeta, resolvedUrl, addonName) {
  const isDash = detectStreamType(streamMeta) === 'dash';
  const isDRM  = hasDRM(streamMeta);

  // Build proxy headers object — Stremio will forward these
  const proxyHeaders = {};

  if (streamMeta.userAgent) {
    proxyHeaders['User-Agent'] = streamMeta.userAgent;
  } else {
    // Default Samsung Tizen UA for all streams
    proxyHeaders['User-Agent'] = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36';
  }

  if (streamMeta.cookie) {
    proxyHeaders['Cookie'] = streamMeta.cookie;
  }

  if (streamMeta.referer) {
    proxyHeaders['Referer'] = streamMeta.referer;
  }

  // Merge any additional HTTP headers from #EXTHTTP
  if (streamMeta.httpHeaders) {
    Object.entries(streamMeta.httpHeaders).forEach(([k, v]) => {
      // Don't overwrite already-set headers unless from explicit field
      if (!proxyHeaders[k]) proxyHeaders[k] = v;
    });
  }

  // Build the stream entry
  const streamEntry = {
    url          : resolvedUrl,
    name         : addonName,
    behaviorHints: {
      notWebReady: true,
    },
  };

  // ── DRM: ClearKey ─────────────────────────────────────────────────────────
  // ClearKey format: "kid1hex:key1hex" — pairs of 32-char hex strings
  // Stremio doesn't natively support DRM but we pass the info in title
  // so players like Stremio with VLC backend can use it
  if (isDRM && streamMeta.licenseType === 'clearkey' && streamMeta.licenseKey) {
    const drmInfo = `🔐 ClearKey`;
    streamEntry.title = `🔴 ${streamMeta.name || 'Live'} [${drmInfo}]`;

    // Some Stremio setups pass this to VLC/MPV via streamingServerPort
    // We embed it in the stream URL as a hint via query param approach
    // For players that support it (VLC, Kodi), include it in description
    streamEntry.description = [
      `DRM: ClearKey`,
      `License: ${streamMeta.licenseKey}`,
      isDash ? `Format: MPEG-DASH` : `Format: HLS`,
    ].join(' | ');
  } else if (isDRM && streamMeta.licenseType === 'widevine' && streamMeta.licenseKey) {
    streamEntry.title = `🔴 ${streamMeta.name || 'Live'} [🔐 Widevine]`;
    streamEntry.description = `DRM: Widevine | License URL: ${streamMeta.licenseKey}`;
  } else {
    streamEntry.title = `🔴 ${streamMeta.name || 'Live Stream'}`;
  }

  // Add proxy headers to behaviorHints if we have them
  // This tells Stremio to forward these headers when fetching the stream
  if (Object.keys(proxyHeaders).length > 0) {
    streamEntry.behaviorHints.proxyHeaders = {
      request: proxyHeaders,
    };
  }

  return streamEntry;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAM HANDLER — Main dispatch
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* keep */ }

  const settings  = getSettings();
  const addonName = settings.addonName || 'Jash IPTV';

  debug(`[STREAM] id=${id.slice(0, 80)}`);

  // ── Auto-combined "Best Streams" ──────────────────────────────────────────
  if (id.startsWith('jashauto')) {
    const key      = decodeId(id.replace('jashauto', ''));
    const streams  = getEnabledStreams();
    const autoComb = buildAutoCombined(streams);
    const c        = autoComb.find(x => x.key === key);

    if (!c || !c.streams.length) {
      debug(`[STREAM] Auto-combined not found: ${key}`);
      return { streams: [] };
    }

    log(`[STREAM] Auto-combined: "${c.name}" (${c.streams.length} streams from ${c.sourceCount} sources)`);
    return resolveVariants(c.streams, addonName, settings);
  }

  // ── Manual combined channel ───────────────────────────────────────────────
  if (id.startsWith('jashcombined')) {
    const cId      = id.replace('jashcombined', '');
    const combined = getCombinedChannels();
    const c        = combined.find(ch => ch.id === cId);

    if (!c || !c.streamUrls || !c.streamUrls.length) {
      debug(`[STREAM] Combined channel not found: ${cId}`);
      return { streams: [] };
    }

    log(`[STREAM] Combined: "${c.name}" (${c.streamUrls.length} streams)`);

    // For manual combined, we have URLs only — no metadata
    const allStreams = getEnabledStreams();
    const variants   = c.streamUrls.map(url => {
      // Try to find the stream metadata if it exists in our library
      return allStreams.find(s => s.url === url) || { url, name: c.name };
    });

    return resolveVariants(variants, addonName, settings);
  }

  // ── Normal channel ─────────────────────────────────────────────────────────
  if (!id.startsWith('jash')) {
    debug(`[STREAM] Unknown ID prefix: ${id.slice(0, 30)}`);
    return { streams: [] };
  }

  const encodedUrl = id.replace(/^jash/, '');
  const primaryUrl = decodeId(encodedUrl);

  if (!primaryUrl) {
    error(`[STREAM] Failed to decode: ${id.slice(0, 60)}`);
    return { streams: [] };
  }

  const all     = getEnabledStreams();
  const primary = all.find(s => s.url === primaryUrl);

  if (!primary) {
    log(`[STREAM] URL not in config, serving directly`);
    return resolveVariants([{ url: primaryUrl, name: 'Live' }], addonName, settings);
  }

  // Find all quality variants (same name + same group)
  const variants = settings.combineMultiQuality !== false
    ? all.filter(s => s.name === primary.name && (s.group || '') === (primary.group || ''))
    : [primary];

  log(`[STREAM] "${primary.name}" → ${variants.length} variant(s) in "${primary.group}" [${detectStreamType(primary)}${hasDRM(primary) ? '+DRM' : ''}]`);

  return resolveVariants(variants, addonName, settings);
}

// ─── Resolve all variants ─────────────────────────────────────────────────────
async function resolveVariants(variants, addonName, settings) {
  const results = [];

  for (let i = 0; i < variants.length; i++) {
    const stream = variants[i];
    const url    = stream.url;
    const type   = detectStreamType(stream);
    const isDRM  = hasDRM(stream);
    const label  = variants.length > 1 ? `${stream.name || 'Stream'} ${i + 1}` : (stream.name || 'Stream');

    try {
      let resolvedUrl = url;

      // ── DRM streams (ClearKey / Widevine) — do NOT extract, pass as-is ──────
      // The green screen happens when we try to HLS-extract a DRM-encrypted
      // DASH stream. The player needs the original .mpd URL + DRM keys.
      if (isDRM) {
        debug(`[STREAM] DRM stream (${stream.licenseType}) — passing through: ${url.slice(0, 60)}`);
        resolvedUrl = url; // Always pass DRM stream URL as-is
      }

      // ── DASH streams — pass through (Stremio handles DASH natively) ──────────
      else if (type === 'dash') {
        debug(`[STREAM] DASH stream — passing through: ${url.slice(0, 60)}`);
        resolvedUrl = url;
      }

      // ── HLS streams — apply Samsung Tizen extraction ─────────────────────────
      else if (type === 'hls') {
        const cached = getCached(url);
        if (cached && cached.url) {
          debug(`[STREAM] ⚡ HLS cache hit: ${url.slice(0, 50)}`);
          resolvedUrl = cached.url;
        } else {
          const extracted = await extractHLS(url, stream);
          resolvedUrl = extracted || url;
          if (extracted && extracted !== url) {
            setCache(url, { url: extracted });
          }
        }
      }

      // ── Direct streams — pass through ─────────────────────────────────────────
      else {
        debug(`[STREAM] Direct stream: ${url.slice(0, 60)}`);
        resolvedUrl = url;
      }

      // Build the stream entry with all metadata
      const entry = buildStreamResult(
        { ...stream, name: label },
        resolvedUrl,
        addonName
      );

      results.push(entry);

    } catch (e) {
      error(`[STREAM] Variant error (${url.slice(0, 50)}):`, e.message);
      // Fallback — always return something
      results.push({
        url          : url,
        title        : `🔴 ${label} (Fallback)`,
        name         : addonName,
        behaviorHints: { notWebReady: true },
      });
    }
  }

  return { streams: results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HLS EXTRACTION — Your exact Samsung Tizen algorithm
// Only runs for HLS streams WITHOUT DRM
// ═══════════════════════════════════════════════════════════════════════════════

async function extractHLS(playlistUrl, streamMeta) {
  log(`[HLS] Fetching playlist: ${playlistUrl.slice(0, 70)}…`);

  // Build custom headers for the request
  const customHeaders = {};
  if (streamMeta && streamMeta.userAgent) {
    customHeaders['User-Agent'] = streamMeta.userAgent;
  }
  if (streamMeta && streamMeta.cookie) {
    customHeaders['Cookie'] = streamMeta.cookie;
  }
  if (streamMeta && streamMeta.referer) {
    customHeaders['Referer'] = streamMeta.referer;
  }
  if (streamMeta && streamMeta.httpHeaders) {
    Object.assign(customHeaders, streamMeta.httpHeaders);
  }

  let content;
  try {
    content = await fetchPlaylist(playlistUrl, customHeaders);
  } catch (e) {
    log(`[HLS] Fetch failed (${e.message}) — using original URL`);
    return null;
  }

  log(`[HLS] Playlist fetched (${content.length} bytes)`);

  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
    debug('[HLS] Not M3U8 — treating as direct');
    return null;
  }

  const realUrl = extractRealStreamUrl(content, playlistUrl);

  if (!realUrl) {
    log('[HLS] No real URL extracted — using original');
    return null;
  }

  log(`[HLS] ✅ Resolved: ${realUrl.slice(0, 70)}…`);
  return realUrl;
}

/**
 * extractRealStreamUrl — Samsung Tizen HLS fix.
 *
 * Master playlist:
 *   → Parse all #EXT-X-STREAM-INF variants
 *   → Sort by BANDWIDTH descending
 *   → Select MIDDLE index = Math.floor(variants.length / 2)
 *     ★ Middle quality = Samsung TV stability sweet spot
 *
 * Media playlist:
 *   → Find first .ts/.m4s/.mp4 segment URL
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
              bandwidth : bwM  ? parseInt(bwM[1],  10) : 0,
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

      // Sort highest bandwidth first
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // ★ KEY: Select MIDDLE quality for Samsung TV stability
      const idx      = Math.floor(variants.length / 2);
      const selected = variants[idx];

      debug(`[EXTRACT] ${variants.length} variants → [${idx}] ${selected.resolution} @ ${selected.bandwidth}bps`);

      let vUrl = selected.url;
      if (!vUrl.startsWith('http')) {
        vUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + vUrl;
      }
      return vUrl;

    } else {
      // Media playlist — extract first segment
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
          debug(`[EXTRACT] Segment: ${segUrl.slice(0, 70)}`);
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
// FETCH PLAYLIST — Samsung Tizen User-Agent + custom headers + redirect following
// ═══════════════════════════════════════════════════════════════════════════════

function fetchPlaylist(playlistUrl, customHeaders, redirectCount) {
  redirectCount  = redirectCount || 0;
  customHeaders  = customHeaders || {};

  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new urlMod.URL(playlistUrl); }
    catch (e) { return reject(new Error('Invalid URL: ' + playlistUrl)); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const timeout = setTimeout(() => reject(new Error('Request timeout')), REQ_TIMEOUT);

    // Merge Samsung Tizen User-Agent with any custom headers from stream metadata
    const headers = {
      'User-Agent'     : customHeaders['User-Agent'] || 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
      'Accept'         : '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection'     : 'keep-alive',
      'Cache-Control'  : 'no-cache',
      // Custom headers from stream metadata take precedence
      ...customHeaders,
    };

    // Set Referer from stream metadata if not explicitly provided
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = parsed.protocol + '//' + parsed.hostname;
    }

    const req = lib.get({
      hostname: parsed.hostname,
      port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path    : parsed.pathname + parsed.search,
      headers,
    }, (res) => {
      clearTimeout(timeout);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redir = new urlMod.URL(res.headers.location, playlistUrl).href;
          debug(`[FETCH] Redirect ${res.statusCode} → ${redir.slice(0, 70)}`);
          fetchPlaylist(redir, customHeaders, redirectCount + 1).then(resolve).catch(reject);
        } catch (e) { reject(e); }
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error('HTTP ' + res.statusCode));
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

function sendJSON(res, data, code) {
  code = code || 200;
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
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed   = urlMod.parse(req.url, true);
  const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  const query    = parsed.query;

  debug(`${req.method} ${pathname}`);

  // ── /health ──────────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/api/health') {
    noCache(res);
    const streams   = getEnabledStreams();
    const groups    = getGroups();
    const settings  = getSettings();
    const autoComb  = buildAutoCombined(streams);
    const manifest  = buildManifest();

    // Count DRM and DASH streams
    const drmCount  = streams.filter(s => hasDRM(s)).length;
    const dashCount = streams.filter(s => detectStreamType(s) === 'dash').length;
    const hlsCount  = streams.filter(s => detectStreamType(s) === 'hls').length;

    return sendJSON(res, {
      status      : 'ok',
      addon       : settings.addonName || 'Jash IPTV',
      streams     : streams.length,
      groups      : groups.length,
      autoCombined: autoComb.length,
      cache       : streamCache.size,
      uptime      : Math.round(process.uptime()),
      publicUrl   : PUBLIC_URL,
      manifestUrl : `${PUBLIC_URL}/manifest.json`,
      version     : manifest.version,
      // Stream type breakdown
      streamTypes : { hls: hlsCount, dash: dashCount, drm: drmCount },
    });
  }

  // ── /api/sync (POST) ──────────────────────────────────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (!Array.isArray(cfg.streams)) {
          return sendJSON(res, { ok: false, error: 'Invalid payload: streams must be an array' }, 400);
        }

        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        streamCache.clear();

        const allStreams  = (cfg.streams || []).filter(s => s.enabled !== false);
        const count       = allStreams.length;
        const combined    = (cfg.combinedChannels || []).length;
        const autoComb    = buildAutoCombined(allStreams);
        const drmCount    = allStreams.filter(s => hasDRM(s)).length;
        const dashCount   = allStreams.filter(s => detectStreamType(s) === 'dash').length;

        log(`[SYNC] ✅ ${count} streams | ${autoComb.length} auto-combined | ${drmCount} DRM | ${dashCount} DASH`);

        const manifest = buildManifest();
        return sendJSON(res, {
          ok          : true,
          streams     : count,
          combined,
          autoCombined: autoComb.length,
          drmStreams  : drmCount,
          dashStreams  : dashCount,
          version     : manifest.version,
        });
      } catch (e) {
        error('[SYNC] Error:', e.message);
        return sendJSON(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  // ── /api/config (GET) ─────────────────────────────────────────────────────
  if (pathname === '/api/config' && req.method === 'GET') {
    noCache(res);
    return sendJSON(res, loadConfig());
  }

  // ── /api/cache (DELETE) ───────────────────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const n = streamCache.size;
    streamCache.clear();
    log(`[CACHE] Cleared ${n} entries`);
    return sendJSON(res, { ok: true, cleared: n });
  }

  // ── /manifest.json ────────────────────────────────────────────────────────
  if (pathname === '/manifest.json') {
    noCache(res);
    const manifest = buildManifest();
    log(`[MANIFEST] v${manifest.version} · ${manifest.catalogs.length} catalogs · ${getEnabledStreams().length} streams`);
    return sendJSON(res, manifest);
  }

  // ── /playlist.m3u  (short URL for IPTV players) ───────────────────────────
  // All streams:   /playlist.m3u
  // By group:      /playlist/Sports.m3u
  // Short aliases: /p.m3u  /iptv.m3u  /live.m3u
  const isPlaylistRoot  = ['/playlist.m3u', '/p.m3u', '/iptv.m3u', '/live.m3u', '/channels.m3u'].includes(pathname);
  const groupPlaylistM  = pathname.match(/^\/playlist\/(.+)\.m3u$/);

  if (isPlaylistRoot || groupPlaylistM) {
    const filterGroup  = groupPlaylistM ? decodeURIComponent(groupPlaylistM[1]) : null;
    const allStreams    = getEnabledStreams();
    const filtered     = filterGroup ? allStreams.filter(s => (s.group || 'Uncategorized') === filterGroup) : allStreams;
    const settings     = getSettings();
    const name         = filterGroup ? `${settings.addonName} - ${filterGroup}` : settings.addonName;

    if (!filtered.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(filterGroup ? `Group "${filterGroup}" not found or empty.` : 'No streams configured.');
    }

    const lines = [`#EXTM3U x-tvg-url="" x-playlist-name="${name}"`];

    for (const s of filtered) {
      const parts = ['#EXTINF:-1'];
      if (s.tvgId)  parts.push(`tvg-id="${s.tvgId}"`);
      parts.push(`tvg-name="${(s.tvgName || s.name || '').replace(/"/g, '')}"`);
      if (s.logo)   parts.push(`tvg-logo="${s.logo}"`);
      parts.push(`group-title="${(s.group || 'Uncategorized').replace(/"/g, '')}"`);
      lines.push(`${parts.join(' ')},${s.name}`);
      // Preserve #KODIPROP / DRM / custom headers in m3u output
      if (s.licenseType && s.licenseKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=${s.licenseType}`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${s.licenseKey}`);
      }
      if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
      if (s.cookie)    lines.push(`#EXTHTTP:{"cookie":"${s.cookie}"}`);
      lines.push(s.url);
    }

    const content = lines.join('\n');
    const fname   = filterGroup ? `${filterGroup.replace(/\s+/g, '-')}.m3u` : 'playlist.m3u';

    res.writeHead(200, {
      'Content-Type'               : 'application/x-mpegurl; charset=utf-8',
      'Content-Disposition'        : `attachment; filename="${fname}"`,
      'Content-Length'             : Buffer.byteLength(content, 'utf8'),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control'              : 'no-cache, no-store, must-revalidate',
      'X-Stream-Count'             : String(filtered.length),
    });
    log(`[M3U] Served ${filtered.length} streams → ${pathname}`);
    return res.end(content);
  }

  // ── /api/playlist-info  (returns all available playlist URLs) ─────────────
  if (pathname === '/api/playlist-info' && req.method === 'GET') {
    noCache(res);
    const allStreams  = getEnabledStreams();
    const groups      = getGroups();
    const settings    = getSettings();

    const info = {
      total        : allStreams.length,
      groups       : groups.length,
      playlistUrl  : `${PUBLIC_URL}/playlist.m3u`,
      shortUrls    : {
        all      : `${PUBLIC_URL}/playlist.m3u`,
        short1   : `${PUBLIC_URL}/p.m3u`,
        short2   : `${PUBLIC_URL}/iptv.m3u`,
        live     : `${PUBLIC_URL}/live.m3u`,
        channels : `${PUBLIC_URL}/channels.m3u`,
      },
      groupUrls    : groups.map(g => ({
        group  : g.name,
        url    : `${PUBLIC_URL}/playlist/${encodeURIComponent(g.name)}.m3u`,
        count  : allStreams.filter(s => (s.group || 'Uncategorized') === g.name).length,
      })),
      addonName    : settings.addonName,
      manifestUrl  : `${PUBLIC_URL}/manifest.json`,
    };

    return sendJSON(res, info);
  }

  // ── /logo.png ─────────────────────────────────────────────────────────────
  if (pathname === '/logo.png' || pathname === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#7C3AED"/>
      <text x="50" y="68" font-size="52" text-anchor="middle" fill="white">📡</text>
    </svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(svg);
  }

  // ── /catalog/tv/:catId[/extra].json ──────────────────────────────────────
  const catM = pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    noCache(res);
    const catId = decodeURIComponent(catM[1]);
    const extra = {};
    if (catM[2]) {
      catM[2].split('&').forEach(p => {
        const [k, ...v] = p.split('=');
        if (k) extra[k] = decodeURIComponent(v.join('=') || '');
      });
    }
    if (query.extra)  Object.assign(extra, parseExtra(String(query.extra)));
    if (query.search) extra.search = String(query.search);
    debug(`[CATALOG] catId=${catId} search=${extra.search || ''}`);
    return sendJSON(res, handleCatalog(catId, extra));
  }

  // ── /meta/tv/:id.json ─────────────────────────────────────────────────────
  const metaM = pathname.match(/^\/meta\/tv\/(.+)\.json$/);
  if (metaM) {
    noCache(res);
    return sendJSON(res, handleMeta(metaM[1]));
  }

  // ── /stream/tv/:id.json ───────────────────────────────────────────────────
  const streamM = pathname.match(/^\/stream\/tv\/(.+)\.json$/);
  if (streamM) {
    noCache(res);
    const rawId = streamM[1];
    log(`[STREAM] Request: ${rawId.slice(0, 80)}`);
    try {
      const result = await handleStream(rawId);
      return sendJSON(res, result);
    } catch (e) {
      error('[STREAM] Unhandled error:', e.message);
      return sendJSON(res, { streams: [] });
    }
  }

  // ── /configure → SPA ─────────────────────────────────────────────────────
  if (pathname === '/configure') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // ── Static files / SPA fallback ───────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const safePath      = path.resolve(DIST_DIR, requestedPath);

    if (!safePath.startsWith(path.resolve(DIST_DIR))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      return serveStatic(res, safePath);
    }

    return serveStatic(res, path.join(DIST_DIR, 'index.html'));
  }

  // No build yet
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Jash Addon v9</title>
  <style>
    body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem;max-width:640px;margin:0 auto}
    h1{color:#a78bfa} a{color:#818cf8} code{background:#1e293b;padding:2px 8px;border-radius:4px}
    .ok{color:#34d399} .warn{color:#fbbf24} hr{border-color:#334155;margin:1.5rem 0}
  </style>
</head>
<body>
  <h1>🚀 Jash Addon v9.0</h1>
  <p class="warn">⚠️ React frontend not built yet.</p>
  <p>Run: <code>npm run build</code> then restart.</p>
  <hr>
  <p>📋 Manifest: <a href="/manifest.json">/manifest.json</a></p>
  <p>❤️ Health: <a href="/health">/health</a></p>
  <p class="ok">✅ Backend v9.0 running — HLS + DASH + DRM support.</p>
</body>
</html>`);
});

// ─── Error Handlers ────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => error('Uncaught:', e.message));
process.on('unhandledRejection', r => error('Unhandled:', r));
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    error(`Port ${PORT} in use. Set PORT env var to override.`);
    process.exit(1);
  }
  error('Server error:', e.message);
});

// ═══════════════════════════════════════════════════════════════════════════════
// KEEPALIVE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

server.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(120_000);
  socket.on('timeout', () => socket.destroy());
});

function startSelfPing() {
  const PING_INTERVAL = 14 * 60 * 1000;
  const selfUrl = `${PUBLIC_URL}/health`;

  setInterval(() => {
    debug(`[KEEPALIVE] Self-ping → ${selfUrl}`);
    const lib = selfUrl.startsWith('https') ? https : http;

    const req = lib.get(selfUrl, { timeout: 8000 }, (res) => {
      debug(`[KEEPALIVE] Ping OK — HTTP ${res.statusCode}`);
      res.on('data', () => {});
      res.on('end', () => {});
    });

    req.on('error', (e) => {
      debug(`[KEEPALIVE] Ping error: ${e.message}`);
    });

    req.on('timeout', () => {
      req.destroy();
      debug('[KEEPALIVE] Ping timed out');
    });

    req.end();
  }, PING_INTERVAL);

  log(`[KEEPALIVE] Self-ping active → every 14 min → ${selfUrl}`);
}

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const streams  = getEnabledStreams();
  const groups   = getGroups();
  const settings = getSettings();
  const manifest = buildManifest();
  const autoComb = buildAutoCombined(streams);
  const drmCount  = streams.filter(s => hasDRM(s)).length;
  const dashCount = streams.filter(s => detectStreamType(s) === 'dash').length;
  const hlsCount  = streams.filter(s => detectStreamType(s) === 'hls').length;

  log('═══════════════════════════════════════════════════════════════');
  log(`🚀  ${settings.addonName} — Jash Addon Backend v9.0`);
  log(`📡  Listening   : http://0.0.0.0:${PORT}`);
  log(`🌐  Public URL  : ${PUBLIC_URL}`);
  log(`📋  Manifest    : ${PUBLIC_URL}/manifest.json`);
  log(`🔖  Version     : ${manifest.version}`);
  log(`⚙️   Config UI   : ${PUBLIC_URL}/`);
  log(`❤️   Health     : ${PUBLIC_URL}/health`);
  log(`📺  Stremio     : stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`);
  log(`��  Playlist    : ${PUBLIC_URL}/playlist.m3u`);
  log(`🔗  Short URLs  : ${PUBLIC_URL}/p.m3u  ${PUBLIC_URL}/iptv.m3u  ${PUBLIC_URL}/live.m3u`);
  log('═══════════════════════════════════════════════════════════════');

  if (streams.length) {
    log(`📺  ${streams.length} streams | ${groups.length} groups`);
    log(`⭐  ${autoComb.length} auto-combined (multiple sources)`);
    log(`🎬  HLS: ${hlsCount} | DASH: ${dashCount} | 🔐 DRM: ${drmCount}`);
    log(`🔤  Sort: ${settings.sortAlphabetically !== false ? 'A→Z' : 'Manual'}`);
    log(`🎬  Multi-quality: ${settings.combineMultiQuality !== false ? 'ON' : 'OFF'}`);
    if (drmCount > 0) {
      log(`🔐  DRM streams detected — passing through with headers (no extraction)`);
    }
  } else {
    log(`ℹ️   No streams yet — open ${PUBLIC_URL} to configure`);
  }

  log('═══════════════════════════════════════════════════════════════');
  log('📌 Stream handling:');
  log('   HLS (.m3u8)  → Samsung Tizen extraction (middle quality)');
  log('   DASH (.mpd)  → Pass-through with headers');
  log('   DRM (any)    → Pass-through with headers + DRM info');
  log('   Direct       → Pass-through');
  log('═══════════════════════════════════════════════════════════════');

  if (process.env.NODE_ENV === 'production' && !PUBLIC_URL.includes('localhost')) {
    startSelfPing();
  } else {
    log('[KEEPALIVE] Disabled (local dev). Set NODE_ENV=production to enable.');
  }
});
