#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         JASH ADDON — Unified Backend Server v11.0                       ║
 * ║   IPTV Addon  →  /manifest.json                                         ║
 * ║   Movie Addon →  /movie/manifest.json                                   ║
 * ║   Both ready to install in Stremio on first boot                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const urlMod = require('url');

// ─── Config ────────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '7000', 10);
const DEBUG      = process.env.DEBUG === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DIST_DIR   = path.join(__dirname, '..', 'dist');
const CFG_FILE   = path.join(__dirname, 'streams-config.json');
const MOV_FILE   = path.join(__dirname, 'movies-config.json');
const REQ_TIMEOUT = 20000;
const CACHE_TTL   = 5 * 60 * 1000;

// ─── Addon Identities ──────────────────────────────────────────────────────────
const IPTV_ID      = process.env.ADDON_ID       || 'community.jash-iptv';
const IPTV_NAME    = process.env.ADDON_NAME     || 'Jash IPTV';
const MOVIE_ID     = process.env.MOVIE_ADDON_ID || 'community.jash-movies';
const MOVIE_NAME   = process.env.MOVIE_ADDON_NAME || 'Jash Movies';
const VERSION_BASE = '1.0';

// ─── Logger ────────────────────────────────────────────────────────────────────
const ts    = () => new Date().toISOString().slice(11, 23);
const log   = (...a) => console.log(`[${ts()}]`, ...a);
const debug = (...a) => DEBUG && console.log(`[${ts()}] [DBG]`, ...a);
const err   = (...a) => console.error(`[${ts()}] [ERR]`, ...a);

// ─── Caches ────────────────────────────────────────────────────────────────────
const streamCache = new Map(); // HLS extraction cache
function getCached(k)   { const c = streamCache.get(k); if (c && Date.now() - c.ts < CACHE_TTL) return c.v; streamCache.delete(k); return null; }
function setCache(k, v) { streamCache.set(k, { v, ts: Date.now() }); }

// ─── ID helpers ────────────────────────────────────────────────────────────────
const encodeId = s => Buffer.from(String(s), 'utf8').toString('base64url');
const decodeId = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } };

// ═══════════════════════════════════════════════════════════════════════════════
// ██  IPTV CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

function defaultIptvCfg() {
  return { streams: [], groups: [], combinedChannels: [], settings: defaultIptvSettings() };
}
function defaultIptvSettings() {
  return { addonId: IPTV_ID, addonName: IPTV_NAME, combineMultiQuality: true, sortAlphabetically: true };
}
function loadIptvConfig() {
  try {
    if (!fs.existsSync(CFG_FILE)) return defaultIptvCfg();
    const raw = fs.readFileSync(CFG_FILE, 'utf8').trim();
    if (!raw || raw === '{}' || raw === '[]') return defaultIptvCfg();
    const cfg = JSON.parse(raw);
    return {
      streams         : Array.isArray(cfg.streams)          ? cfg.streams          : [],
      groups          : Array.isArray(cfg.groups)           ? cfg.groups           : [],
      combinedChannels: Array.isArray(cfg.combinedChannels) ? cfg.combinedChannels : [],
      settings        : { ...defaultIptvSettings(), ...(cfg.settings || {}) },
    };
  } catch(e) { err('loadIptvConfig:', e.message); return defaultIptvCfg(); }
}
function getIptvSettings() { return { ...defaultIptvSettings(), ...(loadIptvConfig().settings || {}) }; }
function getEnabledStreams() {
  const { streams, settings } = loadIptvConfig();
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
function getIptvGroups() {
  const { groups: stored, settings } = loadIptvConfig();
  const streams = getEnabledStreams();
  const names   = [...new Set(streams.map(s => s.group || 'Uncategorized'))];
  if (settings.sortAlphabetically !== false) names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const storedMap = new Map(stored.map(g => [g.name, g]));
  return names
    .map((name, idx) => ({ id: storedMap.get(name)?.id || `grp_${idx}`, name, enabled: storedMap.get(name)?.enabled !== false }))
    .filter(g => g.enabled);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MOVIE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

function defaultMovieCfg() {
  return { streams: [], settings: defaultMovieSettings() };
}
function defaultMovieSettings() {
  return {
    addonId: MOVIE_ID, addonName: MOVIE_NAME,
    tmdbApiKey: '', combineQualities: true, removeDuplicates: true,
    sortAlphabetically: true,
  };
}
function loadMovieConfig() {
  try {
    if (!fs.existsSync(MOV_FILE)) return defaultMovieCfg();
    const raw = fs.readFileSync(MOV_FILE, 'utf8').trim();
    if (!raw || raw === '{}') return defaultMovieCfg();
    const cfg = JSON.parse(raw);
    return {
      streams : Array.isArray(cfg.streams) ? cfg.streams : [],
      settings: { ...defaultMovieSettings(), ...(cfg.settings || {}) },
    };
  } catch(e) { err('loadMovieConfig:', e.message); return defaultMovieCfg(); }
}
function getMovieSettings() { return { ...defaultMovieSettings(), ...(loadMovieConfig().settings || {}) }; }
function getEnabledMovies() {
  const { streams } = loadMovieConfig();
  return streams.filter(s => s.enabled !== false);
}

// ─── Version from file timestamp ──────────────────────────────────────────────
function getVersion(file) {
  try {
    if (fs.existsSync(file)) {
      const patch = Math.floor(fs.statSync(file).mtimeMs / 1000) % 100000;
      return `${VERSION_BASE}.${patch}`;
    }
  } catch { /* ok */ }
  return `${VERSION_BASE}.0`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  STREAM TYPE HELPERS
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
// ═══════════════════════════════════════════════════════════════════════════════

const STRIP_TOKENS = new Set([
  'hd','sd','fhd','uhd','4k','2k','8k','vip','plus','premium',
  'backup','mirror','alt','alternate','usa','uk','us','ca','au','in',
  'live','stream','online','channel','1080p','720p','480p','360p',
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
// ██  AUTO-COMBINE (IPTV — same channel from multiple sources)
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
// ██  MOVIE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const Q_RANK = { '4K':5,'2160p':5,'UHD':5,'1080p':4,'FHD':4,'720p':3,'HD':3,'480p':2,'360p':1,'SD':1,'':0 };

function normalizeMovieTitle(title) {
  return (title || '').toLowerCase()
    .replace(/\b(4k|uhd|fhd|hd|sd|1080p|720p|480p|2160p|bluray|blu-ray|webrip|web-dl|dvdrip|hdcam|cam|ts|scr|extended|directors|cut|remastered)\b/gi, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getMovieGenres(streams) {
  const genres = new Set();
  streams.forEach(s => {
    if (s.genres) s.genres.forEach(g => genres.add(g));
    if (s.group && s.group !== 'Movies') genres.add(s.group);
  });
  return [...genres];
}

// Group movies by normalized title+year, combine quality variants
function groupMovies(streams) {
  const map = new Map();
  for (const s of streams) {
    const key = normalizeMovieTitle(s.title) + '_' + (s.year || '');
    if (!map.has(key)) {
      map.set(key, {
        key, title: s.title, year: s.year,
        tmdbId: s.tmdbId, imdbId: s.imdbId,
        poster: s.poster || s.logo, backdrop: s.backdrop,
        overview: s.overview, rating: s.rating,
        genres: s.genres || [], releaseDate: s.releaseDate,
        runtime: s.runtime, streams: [],
      });
    }
    const g = map.get(key);
    g.streams.push(s);
    // Keep best metadata
    if (!g.tmdbId && s.tmdbId)     g.tmdbId    = s.tmdbId;
    if (!g.imdbId && s.imdbId)     g.imdbId    = s.imdbId;
    if (!g.poster && (s.poster || s.logo)) g.poster = s.poster || s.logo;
    if (!g.backdrop && s.backdrop) g.backdrop  = s.backdrop;
    if (!g.overview && s.overview) g.overview  = s.overview;
    if (!g.rating && s.rating)     g.rating    = s.rating;
    if (!g.genres?.length && s.genres?.length) g.genres = s.genres;
    if ((s.title || '').length < (g.title || '').length) g.title = s.title;
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function removeDupMovies(streams) {
  const seen = new Map();
  for (const s of streams) {
    const key = normalizeMovieTitle(s.title) + '_' + (s.year || '') + '_' + (s.url || '');
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  IPTV MANIFEST
// ═══════════════════════════════════════════════════════════════════════════════

function buildIptvManifest() {
  const settings  = getIptvSettings();
  const streams   = getEnabledStreams();
  const groups    = getIptvGroups();
  const autoComb  = buildAutoCombined(streams);
  const version   = getVersion(CFG_FILE);
  const catalogs  = [];

  if (autoComb.length > 0) {
    catalogs.push({
      type: 'tv', id: 'jash_best', name: '⭐ Best Streams',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: [...new Set(autoComb.map(c => c.streams[0]?.group).filter(Boolean))].slice(0,20) },
      ],
    });
  }

  groups.forEach((g, i) => {
    catalogs.push({
      type: 'tv', id: `jash_cat_${i}`, name: g.name,
      extra: [{ name: 'search', isRequired: false }],
    });
  });

  if (catalogs.length === 0) {
    catalogs.push({
      type: 'tv', id: 'jash_cat_default', name: `${settings.addonName} Channels`,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: ['Entertainment','Sports','News','Movies'] },
      ],
    });
  }

  return {
    id         : IPTV_ID,
    version,
    name       : settings.addonName || IPTV_NAME,
    description: [
      settings.addonName || IPTV_NAME,
      streams.length ? `${streams.length.toLocaleString()} channels` : 'Add sources in configurator',
      groups.length  ? `${groups.length} groups` : '',
      'HLS · DASH · DRM · Samsung Tizen',
    ].filter(Boolean).join(' · '),
    logo: `${PUBLIC_URL}/logo.png`,
    resources: [
      { name: 'catalog', types: ['tv'], idPrefixes: ['jash'] },
      { name: 'meta',    types: ['tv'], idPrefixes: ['jash'] },
      { name: 'stream',  types: ['tv'], idPrefixes: ['jash'] },
    ],
    types      : ['tv'],
    idPrefixes : ['jash'],
    catalogs,
    behaviorHints: { adult: false, p2p: false, configurable: true, configurationRequired: false },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MOVIE MANIFEST
// ═══════════════════════════════════════════════════════════════════════════════

function buildMovieManifest() {
  const settings = getMovieSettings();
  const streams  = getEnabledMovies();
  const groups   = groupMovies(streams);
  const version  = getVersion(MOV_FILE);

  // Collect all unique genres
  const allGenres = [...new Set(streams.flatMap(s => s.genres || []).filter(Boolean))].sort().slice(0, 30);
  // Collect all unique years
  const allYears  = [...new Set(streams.map(s => s.year).filter(Boolean))].sort((a, b) => b - a).slice(0, 30);

  const catalogs = [
    {
      type: 'movie', id: 'jmov_all', name: `${settings.addonName}`,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: allGenres.length ? allGenres : ['Action','Drama','Comedy','Thriller','Horror','Sci-Fi','Romance','Animation','Documentary'] },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      type: 'movie', id: 'jmov_4k', name: '4K / Ultra HD',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: allGenres.length ? allGenres : ['Action','Drama'] },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      type: 'movie', id: 'jmov_hd', name: '1080p HD',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: allGenres.length ? allGenres : ['Action','Drama'] },
        { name: 'skip',   isRequired: false },
      ],
    },
    {
      type: 'movie', id: 'jmov_top', name: '⭐ Top Rated',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre',  isRequired: false, options: allGenres.length ? allGenres : ['Action','Drama'] },
        { name: 'skip',   isRequired: false },
      ],
    },
  ];

  // Add year-based catalogs for most common years
  if (allYears.length > 0) {
    catalogs.push({
      type: 'movie', id: 'jmov_year', name: '📅 By Year',
      extra: [
        { name: 'genre',  isRequired: false, options: allYears.map(String) },
        { name: 'search', isRequired: false },
        { name: 'skip',   isRequired: false },
      ],
    });
  }

  return {
    id         : MOVIE_ID,
    version,
    name       : settings.addonName || MOVIE_NAME,
    description: [
      settings.addonName || MOVIE_NAME,
      groups.length  ? `${groups.length} movies` : 'Add movie sources in configurator',
      streams.length ? `${streams.length} streams` : '',
      'TMDB · 4K · 1080p · DRM',
    ].filter(Boolean).join(' · '),
    logo: `${PUBLIC_URL}/movie-logo.png`,
    resources: [
      { name: 'catalog', types: ['movie'], idPrefixes: ['jmov'] },
      { name: 'meta',    types: ['movie'], idPrefixes: ['jmov'] },
      { name: 'stream',  types: ['movie'], idPrefixes: ['jmov'] },
    ],
    types      : ['movie'],
    idPrefixes : ['jmov'],
    catalogs,
    behaviorHints: { adult: false, p2p: false, configurable: true, configurationRequired: false },
    configurationURL: `${PUBLIC_URL}/`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  IPTV CATALOG HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleIptvCatalog(catId, extra) {
  const streams  = getEnabledStreams();
  const groups   = getIptvGroups();
  const settings = getIptvSettings();
  const search   = (extra.search || '').toLowerCase().trim();
  const genre    = (extra.genre  || '').trim();
  const skip     = parseInt(extra.skip || '0', 10);
  const PAGE     = 100;

  if (catId === 'jash_best') {
    let list = buildAutoCombined(streams);
    if (search) list = list.filter(c => c.name.toLowerCase().includes(search));
    if (genre)  list = list.filter(c => c.streams.some(s => s.group === genre));
    const metas = list.slice(skip, skip + PAGE).map(c => {
      const logo = c.streams.find(s => s.logo)?.logo || null;
      return { id: `jashauto${encodeId(c.key)}`, type: 'tv', name: c.name,
        poster: logo, background: logo, logo,
        description: `${c.sourceCount} sources · ${c.streams.length} streams`,
        genres: [...new Set(c.streams.map(s => s.group).filter(Boolean))] };
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
  if (genre)  list = list.filter(s => s.group === genre);

  const combined = settings.combineMultiQuality !== false;
  const seen     = new Map();
  for (const s of list) {
    const key = combined ? s.name.toLowerCase().trim() : s.id;
    if (!seen.has(key)) seen.set(key, { rep: s, all: [] });
    seen.get(key).all.push(s);
  }

  const metas = [...seen.values()].slice(skip, skip + PAGE).map(({ rep, all }) => ({
    id: `jash${encodeId(rep.url)}`, type: 'tv', name: rep.name,
    poster: rep.logo || null, background: rep.logo || null, logo: rep.logo || null,
    description: all.length > 1 ? `${group.name} · ${all.length} quality options` : group.name,
    genres: [group.name],
  }));

  return { metas };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MOVIE CATALOG HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleMovieCatalog(catId, extra) {
  const streams  = getEnabledMovies();
  const settings = getMovieSettings();
  const search   = (extra.search || '').toLowerCase().trim();
  const genre    = (extra.genre  || '').trim();
  const skip     = parseInt(extra.skip  || '0', 10);
  const PAGE     = 100;

  let groups = groupMovies(streams);

  // ── Filter by catalog type ────────────────────────────────────────────────
  if (catId === 'jmov_4k') {
    groups = groups.filter(g => g.streams.some(s => s.quality === '4K' || s.quality === '2160p' || s.quality === 'UHD'));
  } else if (catId === 'jmov_hd') {
    groups = groups.filter(g => g.streams.some(s => s.quality === '1080p' || s.quality === 'FHD'));
  } else if (catId === 'jmov_top') {
    groups = groups.filter(g => g.rating >= 7.0).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else if (catId === 'jmov_year') {
    // genre param = year for this catalog
    if (genre) groups = groups.filter(g => String(g.year) === genre);
  }

  // ── Genre filter ──────────────────────────────────────────────────────────
  if (genre && catId !== 'jmov_year') {
    groups = groups.filter(g =>
      (g.genres || []).some(gn => gn.toLowerCase().includes(genre.toLowerCase())) ||
      g.streams.some(s => (s.group || '').toLowerCase().includes(genre.toLowerCase()))
    );
  }

  // ── Search ────────────────────────────────────────────────────────────────
  if (search) {
    groups = groups.filter(g => g.title.toLowerCase().includes(search));
  }

  const page  = groups.slice(skip, skip + PAGE);
  const metas = page.map(g => {
    const qualities = [...new Set(g.streams.map(s => s.quality).filter(Boolean))];
    const qualStr   = qualities.slice(0, 3).join(' · ');
    const movieId   = `jmov${encodeId(g.key)}`;

    return {
      id         : movieId,
      type       : 'movie',
      name       : g.title,
      year       : g.year,
      poster     : g.poster || null,
      background : g.backdrop || g.poster || null,
      logo       : g.poster || null,
      description: [
        g.overview,
        qualStr ? `Quality: ${qualStr}` : null,
        g.streams.length > 1 ? `${g.streams.length} streams available` : null,
      ].filter(Boolean).join('\n\n') || null,
      imdbRating : g.rating ? String(g.rating.toFixed(1)) : null,
      genres     : g.genres || [],
      releaseInfo: g.year ? String(g.year) : null,
      runtime    : g.runtime ? `${g.runtime} min` : null,
    };
  });

  debug(`[MOVIE-CATALOG] ${catId} → ${metas.length}/${groups.length} (skip=${skip})`);
  return { metas };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MOVIE META HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleMovieMeta(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }

  const streams = getEnabledMovies();
  const groups  = groupMovies(streams);
  const key     = decodeId(id.replace(/^jmov/, ''));
  const g       = groups.find(x => x.key === key);
  if (!g) return { meta: null };

  const qualities = [...new Set(g.streams.map(s => s.quality).filter(Boolean))];
  return {
    meta: {
      id, type: 'movie', name: g.title, year: g.year,
      poster     : g.poster || null,
      background : g.backdrop || g.poster || null,
      logo       : g.poster || null,
      description: [
        g.overview,
        qualities.length ? `Available in: ${qualities.join(', ')}` : null,
        g.streams.length > 1 ? `${g.streams.length} stream sources` : null,
      ].filter(Boolean).join('\n\n') || null,
      imdbRating : g.rating ? String(g.rating.toFixed(1)) : null,
      genres     : g.genres || [],
      releaseInfo: g.year ? String(g.year) : null,
      runtime    : g.runtime ? `${g.runtime} min` : null,
      imdbId     : g.imdbId || null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  MOVIE STREAM HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleMovieStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }

  const streams = getEnabledMovies();
  const groups  = groupMovies(streams);
  const key     = decodeId(id.replace(/^jmov/, ''));
  const g       = groups.find(x => x.key === key);
  if (!g) return { streams: [] };

  log(`[MOVIE-STREAM] "${g.title}" → ${g.streams.length} variant(s)`);

  // Sort streams by quality (best first)
  const sorted = [...g.streams].sort((a, b) => {
    const qa = Q_RANK[a.quality || ''] || 0;
    const qb = Q_RANK[b.quality || ''] || 0;
    return qb - qa;
  });

  const results = [];
  for (let i = 0; i < sorted.length; i++) {
    const s     = sorted[i];
    const qual  = s.quality || `Stream ${i + 1}`;
    const isDRM = hasDRM(s);
    const type  = detectType(s);
    let resolved = s.url;

    try {
      if (!isDRM && type === 'hls') {
        const cached = getCached(s.url);
        if (cached) { resolved = cached; }
        else {
          const extracted = await extractHLS(s.url, s);
          if (extracted && extracted !== s.url) { setCache(s.url, extracted); resolved = extracted; }
        }
      }
    } catch(e) { err(`[MOVIE-STREAM] extract error: ${e.message}`); }

    const headers = buildHeaders(s);
    let title = `🎬 ${qual}`;
    if (isDRM)        title += ` [🔐 ${(s.licenseType || 'DRM').toUpperCase()}]`;
    if (type === 'dash') title += ' [DASH]';

    const entry = {
      url  : resolved,
      name : g.title,
      title,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
    };

    if (isDRM && s.licenseKey) {
      entry.description = `DRM:${s.licenseType} | Key:${s.licenseKey.substring(0,40)}`;
    }

    results.push(entry);
  }

  return { streams: results };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  IPTV META HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleIptvMeta(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }
  const streams  = getEnabledStreams();
  const settings = getIptvSettings();
  const name     = settings.addonName || IPTV_NAME;

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { meta: null };
    const logo = c.streams.find(s => s.logo)?.logo || null;
    return { meta: { id, type: 'tv', name: c.name, poster: logo, logo,
      description: `${c.sourceCount} sources · ${c.streams.length} streams · ${name}`,
      genres: [...new Set(c.streams.map(s => s.group).filter(Boolean))], releaseInfo: 'LIVE' }};
  }

  const url = decodeId(id.replace(/^jash/, ''));
  if (!url) return { meta: null };
  const s = streams.find(x => x.url === url);
  if (!s) return { meta: null };
  return { meta: { id, type: 'tv', name: s.name,
    poster: s.logo || null, background: s.logo || null, logo: s.logo || null,
    description: `${s.group || 'Uncategorized'} · ${name}`,
    genres: [s.group || 'Uncategorized'], releaseInfo: 'LIVE' }};
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  IPTV STREAM HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIptvStream(rawId) {
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* ok */ }
  const streams  = getEnabledStreams();
  const settings = getIptvSettings();
  const name     = settings.addonName || IPTV_NAME;
  debug(`[IPTV-STREAM] id=${id.slice(0,80)}`);

  if (id.startsWith('jashauto')) {
    const key  = decodeId(id.replace('jashauto', ''));
    const auto = buildAutoCombined(streams);
    const c    = auto.find(x => x.key === key);
    if (!c) return { streams: [] };
    log(`[IPTV-STREAM] auto-combined "${c.name}" → ${c.streams.length} streams`);
    return resolveIptvVariants(c.streams, name, settings);
  }

  if (!id.startsWith('jash')) return { streams: [] };
  const url     = decodeId(id.replace(/^jash/, ''));
  if (!url) return { streams: [] };
  const primary = streams.find(s => s.url === url);
  if (!primary) return resolveIptvVariants([{ url, name: 'Live' }], name, settings);

  const variants = settings.combineMultiQuality !== false
    ? streams.filter(s =>
        s.name.toLowerCase().trim() === primary.name.toLowerCase().trim() &&
        (s.group || '') === (primary.group || ''))
    : [primary];

  log(`[IPTV-STREAM] "${primary.name}" → ${variants.length} variant(s)`);
  return resolveIptvVariants(variants, name, settings);
}

async function resolveIptvVariants(variants, addonName, settings) {
  const results = [];
  for (let i = 0; i < variants.length; i++) {
    const s     = variants[i];
    const type  = detectType(s);
    const isDRM = hasDRM(s);
    const label = variants.length > 1 ? `[${i+1}/${variants.length}] ${s.name || 'Stream'}` : (s.name || 'Live');
    let resolved = s.url;

    try {
      if (!isDRM && type === 'hls') {
        const cached = getCached(s.url);
        if (cached) { resolved = cached; debug(`[RESOLVE] ⚡ cached`); }
        else {
          const extracted = await extractHLS(s.url, s);
          if (extracted && extracted !== s.url) { setCache(s.url, extracted); resolved = extracted; }
        }
      }
    } catch(e) { err(`[RESOLVE] error: ${e.message}`); }

    const headers = buildHeaders(s);
    let title = `🔴 ${label}`;
    if (isDRM)        title += ` [🔐 ${(s.licenseType || 'DRM').toUpperCase()}]`;
    if (type === 'dash') title += ` [DASH]`;

    const entry = {
      url: resolved, name: addonName, title,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } },
    };
    if (isDRM && s.licenseKey) entry.description = `DRM:${s.licenseType} | Key:${s.licenseKey.substring(0,40)}`;
    results.push(entry);
  }
  return { streams: results };
}

function buildHeaders(s) {
  const h = {
    'User-Agent': s.userAgent ||
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
  };
  if (s.cookie)  h['Cookie']  = s.cookie;
  if (s.referer) h['Referer'] = s.referer;
  if (s.httpHeaders) Object.entries(s.httpHeaders).forEach(([k, v]) => { if (!h[k]) h[k] = v; });
  return h;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HLS EXTRACTION — Samsung Tizen fix
// ═══════════════════════════════════════════════════════════════════════════════

async function extractHLS(playlistUrl, streamMeta) {
  log(`[HLS] Fetching: ${playlistUrl.slice(0,70)}…`);
  const customHeaders = {};
  if (streamMeta?.userAgent)   customHeaders['User-Agent'] = streamMeta.userAgent;
  if (streamMeta?.cookie)      customHeaders['Cookie']     = streamMeta.cookie;
  if (streamMeta?.referer)     customHeaders['Referer']    = streamMeta.referer;
  if (streamMeta?.httpHeaders) Object.assign(customHeaders, streamMeta.httpHeaders);
  let content;
  try { content = await fetchUrl(playlistUrl, customHeaders); }
  catch(e) { log(`[HLS] fetch failed: ${e.message}`); return null; }
  if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) { debug('[HLS] not M3U8'); return null; }
  return extractRealStreamUrl(content, playlistUrl);
}

function extractRealStreamUrl(content, baseUrl) {
  try {
    const lines    = content.split('\n').map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));
    if (isMaster) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('#EXT-X-STREAM-INF')) continue;
        const bw  = (lines[i].match(/BANDWIDTH=(\d+)/)  || [])[1];
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
      const idx      = Math.floor(variants.length / 2);
      const selected = variants[idx];
      debug(`[EXTRACT] ${variants.length} variants → [${idx}] ${selected.res} @${selected.bw}bps`);
      let vUrl = selected.url;
      if (!vUrl.startsWith('http')) vUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + vUrl;
      return vUrl;
    } else {
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.includes('.ts') || line.includes('.m4s') || line.includes('.m3u8') || line.includes('.mp4')) {
          let segUrl = line;
          if (!segUrl.startsWith('http')) segUrl = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + line;
          return segUrl;
        }
      }
      return null;
    }
  } catch(e) { err('[EXTRACT]', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HTTP FETCH
// ═══════════════════════════════════════════════════════════════════════════════

function fetchUrl(url, customHeaders, redirects) {
  redirects = redirects || 0;
  customHeaders = customHeaders || {};
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new urlMod.URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    const lib   = parsed.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => reject(new Error('Timeout')), REQ_TIMEOUT);
    const reqHeaders = {
      'User-Agent'  : customHeaders['User-Agent'] ||
        'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
      'Accept'      : '*/*',
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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = new urlMod.URL(res.headers.location, url).href;
        fetchUrl(redir, customHeaders, redirects + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end',  () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  M3U PLAYLIST GENERATOR (IPTV)
// ═══════════════════════════════════════════════════════════════════════════════

function generateM3U(streams, playlistName) {
  const lines = [`#EXTM3U x-playlist-name="${playlistName || IPTV_NAME}"`];
  for (const s of streams) {
    const parts = ['#EXTINF:-1'];
    if (s.tvgId) parts.push(`tvg-id="${s.tvgId}"`);
    parts.push(`tvg-name="${(s.tvgName || s.name || '').replace(/"/g,'')}"`);
    if (s.logo) parts.push(`tvg-logo="${s.logo}"`);
    parts.push(`group-title="${(s.group || 'Uncategorized').replace(/"/g,'')}"`);
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
// ██  HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
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
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('404'); }
  const mime = {
    '.html':'text/html; charset=utf-8','.js':'application/javascript',
    '.css':'text/css','.json':'application/json','.png':'image/png',
    '.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon',
    '.woff':'font/woff','.woff2':'font/woff2','.webp':'image/webp','.txt':'text/plain',
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': mime.includes('html') ? 'no-cache' : 'public, max-age=3600' });
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
// ██  INSTALL PAGE HTML
// ═══════════════════════════════════════════════════════════════════════════════

function installPage() {
  const iptvM  = buildIptvManifest();
  const movieM = buildMovieManifest();
  const iptvS  = getEnabledStreams().length;
  const movieS = groupMovies(getEnabledMovies()).length;
  const host   = PUBLIC_URL.replace(/^https?:\/\//, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jash Addon — Ready to Install</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .wrap{max-width:700px;width:100%;space-y:1.5rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:1.5rem;padding:2rem;margin-bottom:1.5rem;box-shadow:0 25px 50px rgba(0,0,0,.5)}
    h1{color:#a78bfa;font-size:2rem;font-weight:800;text-align:center;margin-bottom:.25rem}
    .sub{color:#64748b;text-align:center;font-size:.9rem;margin-bottom:1.5rem}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem}
    .addon-card{background:#0f172a;border-radius:1rem;padding:1.5rem;border:1px solid #334155}
    .addon-card h2{font-size:1rem;font-weight:700;margin-bottom:.5rem}
    .iptv-card{border-color:#4f46e522} .iptv-card h2{color:#818cf8}
    .movie-card{border-color:#d9770622} .movie-card h2{color:#fb923c}
    .url-box{background:#0f172a;border:1px solid #1e293b;border-radius:.5rem;padding:.75rem;font-family:monospace;font-size:.75rem;word-break:break-all;margin-bottom:.75rem}
    .url-box .lbl{color:#64748b;font-size:.65rem;display:block;margin-bottom:.25rem}
    .url-box .val{color:#818cf8}
    .btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;padding:.75rem 1rem;border-radius:.75rem;font-weight:700;font-size:.85rem;cursor:pointer;text-decoration:none;border:none;margin-bottom:.5rem;transition:all .15s}
    .btn-iptv{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff}
    .btn-movie{background:linear-gradient(135deg,#ea580c,#d97706);color:#fff}
    .btn-sm{background:#1e293b;border:1px solid #475569;color:#cbd5e1;font-size:.8rem;padding:.5rem .75rem;border-radius:.5rem;text-decoration:none;display:inline-flex;align-items:center;gap:.4rem;margin-right:.5rem;margin-bottom:.5rem}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin-bottom:1rem}
    .stat{background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:.75rem;text-align:center}
    .stat .val{font-size:1.5rem;font-weight:800;color:#a78bfa}
    .stat .lbl{font-size:.65rem;color:#64748b;margin-top:.2rem}
    .step{display:flex;gap:.75rem;margin-bottom:.75rem;align-items:flex-start}
    .step-n{background:#7c3aed22;border:1px solid #7c3aed55;color:#a78bfa;width:1.75rem;height:1.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;flex-shrink:0}
    .step-t{color:#94a3b8;font-size:.85rem;padding-top:.2rem} .step-t strong{color:#e2e8f0}
    footer{text-align:center;color:#475569;font-size:.75rem;padding-top:1rem}
    @media(max-width:560px){.row{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div style="font-size:3.5rem;text-align:center;margin-bottom:.75rem">📡</div>
    <h1>Jash Addon</h1>
    <p class="sub">Two Stremio Addons · IPTV + Movies · HLS/DASH/DRM · Samsung Tizen</p>

    <div class="stats">
      <div class="stat"><div class="val">${iptvS.toLocaleString()}</div><div class="lbl">IPTV Channels</div></div>
      <div class="stat"><div class="val">${iptvM.catalogs.length}</div><div class="lbl">IPTV Groups</div></div>
      <div class="stat"><div class="val">${movieS.toLocaleString()}</div><div class="lbl">Movies</div></div>
      <div class="stat"><div class="val">v${iptvM.version}</div><div class="lbl">Version</div></div>
    </div>

    <div class="row">
      <div class="addon-card iptv-card">
        <h2>📺 IPTV Addon</h2>
        <div class="url-box">
          <span class="lbl">Manifest URL</span>
          <span class="val">${PUBLIC_URL}/manifest.json</span>
        </div>
        <a href="stremio://${host}/manifest.json" class="btn btn-iptv">🎬 Install IPTV Addon</a>
        <a href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}" class="btn-sm" target="_blank">🌐 Web Install</a>
        <a href="/manifest.json" class="btn-sm" target="_blank">📋 Manifest</a>
      </div>

      <div class="addon-card movie-card">
        <h2>🎬 Movie Addon</h2>
        <div class="url-box">
          <span class="lbl">Manifest URL</span>
          <span class="val">${PUBLIC_URL}/movie/manifest.json</span>
        </div>
        <a href="stremio://${host}/movie/manifest.json" class="btn btn-movie">🎬 Install Movie Addon</a>
        <a href="https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/movie/manifest.json`)}" class="btn-sm" target="_blank">🌐 Web Install</a>
        <a href="/movie/manifest.json" class="btn-sm" target="_blank">📋 Manifest</a>
      </div>
    </div>

    <div style="margin-bottom:1rem">
      <div style="color:#94a3b8;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem">📻 M3U Playlists (Tivimate · OTT Navigator · VLC)</div>
      <div class="url-box">
        <span class="lbl">IPTV Playlist (all channels)</span>
        <span class="val">${PUBLIC_URL}/p.m3u</span>
      </div>
    </div>

    <div style="margin-bottom:1rem">
      <div style="color:#94a3b8;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.75rem">🚀 How to Use</div>
      <div class="step"><div class="step-n">1</div><div class="step-t"><strong>Install both addons</strong> — click the install buttons above</div></div>
      <div class="step"><div class="step-n">2</div><div class="step-t"><strong>Open Configurator</strong> — add M3U/JSON sources, manage streams, groups, selection models</div></div>
      <div class="step"><div class="step-n">3</div><div class="step-t"><strong>Sync to Backend</strong> — click "Sync to Backend" in the Backend tab — changes appear in Stremio instantly</div></div>
      <div class="step"><div class="step-n">4</div><div class="step-t"><strong>No reinstall needed</strong> — sync updates the addon without reinstalling</div></div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:.5rem">
      <a href="/" class="btn-sm">⚙️ Open Configurator</a>
      <a href="/health" class="btn-sm">❤️ Health</a>
      <a href="/manifest.json" class="btn-sm">📋 IPTV Manifest</a>
      <a href="/movie/manifest.json" class="btn-sm">🎬 Movie Manifest</a>
      <a href="/p.m3u" class="btn-sm">📻 M3U Playlist</a>
    </div>
  </div>
  <footer>Jash Addon v${iptvM.version} · ${IPTV_ID} · ${MOVIE_ID}</footer>
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
    const iptvStreams  = getEnabledStreams();
    const iptvGroups  = getIptvGroups();
    const movieStream = getEnabledMovies();
    const movieGroups = groupMovies(movieStream);
    const autoComb    = buildAutoCombined(iptvStreams);
    const iptvM       = buildIptvManifest();
    const movieM      = buildMovieManifest();
    return json(res, {
      status: 'ok', uptime: Math.round(process.uptime()),
      publicUrl: PUBLIC_URL,
      iptv: {
        streams: iptvStreams.length, groups: iptvGroups.length,
        autoCombined: autoComb.length, catalogs: iptvM.catalogs.length,
        version: iptvM.version,
        manifestUrl: `${PUBLIC_URL}/manifest.json`,
        installUrl : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json`,
        streamTypes: {
          hls   : iptvStreams.filter(s => detectType(s) === 'hls').length,
          dash  : iptvStreams.filter(s => detectType(s) === 'dash').length,
          drm   : iptvStreams.filter(s => hasDRM(s)).length,
          direct: iptvStreams.filter(s => detectType(s) === 'direct').length,
        },
      },
      movies: {
        streams: movieStream.length, uniqueMovies: movieGroups.length,
        catalogs: movieM.catalogs.length, version: movieM.version,
        manifestUrl: `${PUBLIC_URL}/movie/manifest.json`,
        installUrl : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/movie/manifest.json`,
        qualities: {
          '4K'   : movieStream.filter(s => s.quality === '4K' || s.quality === '2160p').length,
          '1080p': movieStream.filter(s => s.quality === '1080p').length,
          '720p' : movieStream.filter(s => s.quality === '720p').length,
        },
      },
      cache: streamCache.size,
    });
  }

  // ── /api/sync — IPTV (POST) ───────────────────────────────────────────────
  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (!Array.isArray(cfg.streams)) return json(res, { ok: false, error: 'streams must be array' }, 400);
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        streamCache.clear();
        const enabled  = cfg.streams.filter(s => s.enabled !== false);
        const autoComb = buildAutoCombined(enabled);
        const manifest = buildIptvManifest();
        log(`[SYNC-IPTV] ✅ ${enabled.length} streams | v${manifest.version} | ${autoComb.length} auto-combined`);
        return json(res, { ok: true, streams: enabled.length, autoCombined: autoComb.length,
          version: manifest.version,
          manifestUrl: `${PUBLIC_URL}/manifest.json`,
          installUrl : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/manifest.json` });
      } catch(e) { err('[SYNC-IPTV]', e.message); return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }

  // ── /api/movie-sync — Movie (POST) ────────────────────────────────────────
  if (pathname === '/api/movie-sync' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (!Array.isArray(cfg.streams)) return json(res, { ok: false, error: 'streams must be array' }, 400);
        fs.writeFileSync(MOV_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        streamCache.clear();
        const enabled  = cfg.streams.filter(s => s.enabled !== false);
        const movies   = groupMovies(enabled);
        const manifest = buildMovieManifest();
        log(`[SYNC-MOVIE] ✅ ${enabled.length} streams | ${movies.length} unique movies | v${manifest.version}`);
        return json(res, { ok: true, streams: enabled.length, uniqueMovies: movies.length,
          version: manifest.version,
          manifestUrl: `${PUBLIC_URL}/movie/manifest.json`,
          installUrl : `stremio://${PUBLIC_URL.replace(/^https?:\/\//, '')}/movie/manifest.json` });
      } catch(e) { err('[SYNC-MOVIE]', e.message); return json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }

  // ── /api/config ───────────────────────────────────────────────────────────
  if (pathname === '/api/config') { noCache(res); return json(res, loadIptvConfig()); }
  if (pathname === '/api/movie-config') { noCache(res); return json(res, loadMovieConfig()); }

  // ── /api/cache (DELETE) ───────────────────────────────────────────────────
  if (pathname === '/api/cache' && req.method === 'DELETE') {
    const n = streamCache.size; streamCache.clear();
    log(`[CACHE] Cleared ${n} entries`);
    return json(res, { ok: true, cleared: n });
  }

  // ── /api/install ──────────────────────────────────────────────────────────
  if (pathname === '/api/install') {
    noCache(res);
    const host   = PUBLIC_URL.replace(/^https?:\/\//, '');
    const iptvM  = buildIptvManifest();
    const movieM = buildMovieManifest();
    return json(res, {
      iptv: {
        manifestUrl  : `${PUBLIC_URL}/manifest.json`,
        stremioUrl   : `stremio://${host}/manifest.json`,
        webInstallUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/manifest.json`)}`,
        version      : iptvM.version,
        streams      : getEnabledStreams().length,
      },
      movie: {
        manifestUrl  : `${PUBLIC_URL}/movie/manifest.json`,
        stremioUrl   : `stremio://${host}/movie/manifest.json`,
        webInstallUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${PUBLIC_URL}/movie/manifest.json`)}`,
        version      : movieM.version,
        movies       : groupMovies(getEnabledMovies()).length,
      },
      configureUrl: `${PUBLIC_URL}/`,
      playlistUrl : `${PUBLIC_URL}/playlist.m3u`,
      shortUrls   : { m3u: `${PUBLIC_URL}/p.m3u`, iptv: `${PUBLIC_URL}/iptv.m3u` },
    });
  }

  // ── /api/playlist-info ────────────────────────────────────────────────────
  if (pathname === '/api/playlist-info') {
    noCache(res);
    const streams = getEnabledStreams();
    const groups  = getIptvGroups();
    return json(res, {
      total: streams.length, groups: groups.length,
      playlistUrl: `${PUBLIC_URL}/playlist.m3u`,
      shortUrls: { all: `${PUBLIC_URL}/playlist.m3u`, short: `${PUBLIC_URL}/p.m3u`, iptv: `${PUBLIC_URL}/iptv.m3u`, live: `${PUBLIC_URL}/live.m3u`, channels: `${PUBLIC_URL}/channels.m3u` },
      groupUrls: groups.map(g => ({ group: g.name, url: `${PUBLIC_URL}/playlist/${encodeURIComponent(g.name)}.m3u`, count: streams.filter(s => (s.group || 'Uncategorized') === g.name).length })),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  IPTV ADDON ROUTES  (/manifest.json, /catalog/tv/*, /meta/tv/*, /stream/tv/*)
  // ══════════════════════════════════════════════════════════════════════════

  // ── /manifest.json ────────────────────────────────────────────────────────
  if (pathname === '/manifest.json') {
    noCache(res);
    const m = buildIptvManifest();
    log(`[IPTV-MANIFEST] v${m.version} | ${m.catalogs.length} catalogs | ${getEnabledStreams().length} streams`);
    return json(res, m);
  }

  // ── IPTV catalog ──────────────────────────────────────────────────────────
  const iptvCatM = pathname.match(/^\/catalog\/tv\/([^/]+?)(?:\/(.+))?\.json$/);
  if (iptvCatM) {
    noCache(res);
    const catId = decodeURIComponent(iptvCatM[1]);
    const extra = {};
    if (iptvCatM[2]) iptvCatM[2].split('/').forEach(seg => { const [k,...v]=seg.split('='); if(k) extra[k]=decodeURIComponent(v.join('=')||''); });
    if (query.extra)  Object.assign(extra, parseExtra(String(query.extra)));
    if (query.search) extra.search = String(query.search);
    if (query.genre)  extra.genre  = String(query.genre);
    if (query.skip)   extra.skip   = String(query.skip);
    return json(res, handleIptvCatalog(catId, extra));
  }

  // ── IPTV meta ─────────────────────────────────────────────────────────────
  const iptvMetaM = pathname.match(/^\/meta\/tv\/(.+)\.json$/);
  if (iptvMetaM) { noCache(res); return json(res, handleIptvMeta(iptvMetaM[1])); }

  // ── IPTV stream ───────────────────────────────────────────────────────────
  const iptvStreamM = pathname.match(/^\/stream\/tv\/(.+)\.json$/);
  if (iptvStreamM) {
    noCache(res);
    try { return json(res, await handleIptvStream(iptvStreamM[1])); }
    catch(e) { err('[IPTV-STREAM]', e.message); return json(res, { streams: [] }); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  MOVIE ADDON ROUTES  (/movie/*)
  // ══════════════════════════════════════════════════════════════════════════

  // ── /movie/manifest.json ──────────────────────────────────────────────────
  if (pathname === '/movie/manifest.json') {
    noCache(res);
    const m = buildMovieManifest();
    log(`[MOVIE-MANIFEST] v${m.version} | ${m.catalogs.length} catalogs | ${groupMovies(getEnabledMovies()).length} movies`);
    return json(res, m);
  }

  // ── Movie catalog ─────────────────────────────────────────────────────────
  const movCatM = pathname.match(/^\/movie\/catalog\/movie\/([^/]+?)(?:\/(.+))?\.json$/);
  if (movCatM) {
    noCache(res);
    const catId = decodeURIComponent(movCatM[1]);
    const extra = {};
    if (movCatM[2]) movCatM[2].split('/').forEach(seg => { const [k,...v]=seg.split('='); if(k) extra[k]=decodeURIComponent(v.join('=')||''); });
    if (query.extra)  Object.assign(extra, parseExtra(String(query.extra)));
    if (query.search) extra.search = String(query.search);
    if (query.genre)  extra.genre  = String(query.genre);
    if (query.skip)   extra.skip   = String(query.skip);
    debug(`[MOVIE-CATALOG] ${catId} search="${extra.search||''}" genre="${extra.genre||''}" skip=${extra.skip||0}`);
    return json(res, handleMovieCatalog(catId, extra));
  }

  // ── Movie meta ────────────────────────────────────────────────────────────
  const movMetaM = pathname.match(/^\/movie\/meta\/movie\/(.+)\.json$/);
  if (movMetaM) { noCache(res); return json(res, handleMovieMeta(movMetaM[1])); }

  // ── Movie stream ──────────────────────────────────────────────────────────
  const movStreamM = pathname.match(/^\/movie\/stream\/movie\/(.+)\.json$/);
  if (movStreamM) {
    noCache(res);
    try { return json(res, await handleMovieStream(movStreamM[1])); }
    catch(e) { err('[MOVIE-STREAM]', e.message); return json(res, { streams: [] }); }
  }

  // ── /movie/ root → movie install page ────────────────────────────────────
  if (pathname === '/movie' || pathname === '/movie/') {
    res.writeHead(302, { Location: '/install' }); return res.end();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  M3U PLAYLIST ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const PLAYLIST_ALIASES = ['/playlist.m3u','/p.m3u','/iptv.m3u','/live.m3u','/channels.m3u'];
  const groupM2 = pathname.match(/^\/playlist\/(.+)\.m3u$/);
  if (PLAYLIST_ALIASES.includes(pathname) || groupM2) {
    const filterGroup = groupM2 ? decodeURIComponent(groupM2[1]) : null;
    const all      = getEnabledStreams();
    const filtered = filterGroup ? all.filter(s => (s.group||'Uncategorized') === filterGroup) : all;
    const settings = getIptvSettings();
    const pName    = filterGroup ? `${settings.addonName} - ${filterGroup}` : settings.addonName;
    if (!filtered.length) { res.writeHead(filterGroup ? 404 : 200, {'Content-Type':'text/plain;charset=utf-8'}); return res.end(filterGroup ? `Group "${filterGroup}" not found.` : '#EXTM3U\n# No streams yet. Open configurator.'); }
    const content = generateM3U(filtered, pName);
    const fname   = filterGroup ? `${filterGroup.replace(/\s+/g,'-')}.m3u` : 'playlist.m3u';
    res.writeHead(200, { 'Content-Type':'application/x-mpegurl;charset=utf-8', 'Content-Disposition':`inline;filename="${fname}"`, 'Content-Length':Buffer.byteLength(content,'utf8'), 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache,no-store', 'X-Stream-Count':String(filtered.length) });
    log(`[M3U] ${filtered.length} streams → ${pathname}`);
    return res.end(content);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ██  LOGO / FAVICON
  // ══════════════════════════════════════════════════════════════════════════

  if (pathname === '/logo.png' || pathname === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#4F46E5"/></linearGradient></defs><rect width="200" height="200" rx="40" fill="url(#g)"/><text x="100" y="130" font-size="100" text-anchor="middle" fill="white">📡</text><text x="100" y="175" font-size="22" font-family="Arial,sans-serif" font-weight="bold" text-anchor="middle" fill="rgba(255,255,255,0.8)">JASH</text></svg>`;
    res.writeHead(200, { 'Content-Type':'image/svg+xml', 'Cache-Control':'public,max-age=86400' });
    return res.end(svg);
  }

  if (pathname === '/movie-logo.png') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#EA580C"/><stop offset="100%" stop-color="#D97706"/></linearGradient></defs><rect width="200" height="200" rx="40" fill="url(#g)"/><text x="100" y="130" font-size="100" text-anchor="middle" fill="white">🎬</text><text x="100" y="175" font-size="18" font-family="Arial,sans-serif" font-weight="bold" text-anchor="middle" fill="rgba(255,255,255,0.8)">MOVIES</text></svg>`;
    res.writeHead(200, { 'Content-Type':'image/svg+xml', 'Cache-Control':'public,max-age=86400' });
    return res.end(svg);
  }

  // ── /install or /addon → install page ────────────────────────────────────
  if (pathname === '/install' || pathname === '/addon') {
    res.writeHead(200, { 'Content-Type':'text/html;charset=utf-8' });
    return res.end(installPage());
  }

  // ── /configure redirect ───────────────────────────────────────────────────
  if (pathname === '/configure') { res.writeHead(302, { Location: '/' }); return res.end(); }

  // ── Static files / SPA ───────────────────────────────────────────────────
  if (fs.existsSync(DIST_DIR)) {
    const reqPath  = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const safePath = path.resolve(DIST_DIR, reqPath);
    if (!safePath.startsWith(path.resolve(DIST_DIR))) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) return serveFile(res, safePath);
    return serveFile(res, path.join(DIST_DIR, 'index.html'));
  }

  // ── No build yet ──────────────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type':'text/html;charset=utf-8' });
  res.end(installPage());
});

// ─── Error handlers ────────────────────────────────────────────────────────────
process.on('uncaughtException',  e => err('Uncaught:', e.message));
process.on('unhandledRejection', r => err('Unhandled:', String(r)));
server.on('error', e => { if (e.code === 'EADDRINUSE') { err(`Port ${PORT} in use`); process.exit(1); } err('Server:', e.message); });

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
  const INTERVAL = 14 * 60 * 1000;
  const pingUrl  = `${PUBLIC_URL}/health`;
  setInterval(() => {
    debug(`[KEEPALIVE] ping → ${pingUrl}`);
    const lib = pingUrl.startsWith('https') ? https : http;
    const req = lib.get(pingUrl, { timeout: 10000 }, res => { debug(`[KEEPALIVE] OK (${res.statusCode})`); res.resume(); });
    req.on('error', e => debug(`[KEEPALIVE] fail: ${e.message}`));
    req.on('timeout', () => { req.destroy(); debug('[KEEPALIVE] timeout'); });
  }, INTERVAL);
  log(`[KEEPALIVE] Active → pinging every 14min`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const iptvStreams  = getEnabledStreams();
  const iptvGroups  = getIptvGroups();
  const movieStream = getEnabledMovies();
  const movieGroups = groupMovies(movieStream);
  const iptvM       = buildIptvManifest();
  const movieM      = buildMovieManifest();
  const host        = PUBLIC_URL.replace(/^https?:\/\//, '');

  log('═══════════════════════════════════════════════════════════════════════');
  log(`🚀  Jash Addon Backend v11.0`);
  log(`📡  Port         : ${PORT}`);
  log(`🌐  Public URL   : ${PUBLIC_URL}`);
  log('───────────────────────────────────────────────────────────────────────');
  log(`📺  IPTV ADDON   : ${PUBLIC_URL}/manifest.json`);
  log(`    Stremio      : stremio://${host}/manifest.json`);
  log(`    Version      : ${iptvM.version}  (${IPTV_ID})`);
  log(`    Streams      : ${iptvStreams.length} | Groups: ${iptvGroups.length} | Catalogs: ${iptvM.catalogs.length}`);
  log('───────────────────────────────────────────────────────────────────────');
  log(`🎬  MOVIE ADDON  : ${PUBLIC_URL}/movie/manifest.json`);
  log(`    Stremio      : stremio://${host}/movie/manifest.json`);
  log(`    Version      : ${movieM.version}  (${MOVIE_ID})`);
  log(`    Movies       : ${movieGroups.length} unique | Streams: ${movieStream.length} | Catalogs: ${movieM.catalogs.length}`);
  log('───────────────────────────────────────────────────────────────────────');
  log(`⚙️   Configurator : ${PUBLIC_URL}/`);
  log(`🛠️   Install Page : ${PUBLIC_URL}/install`);
  log(`❤️   Health       : ${PUBLIC_URL}/health`);
  log(`📻  Playlist     : ${PUBLIC_URL}/p.m3u`);
  log('═══════════════════════════════════════════════════════════════════════');

  if (!PUBLIC_URL.includes('localhost') && !PUBLIC_URL.includes('127.0.0.1')) {
    startKeepalive();
  } else {
    log('[KEEPALIVE] Disabled (localhost)');
  }
});
