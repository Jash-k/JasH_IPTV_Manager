import React, { useState, useCallback, useEffect, useRef } from 'react';
import { MovieStream, MovieSource, MovieAddonSettings } from '../types';
import { fetchM3U } from '../utils/m3uParser';

// ── Storage keys ─────────────────────────────────────────────────────────────
const MOVIE_STREAMS_KEY  = 'jash_movie_streams';
const MOVIE_SOURCES_KEY  = 'jash_movie_sources';
const MOVIE_SETTINGS_KEY = 'jash_movie_settings';

function loadLS<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; }
}
function saveLS(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

// ── Default settings ──────────────────────────────────────────────────────────
const defaultSettings: MovieAddonSettings = {
  addonId: 'jash-movie-addon',
  addonName: 'Jash Movies',
  tmdbApiKey: '',
  autoFetchMetadata: true,
  removeDuplicates: true,
  combineQualities: true,
  defaultLanguage: 'en',
};

// ── Quality patterns ──────────────────────────────────────────────────────────
const QUALITY_PATTERNS = [
  { pattern: /\b4k|uhd|2160p\b/i, label: '4K' },
  { pattern: /\b1080p|fhd|fullhd\b/i, label: '1080p' },
  { pattern: /\b720p|hd\b/i, label: '720p' },
  { pattern: /\b480p|sd\b/i, label: '480p' },
  { pattern: /\b360p\b/i, label: '360p' },
];

function detectQuality(name: string, url: string): string {
  const combined = `${name} ${url}`.toLowerCase();
  for (const { pattern, label } of QUALITY_PATTERNS) {
    if (pattern.test(combined)) return label;
  }
  return '';
}

function extractYear(title: string): { title: string; year?: number } {
  const m = title.match(/^(.+?)\s*[\(\[]\s*(\d{4})\s*[\)\]]/);
  if (m) return { title: m[1].trim(), year: parseInt(m[2]) };
  const m2 = title.match(/^(.+?)\s+(\d{4})$/);
  if (m2 && parseInt(m2[2]) >= 1900 && parseInt(m2[2]) <= new Date().getFullYear() + 2) {
    return { title: m2[1].trim(), year: parseInt(m2[2]) };
  }
  return { title };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/\b(4k|uhd|fhd|hd|sd|1080p|720p|480p|2160p|bluray|blu-ray|webrip|web-dl|dvdrip|hdcam|cam|ts|scr)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Parse streams from content (M3U or JSON) ─────────────────────────────────
function parseMovieContent(content: string, sourceId: string): Omit<MovieStream, 'tmdbId' | 'imdbId' | 'poster' | 'backdrop' | 'overview' | 'rating' | 'genres' | 'releaseDate' | 'runtime'>[] {
  const streams: ReturnType<typeof parseMovieContent> = [];

  // Try JSON first
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const arr = JSON.parse(trimmed);
      const items = Array.isArray(arr) ? arr : (arr.data || arr.movies || arr.streams || arr.items || [arr]);
      items.forEach((item: any, i: number) => {
        const url = item.link || item.url || item.stream || item.src || item.streamUrl || '';
        const title = item.name || item.title || item.movie || item.channel || `Movie ${i + 1}`;
        if (!url) return;
        const { title: cleanTitle, year } = extractYear(title);
        streams.push({
          id: `mov_${sourceId}_${i}_${Date.now()}`,
          title: cleanTitle,
          year,
          url,
          quality: detectQuality(title, url),
          logo: item.logo || item.icon || item.image || item.poster || '',
          group: item.group || item['group-title'] || item.category || 'Movies',
          sourceId,
          enabled: true,
          source: item.source || '',
          licenseType: item.drmScheme || item.licenseType || '',
          licenseKey: item.drmLicense || item.licenseKey || '',
          userAgent: item.userAgent || '',
          cookie: item.cookie || '',
        });
      });
      return streams;
    } catch { /* fall through to M3U */ }
  }

  // Parse M3U
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  let meta: Partial<MovieStream> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      meta = {};
      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        const { title, year } = extractYear(nameMatch[1].trim());
        meta.title = title;
        meta.year = year;
      }
      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      const groupM = line.match(/group-title="([^"]+)"/i);
      if (logoM) meta.logo = logoM[1];
      if (groupM) meta.group = groupM[1];
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
      meta.licenseType = line.split('=')[1];
    } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      meta.licenseKey = line.split('=')[1];
    } else if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
      meta.userAgent = line.replace('#EXTVLCOPT:http-user-agent=', '');
    } else if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.replace('#EXTHTTP:', ''));
        if (h.cookie) meta.cookie = h.cookie;
      } catch { /* ignore */ }
    } else if (!line.startsWith('#')) {
      const url = line;
      if (!meta.title) {
        const { title, year } = extractYear(url.split('/').pop()?.replace(/\.(m3u8?|mpd|ts|mp4).*$/i, '') || 'Unknown');
        meta.title = title;
        meta.year = year;
      }
      streams.push({
        id: `mov_${sourceId}_${streams.length}_${Date.now()}`,
        title: meta.title || 'Unknown',
        year: meta.year,
        url,
        quality: detectQuality(meta.title || '', url),
        logo: meta.logo || '',
        group: meta.group || 'Movies',
        sourceId,
        enabled: true,
        source: '',
        licenseType: meta.licenseType || '',
        licenseKey: meta.licenseKey || '',
        userAgent: meta.userAgent || '',
        cookie: meta.cookie || '',
      });
      meta = {};
    }
  }
  return streams;
}

// ── Remove duplicates ─────────────────────────────────────────────────────────
function removeDuplicates(streams: MovieStream[]): MovieStream[] {
  const seen = new Map<string, MovieStream>();
  for (const s of streams) {
    const key = normalizeTitle(s.title) + (s.year ? `_${s.year}` : '');
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, s);
    } else {
      // Keep the higher quality one
      const qRank: Record<string, number> = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, '360p': 0, '': -1 };
      if ((qRank[s.quality || ''] || 0) > (qRank[existing.quality || ''] || 0)) {
        seen.set(key, s);
      }
    }
  }
  return Array.from(seen.values());
}

// ── Combine qualities ─────────────────────────────────────────────────────────
interface MovieGroup {
  title: string;
  year?: number;
  streams: MovieStream[];
  metadata?: Partial<MovieStream>;
}

function combineByQuality(streams: MovieStream[]): MovieGroup[] {
  const map = new Map<string, MovieGroup>();
  for (const s of streams) {
    const key = normalizeTitle(s.title) + (s.year ? `_${s.year}` : '');
    if (!map.has(key)) {
      map.set(key, { title: s.title, year: s.year, streams: [], metadata: s });
    }
    map.get(key)!.streams.push(s);
  }
  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

// ── TMDB API ──────────────────────────────────────────────────────────────────
async function fetchTMDB(title: string, year: number | undefined, apiKey: string): Promise<Partial<MovieStream>> {
  if (!apiKey) return {};
  try {
    const yearParam = year ? `&year=${year}` : '';
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}${yearParam}&language=en-US&page=1`;
    const res = await fetch(searchUrl);
    if (!res.ok) return {};
    const data = await res.json();
    const movie = data.results?.[0];
    if (!movie) return {};
    return {
      tmdbId: movie.id,
      poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : undefined,
      backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : undefined,
      overview: movie.overview,
      rating: movie.vote_average,
      genres: [],
      releaseDate: movie.release_date,
    };
  } catch { return {}; }
}

// ── Generate server code ──────────────────────────────────────────────────────
function generateMovieServerCode(streams: MovieStream[], settings: MovieAddonSettings): string {
  const grouped = combineByQuality(streams.filter(s => s.enabled));
  const catalogData = grouped.map(g => ({
    title: g.title,
    year: g.year,
    imdbId: g.metadata?.imdbId,
    tmdbId: g.metadata?.tmdbId,
    poster: g.metadata?.poster || g.metadata?.logo,
    backdrop: g.metadata?.backdrop,
    overview: g.metadata?.overview,
    rating: g.metadata?.rating,
    genres: g.metadata?.genres || [],
    releaseDate: g.metadata?.releaseDate,
    streams: g.streams.map(s => ({ url: s.url, quality: s.quality || 'HD', licenseType: s.licenseType, licenseKey: s.licenseKey, userAgent: s.userAgent, cookie: s.cookie })),
  }));

  return `#!/usr/bin/env node
// Jash Movie Addon — Auto-generated
// Install: npm install && node movie-server.js

const { addonBuilder } = require('stremio-addon-sdk');
const http = require('http');
const https = require('https');

const MOVIES = ${JSON.stringify(catalogData, null, 2)};

const manifest = {
  id: '${settings.addonId}',
  version: '1.0.0',
  name: '${settings.addonName}',
  description: '${settings.addonName} · ${streams.filter(s => s.enabled).length} streams · ${grouped.length} movies',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['jmov'],
  catalogs: [
    { type: 'movie', id: 'jmov_all', name: 'All Movies', extra: [{ name: 'search' }, { name: 'genre' }, { name: 'skip' }] },
    { type: 'movie', id: 'jmov_hd', name: '1080p & 4K', extra: [{ name: 'search' }, { name: 'skip' }] },
  ],
  behaviorHints: { adult: false, p2p: false, configurable: true },
};

const builder = new addonBuilder(manifest);

const enc = u => Buffer.from(u, 'utf8').toString('base64url');
const dec = s => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } };

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'movie') return Promise.resolve({ metas: [] });
  const search = (extra.search || '').toLowerCase();
  const skip   = parseInt(extra.skip || '0') || 0;

  let list = [...MOVIES];
  if (id === 'jmov_hd') list = list.filter(m => m.streams.some(s => s.quality === '1080p' || s.quality === '4K'));
  if (search) list = list.filter(m => m.title.toLowerCase().includes(search));

  const metas = list.slice(skip, skip + 100).map(m => ({
    id: 'jmov' + enc(m.title + (m.year || '')),
    type: 'movie',
    name: m.title,
    year: m.year,
    poster: m.poster || null,
    background: m.backdrop || null,
    description: m.overview || null,
    imdbRating: m.rating ? m.rating.toFixed(1) : null,
    genres: m.genres || [],
    releaseInfo: m.year ? String(m.year) : null,
  }));

  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ type, id }) => {
  if (type !== 'movie') return Promise.resolve({ meta: null });
  const key = dec(id.replace('jmov', ''));
  const m = MOVIES.find(x => (x.title + (x.year || '')) === key);
  if (!m) return Promise.resolve({ meta: null });
  return Promise.resolve({
    meta: {
      id, type: 'movie', name: m.title, year: m.year,
      poster: m.poster || null, background: m.backdrop || null,
      description: m.overview || null, releaseInfo: m.year ? String(m.year) : null,
      imdbRating: m.rating ? m.rating.toFixed(1) : null,
      genres: m.genres || [],
    }
  });
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'movie') return { streams: [] };
  const key = dec(id.replace('jmov', ''));
  const movie = MOVIES.find(m => (m.title + (m.year || '')) === key);
  if (!movie) return { streams: [] };

  const streams = movie.streams.map(s => {
    const entry = {
      url: s.url,
      name: '${settings.addonName}',
      title: s.quality ? \`\${s.quality}\` : 'Stream',
      behaviorHints: { notWebReady: true },
    };
    if (s.userAgent || s.cookie) {
      const h = {};
      if (s.userAgent) h['User-Agent'] = s.userAgent;
      if (s.cookie) h['Cookie'] = s.cookie;
      entry.behaviorHints.proxyHeaders = { request: h };
    }
    return entry;
  });

  return { streams };
});

const addonInterface = builder.getInterface();
const PORT = process.env.PORT || 7001;
const server = require('http').createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = req.url.replace(/\\/+$/, '') || '/';
  if (url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(addonInterface.manifest));
  }

  const m = url.match(/^\\/(catalog|meta|stream)\\/([^\\/]+)\\/(.+)\\.json$/);
  if (m) {
    const [, resource, type, id] = m;
    const extra = {};
    const searchM = id.match(/search=(.*?)(&|$)/);
    const skipM   = id.match(/skip=(.*?)(&|$)/);
    if (searchM) extra.search = decodeURIComponent(searchM[1]);
    if (skipM)   extra.skip   = skipM[1];
    const cleanId = id.split('/')[0];
    addonInterface[resource + 'Handler']({ type, id: cleanId, extra }).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(e => {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ name: '${settings.addonName}', manifest: '/manifest.json' }));
});

server.listen(PORT, () => {
  console.log('🎬 ${settings.addonName} running on port', PORT);
  console.log('📋 Manifest: http://localhost:' + PORT + '/manifest.json');
  console.log('📺 Install:  stremio://localhost:' + PORT + '/manifest.json');
});
`;
}

// ── Main Component ────────────────────────────────────────────────────────────
const MovieAddonTab: React.FC = () => {
  const [sources, setSources]   = useState<MovieSource[]>(() => loadLS(MOVIE_SOURCES_KEY, []));
  const [streams, setStreams]   = useState<MovieStream[]>(() => loadLS(MOVIE_STREAMS_KEY, []));
  const [settings, setSettings] = useState<MovieAddonSettings>(() => loadLS(MOVIE_SETTINGS_KEY, defaultSettings));
  const [activeSection, setActiveSection] = useState<'sources' | 'movies' | 'settings' | 'export'>('sources');
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterQuality, setFilterQuality] = useState('');
  const [filterGenre, setFilterGenre] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterRating, setFilterRating] = useState('');
  const [fetchingMeta, setFetchingMeta] = useState<string[]>([]);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceType, setNewSourceType] = useState<'url' | 'json'>('url');
  const [generatedCode, setGeneratedCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [editingStream, setEditingStream] = useState<MovieStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [syncing, setSyncing] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [lastSyncMsg, setLastSyncMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [movieManifestUrl] = useState(() => {
    try { return `${window.location.protocol}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}/movie/manifest.json`; } catch { return '/movie/manifest.json'; }
  });
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const notify = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  };

  // ── Backend health check ────────────────────────────────────────────────
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(`${movieManifestUrl.replace('/movie/manifest.json', '')}/health`, { signal: AbortSignal.timeout(5000) });
        setBackendOnline(res.ok);
      } catch { setBackendOnline(false); }
    };
    checkHealth();
    const iv = setInterval(checkHealth, 30000);
    return () => clearInterval(iv);
  }, [movieManifestUrl]);

  // ── Sync movies to backend ──────────────────────────────────────────────
  const handleMovieSync = useCallback(async () => {
    setSyncing(true);
    try {
      const { syncMoviesToBackend: syncFn } = await import('../utils/backendSync');
      const result = await syncFn({
        streams: streams.filter(s => s.enabled),
        settings: settings as unknown as Record<string, unknown>,
      });
      setLastSyncMsg({ ok: result.ok, msg: result.message });
      notify(result.message, result.ok ? 'success' : 'error');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastSyncMsg({ ok: false, msg });
      notify(`Sync failed: ${msg}`, 'error');
    } finally { setSyncing(false); }
  }, [streams, settings, notify]);

  // ── Copy to clipboard ───────────────────────────────────────────────────
  const copyToClipboard = useCallback(async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const el = document.createElement('textarea'); el.value = text;
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
    }
    setCopiedKey(key); setTimeout(() => setCopiedKey(null), 2500);
    notify('Copied!', 'success');
  }, [notify]);

  const saveStreams = (s: MovieStream[]) => { saveLS(MOVIE_STREAMS_KEY, s); setStreams(s); };
  const saveSources = (s: MovieSource[]) => { saveLS(MOVIE_SOURCES_KEY, s); setSources(s); };
  const saveSettings = (s: MovieAddonSettings) => { saveLS(MOVIE_SETTINGS_KEY, s); setSettings(s); };

  // ── Auto-refresh sources ────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      const now = Date.now();
      const due = sources.filter(s =>
        s.enabled && s.autoRefreshInterval && s.autoRefreshInterval > 0 &&
        s.url && s.nextAutoRefresh && now >= s.nextAutoRefresh
      );
      for (const src of due) {
        try {
          const content = await fetchM3U(src.url!, '');
          const parsed = parseMovieContent(content, src.id).map((s, i) => ({
            ...s, id: `mov_${src.id}_${i}_${Date.now()}`,
            tmdbId: undefined, imdbId: undefined, poster: undefined,
            backdrop: undefined, overview: undefined, rating: undefined,
            genres: undefined, releaseDate: undefined, runtime: undefined,
          })) as MovieStream[];
          const otherStreams = streams.filter(s => s.sourceId !== src.id);
          const newStreams = [...otherStreams, ...parsed];
          saveStreams(newStreams);
          const updated = { ...src, streamCount: parsed.length, status: 'active' as const, lastUpdated: now, nextAutoRefresh: now + src.autoRefreshInterval! * 60 * 1000 };
          saveSources(sources.map(s => s.id === src.id ? updated : s));
          notify(`🔄 Auto-refreshed: ${src.name}`, 'info');
        } catch (_) {}
      }
    }, 60_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, streams]);

  // ── Add source ──────────────────────────────────────────────────────────
  const addSource = useCallback(async () => {
    if (!newSourceUrl.trim()) return;
    const srcId = `movsrc_${Date.now()}`;
    const src: MovieSource = {
      id: srcId, name: newSourceName || newSourceUrl.split('/').pop() || 'Movie Source',
      type: newSourceType, url: newSourceUrl, enabled: true, streamCount: 0,
      status: 'loading', lastUpdated: Date.now(),
    };
    const updatedSources = [...sources, src];
    saveSources(updatedSources);
    setLoading(true);
    try {
      const content = await fetchM3U(newSourceUrl, '');
      const parsed = parseMovieContent(content, srcId).map((s, i) => ({
        ...s, id: `mov_${srcId}_${i}_${Date.now()}`,
        tmdbId: undefined, imdbId: undefined, poster: undefined,
        backdrop: undefined, overview: undefined, rating: undefined,
        genres: undefined, releaseDate: undefined, runtime: undefined,
      })) as MovieStream[];

      let finalStreams = [...streams.filter(s => s.sourceId !== srcId), ...parsed];
      if (settings.removeDuplicates) finalStreams = removeDuplicates(finalStreams);

      saveStreams(finalStreams);
      const updated = { ...src, status: 'active' as const, streamCount: parsed.length };
      saveSources(updatedSources.map(s => s.id === srcId ? updated : s));
      notify(`✅ Added ${parsed.length} movies from "${src.name}"`, 'success');
      setShowAddSource(false);
      setNewSourceUrl('');
      setNewSourceName('');

      // Auto-fetch TMDB if enabled and API key present
      if (settings.autoFetchMetadata && settings.tmdbApiKey) {
        fetchAllMetadata(finalStreams, settings.tmdbApiKey);
      }
    } catch (e: any) {
      const updated = { ...src, status: 'error' as const, error: e.message };
      saveSources(updatedSources.map(s => s.id === srcId ? updated : s));
      notify(`Error: ${e.message}`, 'error');
    } finally { setLoading(false); }
  }, [newSourceUrl, newSourceName, newSourceType, sources, streams, settings]);

  // ── File upload ─────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      const srcId = `movsrc_file_${Date.now()}`;
      const src: MovieSource = {
        id: srcId, name: file.name.replace(/\.(m3u8?|json)$/i, ''),
        type: 'file', content, enabled: true, streamCount: 0,
        status: 'loading', lastUpdated: Date.now(),
      };
      const updatedSources = [...sources, src];
      saveSources(updatedSources);
      setLoading(true);
      try {
        const parsed = parseMovieContent(content, srcId).map((s, i) => ({
          ...s, id: `mov_${srcId}_${i}_${Date.now()}`,
          tmdbId: undefined, imdbId: undefined, poster: undefined,
          backdrop: undefined, overview: undefined, rating: undefined,
          genres: undefined, releaseDate: undefined, runtime: undefined,
        })) as MovieStream[];
        let finalStreams = [...streams.filter(s => s.sourceId !== srcId), ...parsed];
        if (settings.removeDuplicates) finalStreams = removeDuplicates(finalStreams);
        saveStreams(finalStreams);
        const updated = { ...src, status: 'active' as const, streamCount: parsed.length };
        saveSources(updatedSources.map(s => s.id === srcId ? updated : s));
        notify(`✅ Uploaded ${parsed.length} movies`, 'success');
      } catch (ex: any) {
        notify(`Upload error: ${ex.message}`, 'error');
      } finally { setLoading(false); }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ── Delete source ───────────────────────────────────────────────────────
  const deleteSource = (srcId: string) => {
    saveSources(sources.filter(s => s.id !== srcId));
    saveStreams(streams.filter(s => s.sourceId !== srcId));
    notify('Source deleted', 'success');
  };

  // ── Refresh source ──────────────────────────────────────────────────────
  const refreshSource = async (src: MovieSource) => {
    if (!src.url) return;
    saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'loading' } : s));
    try {
      const content = await fetchM3U(src.url, '');
      const parsed = parseMovieContent(content, src.id).map((s, i) => ({
        ...s, id: `mov_${src.id}_${i}_${Date.now()}`,
        tmdbId: undefined, imdbId: undefined, poster: undefined,
        backdrop: undefined, overview: undefined, rating: undefined,
        genres: undefined, releaseDate: undefined, runtime: undefined,
      })) as MovieStream[];
      let finalStreams = [...streams.filter(s => s.sourceId !== src.id), ...parsed];
      if (settings.removeDuplicates) finalStreams = removeDuplicates(finalStreams);
      saveStreams(finalStreams);
      saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'active', streamCount: parsed.length, lastUpdated: Date.now() } : s));
      notify(`✅ Refreshed ${parsed.length} movies`, 'success');
    } catch (e: any) {
      saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'error', error: e.message } : s));
      notify(`Refresh failed: ${e.message}`, 'error');
    }
  };

  // ── Fetch TMDB metadata ─────────────────────────────────────────────────
  const fetchAllMetadata = async (streamList: MovieStream[], apiKey: string) => {
    const groups = combineByQuality(streamList);
    const toFetch = groups.filter(g => !g.metadata?.tmdbId);
    if (!toFetch.length) { notify('All metadata already fetched', 'info'); return; }
    notify(`Fetching metadata for ${toFetch.length} movies...`, 'info');
    const batchSize = 5;
    const updatedStreams = [...streamList];

    for (let i = 0; i < toFetch.length; i += batchSize) {
      const batch = toFetch.slice(i, i + batchSize);
      setFetchingMeta(batch.map(g => g.title));
      await Promise.all(batch.map(async (group) => {
        const meta = await fetchTMDB(group.title, group.year, apiKey);
        if (!meta.tmdbId) return;
        // Apply metadata to all streams in this group
        group.streams.forEach(gs => {
          const idx = updatedStreams.findIndex(s => s.id === gs.id);
          if (idx >= 0) Object.assign(updatedStreams[idx], meta);
        });
      }));
      saveStreams([...updatedStreams]);
      await new Promise(r => setTimeout(r, 300)); // Rate limit
    }
    setFetchingMeta([]);
    notify('✅ Metadata fetched successfully', 'success');
  };

  // ── Filtered movies for display ─────────────────────────────────────────
  const combinedMovies = combineByQuality(streams.filter(s => s.enabled));
  const filteredMovies = combinedMovies.filter(m => {
    const meta = m.metadata;
    if (searchQuery && !m.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterQuality && !m.streams.some(s => s.quality === filterQuality)) return false;
    if (filterYear && String(m.year) !== filterYear) return false;
    if (filterRating && meta?.rating && meta.rating < parseFloat(filterRating)) return false;
    if (filterGenre && meta?.genres && !meta.genres.some(g => g.toLowerCase().includes(filterGenre.toLowerCase()))) return false;
    return true;
  });

  const qualities = [...new Set(streams.map(s => s.quality).filter(Boolean))].sort();
  const years = [...new Set(streams.map(s => s.year).filter(Boolean))].sort((a, b) => (b as number) - (a as number));

  // ── Generate & export ───────────────────────────────────────────────────
  const generateAddon = () => {
    const code = generateMovieServerCode(streams, settings);
    setGeneratedCode(code);
    setShowCode(true);
  };

  const downloadAddon = () => {
    const code = generateMovieServerCode(streams, settings);
    const pkg = JSON.stringify({
      name: settings.addonId,
      version: '1.0.0',
      scripts: { start: 'node movie-server.js' },
      dependencies: { 'stremio-addon-sdk': '^1.6.10' },
    }, null, 2);
    // Download server.js
    const blob1 = new Blob([code], { type: 'text/javascript' });
    const a1 = document.createElement('a');
    a1.href = URL.createObjectURL(blob1);
    a1.download = 'movie-server.js';
    a1.click();
    // Download package.json
    setTimeout(() => {
      const blob2 = new Blob([pkg], { type: 'application/json' });
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(blob2);
      a2.download = 'package.json';
      a2.click();
    }, 500);
    notify('Downloaded movie-server.js + package.json', 'success');
  };

  const exportM3U = () => {
    const lines = ['#EXTM3U'];
    streams.filter(s => s.enabled).forEach(s => {
      lines.push(`#EXTINF:-1 tvg-logo="${s.logo || ''}" group-title="${s.group || 'Movies'}",${s.title}${s.quality ? ` [${s.quality}]` : ''}${s.year ? ` (${s.year})` : ''}`);
      if (s.licenseType && s.licenseKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=${s.licenseType}`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${s.licenseKey}`);
      }
      if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
      if (s.cookie) lines.push(`#EXTHTTP:{"cookie":"${s.cookie}"}`);
      lines.push(s.url);
    });
    const blob = new Blob([lines.join('\n')], { type: 'application/x-mpegurl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${settings.addonName.replace(/\s+/g, '-')}-movies.m3u`;
    a.click();
    notify('Downloaded M3U playlist', 'success');
  };

  const deleteStream = (id: string) => {
    saveStreams(streams.filter(s => s.id !== id));
  };

  const _toggleStream = (id: string) => {
    saveStreams(streams.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };
  void _toggleStream;

  return (
    <div className="h-full flex flex-col bg-gray-950">
      {/* Notification */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm shadow-2xl flex items-center gap-2 ${
          notification.type === 'success' ? 'bg-green-600' : notification.type === 'error' ? 'bg-red-600' : 'bg-blue-600'
        }`}>
          {notification.type === 'success' ? '✅' : notification.type === 'error' ? '❌' : 'ℹ️'}
          {notification.msg}
        </div>
      )}

      {/* Header */}
      <div className="bg-gray-900 border-b border-white/10 px-6 py-4 flex-shrink-0">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              🎬 <span>Movie Addon</span>
              <span className="bg-yellow-500 text-black text-xs px-2 py-0.5 rounded-full font-bold">SEPARATE</span>
            </h2>
            <p className="text-gray-400 text-xs mt-0.5">
              Stremio movie addon · {streams.filter(s => s.enabled).length} streams · {combinedMovies.length} unique movies
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportM3U}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-2 rounded-lg transition-colors">
              ⬇️ M3U
            </button>
            <button onClick={generateAddon}
              className="flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs px-3 py-2 rounded-lg transition-colors">
              🖥️ Generate Server
            </button>
            <button onClick={downloadAddon}
              className="flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-2 rounded-lg transition-colors">
              📦 Download
            </button>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-1 mt-4">
          {(['sources', 'movies', 'settings', 'export'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveSection(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors ${
                activeSection === tab ? 'bg-yellow-500 text-black' : 'bg-white/10 text-gray-300 hover:bg-white/20'
              }`}>
              {tab === 'sources' ? '📂 Sources' : tab === 'movies' ? `🎬 Movies (${filteredMovies.length})` : tab === 'settings' ? '⚙️ Settings' : '🚀 Export'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Sources ──────────────────────────────────────────────────── */}
        {activeSection === 'sources' && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold">Movie Sources ({sources.length})</h3>
              <div className="flex gap-2">
                <button onClick={() => fileRef.current?.click()}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors">
                  📁 Upload File
                </button>
                <button onClick={() => setShowAddSource(true)}
                  className="bg-yellow-500 hover:bg-yellow-600 text-black text-xs px-3 py-1.5 rounded-lg font-medium transition-colors">
                  + Add URL / JSON
                </button>
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".m3u,.m3u8,.json" className="hidden" onChange={handleFileUpload} />

            {/* Add Source Form */}
            {showAddSource && (
              <div className="bg-gray-900 border border-yellow-500/30 rounded-xl p-4 space-y-3">
                <h4 className="text-yellow-400 font-medium text-sm">Add Movie Source</h4>
                <div className="flex gap-2">
                  {(['url', 'json'] as const).map(t => (
                    <button key={t} onClick={() => setNewSourceType(t)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${newSourceType === t ? 'bg-yellow-500 text-black' : 'bg-white/10 text-gray-300 hover:bg-white/20'}`}>
                      {t === 'url' ? '🔗 M3U URL' : '📋 JSON URL'}
                    </button>
                  ))}
                </div>
                <input type="text" placeholder="Source name (optional)"
                  value={newSourceName} onChange={e => setNewSourceName(e.target.value)}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500 placeholder-gray-500" />
                <input type="text" placeholder={newSourceType === 'json' ? 'https://example.com/movies.json' : 'https://example.com/movies.m3u'}
                  value={newSourceUrl} onChange={e => setNewSourceUrl(e.target.value)}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500 placeholder-gray-500" />
                <div className="flex gap-2">
                  <button onClick={addSource} disabled={loading}
                    className="bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                    {loading ? 'Loading...' : 'Add Source'}
                  </button>
                  <button onClick={() => setShowAddSource(false)}
                    className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Source List */}
            {sources.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <div className="text-4xl mb-3">🎬</div>
                <p>No movie sources added yet.</p>
                <p className="text-xs mt-1">Add an M3U URL or JSON file with movies.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sources.map(src => (
                  <div key={src.id} className="bg-gray-900 border border-white/10 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${src.status === 'active' ? 'bg-green-500' : src.status === 'error' ? 'bg-red-500' : src.status === 'loading' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-500'}`} />
                        <div className="min-w-0">
                          <p className="text-white text-sm font-medium truncate">{src.name}</p>
                          <p className="text-gray-500 text-xs truncate">{src.url || 'Uploaded file'}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                              {src.streamCount} movies
                            </span>
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-0.5 rounded uppercase">
                              {src.type}
                            </span>
                            {src.error && <span className="text-xs text-red-400">{src.error}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {src.url && (
                          <button onClick={() => refreshSource(src)}
                            className="bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 px-2 py-1 rounded text-xs transition-colors">
                            🔄 Refresh
                          </button>
                        )}
                        <button onClick={() => deleteSource(src.id)}
                          className="bg-red-500/20 hover:bg-red-500/40 text-red-400 px-2 py-1 rounded text-xs transition-colors">
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Auto-refresh */}
                    {src.url && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-gray-500 text-xs">Auto-refresh:</span>
                        <select value={src.autoRefreshInterval || 0}
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            const updated = { ...src, autoRefreshInterval: val, nextAutoRefresh: val > 0 ? Date.now() + val * 60 * 1000 : undefined };
                            saveSources(sources.map(s => s.id === src.id ? updated : s));
                          }}
                          className="bg-white/5 text-gray-300 text-xs rounded px-2 py-1 border border-white/10 focus:outline-none focus:border-yellow-500">
                          <option value={0}>Off</option>
                          <option value={60}>1 hour</option>
                          <option value={360}>6 hours</option>
                          <option value={720}>12 hours</option>
                          <option value={1440}>24 hours</option>
                        </select>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Movies ───────────────────────────────────────────────────── */}
        {activeSection === 'movies' && (
          <div className="p-6 space-y-4">
            {/* Filters */}
            <div className="bg-gray-900 border border-white/10 rounded-xl p-4 space-y-3">
              <h3 className="text-white font-semibold text-sm flex items-center gap-2">🔍 Filters</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <input type="text" placeholder="Search title..."
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  className="col-span-2 sm:col-span-1 bg-white/5 text-white text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500 placeholder-gray-500" />
                <select value={filterQuality} onChange={e => setFilterQuality(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Quality</option>
                  {qualities.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
                <select value={filterYear} onChange={e => setFilterYear(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Years</option>
                  {years.slice(0, 30).map(y => <option key={y} value={String(y)}>{y}</option>)}
                </select>
                <select value={filterRating} onChange={e => setFilterRating(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Ratings</option>
                  <option value="8">8+ ⭐</option>
                  <option value="7">7+ ⭐</option>
                  <option value="6">6+ ⭐</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400 text-xs">{filteredMovies.length} movies shown</span>
                <div className="flex gap-2">
                  {settings.tmdbApiKey && (
                    <button onClick={() => fetchAllMetadata(streams, settings.tmdbApiKey)}
                      disabled={fetchingMeta.length > 0}
                      className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1">
                      {fetchingMeta.length > 0 ? <>⏳ Fetching {fetchingMeta.length}...</> : <>🎭 Fetch TMDB Metadata</>}
                    </button>
                  )}
                  <button onClick={() => { setSearchQuery(''); setFilterQuality(''); setFilterYear(''); setFilterRating(''); setFilterGenre(''); }}
                    className="text-gray-400 hover:text-white text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                    Clear Filters
                  </button>
                </div>
              </div>
            </div>

            {/* Movie Grid */}
            {filteredMovies.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <div className="text-4xl mb-3">🎬</div>
                <p>No movies found.</p>
                <p className="text-xs mt-1">Add movie sources first.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                {filteredMovies.slice(0, 200).map(movie => {
                  const meta = movie.metadata;
                  const poster = meta?.poster || meta?.logo || '';
                  void movie.streams.some(s => s.quality === '1080p' || s.quality === '4K');
                  return (
                    <div key={movie.title + movie.year}
                      className="bg-gray-900 border border-white/10 rounded-xl overflow-hidden hover:border-yellow-500/50 transition-all group">
                      {/* Poster */}
                      <div className="relative aspect-[2/3] bg-gray-800">
                        {poster ? (
                          <img src={poster} alt={movie.title}
                            className="w-full h-full object-cover"
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-4xl text-gray-700">🎬</div>
                        )}
                        {/* Quality badges */}
                        <div className="absolute top-1 left-1 flex flex-wrap gap-1">
                          {[...new Set(movie.streams.map(s => s.quality).filter(Boolean))].slice(0, 3).map(q => (
                            <span key={q} className={`text-xs px-1 py-0.5 rounded font-bold ${q === '4K' ? 'bg-yellow-500 text-black' : q === '1080p' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-white'}`}>
                              {q}
                            </span>
                          ))}
                        </div>
                        {/* Rating */}
                        {meta?.rating && (
                          <div className="absolute top-1 right-1 bg-black/80 text-yellow-400 text-xs px-1.5 py-0.5 rounded font-bold">
                            ⭐ {meta.rating.toFixed(1)}
                          </div>
                        )}
                        {/* Stream count */}
                        {movie.streams.length > 1 && (
                          <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
                            {movie.streams.length} streams
                          </div>
                        )}
                        {/* Delete overlay */}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                          <button onClick={() => movie.streams.forEach(s => deleteStream(s.id))}
                            className="w-full bg-red-500 hover:bg-red-600 text-white text-xs py-1.5 rounded transition-colors">
                            Remove
                          </button>
                        </div>
                      </div>
                      {/* Info */}
                      <div className="p-2">
                        <p className="text-white text-xs font-medium truncate" title={movie.title}>{movie.title}</p>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-gray-500 text-xs">{movie.year || '—'}</span>
                          {meta?.genres?.[0] && (
                            <span className="text-gray-600 text-xs truncate max-w-16">{meta.genres[0]}</span>
                          )}
                        </div>
                        {meta?.overview && (
                          <p className="text-gray-600 text-xs mt-1 line-clamp-2 leading-tight">{meta.overview}</p>
                        )}
                        {/* DRM indicator */}
                        {movie.streams.some(s => s.licenseType) && (
                          <div className="mt-1 text-xs text-red-400 flex items-center gap-1">
                            🔐 <span>{movie.streams.find(s => s.licenseType)?.licenseType}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {filteredMovies.length > 200 && (
              <p className="text-center text-gray-500 text-sm py-4">Showing first 200 of {filteredMovies.length} movies</p>
            )}
          </div>
        )}

        {/* ── Settings ─────────────────────────────────────────────────── */}
        {activeSection === 'settings' && (
          <div className="p-6 space-y-4 max-w-2xl">
            <h3 className="text-white font-semibold">Movie Addon Settings</h3>

            <div className="bg-gray-900 border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <label className="text-gray-300 text-sm font-medium block mb-1">Addon ID</label>
                <input type="text" value={settings.addonId}
                  onChange={e => setSettings(p => ({ ...p, addonId: e.target.value }))}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="text-gray-300 text-sm font-medium block mb-1">Addon Name</label>
                <input type="text" value={settings.addonName}
                  onChange={e => setSettings(p => ({ ...p, addonName: e.target.value }))}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500" />
              </div>
              <div>
                <label className="text-gray-300 text-sm font-medium block mb-1">
                  TMDB API Key
                  <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
                    className="text-yellow-400 text-xs ml-2 hover:underline">Get free key →</a>
                </label>

                {/* Env var notice — most important */}
                <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 mb-2">
                  <p className="text-orange-300 text-xs font-semibold mb-1">⭐ Recommended: Use Environment Variable</p>
                  <p className="text-gray-400 text-xs">Set <code className="bg-black/30 text-orange-300 px-1 py-0.5 rounded">TMDB_API_KEY=your_key</code> in your Render/Koyeb/Railway environment variables.</p>
                  <p className="text-gray-500 text-xs mt-1">The env var is loaded automatically by the backend and is more secure than storing it in the browser.</p>
                  <div className="mt-2 bg-black/30 rounded p-2 font-mono text-xs text-green-400">
                    TMDB_API_KEY=a1b2c3d4e5f6...
                  </div>
                </div>

                <input type="password" placeholder="Or enter key here for local use only..."
                  value={settings.tmdbApiKey}
                  onChange={e => setSettings(p => ({ ...p, tmdbApiKey: e.target.value }))}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500 placeholder-gray-500" />
                <p className="text-gray-500 text-xs mt-1">
                  Used to fetch movie posters, ratings, genres, and descriptions from TMDB.
                  The backend uses the env var; this field is used for local frontend metadata fetching only.
                </p>
              </div>

              {[
                { key: 'autoFetchMetadata', label: 'Auto-fetch TMDB metadata on source add', desc: 'Automatically fetch movie details from TMDB when adding sources' },
                { key: 'removeDuplicates', label: 'Remove duplicate movies', desc: 'Keep only the highest quality version when same movie exists multiple times' },
                { key: 'combineQualities', label: 'Combine quality streams', desc: 'Show multiple quality options (720p, 1080p, 4K) as a single catalog entry in Stremio' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-start justify-between gap-3 pt-3 border-t border-white/10">
                  <div>
                    <p className="text-white text-sm font-medium">{label}</p>
                    <p className="text-gray-500 text-xs mt-0.5">{desc}</p>
                  </div>
                  <button onClick={() => setSettings(p => ({ ...p, [key]: !p[key as keyof MovieAddonSettings] }))}
                    className={`flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings[key as keyof MovieAddonSettings] ? 'bg-yellow-500' : 'bg-gray-600'}`}>
                    <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${settings[key as keyof MovieAddonSettings] ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              ))}
            </div>

            <button onClick={() => { saveSettings(settings); notify('Settings saved', 'success'); }}
              className="bg-yellow-500 hover:bg-yellow-600 text-black px-6 py-2.5 rounded-lg text-sm font-bold transition-colors">
              Save Settings
            </button>
          </div>
        )}

        {/* ── Export / Server ───────────────────────────────────────────── */}
        {activeSection === 'export' && (
          <div className="p-6 space-y-4 max-w-3xl">
            <h3 className="text-white font-semibold">Export Movie Addon</h3>

            {/* Info card */}
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
              <h4 className="text-yellow-400 font-semibold text-sm mb-2">📋 How to Deploy Your Movie Addon</h4>
              <ol className="text-gray-300 text-xs space-y-1.5 list-decimal list-inside">
                <li>Click <strong>Download Addon Files</strong> to get <code className="bg-black/30 px-1 rounded">movie-server.js</code> + <code className="bg-black/30 px-1 rounded">package.json</code></li>
                <li>Upload both files to Render, Railway, or Koyeb</li>
                <li>Set Start Command: <code className="bg-black/30 px-1 rounded">node movie-server.js</code></li>
                <li>Install in Stremio: <code className="bg-black/30 px-1 rounded">https://your-app.com/manifest.json</code></li>
              </ol>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total Streams', value: streams.length },
                { label: 'Unique Movies', value: combinedMovies.length },
                { label: 'With Metadata', value: streams.filter(s => s.tmdbId).length },
                { label: 'With 4K/1080p', value: streams.filter(s => s.quality === '4K' || s.quality === '1080p').length },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-900 border border-white/10 rounded-xl p-3 text-center">
                  <div className="text-2xl font-bold text-yellow-400">{value.toLocaleString()}</div>
                  <div className="text-gray-400 text-xs mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
              <button onClick={handleMovieSync} disabled={syncing || !streams.filter(s => s.enabled).length}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors ${syncing ? 'bg-violet-800 text-violet-300 cursor-wait animate-pulse' : backendOnline ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}`}>
                <span className={syncing ? 'animate-spin inline-block' : ''}>🔄</span>
                {syncing ? 'Syncing…' : `Sync ${streams.filter(s => s.enabled).length} Movies to Backend`}
              </button>
              <button onClick={downloadAddon}
                className="flex items-center gap-2 bg-yellow-500 hover:bg-yellow-600 text-black px-5 py-2.5 rounded-lg text-sm font-bold transition-colors">
                📦 Download Addon Files
              </button>
              <button onClick={generateAddon}
                className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors">
                🖥️ Preview Server Code
              </button>
              <button onClick={exportM3U}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors">
                📋 Download M3U Playlist
              </button>
            </div>

            {/* Backend sync status */}
            {lastSyncMsg && (
              <div className={`px-4 py-3 rounded-lg text-sm ${lastSyncMsg.ok ? 'bg-emerald-900/30 border border-emerald-700/40 text-emerald-300' : 'bg-orange-900/30 border border-orange-700/40 text-orange-300'}`}>
                {lastSyncMsg.msg}
              </div>
            )}

            {/* Movie Addon install URLs */}
            <div className="bg-orange-900/20 border border-orange-700/30 rounded-xl p-4 space-y-3">
              <div className="text-orange-300 font-semibold text-sm flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${backendOnline ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                {backendOnline ? 'Backend Online — Install Movie Addon' : 'Backend Offline — Deploy first'}
              </div>
              {backendOnline && (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-gray-900 border border-orange-600/40 rounded-lg px-3 py-2.5 font-mono text-orange-300 text-xs break-all">{movieManifestUrl}</div>
                    <button onClick={() => copyToClipboard(movieManifestUrl, 'mov-manifest')}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors flex-shrink-0 ${copiedKey === 'mov-manifest' ? 'bg-emerald-600 text-white' : 'bg-orange-700 hover:bg-orange-600 text-white'}`}>
                      {copiedKey === 'mov-manifest' ? '✓' : '📋'}
                    </button>
                  </div>
                  <a href={movieManifestUrl.replace(/^https?:\/\//, 'stremio://').replace('/movie/manifest.json', '')+'/movie/manifest.json'}
                    className="flex items-center justify-center gap-2 w-full py-2.5 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white rounded-lg text-sm font-bold transition-all">
                    🎬 Install Movie Addon in Stremio
                  </a>
                </>
              )}
              <div className="text-xs text-orange-200/60">
                Filters in Stremio: All Movies · 4K UHD · 1080p HD · ⭐ Top Rated · 📅 By Year · Genre · Search
              </div>
            </div>

            {/* Generated Code Preview */}
            {showCode && generatedCode && (
              <div className="bg-gray-900 border border-white/10 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-white/10">
                  <span className="text-gray-300 text-sm font-mono">movie-server.js</span>
                  <div className="flex gap-2">
                    <button onClick={() => navigator.clipboard.writeText(generatedCode)}
                      className="text-gray-400 hover:text-white text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors">
                      Copy
                    </button>
                    <button onClick={() => setShowCode(false)}
                      className="text-gray-400 hover:text-white text-xs">✕</button>
                  </div>
                </div>
                <pre className="p-4 text-xs text-green-400 font-mono overflow-x-auto max-h-96 overflow-y-auto leading-relaxed">
                  {generatedCode}
                </pre>
              </div>
            )}

            {/* Stream list for export */}
            <div className="bg-gray-900 border border-white/10 rounded-xl p-4">
              <h4 className="text-white font-medium text-sm mb-3">Streams to Export ({streams.filter(s => s.enabled).length})</h4>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {combinedMovies.slice(0, 50).map(movie => (
                  <div key={movie.title + movie.year} className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-white/5">
                    <div className="flex items-center gap-2 min-w-0">
                      {movie.metadata?.poster && (
                        <img src={movie.metadata.poster} alt="" className="w-8 h-10 object-cover rounded flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-white font-medium truncate">{movie.title} {movie.year ? `(${movie.year})` : ''}</p>
                        <div className="flex gap-1 mt-0.5">
                          {[...new Set(movie.streams.map(s => s.quality).filter(Boolean))].map(q => (
                            <span key={q} className="bg-yellow-500/20 text-yellow-400 px-1 rounded">{q}</span>
                          ))}
                          {movie.metadata?.rating && (
                            <span className="text-gray-500">⭐ {movie.metadata.rating.toFixed(1)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className="text-gray-600 flex-shrink-0">{movie.streams.length} stream{movie.streams.length !== 1 ? 's' : ''}</span>
                  </div>
                ))}
                {combinedMovies.length > 50 && (
                  <p className="text-center text-gray-600 py-2">+ {combinedMovies.length - 50} more movies</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Edit Stream Modal */}
      {editingStream && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-white/20 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-white font-semibold">Edit Movie Stream</h3>
            {[
              { field: 'title', label: 'Title' },
              { field: 'url', label: 'Stream URL' },
              { field: 'quality', label: 'Quality (4K/1080p/720p)' },
              { field: 'logo', label: 'Poster/Logo URL' },
              { field: 'group', label: 'Category' },
            ].map(({ field, label }) => (
              <div key={field}>
                <label className="text-gray-400 text-xs mb-1 block">{label}</label>
                <input type="text"
                  value={String((editingStream as any)[field] || '')}
                  onChange={e => setEditingStream(p => p ? { ...p, [field]: e.target.value } : null)}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500" />
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={() => {
                saveStreams(streams.map(s => s.id === editingStream.id ? editingStream : s));
                setEditingStream(null);
                notify('Stream updated', 'success');
              }} className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-black py-2 rounded-lg text-sm font-bold transition-colors">
                Save
              </button>
              <button onClick={() => setEditingStream(null)}
                className="flex-1 bg-white/10 hover:bg-white/20 text-white py-2 rounded-lg text-sm transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MovieAddonTab;