import React, { useState, useCallback, useEffect, useRef } from 'react';
import { MovieStream, MovieSource, MovieAddonSettings } from '../types';
import { fetchM3U } from '../utils/m3uParser';

// ── Storage keys ──────────────────────────────────────────────────────────────
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
  addonId: 'community.jash-movies',
  addonName: 'Jash Movies',
  tmdbApiKey: '',
  autoFetchMetadata: true,
  removeDuplicates: true,
  combineQualities: true,
  defaultLanguage: 'en',
};

// ── Quality patterns ──────────────────────────────────────────────────────────
const QUALITY_PATTERNS = [
  { pattern: /\b(4k|uhd|2160p)\b/i, label: '4K' },
  { pattern: /\b(1080p|fhd|fullhd|1080)\b/i, label: '1080p' },
  { pattern: /\b(720p|hd|720)\b/i, label: '720p' },
  { pattern: /\b(480p|sd|480)\b/i, label: '480p' },
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
  // (YYYY) or [YYYY]
  const m = title.match(/^(.+?)\s*[\(\[]\s*(\d{4})\s*[\)\]]/);
  if (m) return { title: m[1].trim(), year: parseInt(m[2]) };
  // trailing YYYY
  const m2 = title.match(/^(.+?)\s+(\d{4})$/);
  if (m2 && parseInt(m2[2]) >= 1900 && parseInt(m2[2]) <= new Date().getFullYear() + 2) {
    return { title: m2[1].trim(), year: parseInt(m2[2]) };
  }
  return { title };
}

function normalizeTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/\b(4k|uhd|fhd|hd|sd|1080p|720p|480p|2160p|bluray|blu-ray|webrip|web-dl|dvdrip|hdcam|cam|ts|scr|extended|directors|cut|remastered)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXED: extractName — handles commas inside quoted attribute values
// Precisely matches the algorithm in m3uParser.ts
// ─────────────────────────────────────────────────────────────────────────────
function extractMovieName(extinf: string): string {
  // Strip #EXTINF:-1 or #EXTINF:0 prefix
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');

  // Walk char-by-char tracking quote state
  let inQuote = false;
  let quoteChar = '';
  let lastUnquotedComma = -1;

  for (let i = 0; i < withoutPrefix.length; i++) {
    const ch = withoutPrefix[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      else if (ch === ',') { lastUnquotedComma = i; }
    }
  }

  if (lastUnquotedComma !== -1) {
    return withoutPrefix.substring(lastUnquotedComma + 1).trim();
  }

  // Fallback
  const fb = extinf.lastIndexOf(',');
  if (fb !== -1) return extinf.substring(fb + 1).trim();
  return 'Unknown';
}

function extractAttr(line: string, attr: string): string | undefined {
  const m = line.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
  return m ? m[1].trim() || undefined : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse M3U or JSON content into MovieStream[]
// ─────────────────────────────────────────────────────────────────────────────
function parseMovieContent(
  content: string,
  sourceId: string,
): Omit<MovieStream, 'tmdbId' | 'imdbId' | 'poster' | 'backdrop' | 'overview' | 'rating' | 'genres' | 'releaseDate' | 'runtime'>[] {

  type PartialMovie = ReturnType<typeof parseMovieContent>[number];
  const streams: PartialMovie[] = [];

  // ── Try JSON first ──────────────────────────────────────────────────────
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed.data || parsed.movies || parsed.streams || parsed.items || parsed.channels || [parsed]);

      (arr as Record<string, unknown>[]).forEach((item, i) => {
        const url = String(
          item.link || item.url || item.stream || item.src || item.streamUrl || item.playbackUrl || ''
        );
        if (!url || !url.startsWith('http')) return;

        const rawName = String(item.name || item.title || item.movie || item.channel || `Movie ${i + 1}`);
        const { title, year } = extractYear(rawName);

        streams.push({
          id: `mov_${sourceId}_${i}_${Date.now()}`,
          title,
          year,
          url,
          quality: detectQuality(rawName, url),
          logo: String(item.logo || item.icon || item.image || item.poster || ''),
          group: String(item.group || item['group-title'] || item.category || 'Movies'),
          sourceId,
          enabled: true,
          source: String(item.source || ''),
          licenseType: String(item.drmScheme || item.licenseType || ''),
          licenseKey: String(item.drmLicense || item.licenseKey || ''),
          userAgent: String(item.userAgent || item['user-agent'] || ''),
          cookie: String(item.cookie || ''),
        });
      });
      return streams;
    } catch { /* fall through to M3U parser */ }
  }

  // ── Parse M3U ───────────────────────────────────────────────────────────
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  let pendingExtinf: string | null = null;
  let pendingLicenseType = '';
  let pendingLicenseKey  = '';
  let pendingUserAgent   = '';
  let pendingCookie      = '';
  let pendingLogo        = '';
  let pendingGroup       = '';

  const reset = () => {
    pendingExtinf       = null;
    pendingLicenseType  = '';
    pendingLicenseKey   = '';
    pendingUserAgent    = '';
    pendingCookie       = '';
    pendingLogo         = '';
    pendingGroup        = '';
  };

  for (const line of lines) {
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      reset();
      pendingExtinf = line;
      pendingLogo   = extractAttr(line, 'tvg-logo') || '';
      pendingGroup  = extractAttr(line, 'group-title') || 'Movies';
      continue;
    }

    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
      pendingLicenseType = line.split('=').slice(1).join('=').trim();
      continue;
    }
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      pendingLicenseKey = line.split('=').slice(1).join('=').trim();
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
      pendingUserAgent = line.replace('#EXTVLCOPT:http-user-agent=', '').trim();
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.replace('#EXTHTTP:', '').trim());
        if (h.cookie || h.Cookie) pendingCookie = h.cookie || h.Cookie;
      } catch { /* ignore */ }
      continue;
    }

    if (!line.startsWith('#') && line.startsWith('http')) {
      const url = line;
      let rawTitle = '';

      if (pendingExtinf) {
        // ✅ Use the FIXED extractMovieName — handles commas in logo URLs
        rawTitle = extractMovieName(pendingExtinf);
      } else {
        rawTitle = url.split('/').pop()?.replace(/\.(m3u8?|mpd|ts|mp4).*$/i, '') || 'Unknown';
      }

      // Strip quality keywords from title for clean name
      const cleanRawTitle = rawTitle
        .replace(/\s*[\(\[](4K|UHD|1080p|720p|480p|FHD|HD|SD|BluRay|WEBRip)[\)\]]/gi, '')
        .trim();

      const { title, year } = extractYear(cleanRawTitle);

      streams.push({
        id: `mov_${sourceId}_${streams.length}_${Date.now()}`,
        title: title || 'Unknown',
        year,
        url,
        quality: detectQuality(rawTitle, url),
        logo: pendingLogo,
        group: pendingGroup || 'Movies',
        sourceId,
        enabled: true,
        source: '',
        licenseType: pendingLicenseType,
        licenseKey: pendingLicenseKey,
        userAgent: pendingUserAgent,
        cookie: pendingCookie,
      });
      reset();
    }
  }

  return streams;
}

// ── Remove duplicates — keep highest quality ─────────────────────────────────
function removeDuplicates(streams: MovieStream[]): MovieStream[] {
  const seen = new Map<string, MovieStream>();
  const Q: Record<string, number> = { '4K': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1, '': 0 };
  for (const s of streams) {
    const key = normalizeTitle(s.title) + '_' + (s.year || '');
    const ex  = seen.get(key);
    if (!ex || (Q[s.quality || ''] || 0) > (Q[ex.quality || ''] || 0)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

// ── Combine by quality ───────────────────────────────────────────────────────
interface MovieGroup {
  title: string;
  year?: number;
  streams: MovieStream[];
  metadata?: Partial<MovieStream>;
}

function combineByQuality(streams: MovieStream[]): MovieGroup[] {
  const map = new Map<string, MovieGroup>();
  for (const s of streams) {
    const key = normalizeTitle(s.title) + '_' + (s.year || '');
    if (!map.has(key)) map.set(key, { title: s.title, year: s.year, streams: [], metadata: s });
    map.get(key)!.streams.push(s);
    // Prefer stream with metadata
    const g = map.get(key)!;
    if (!g.metadata?.tmdbId && s.tmdbId) g.metadata = s;
    // prefer shorter/cleaner title
    if ((s.title || '').length < (g.title || '').length && !s.title.match(/\b(hd|4k|1080p|720p)\b/i)) {
      g.title = s.title;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

// ── TMDB fetch (browser — uses user's API key) ────────────────────────────────
async function fetchTMDB(title: string, year: number | undefined, apiKey: string): Promise<Partial<MovieStream>> {
  if (!apiKey || !apiKey.trim()) return {};
  try {
    const yearParam = year ? `&year=${year}` : '';
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey.trim()}&query=${encodeURIComponent(title)}${yearParam}&language=en-US&page=1&include_adult=false`;
    const res  = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      if (res.status === 401) throw new Error('Invalid TMDB API key (401)');
      return {};
    }
    const data  = await res.json();
    const movie = data.results?.[0];
    if (!movie) return {};

    // Fetch full details for genres, runtime, imdb_id
    let genres: string[]  = [];
    let runtime: number | undefined;
    let imdbId: string | undefined;
    try {
      const det  = await fetch(`https://api.themoviedb.org/3/movie/${movie.id}?api_key=${apiKey.trim()}&append_to_response=external_ids`, { signal: AbortSignal.timeout(8000) });
      if (det.ok) {
        const d = await det.json();
        genres  = (d.genres || []).map((g: { name: string }) => g.name);
        runtime = d.runtime || undefined;
        imdbId  = d.external_ids?.imdb_id || d.imdb_id || undefined;
      }
    } catch { /* detail fetch failed — use search result */ }

    return {
      tmdbId  : movie.id,
      imdbId,
      poster  : movie.poster_path   ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`   : undefined,
      backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : undefined,
      overview: movie.overview      || undefined,
      rating  : movie.vote_average  || undefined,
      genres  : genres.length ? genres : [],
      releaseDate: movie.release_date || undefined,
      runtime,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('401') || msg.includes('Invalid TMDB')) throw new Error(msg);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
const MovieAddonTab: React.FC = () => {
  const [sources,    setSources]   = useState<MovieSource[]>(() => loadLS(MOVIE_SOURCES_KEY, []));
  const [streams,    setStreams]   = useState<MovieStream[]>(() => loadLS(MOVIE_STREAMS_KEY, []));
  const [settings,   setSettings]  = useState<MovieAddonSettings>(() => loadLS(MOVIE_SETTINGS_KEY, defaultSettings));
  const [activeSection, setActiveSection] = useState<'sources' | 'movies' | 'settings' | 'export'>('sources');
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' | 'warn' } | null>(null);
  const [loading,    setLoading]   = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterQuality, setFilterQuality] = useState('');
  const [filterGenre,   setFilterGenre]   = useState('');
  const [filterYear,    setFilterYear]    = useState('');
  const [filterRating,  setFilterRating]  = useState('');
  const [fetchingMeta,  setFetchingMeta]  = useState<string[]>([]);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceUrl,  setNewSourceUrl]  = useState('');
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceType, setNewSourceType] = useState<'url' | 'json'>('url');
  const [editingStream, setEditingStream] = useState<MovieStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [syncing,  setSyncing]  = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [lastSyncMsg,  setLastSyncMsg]  = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedKey,    setCopiedKey]    = useState<string | null>(null);
  const [tmdbError,    setTmdbError]    = useState<string | null>(null);

  const backendBase = (() => {
    try {
      const { hostname, protocol, port } = window.location;
      if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${hostname}:7000`;
      return `${protocol}//${hostname}${port ? ':' + port : ''}`;
    } catch { return ''; }
  })();
  const movieManifestUrl = `${backendBase}/movie/manifest.json`;

  const notify = useCallback((msg: string, type: 'success' | 'error' | 'info' | 'warn' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // Backend health check
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${backendBase}/health`, { signal: AbortSignal.timeout(5000) });
        setBackendOnline(r.ok);
      } catch { setBackendOnline(false); }
    };
    check();
    const iv = setInterval(check, 30000);
    return () => clearInterval(iv);
  }, [backendBase]);

  // Auto-refresh sources
  useEffect(() => {
    const iv = setInterval(async () => {
      const now = Date.now();
      const due = sources.filter(s =>
        s.enabled && s.autoRefreshInterval && s.autoRefreshInterval > 0 &&
        s.url && s.nextAutoRefresh && now >= s.nextAutoRefresh
      );
      for (const src of due) {
        try {
          const content = await fetchM3U(src.url!, '');
          const parsed = parseMovieContent(content, src.id).map((s, i) => ({
            ...s,
            id: `mov_${src.id}_${i}_${Date.now()}`,
            tmdbId: undefined, imdbId: undefined, poster: undefined,
            backdrop: undefined, overview: undefined, rating: undefined,
            genres: undefined, releaseDate: undefined, runtime: undefined,
          })) as MovieStream[];
          const other = streams.filter(s => s.sourceId !== src.id);
          const updated: MovieSource = { ...src, streamCount: parsed.length, status: 'active', lastUpdated: now, nextAutoRefresh: now + (src.autoRefreshInterval ?? 0) * 60 * 1000 };
          const ns = [...other, ...parsed];
          saveLS(MOVIE_STREAMS_KEY, ns); setStreams(ns);
          const us = sources.map(s => s.id === src.id ? updated : s);
          saveLS(MOVIE_SOURCES_KEY, us); setSources(us);
          notify(`🔄 Auto-refreshed: ${src.name}`, 'info');
        } catch (_) { /* silent */ }
      }
    }, 60_000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, streams]);

  const saveStreams = useCallback((s: MovieStream[]) => { saveLS(MOVIE_STREAMS_KEY, s); setStreams(s); }, []);
  const saveSources = useCallback((s: MovieSource[]) => { saveLS(MOVIE_SOURCES_KEY, s); setSources(s); }, []);

  // ── Sync to backend ────────────────────────────────────────────────────────
  const handleMovieSync = useCallback(async () => {
    setSyncing(true);
    try {
      const { syncMoviesToBackend } = await import('../utils/backendSync');
      const result = await syncMoviesToBackend({
        streams: streams.filter(s => s.enabled),
        settings: settings as unknown as Record<string, unknown>,
      });
      setLastSyncMsg({ ok: result.ok, msg: result.message });
      notify(result.message, result.ok ? 'success' : 'error');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastSyncMsg({ ok: false, msg });
      notify(`Sync failed: ${msg}`, 'error');
    } finally { setSyncing(false); }
  }, [streams, settings, notify]);

  const copyText = useCallback(async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const el = document.createElement('textarea'); el.value = text;
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
    }
    setCopiedKey(key); setTimeout(() => setCopiedKey(null), 2500);
    notify('Copied!', 'success');
  }, [notify]);

  // ── Load source content ────────────────────────────────────────────────────
  const processContent = useCallback((content: string, srcId: string, srcName: string, existingStreams: MovieStream[]): MovieStream[] => {
    const parsed = parseMovieContent(content, srcId).map((s, i) => ({
      ...s,
      id: `mov_${srcId}_${i}_${Date.now()}`,
      tmdbId: undefined as undefined,
      imdbId: undefined as undefined,
      poster: undefined as undefined,
      backdrop: undefined as undefined,
      overview: undefined as undefined,
      rating: undefined as undefined,
      genres: undefined as undefined,
      releaseDate: undefined as undefined,
      runtime: undefined as undefined,
    })) as MovieStream[];

    let finalStreams = [...existingStreams.filter(s => s.sourceId !== srcId), ...parsed];
    if (settings.removeDuplicates) finalStreams = removeDuplicates(finalStreams);
    notify(`✅ Loaded ${parsed.length} movies from "${srcName}"`, 'success');
    return finalStreams;
  }, [settings.removeDuplicates, notify]);

  // ── Add URL source ─────────────────────────────────────────────────────────
  const addSource = useCallback(async () => {
    if (!newSourceUrl.trim()) return;
    const srcId = `movsrc_${Date.now()}`;
    const name  = newSourceName.trim() || newSourceUrl.split('/').pop() || 'Movie Source';
    const src: MovieSource = {
      id: srcId, name, type: newSourceType, url: newSourceUrl.trim(),
      enabled: true, streamCount: 0, status: 'loading', lastUpdated: Date.now(),
    };
    const updSrc = [...sources, src];
    saveSources(updSrc);
    setLoading(true);
    try {
      const content = await fetchM3U(newSourceUrl.trim(), '');
      const finalStreams = processContent(content, srcId, name, streams);
      saveStreams(finalStreams);
      const parsedCount = finalStreams.filter(s => s.sourceId === srcId).length;
      saveSources(updSrc.map(s => s.id === srcId ? { ...s, status: 'active' as const, streamCount: parsedCount } : s));
      setShowAddSource(false); setNewSourceUrl(''); setNewSourceName('');

      // Auto-fetch TMDB
      if (settings.autoFetchMetadata && settings.tmdbApiKey) {
        await fetchAllMetadata(finalStreams, settings.tmdbApiKey);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      saveSources(updSrc.map(s => s.id === srcId ? { ...s, status: 'error' as const, error: msg } : s));
      notify(`Error: ${msg}`, 'error');
    } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSourceUrl, newSourceName, newSourceType, sources, streams, settings]);

  // ── File upload ────────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      const srcId   = `movsrc_file_${Date.now()}`;
      const name    = file.name.replace(/\.(m3u8?|json)$/i, '');
      const src: MovieSource = { id: srcId, name, type: 'file', content, enabled: true, streamCount: 0, status: 'loading', lastUpdated: Date.now() };
      const updSrc = [...sources, src];
      saveSources(updSrc);
      setLoading(true);
      try {
        const finalStreams = processContent(content, srcId, name, streams);
        saveStreams(finalStreams);
        const cnt = finalStreams.filter(s => s.sourceId === srcId).length;
        saveSources(updSrc.map(s => s.id === srcId ? { ...s, status: 'active' as const, streamCount: cnt } : s));
      } catch (ex) {
        const msg = ex instanceof Error ? ex.message : String(ex);
        notify(`Upload error: ${msg}`, 'error');
        saveSources(updSrc.map(s => s.id === srcId ? { ...s, status: 'error' as const, error: msg } : s));
      } finally { setLoading(false); }
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const deleteSource = (srcId: string) => {
    saveSources(sources.filter(s => s.id !== srcId));
    saveStreams(streams.filter(s => s.sourceId !== srcId));
    notify('Source deleted', 'success');
  };

  const refreshSource = async (src: MovieSource) => {
    if (!src.url) return;
    saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'loading' as const } : s));
    try {
      const content = await fetchM3U(src.url, '');
      const finalStreams = processContent(content, src.id, src.name, streams);
      saveStreams(finalStreams);
      const cnt = finalStreams.filter(s => s.sourceId === src.id).length;
      saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'active' as const, streamCount: cnt, lastUpdated: Date.now() } : s));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      saveSources(sources.map(s => s.id === src.id ? { ...s, status: 'error' as const, error: msg } : s));
      notify(`Refresh failed: ${msg}`, 'error');
    }
  };

  // ── TMDB metadata batch fetch ──────────────────────────────────────────────
  const fetchAllMetadata = useCallback(async (streamList: MovieStream[], apiKey: string) => {
    const key = apiKey?.trim();
    if (!key) { notify('Enter your TMDB API key in Settings first', 'warn'); return; }
    setTmdbError(null);

    const groups  = combineByQuality(streamList);
    const toFetch = groups.filter(g => !g.metadata?.tmdbId);
    if (!toFetch.length) { notify('All metadata already fetched', 'info'); return; }
    notify(`Fetching TMDB metadata for ${toFetch.length} movies…`, 'info');

    const BATCH = 5;
    const updated = [...streamList];

    for (let i = 0; i < toFetch.length; i += BATCH) {
      const batch = toFetch.slice(i, i + BATCH);
      setFetchingMeta(batch.map(g => g.title));
      await Promise.all(batch.map(async (group) => {
        try {
          const meta = await fetchTMDB(group.title, group.year, key);
          if (!meta.tmdbId) return;
          group.streams.forEach(gs => {
            const idx = updated.findIndex(s => s.id === gs.id);
            if (idx >= 0) Object.assign(updated[idx], meta);
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('401') || msg.includes('Invalid TMDB')) {
            setTmdbError(`❌ TMDB Error: ${msg}. Check your API key in Settings.`);
          }
        }
      }));
      saveStreams([...updated]);
      await new Promise(r => setTimeout(r, 350)); // rate limit: ~3 req/s
    }
    setFetchingMeta([]);
    notify('✅ TMDB metadata fetch complete', 'success');
  }, [notify, saveStreams]);

  // ── Filtered movies ────────────────────────────────────────────────────────
  const combinedMovies = combineByQuality(streams.filter(s => s.enabled));
  const filteredMovies = combinedMovies.filter(m => {
    if (searchQuery  && !m.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterQuality && !m.streams.some(s => s.quality === filterQuality))          return false;
    if (filterYear   && String(m.year) !== filterYear)                               return false;
    if (filterGenre  && !m.metadata?.genres?.some(g => g.toLowerCase().includes(filterGenre.toLowerCase()))) return false;
    if (filterRating && m.metadata?.rating && m.metadata.rating < parseFloat(filterRating)) return false;
    return true;
  });

  const qualities = [...new Set(streams.map(s => s.quality).filter(Boolean))].sort();
  const years     = [...new Set(streams.map(s => s.year).filter(Boolean))].sort((a, b) => (b as number) - (a as number));
  const genres    = [...new Set(streams.flatMap(s => s.genres || []).filter(Boolean))].sort().slice(0, 30);

  const exportM3U = () => {
    const lines = ['#EXTM3U'];
    streams.filter(s => s.enabled).forEach(s => {
      const title = `${s.title}${s.quality ? ` [${s.quality}]` : ''}${s.year ? ` (${s.year})` : ''}`;
      lines.push(`#EXTINF:-1 tvg-logo="${s.logo || ''}" group-title="${s.group || 'Movies'}",${title}`);
      if (s.licenseType && s.licenseKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=${s.licenseType}`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${s.licenseKey}`);
      }
      if (s.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
      if (s.cookie)    lines.push(`#EXTHTTP:{"cookie":"${s.cookie}"}`);
      lines.push(s.url);
    });
    const blob = new Blob([lines.join('\n')], { type: 'application/x-mpegurl' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${settings.addonName.replace(/\s+/g, '-')}.m3u`; a.click();
    notify('Downloaded M3U', 'success');
  };

  const notifColor = {
    success: 'bg-green-600', error: 'bg-red-600', info: 'bg-blue-600', warn: 'bg-amber-600',
  };

  return (
    <div className="h-full flex flex-col bg-gray-950">
      {/* Notification */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-white text-sm shadow-2xl flex items-center gap-2 ${notifColor[notification.type]}`}>
          {notification.type === 'success' ? '✅' : notification.type === 'error' ? '❌' : notification.type === 'warn' ? '⚠️' : 'ℹ️'}
          {notification.msg}
        </div>
      )}

      {/* Header */}
      <div className="bg-gray-900 border-b border-white/10 px-6 py-4 flex-shrink-0">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              🎬 <span>Movie Addon</span>
              <span className="bg-yellow-500 text-black text-xs px-2 py-0.5 rounded-full font-bold">TMDB</span>
              <span className={`w-2 h-2 rounded-full ${backendOnline ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
            </h2>
            <p className="text-gray-400 text-xs mt-0.5">
              {streams.filter(s => s.enabled).length} streams · {combinedMovies.length} unique movies
              {streams.filter(s => s.tmdbId).length > 0 && ` · ${streams.filter(s => s.tmdbId).length} with TMDB data`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={exportM3U} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-2 rounded-lg transition-colors">
              ⬇️ M3U
            </button>
            <button onClick={handleMovieSync} disabled={syncing || !backendOnline || !streams.filter(s => s.enabled).length}
              className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg transition-colors ${syncing ? 'bg-violet-800 text-violet-300 animate-pulse' : backendOnline ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'}`}>
              <span className={syncing ? 'animate-spin inline-block' : ''}>🔄</span>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-1 mt-4 overflow-x-auto">
          {(['sources', 'movies', 'settings', 'export'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveSection(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors flex-shrink-0 ${
                activeSection === tab ? 'bg-yellow-500 text-black' : 'bg-white/10 text-gray-300 hover:bg-white/20'
              }`}>
              {tab === 'sources' ? `📂 Sources (${sources.length})` :
               tab === 'movies'  ? `🎬 Movies (${filteredMovies.length})` :
               tab === 'settings'? '⚙️ Settings' : '🚀 Export'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── SOURCES ──────────────────────────────────────────────────────── */}
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
                    {loading ? 'Loading…' : 'Add Source'}
                  </button>
                  <button onClick={() => { setShowAddSource(false); setNewSourceUrl(''); setNewSourceName(''); }}
                    className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {sources.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <div className="text-4xl mb-3">🎬</div>
                <p>No movie sources yet.</p>
                <p className="text-xs mt-1">Add M3U or JSON URL, or upload a file.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sources.map(src => (
                  <div key={src.id} className="bg-gray-900 border border-white/10 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          src.status === 'active' ? 'bg-green-500' :
                          src.status === 'error'  ? 'bg-red-500' :
                          src.status === 'loading'? 'bg-yellow-500 animate-pulse' : 'bg-gray-500'
                        }`} />
                        <div className="min-w-0">
                          <p className="text-white text-sm font-medium truncate">{src.name}</p>
                          <p className="text-gray-500 text-xs truncate">{src.url || 'Uploaded file'}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                              {src.streamCount} movies
                            </span>
                            <span className="text-xs bg-white/10 text-gray-400 px-2 py-0.5 rounded uppercase">{src.type}</span>
                            {src.error && <span className="text-xs text-red-400 truncate max-w-48">{src.error}</span>}
                            {src.nextAutoRefresh && src.autoRefreshInterval && (
                              <span className="text-xs text-blue-400">
                                🔄 next in {Math.max(0, Math.round((src.nextAutoRefresh - Date.now()) / 60000))}m
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {src.url && (
                          <button onClick={() => refreshSource(src)}
                            className="bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 px-2 py-1 rounded text-xs transition-colors">
                            🔄
                          </button>
                        )}
                        <button onClick={() => deleteSource(src.id)}
                          className="bg-red-500/20 hover:bg-red-500/40 text-red-400 px-2 py-1 rounded text-xs transition-colors">
                          🗑️
                        </button>
                      </div>
                    </div>

                    {src.url && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-gray-500 text-xs">Auto-refresh:</span>
                        <select value={src.autoRefreshInterval || 0}
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            const upd = { ...src, autoRefreshInterval: val, nextAutoRefresh: val > 0 ? Date.now() + val * 60 * 1000 : undefined };
                            saveSources(sources.map(s => s.id === src.id ? upd : s));
                          }}
                          className="bg-white/5 text-gray-300 text-xs rounded px-2 py-1 border border-white/10 focus:outline-none focus:border-yellow-500">
                          <option value={0}>Off</option>
                          <option value={30}>30 min</option>
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

        {/* ── MOVIES ───────────────────────────────────────────────────────── */}
        {activeSection === 'movies' && (
          <div className="p-6 space-y-4">
            {/* TMDB error banner */}
            {tmdbError && (
              <div className="bg-red-900/30 border border-red-700/40 rounded-xl p-3 flex items-start gap-2">
                <span className="text-red-400 text-sm">{tmdbError}</span>
                <button onClick={() => setTmdbError(null)} className="text-gray-500 hover:text-white ml-auto text-xs">✕</button>
              </div>
            )}

            {/* Filters */}
            <div className="bg-gray-900 border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-semibold text-sm">🔍 Filters — {filteredMovies.length} movies</h3>
                <button onClick={() => { setSearchQuery(''); setFilterQuality(''); setFilterYear(''); setFilterRating(''); setFilterGenre(''); }}
                  className="text-gray-500 hover:text-white text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors">
                  Clear All
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                <input type="text" placeholder="🔍 Search title…"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  className="col-span-2 sm:col-span-1 bg-white/5 text-white text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500 placeholder-gray-500" />
                <select value={filterQuality} onChange={e => setFilterQuality(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Quality</option>
                  {qualities.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
                <select value={filterGenre} onChange={e => setFilterGenre(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Genres</option>
                  {genres.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <select value={filterYear} onChange={e => setFilterYear(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Years</option>
                  {years.slice(0, 30).map(y => <option key={y} value={String(y)}>{y}</option>)}
                </select>
                <select value={filterRating} onChange={e => setFilterRating(e.target.value)}
                  className="bg-white/5 text-gray-300 text-xs rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500">
                  <option value="">All Ratings</option>
                  <option value="8">8+ ⭐⭐⭐</option>
                  <option value="7">7+ ⭐⭐</option>
                  <option value="6">6+ ⭐</option>
                  <option value="5">5+</option>
                </select>
              </div>

              {/* TMDB fetch button */}
              {settings.tmdbApiKey && (
                <div className="flex items-center gap-2">
                  <button onClick={() => fetchAllMetadata(streams, settings.tmdbApiKey)}
                    disabled={fetchingMeta.length > 0}
                    className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1">
                    {fetchingMeta.length > 0 ? <>⏳ Fetching: {fetchingMeta[0]}…</> : <>🎭 Fetch TMDB Metadata</>}
                  </button>
                  {fetchingMeta.length > 0 && (
                    <div className="bg-gray-800 rounded-full h-1.5 flex-1 overflow-hidden">
                      <div className="bg-blue-500 h-full animate-pulse w-1/3" />
                    </div>
                  )}
                </div>
              )}
              {!settings.tmdbApiKey && (
                <p className="text-amber-400/70 text-xs">⚠️ Add TMDB API key in Settings to fetch movie posters, ratings & genres</p>
              )}
            </div>

            {/* Movie Grid */}
            {filteredMovies.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <div className="text-5xl mb-3">🎬</div>
                <p className="text-sm">No movies found</p>
                <p className="text-xs mt-1">Add movie sources or adjust filters</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                {filteredMovies.slice(0, 300).map(movie => {
                  const meta   = movie.metadata;
                  const poster = meta?.poster || meta?.logo || '';
                  return (
                    <div key={movie.title + (movie.year || '')}
                      className="bg-gray-900 border border-white/10 rounded-xl overflow-hidden hover:border-yellow-500/50 transition-all group cursor-pointer">
                      <div className="relative aspect-[2/3] bg-gray-800">
                        {poster ? (
                          <img src={poster} alt={movie.title} className="w-full h-full object-cover"
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-4xl text-gray-700">🎬</div>
                        )}
                        {/* Quality badges */}
                        <div className="absolute top-1 left-1 flex flex-col gap-0.5">
                          {[...new Set(movie.streams.map(s => s.quality).filter(Boolean))].slice(0, 3).map(q => (
                            <span key={q} className={`text-xs px-1 py-0.5 rounded font-bold ${
                              q === '4K' ? 'bg-yellow-500 text-black' :
                              q === '1080p' ? 'bg-blue-600 text-white' :
                              q === '720p' ? 'bg-green-600 text-white' : 'bg-gray-700 text-white'
                            }`}>{q}</span>
                          ))}
                        </div>
                        {/* Rating */}
                        {meta?.rating && (
                          <div className="absolute top-1 right-1 bg-black/80 text-yellow-400 text-xs px-1 py-0.5 rounded font-bold">
                            ⭐{meta.rating.toFixed(1)}
                          </div>
                        )}
                        {/* Stream count */}
                        {movie.streams.length > 1 && (
                          <div className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1 rounded">
                            {movie.streams.length}🎬
                          </div>
                        )}
                        {/* DRM badge */}
                        {movie.streams.some(s => s.licenseType) && (
                          <div className="absolute bottom-1 left-1 bg-red-900/90 text-red-300 text-xs px-1 rounded font-bold">🔐DRM</div>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-2">
                          <button onClick={() => setEditingStream(movie.streams[0])}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white text-xs py-1.5 rounded transition-colors">
                            ✏️ Edit
                          </button>
                          <button onClick={() => movie.streams.forEach(s => saveStreams(streams.filter(x => x.id !== s.id)))}
                            className="w-full bg-red-600 hover:bg-red-700 text-white text-xs py-1.5 rounded transition-colors">
                            🗑️ Remove
                          </button>
                        </div>
                      </div>
                      <div className="p-2">
                        <p className="text-white text-xs font-medium line-clamp-2 leading-tight" title={movie.title}>{movie.title}</p>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-gray-500 text-xs">{movie.year || '—'}</span>
                          {meta?.genres?.[0] && (
                            <span className="text-gray-600 text-xs truncate max-w-20">{meta.genres[0]}</span>
                          )}
                        </div>
                        {!meta?.tmdbId && !meta?.poster && (
                          <div className="mt-1 text-xs text-gray-600 italic">No TMDB data</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {filteredMovies.length > 300 && (
              <p className="text-center text-gray-500 text-sm py-4">Showing 300 of {filteredMovies.length} movies</p>
            )}
          </div>
        )}

        {/* ── SETTINGS ──────────────────────────────────────────────────────── */}
        {activeSection === 'settings' && (
          <div className="p-6 space-y-4 max-w-2xl">
            <h3 className="text-white font-semibold">Movie Addon Settings</h3>

            <div className="bg-gray-900 border border-white/10 rounded-xl p-4 space-y-4">
              <div>
                <label className="text-gray-300 text-sm font-medium block mb-1">Addon Name</label>
                <input type="text" value={settings.addonName}
                  onChange={e => setSettings(p => ({ ...p, addonName: e.target.value }))}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500" />
              </div>

              {/* TMDB API Key — most critical section */}
              <div className="border-t border-white/10 pt-4">
                <label className="text-gray-300 text-sm font-bold block mb-2 flex items-center gap-2">
                  🎭 TMDB API Key
                  <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer"
                    className="text-yellow-400 text-xs hover:underline font-normal">Get free key →</a>
                </label>

                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mb-3">
                  <p className="text-blue-300 text-xs font-semibold mb-1">✅ Backend env var (recommended)</p>
                  <div className="bg-black/30 rounded p-2 font-mono text-xs text-green-400 mb-1">TMDB_API_KEY=your_api_key_here</div>
                  <p className="text-gray-400 text-xs">Set this in Render / Koyeb / Railway environment variables. The backend auto-enriches movies on sync.</p>
                </div>

                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-3">
                  <p className="text-amber-300 text-xs font-semibold mb-1">⚡ Browser key (for local fetch)</p>
                  <p className="text-gray-400 text-xs mb-2">Enter key here to fetch TMDB metadata directly in the browser (click "Fetch TMDB Metadata" in Movies tab).</p>
                  <input type="password" placeholder="tmdb_api_key…"
                    value={settings.tmdbApiKey}
                    onChange={e => setSettings(p => ({ ...p, tmdbApiKey: e.target.value }))}
                    className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-amber-500 placeholder-gray-600 font-mono" />
                  {settings.tmdbApiKey && (
                    <p className="text-green-400 text-xs mt-1">✅ Key saved — use "Fetch TMDB Metadata" button in Movies tab</p>
                  )}
                </div>
              </div>

              {[
                { key: 'autoFetchMetadata',  label: 'Auto-fetch TMDB on source add', desc: 'Automatically fetch movie details when adding new sources' },
                { key: 'removeDuplicates',   label: 'Remove duplicate movies',        desc: 'Keep highest quality when same movie exists multiple times' },
                { key: 'combineQualities',   label: 'Combine quality streams',        desc: 'Show 720p/1080p as one catalog entry with quality picker in Stremio' },
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

            <button onClick={() => { saveLS(MOVIE_SETTINGS_KEY, settings); notify('Settings saved ✅', 'success'); }}
              className="bg-yellow-500 hover:bg-yellow-600 text-black px-6 py-2.5 rounded-lg text-sm font-bold transition-colors">
              Save Settings
            </button>
          </div>
        )}

        {/* ── EXPORT ──────────────────────────────────────────────────────── */}
        {activeSection === 'export' && (
          <div className="p-6 space-y-4 max-w-3xl">
            <h3 className="text-white font-semibold">Export & Install Movie Addon</h3>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total Streams', value: streams.length, color: 'text-yellow-400' },
                { label: 'Unique Movies', value: combinedMovies.length, color: 'text-blue-400' },
                { label: 'With TMDB', value: streams.filter(s => s.tmdbId).length, color: 'text-green-400' },
                { label: 'With DRM', value: streams.filter(s => s.licenseType).length, color: 'text-red-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-gray-900 border border-white/10 rounded-xl p-3 text-center">
                  <div className={`text-2xl font-bold ${color}`}>{value.toLocaleString()}</div>
                  <div className="text-gray-400 text-xs mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
              <button onClick={handleMovieSync} disabled={syncing || !backendOnline || !streams.filter(s => s.enabled).length}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-colors ${
                  syncing ? 'bg-violet-800 text-violet-300 cursor-wait animate-pulse' :
                  backendOnline ? 'bg-violet-600 hover:bg-violet-700 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }`}>
                <span className={syncing ? 'animate-spin inline-block' : ''}>🔄</span>
                {syncing ? 'Syncing…' : `Sync ${streams.filter(s => s.enabled).length} Movies to Backend`}
              </button>
              <button onClick={exportM3U}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition-colors">
                ⬇️ Download M3U
              </button>
            </div>

            {/* Backend sync result */}
            {lastSyncMsg && (
              <div className={`px-4 py-3 rounded-lg text-sm ${lastSyncMsg.ok ? 'bg-emerald-900/30 border border-emerald-700/40 text-emerald-300' : 'bg-red-900/30 border border-red-700/40 text-red-300'}`}>
                {lastSyncMsg.msg}
              </div>
            )}

            {/* Install in Stremio */}
            <div className="bg-orange-900/20 border border-orange-700/30 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${backendOnline ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                <span className="text-orange-300 font-semibold text-sm">
                  {backendOnline ? '✅ Backend Online — Movie Addon Ready' : '⚠️ Backend Offline — Deploy first'}
                </span>
              </div>

              {backendOnline ? (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-gray-900 border border-orange-600/40 rounded-lg px-3 py-2.5 font-mono text-orange-300 text-xs break-all">
                      {movieManifestUrl}
                    </div>
                    <button onClick={() => copyText(movieManifestUrl, 'mov-manifest')}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold flex-shrink-0 transition-colors ${copiedKey === 'mov-manifest' ? 'bg-green-600 text-white' : 'bg-orange-700 hover:bg-orange-600 text-white'}`}>
                      {copiedKey === 'mov-manifest' ? '✓' : '📋'}
                    </button>
                  </div>
                  <a href={`stremio://${movieManifestUrl.replace(/^https?:\/\//, '')}`}
                    className="flex items-center justify-center gap-2 w-full py-2.5 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white rounded-lg text-sm font-bold transition-all">
                    🎬 Install Movie Addon in Stremio
                  </a>
                  <a href={`https://web.stremio.com/#/addons?addon=${encodeURIComponent(movieManifestUrl)}`} target="_blank" rel="noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-medium transition-colors">
                    🌐 Install via Stremio Web
                  </a>
                </>
              ) : (
                <div className="bg-gray-900/50 rounded-lg p-3 text-gray-400 text-xs space-y-1">
                  <p><strong className="text-white">Deploy to Render/Koyeb/Railway:</strong></p>
                  <p>Build: <code className="bg-black/30 px-1 rounded">npm install --include=dev &amp;&amp; npm run build</code></p>
                  <p>Start: <code className="bg-black/30 px-1 rounded">node backend/server.js</code></p>
                  <p>Env:   <code className="bg-black/30 px-1 rounded">TMDB_API_KEY=your_key</code></p>
                </div>
              )}
            </div>

            {/* Filters in Stremio */}
            <div className="bg-gray-900 border border-white/10 rounded-xl p-4">
              <h4 className="text-white font-medium text-sm mb-3">🎬 Stremio Catalog Structure</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { name: 'All Movies', desc: 'Search + Genre filter' },
                  { name: '🎬 HD Movies', desc: '720p & 1080p only' },
                  { name: '⭐ Top Rated', desc: 'Rating ≥ 7.0' },
                  { name: '📅 By Year', desc: 'Year filter' },
                ].map(c => (
                  <div key={c.name} className="bg-gray-800 rounded-lg p-3 text-center">
                    <div className="text-white text-xs font-semibold">{c.name}</div>
                    <div className="text-gray-500 text-xs mt-1">{c.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Edit Stream Modal */}
      {editingStream && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-white/20 rounded-2xl p-6 w-full max-w-md space-y-4">
            <h3 className="text-white font-semibold">✏️ Edit Movie Stream</h3>
            {[
              { field: 'title',   label: 'Title' },
              { field: 'url',     label: 'Stream URL' },
              { field: 'quality', label: 'Quality (4K / 1080p / 720p / 480p)' },
              { field: 'logo',    label: 'Poster / Logo URL' },
              { field: 'group',   label: 'Category / Group' },
            ].map(({ field, label }) => (
              <div key={field}>
                <label className="text-gray-400 text-xs mb-1 block">{label}</label>
                <input type="text"
                  value={String((editingStream as unknown as Record<string, unknown>)[field] || '')}
                  onChange={e => setEditingStream(p => p ? { ...p, [field]: e.target.value } : null)}
                  className="w-full bg-white/5 text-white text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-yellow-500" />
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={() => {
                saveStreams(streams.map(s => s.id === editingStream.id ? editingStream : s));
                setEditingStream(null);
                notify('Stream updated ✅', 'success');
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
