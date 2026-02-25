#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║           JASH ADDON — Backend Server v8.0                               ║
 * ║   Stremio IPTV Addon · Samsung Tizen HLS Extraction Engine              ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  v8.0 Changes:                                                           ║
 * ║  • Precise channel matching (no cross-language false positives)          ║
 * ║  • Auto-combine same channels from multiple sources → "Combined" group   ║
 * ║  • Sort A→Z by group title then channel name                            ║
 * ║  • Remove "Combine" UI — all combining is automatic in backend          ║
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
  if (c && Date.now() - c.ts < CACHE_TTL) return c.url;
  streamCache.delete(k);
  return null;
}
function setCache(k, v) { streamCache.set(k, { url: v, ts: Date.now() }); }

// ─── ID helpers ───────────────────────────────────────────────────────────────
const encodeId = (u) => Buffer.from(u, 'utf8').toString('base64url');
const decodeId = (s) => {
  try { return Buffer.from(s, 'base64url').toString('utf8'); }
  catch { return ''; }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRECISE CHANNEL NAME MATCHING
// Same logic as frontend channelMatcher.ts — keeps language words intact
// so "Zee Tamil" never matches "Zee Marathi" or "Zee Kannada"
// ═══════════════════════════════════════════════════════════════════════════════

// Only quality/delivery tokens are stripped — language/brand words are NEVER stripped
// 'tv' is intentionally NOT in this list (it's meaningful in channel names)
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
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')   // remove [HD], (4K) etc
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

/**
 * channelMatches — precise word-boundary matching.
 * ALL tokens of pattern must appear as whole words in channel name.
 *
 * "Zee Tamil"    → tokens ["zee","tamil"]
 * "Zee Tamil HD" normalizes → "zee tamil"   → ✅ MATCH
 * "Zee Marathi"  normalizes → "zee marathi" → ❌ NO MATCH (no "tamil")
 * "Zee Kannada"  normalizes → "zee kannada" → ❌ NO MATCH
 * "Sun TV HD"    → pattern "Sun TV" tokens ["sun","tv"] → ✅ MATCH
 * "SunTV VIP"    → handles via concatenated alias check
 */
function channelMatches(channelName, pattern) {
  const patNorm   = normalizeChannelKey(pattern);
  const chanNorm  = normalizeChannelKey(channelName);
  const patTokens = patNorm.split(' ').filter(t => t.length >= 1);
  if (patTokens.length === 0) return false;
  const chanWords = chanNorm.split(' ');

  // Primary: whole-word match
  if (patTokens.every(tok => chanWords.some(w => w === tok))) return true;

  // Secondary: concatenated brand names like "SunTV" vs pattern "Sun TV"
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

// ─── Get enabled streams ──────────────────────────────────────────────────────
function getEnabledStreams() {
  const cfg      = loadConfig();
  const settings = cfg.settings;
  const streams  = cfg.streams.filter(s => s.enabled !== false);

  if (settings.sortAlphabetically !== false) {
    // Sort A→Z by group title first, then channel name
    return [...streams].sort((a, b) => {
      const ga = (a.group || 'Uncategorized').toLowerCase();
      const gb = (b.group || 'Uncategorized').toLowerCase();
      if (ga !== gb) return ga < gb ? -1 : 1;
      return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
  }
  return [...streams].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ─── Get groups sorted A→Z ───────────────────────────────────────────────────
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

// ─── Get manual combined channels ─────────────────────────────────────────────
function getCombinedChannels() {
  const cfg = loadConfig();
  return (cfg.combinedChannels || []).filter(c => c.enabled !== false);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-COMBINE LOGIC
//
// Automatically finds channels with the same normalized name that exist in
// MULTIPLE sources, and groups them into the "⭐ Best Streams" catalog.
//
// Rules:
//   • Same normalized name (strips HD/4K/SD/VIP/USA etc.)
//   • Language words kept intact: "Zee Tamil" ≠ "Zee Marathi"
//   • Must appear in ≥ 2 different sources (sourceId)
//   • ALL streams for that channel (from all sources) are included
//
// Example:
//   Source A: "Sun TV HD"        → key: "sun"
//   Source B: "Sun TV 4K"        → key: "sun"
//   Source C: "Sun TV"           → key: "sun"
//   Result:   One catalog entry "Sun TV" with 3 quality streams ✅
//
//   Source A: "Zee Tamil HD"     → key: "zee tamil"
//   Source B: "Zee Tamil 4K"     → key: "zee tamil"
//   Source B: "Zee Marathi HD"   → key: "zee marathi" (DIFFERENT key)
//   Result:   "Zee Tamil" entry with 2 streams, "Zee Marathi" NOT included ✅
// ═══════════════════════════════════════════════════════════════════════════════

function buildAutoCombined(streams) {
  // Group by normalized key
  const byKey = new Map();

  for (const s of streams) {
    const key = normalizeChannelKey(s.name);
    if (!key) continue;

    if (!byKey.has(key)) {
      // Use the shortest/cleanest name as the representative name
      byKey.set(key, { name: s.name, streams: [], sourceIds: new Set() });
    }
    const entry = byKey.get(key);
    entry.streams.push(s);
    entry.sourceIds.add(s.sourceId || 'unknown');

    // Prefer shorter name as representative (e.g. "Sun TV" over "Sun TV HD from Source 1")
    if (s.name.length < entry.name.length) {
      entry.name = s.name;
    }
  }

  // Only keep channels with streams from ≥ 2 different sources
  const combined = [];
  for (const [key, entry] of byKey) {
    if (entry.sourceIds.size >= 2) {
      combined.push({
        key,
        name      : entry.name,
        streams   : entry.streams,
        sourceCount: entry.sourceIds.size,
      });
    }
  }

  // Sort A→Z by channel name
  combined.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return combined;
}

// ─── Group streams for a catalog (multi-quality within same source) ────────────
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

  // Semantic version from config file mtime (1.X.Y format)
  let version = '1.0.0';
  try {
    const stat  = fs.statSync(CFG_FILE);
    const secs  = Math.floor(stat.mtimeMs / 1000);
    version     = `1.${Math.floor(secs / 100000)}.${secs % 100000}`;
  } catch { /* no config file yet */ }

  // One catalog per group (sorted A→Z)
  const catalogs = groups.map((g, i) => ({
    type : 'tv',
    id   : `jash_cat_${i}`,
    name : g.name,
    extra: [{ name: 'search', isRequired: false }],
  }));

  // "⭐ Best Streams" catalog — auto-combined channels from multiple sources
  if (autoComb.length > 0) {
    catalogs.unshift({
      type : 'tv',
      id   : 'jash_best',
      name : '⭐ Best Streams',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  // Manual combined channels catalog
  if (combined.length > 0) {
    catalogs.push({
      type : 'tv',
      id   : 'jash_combined',
      name : '🔗 Combined Channels',
      extra: [{ name: 'search', isRequired: false }],
    });
  }

  // Fallback placeholder
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
    description : `${addonName} · ${streams.length} channels · ${groups.length} groups · Samsung Tizen Optimized · HLS Extraction`,
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

  // ── ⭐ Best Streams — auto-combined from multiple sources ─────────────────
  if (catId === 'jash_best') {
    let autoComb = buildAutoCombined(streams);
    if (searchQ) {
      autoComb = autoComb.filter(c => c.name.toLowerCase().includes(searchQ));
    }

    const metas = autoComb.map(c => {
      // Use the best logo from any variant
      const logo = c.streams.find(s => s.logo)?.logo || null;
      // Use the URL of the first stream as the representative ID
      const repUrl = c.streams[0].url;
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

  // ── 🔗 Manual combined channels ───────────────────────────────────────────
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

  // ── Default placeholder ───────────────────────────────────────────────────
  if (catId === 'jash_cat_default') {
    return { metas: [] };
  }

  // ── Normal group catalog ──────────────────────────────────────────────────
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

  // Auto-combined channel
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

  // Manual combined channel
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

  // Normal stream
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
// STREAM HANDLER — Samsung Tizen HLS Extraction
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

    // Return ALL variants — each from a different source
    const variants = c.streams.map((s, i) => ({
      // Use source name if available, otherwise quality info
      name: c.streams.length > 1
        ? `${c.name} ${i + 1}`
        : c.name,
      url: s.url,
    }));

    return resolveAndReturn(variants, addonName);
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
    return resolveAndReturn(
      c.streamUrls.map((url, i) => ({
        name: c.streamUrls.length > 1 ? `${c.name} Stream ${i + 1}` : c.name,
        url,
      })),
      addonName
    );
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
    return resolveAndReturn([{ name: 'Live', url: primaryUrl }], addonName);
  }

  // Find all quality variants (same name + same group, any source)
  const variants = settings.combineMultiQuality !== false
    ? all.filter(s => s.name === primary.name && (s.group || '') === (primary.group || ''))
    : [primary];

  log(`[STREAM] "${primary.name}" → ${variants.length} variant(s) in "${primary.group}"`);

  return resolveAndReturn(variants.map((v, i) => ({
    name: variants.length > 1 ? `${v.name} ${i + 1}` : v.name,
    url: v.url,
  })), addonName);
}

// ─── Resolve all variants through HLS extraction ───────────────────────────────
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
      error(`[STREAM] Resolve error:`, e.message);
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
// Identical logic to extractRealStreamUrl in your original working addon
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveStreamUrl(playlistUrl) {
  // 1. Cache check
  const cached = getCached(playlistUrl);
  if (cached) {
    log(`[HLS] ⚡ Cache hit: ${playlistUrl.slice(0, 50)}`);
    return { url: cached };
  }

  // 2. Only extract from HLS URLs
  const isHLS =
    playlistUrl.includes('.m3u8')     ||
    playlistUrl.includes('.m3u')      ||
    playlistUrl.includes('/playlist') ||
    playlistUrl.includes('play.m3u')  ||
    playlistUrl.includes('index.m3u') ||
    playlistUrl.includes('chunklist') ||
    playlistUrl.includes('/hls/');

  if (!isHLS) {
    debug(`[HLS] Direct (non-HLS): ${playlistUrl.slice(0, 60)}`);
    return { url: playlistUrl };
  }

  log(`[HLS] Fetching playlist: ${playlistUrl.slice(0, 70)}…`);

  let content;
  try {
    content = await fetchPlaylist(playlistUrl);
  } catch (e) {
    log(`[HLS] Fetch failed (${e.message}) — using original URL`);
    return { url: playlistUrl };
  }

  log(`[HLS] Playlist fetched (${content.length} bytes)`);

  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
    debug('[HLS] Not M3U8 — treating as direct');
    return { url: playlistUrl };
  }

  const realUrl = extractRealStreamUrl(content, playlistUrl);

  if (!realUrl) {
    log('[HLS] No real URL extracted — using original');
    return { url: playlistUrl };
  }

  log(`[HLS] ✅ Resolved: ${realUrl.slice(0, 70)}…`);
  setCache(playlistUrl, realUrl);
  return { url: realUrl };
}

/**
 * extractRealStreamUrl — Samsung Tizen HLS fix.
 *
 * This is the EXACT algorithm from your working Tamil addon:
 *
 * Master playlist:
 *   → Parse all #EXT-X-STREAM-INF variants
 *   → Sort by BANDWIDTH descending
 *   → Select MIDDLE index = Math.floor(variants.length / 2)
 *     ★ Middle quality = Samsung TV stability sweet spot
 *     (highest buffers, lowest looks bad, middle = perfect balance)
 *   → Resolve relative URL against base
 *
 * Media playlist:
 *   → Find first .ts/.m4s/.mp4 segment URL
 *   → Resolve relative URL
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
// FETCH PLAYLIST — Samsung Tizen User-Agent + redirect following
// ═══════════════════════════════════════════════════════════════════════════════

function fetchPlaylist(playlistUrl, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new urlMod.URL(playlistUrl); }
    catch (e) { return reject(new Error('Invalid URL: ' + playlistUrl)); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const timeout = setTimeout(() => reject(new Error('Request timeout')), REQ_TIMEOUT);

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
        'Referer'        : parsed.protocol + '//' + parsed.hostname,
      },
    }, (res) => {
      clearTimeout(timeout);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const redir = new urlMod.URL(res.headers.location, playlistUrl).href;
          debug(`[FETCH] Redirect ${res.statusCode} → ${redir.slice(0, 70)}`);
          fetchPlaylist(redir, redirectCount + 1).then(resolve).catch(reject);
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
        streamCache.clear(); // clear HLS cache for fresh extraction

        const count    = (cfg.streams || []).filter(s => s.enabled !== false).length;
        const combined = (cfg.combinedChannels || []).length;

        // Count auto-combined channels
        const allStreams = (cfg.streams || []).filter(s => s.enabled !== false);
        const autoComb   = buildAutoCombined(allStreams);

        log(`[SYNC] ✅ ${count} streams, ${autoComb.length} auto-combined, ${combined} manual combined`);

        const manifest = buildManifest();
        return sendJSON(res, {
          ok         : true,
          streams    : count,
          combined,
          autoCombined: autoComb.length,
          version    : manifest.version,
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
  <title>Jash Addon v8</title>
  <style>
    body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem;max-width:640px;margin:0 auto}
    h1{color:#a78bfa} a{color:#818cf8} code{background:#1e293b;padding:2px 8px;border-radius:4px}
    .ok{color:#34d399} .warn{color:#fbbf24} hr{border-color:#334155;margin:1.5rem 0}
  </style>
</head>
<body>
  <h1>🚀 Jash Addon v8.0</h1>
  <p class="warn">⚠️ React frontend not built yet.</p>
  <p>Run: <code>npm run build</code> then restart.</p>
  <hr>
  <p>📋 Manifest: <a href="/manifest.json">/manifest.json</a></p>
  <p>❤️ Health: <a href="/health">/health</a></p>
  <p class="ok">✅ Backend is running correctly.</p>
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
//
// Two-layer keepalive to prevent Render/Koyeb free tier from sleeping:
//
// 1. TCP keep-alive on the HTTP server itself — keeps long-lived connections alive
// 2. Self-ping every 14 minutes — Render free tier sleeps after 15 min idle.
//    This pings our own /health endpoint to keep the process running.
//
// The self-ping only activates in production (NODE_ENV=production) to avoid
// noise during local development.
// ═══════════════════════════════════════════════════════════════════════════════

// Layer 1 — TCP keep-alive on all incoming connections
server.on('connection', (socket) => {
  socket.setKeepAlive(true, 30_000); // send TCP keepalive every 30s
  socket.setTimeout(120_000);        // reset idle timeout to 2 min
  socket.on('timeout', () => socket.destroy());
});

// Layer 2 — Self-ping (Render free tier sleep prevention)
function startSelfPing() {
  const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
  const selfUrl = `${PUBLIC_URL}/health`;

  setInterval(() => {
    debug(`[KEEPALIVE] Self-ping → ${selfUrl}`);
    const lib = selfUrl.startsWith('https') ? https : http;

    const req = lib.get(selfUrl, { timeout: 8000 }, (res) => {
      debug(`[KEEPALIVE] Ping OK — HTTP ${res.statusCode}`);
      // Drain the response body so the connection can close cleanly
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

  log('═══════════════════════════════════════════════════════════════');
  log(`🚀  ${settings.addonName} — Jash Addon Backend v8.0`);
  log(`📡  Listening   : http://0.0.0.0:${PORT}`);
  log(`🌐  Public URL  : ${PUBLIC_URL}`);
  log(`📋  Manifest    : ${PUBLIC_URL}/manifest.json`);
  log(`🔖  Version     : ${manifest.version}`);
  log(`⚙️   Config UI   : ${PUBLIC_URL}/`);
  log(`❤️   Health     : ${PUBLIC_URL}/health`);
  log(`📺  Stremio     : stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`);
  log('═══════════════════════════════════════════════════════════════');

  if (streams.length) {
    log(`📺  ${streams.length} streams | ${groups.length} groups`);
    log(`⭐  ${autoComb.length} auto-combined channels (from multiple sources)`);
    log(`🔤  Sort: ${settings.sortAlphabetically !== false ? 'A→Z (group+name)' : 'Manual order'}`);
    log(`🎬  Multi-quality: ${settings.combineMultiQuality !== false ? 'ON' : 'OFF'}`);
  } else {
    log(`ℹ️   No streams yet — open ${PUBLIC_URL} to configure`);
  }

  // Start keepalive only in production (avoids self-ping during local dev)
  if (process.env.NODE_ENV === 'production' && !PUBLIC_URL.includes('localhost')) {
    startSelfPing();
  } else {
    log('[KEEPALIVE] Self-ping disabled (local dev mode). Set NODE_ENV=production to enable.');
  }
});
