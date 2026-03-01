/**
 * ShakaPlayer.tsx — Jash IPTV Player
 *
 * DRM Pipeline:
 *   HLS (.m3u8)           → Shaka Player (native HLS on Safari, MSE elsewhere)
 *   DASH (.mpd) no DRM    → Shaka Player direct
 *   DASH (.mpd) + ClearKey → Backend /play/:id → modified MPD → /license/:id
 *
 * Shaka clearKeys expects HEX strings directly (not base64).
 * Group channels by source name using sourceId stored in channel id prefix.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, Source } from '../types';
import { cn } from '../utils/cn';
import {
  Search, X, ArrowLeft, Tv, Play, Volume2, VolumeX,
  Maximize, Minimize, AlertCircle, Loader2, ChevronLeft,
  ChevronRight, List, Grid3x3, RefreshCw, Info, Radio,
} from 'lucide-react';

declare global { interface Window { shaka: any } }

/* ─── types ─────────────────────────────────────────────────────────────────── */
interface Props { channels: Channel[]; sources: Source[] }
interface GroupedSource { sourceName: string; sourceId: string; channels: Channel[] }

/* ─── helpers ────────────────────────────────────────────────────────────────── */

/**
 * Channel IDs are formatted as:  `${sourceId}_${uuid}`
 * sourceId is itself a UUID → contains hyphens.
 * We store it in Source.id so we match by checking which source's id
 * is a prefix of the channel id.
 */
function getSourceId(channelId: string, sources: Source[]): string {
  for (const s of sources) {
    if (channelId.startsWith(s.id + '_')) return s.id;
  }
  // fallback: everything before the last _ segment
  const parts = channelId.split('_');
  return parts.length > 1 ? parts.slice(0, -1).join('_') : 'unknown';
}

function groupBySource(channels: Channel[], sources: Source[]): GroupedSource[] {
  const bySource = new Map<string, { name: string; chs: Channel[] }>();

  for (const ch of channels) {
    if (!ch.enabled) continue;
    const srcId   = getSourceId(ch.id, sources);
    const srcName = sources.find(s => s.id === srcId)?.name ?? 'Unknown Source';
    if (!bySource.has(srcId)) bySource.set(srcId, { name: srcName, chs: [] });
    bySource.get(srcId)!.chs.push(ch);
  }

  return Array.from(bySource.entries())
    .map(([id, v]) => ({ sourceId: id, sourceName: v.name, channels: v.chs }))
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

function getAllGroups(channels: Channel[]): string[] {
  const set = new Set(channels.filter(c => c.enabled).map(c => c.group).filter(Boolean));
  return ['All', ...Array.from(set).sort()];
}

/* ─── Backend DRM proxy URL helpers ─────────────────────────────────────────── */
function getBackendBase(): string {
  const { protocol, hostname, port } = window.location;
  if (port === '5173' || port === '5174' || port === '3000') {
    return `${protocol}//${hostname}:7000`;
  }
  return `${protocol}//${window.location.host}`;
}

/**
 * For DRM streams, we route through the backend proxy:
 *   GET /play/:encodedId  → backend fetches MPD, injects /license/:encodedId
 * The encodedId encodes the channel's URL + kid + key.
 */
function buildProxyPlayUrl(ch: Channel): string {
  const base    = getBackendBase();
  const payload = JSON.stringify({ url: ch.url, kid: ch.kid, key: ch.contentKey });
  const encoded = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${base}/play/${encoded}`;
}

/* ─── Shaka singleton loader ─────────────────────────────────────────────────── */
let shakaLoadPromise: Promise<void> | null = null;
function ensureShaka(): Promise<void> {
  if (window.shaka) return Promise.resolve();
  if (shakaLoadPromise) return shakaLoadPromise;
  shakaLoadPromise = new Promise((resolve, reject) => {
    const s   = document.createElement('script');
    s.src     = 'https://cdn.jsdelivr.net/npm/shaka-player@4.7.11/dist/shaka-player.compiled.js';
    s.onload  = () => {
      if (window.shaka) { window.shaka.polyfill.installAll(); resolve(); }
      else reject(new Error('Shaka not found after CDN load'));
    };
    s.onerror = () => reject(new Error('Failed to load Shaka Player from CDN'));
    document.head.appendChild(s);
  });
  return shakaLoadPromise;
}

/* ─── Error decoder ──────────────────────────────────────────────────────────── */
function decodeShakaError(err: any): string {
  const code = err?.code ?? err?.detail?.code ?? 0;
  const msg  = err?.message ?? err?.detail?.message ?? String(err);

  const codes: Record<number, string> = {
    1001: 'Network request failed — stream server unreachable',
    1002: 'Network request timed out',
    1003: 'Malformed data URI',
    2000: 'Failed to parse DASH manifest',
    2003: 'Failed to parse HLS playlist',
    3000: 'DRM key system not supported in this browser',
    3001: 'DRM key system access denied',
    3002: 'DRM key expired or invalid',
    3016: 'ClearKey DRM not supported in this browser',
    4000: 'Stream playback failed — source error (possibly DRM protected, try via proxy)',
    4001: 'Stream network error — server down or geo-blocked',
    4005: 'Segment request failed repeatedly',
    4015: 'Streaming failed — invalid manifest or segments',
    6000: 'Requested operation not supported',
    6007: 'Buffer quota exceeded',
  };

  if (codes[code]) return `${codes[code]} (code ${code})`;
  if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) return 'Network error — CORS blocked or server down';
  if (msg.includes('4000') || msg.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) return 'Stream format not supported or DRM encrypted';
  return `Error ${code}: ${msg.slice(0, 120)}`;
}

/* ─── Main Component ─────────────────────────────────────────────────────────── */
export default function ShakaPlayer({ channels, sources }: Props) {
  const [showPlayer, setShowPlayer]   = useState(false);
  const [search,     setSearch]       = useState('');
  const [selGroup,   setSelGroup]     = useState('All');
  const [viewMode,   setViewMode]     = useState<'grid' | 'list'>('grid');
  const [activeCh,   setActiveCh]     = useState<Channel | null>(null);
  const [error,      setError]        = useState('');
  const [retryInfo,  setRetryInfo]    = useState('');   // extra retry hint
  const [loading,    setLoading]      = useState(false);
  const [manualPlay, setManualPlay]   = useState(false);
  const [muted,      setMuted]        = useState(false);
  const [volume,     setVolume]       = useState(1);
  const [fullscreen, setFullscreen]   = useState(false);
  const [sidebarOpen,setSidebarOpen]  = useState(true);
  const [shakaReady, setShakaReady]   = useState(!!window.shaka);
  const [shakaError, setShakaError]   = useState('');
  const [showInfo,   setShowInfo]     = useState(false);
  const [useProxy,   setUseProxy]     = useState(false);  // toggle DRM proxy mode
  const [attempt,    setAttempt]      = useState(0);      // retry counter

  const videoRef     = useRef<HTMLVideoElement>(null);
  const playerRef    = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const grouped   = groupBySource(channels, sources);
  const allGroups = getAllGroups(channels);
  const enabled   = channels.filter(c => c.enabled);

  const filtered = enabled.filter(ch => {
    const ms = !search || ch.name.toLowerCase().includes(search.toLowerCase());
    const mg = selGroup === 'All' || ch.group === selGroup;
    return ms && mg;
  });

  /* ── Load Shaka ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (window.shaka) { setShakaReady(true); return; }
    ensureShaka()
      .then(() => setShakaReady(true))
      .catch(e  => setShakaError(String(e)));
  }, []);

  /* ── Destroy helper ─────────────────────────────────────────────────────── */
  const destroyPlayer = useCallback(async () => {
    if (playerRef.current) {
      try { await playerRef.current.destroy(); } catch (_) {}
      playerRef.current = null;
    }
    const v = videoRef.current;
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  }, []);

  /* ── Core play function ──────────────────────────────────────────────────── */
  const playChannel = useCallback(async (ch: Channel, viaProxy: boolean, retryN = 0) => {
    setActiveCh(ch);
    setShowPlayer(true);
    setError('');
    setRetryInfo('');
    setLoading(true);
    setManualPlay(false);
    setUseProxy(viaProxy);
    setAttempt(retryN);

    // Let DOM render the video element
    await new Promise(r => setTimeout(r, 100));

    // Ensure Shaka is loaded
    if (!window.shaka) {
      try   { await ensureShaka(); setShakaReady(true); }
      catch (e) {
        setError('Shaka Player failed to load. Check internet connection.');
        setLoading(false); return;
      }
    }

    const video = videoRef.current;
    if (!video) {
      setError('Video element not ready — please try again.');
      setLoading(false); return;
    }

    await destroyPlayer();

    try {
      const shaka  = window.shaka;

      /* ── Determine stream URL ─────────────────────────────── */
      const isDRM   = !!(ch.kid && ch.contentKey);
      const isDASH  = ch.url.includes('.mpd');
      const isHLS   = ch.url.includes('.m3u8') || ch.url.includes('.m3u');

      // Use backend DRM proxy URL if:
      //   • viaProxy is set explicitly, OR
      //   • stream is DASH + DRM (most reliable path)
      const streamUrl = (viaProxy && isDRM && isDASH)
        ? buildProxyPlayUrl(ch)
        : ch.url;

      /* ── Native HLS on Safari ────────────────────────────── */
      if (isHLS && !isDRM && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        setLoading(false);
        video.play().catch(() => setManualPlay(true));
        return;
      }

      /* ── Init Shaka ──────────────────────────────────────── */
      const player = new shaka.Player(video);
      playerRef.current = player;

      player.addEventListener('error', (evt: any) => {
        const errMsg = decodeShakaError(evt.detail);
        setError(errMsg);
        setLoading(false);

        // Auto-suggest proxy if DRM stream failed without proxy
        if (isDRM && !viaProxy) {
          setRetryInfo('This stream appears DRM-encrypted. Try "Retry via Proxy" to route through the backend DRM handler.');
        }
      });

      player.addEventListener('buffering', (evt: any) => {
        if (!error) setLoading(evt.buffering);
      });

      /* ── DRM config ───────────────────────────────────────── */
      // Shaka clearKeys expects hex strings directly (NOT base64)
      const clearKeys: Record<string, string> = {};
      if (isDRM && !viaProxy) {
        // Direct ClearKey mode — Shaka handles decryption internally
        clearKeys[ch.kid] = ch.contentKey;
      }

      player.configure({
        drm: isDRM && !viaProxy && Object.keys(clearKeys).length > 0
          ? { clearKeys }
          : {},
        streaming: {
          lowLatencyMode       : false,
          bufferingGoal        : 20,
          rebufferingGoal      : 3,
          bufferBehind         : 30,
          retryParameters      : {
            timeout      : 20_000,
            maxAttempts  : 4,
            baseDelay    : 500,
            backoffFactor: 1.5,
            fuzzFactor   : 0.5,
          },
          useNativeHlsOnSafari : true,
        },
        manifest: {
          retryParameters: {
            timeout      : 20_000,
            maxAttempts  : 3,
            baseDelay    : 1000,
            backoffFactor: 2,
            fuzzFactor   : 0.5,
          },
        },
      });

      /* ── Network request filter ───────────────────────────── */
      player.getNetworkingEngine().registerRequestFilter((_type: any, request: any) => {
        // Inject standard IPTV headers
        request.headers['User-Agent'] =
          'plaYtv/7.1.3 (Linux;Android 13) ygx/824.1 ExoPlayerLib/824.0';
        request.headers['Referer'] = 'https://www.jiotv.com/';
        request.headers['Origin']  = 'https://www.jiotv.com';

        // Cookie stored in language field (parser puts it there)
        if (ch.language && (ch.language.includes('__hdnea__') || ch.language.includes('='))) {
          request.headers['Cookie'] = ch.language;
          // Also append as query param for CDNs that require it
          if (request.uris?.[0] && !request.uris[0].includes('__hdnea__')) {
            const sep = request.uris[0].includes('?') ? '&' : '?';
            request.uris[0] += sep + ch.language;
          }
        }
      });

      /* ── Load stream ─────────────────────────────────────── */
      await player.load(streamUrl);
      setLoading(false);
      setError('');

      // Autoplay
      try {
        video.muted = false;
        await video.play();
        setManualPlay(false);
      } catch (_) {
        setManualPlay(true);
      }

    } catch (err: any) {
      console.error('[ShakaPlayer] Load error:', err);
      const errMsg = decodeShakaError(err);
      setError(errMsg);
      setLoading(false);

      // Suggest proxy for DRM DASH streams
      const isDRM  = !!(ch.kid && ch.contentKey);
      const isDASH = ch.url.includes('.mpd');
      if (isDRM && isDASH && !viaProxy) {
        setRetryInfo('Stream is DRM-encrypted. Use "Retry via Proxy" to route through backend DRM handler.');
      }
    }
  }, [destroyPlayer, error]);

  /* ── Open channel (always try direct first) ──────────────────────────────── */
  const openChannel = useCallback((ch: Channel) => {
    playChannel(ch, false, 0);
  }, [playChannel]);

  /* ── Retry via DRM proxy ──────────────────────────────────────────────────── */
  const retryViaProxy = useCallback(() => {
    if (activeCh) playChannel(activeCh, true, attempt + 1);
  }, [activeCh, playChannel, attempt]);

  /* ── Retry same channel ───────────────────────────────────────────────────── */
  const retryChannel = useCallback(() => {
    if (activeCh) playChannel(activeCh, useProxy, attempt + 1);
  }, [activeCh, playChannel, useProxy, attempt]);

  /* ── Close ───────────────────────────────────────────────────────────────── */
  const closePlayer = useCallback(async () => {
    await destroyPlayer();
    setShowPlayer(false);
    setActiveCh(null);
    setError('');
    setRetryInfo('');
    setLoading(false);
    setManualPlay(false);
    setUseProxy(false);
  }, [destroyPlayer]);

  /* ── Navigate ────────────────────────────────────────────────────────────── */
  const navigate = useCallback((dir: 'prev' | 'next') => {
    if (!activeCh) return;
    const list = filtered.length > 0 ? filtered : enabled;
    const idx  = list.findIndex(c => c.id === activeCh.id);
    const next = dir === 'next'
      ? list[(idx + 1) % list.length]
      : list[(idx - 1 + list.length) % list.length];
    if (next) openChannel(next);
  }, [activeCh, filtered, enabled, openChannel]);

  /* ── Fullscreen ──────────────────────────────────────────────────────────── */
  const toggleFS = useCallback(async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen().catch(() => {});
      setFullscreen(true);
    } else {
      await document.exitFullscreen().catch(() => {});
      setFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  /* ── Volume / mute sync ──────────────────────────────────────────────────── */
  useEffect(() => {
    const v = videoRef.current;
    if (v) { v.volume = volume; v.muted = muted; }
  }, [volume, muted]);

  /* ── Keyboard ─────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!showPlayer) return;
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape')   closePlayer();
      if (e.key === 'ArrowRight') navigate('next');
      if (e.key === 'ArrowLeft')  navigate('prev');
      if (e.key === 'm' || e.key === 'M') setMuted(v => !v);
      if (e.key === 'f' || e.key === 'F') toggleFS();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [showPlayer, closePlayer, navigate, toggleFS]);

  /* ────────────────────────────────────────────────────────────────────────── */
  /* RENDER                                                                     */
  /* ────────────────────────────────────────────────────────────────────────── */

  const isDRM   = !!(activeCh?.kid && activeCh?.contentKey);
  const isDASH  = !!(activeCh?.url.includes('.mpd'));
  const isHLS   = !!(activeCh?.url.includes('.m3u8'));

  return (
    <div className="relative">

      {/* ── VIDEO — always mounted so videoRef is always valid ───────────────── */}
      <div className={showPlayer ? 'block' : 'hidden'}>
        <div className="flex gap-3 h-[calc(100vh-8rem)]" ref={containerRef}>

          {/* ── Sidebar ─────────────────────────────────────────────────────── */}
          <div className={cn(
            'flex-shrink-0 bg-gray-900 border border-gray-700/50 rounded-2xl overflow-hidden flex flex-col transition-all duration-300',
            sidebarOpen ? 'w-64' : 'w-0 border-0'
          )}>
            {sidebarOpen && (
              <>
                {/* Search */}
                <div className="p-3 border-b border-gray-700/50 flex-shrink-0">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search channels…"
                      className="w-full bg-gray-800 border border-gray-700/50 rounded-lg pl-8 pr-3 py-1.5 text-white placeholder-gray-500 text-xs focus:border-orange-500 outline-none"
                    />
                  </div>
                </div>

                {/* Source group sections */}
                <div className="flex-1 overflow-y-auto">
                  {grouped.map(grp => {
                    const grpChs = grp.channels.filter(ch => {
                      const ms = !search || ch.name.toLowerCase().includes(search.toLowerCase());
                      const mg = selGroup === 'All' || ch.group === selGroup;
                      return ms && mg;
                    });
                    if (grpChs.length === 0) return null;
                    return (
                      <div key={grp.sourceId}>
                        {/* Source header */}
                        <div className="sticky top-0 bg-gray-850 border-b border-gray-700/30 px-3 py-1.5 flex items-center gap-2 z-10 bg-gray-900">
                          <div className="w-1 h-4 bg-orange-500 rounded-full flex-shrink-0" />
                          <span className="text-orange-300 text-xs font-bold truncate">{grp.sourceName}</span>
                          <span className="text-gray-600 text-[10px] ml-auto flex-shrink-0">({grpChs.length})</span>
                        </div>
                        {grpChs.map((ch, i) => (
                          <button
                            key={ch.id}
                            onClick={() => openChannel(ch)}
                            className={cn(
                              'w-full flex items-center gap-2 px-3 py-2 text-left transition border-b border-gray-800/40 hover:bg-gray-800/80',
                              activeCh?.id === ch.id && 'bg-orange-500/10 border-l-2 border-l-orange-500'
                            )}
                          >
                            <span className="text-gray-700 text-[10px] w-5 font-mono flex-shrink-0">{i + 1}</span>
                            {ch.logo ? (
                              <img src={ch.logo} alt="" className="w-7 h-7 rounded object-contain bg-gray-800 flex-shrink-0"
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            ) : (
                              <div className="w-7 h-7 rounded bg-gray-700 flex items-center justify-center flex-shrink-0">
                                <Tv className="w-3.5 h-3.5 text-gray-500" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className={cn('text-xs font-medium truncate', activeCh?.id === ch.id ? 'text-orange-300' : 'text-gray-200')}>
                                {ch.name}
                              </div>
                              {ch.group && <div className="text-gray-600 text-[10px] truncate">{ch.group}</div>}
                            </div>
                            {ch.kid && <span className="text-red-400 text-[10px] flex-shrink-0">🔐</span>}
                            {activeCh?.id === ch.id && <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {/* Back */}
                <div className="p-3 border-t border-gray-700/50 flex-shrink-0">
                  <button onClick={closePlayer}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-xl transition text-sm">
                    <ArrowLeft className="w-4 h-4" />Back to Grid
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── Player area ─────────────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col gap-2 min-w-0">

            {/* Top bar */}
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              <button onClick={() => setSidebarOpen(v => !v)}
                className="p-2 bg-gray-700/60 hover:bg-gray-700 text-gray-300 rounded-xl transition">
                <List className="w-4 h-4" />
              </button>

              {activeCh && (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {activeCh.logo && (
                    <img src={activeCh.logo} alt="" className="w-7 h-7 rounded object-contain bg-gray-800 flex-shrink-0"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-white font-semibold text-sm truncate">{activeCh.name}</div>
                    {activeCh.group && <div className="text-gray-500 text-xs">{activeCh.group}</div>}
                  </div>
                  {isDRM  && <span className="bg-red-500/20 text-red-300 text-xs px-2 py-0.5 rounded-full border border-red-500/30 flex-shrink-0">🔐 DRM</span>}
                  {isDASH && <span className="bg-purple-500/20 text-purple-300 text-xs px-2 py-0.5 rounded-full border border-purple-500/30 flex-shrink-0">DASH</span>}
                  {isHLS  && <span className="bg-blue-500/20 text-blue-300 text-xs px-2 py-0.5 rounded-full border border-blue-500/30 flex-shrink-0">HLS</span>}
                  {useProxy && <span className="bg-green-500/20 text-green-300 text-xs px-2 py-0.5 rounded-full border border-green-500/30 flex-shrink-0">🔀 Proxy</span>}
                  <span className="flex items-center gap-1 text-red-400 text-xs flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />LIVE
                  </span>
                </div>
              )}

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button onClick={() => navigate('prev')} className="p-2 bg-gray-700/60 hover:bg-gray-700 text-gray-300 rounded-xl transition" title="Prev">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => navigate('next')} className="p-2 bg-gray-700/60 hover:bg-gray-700 text-gray-300 rounded-xl transition" title="Next">
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button onClick={retryChannel} className="p-2 bg-gray-700/60 hover:bg-orange-500/20 text-gray-300 hover:text-orange-400 rounded-xl transition" title="Reload">
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button onClick={() => setShowInfo(v => !v)} className="p-2 bg-gray-700/60 hover:bg-blue-500/20 text-gray-300 hover:text-blue-400 rounded-xl transition" title="Stream info">
                  <Info className="w-4 h-4" />
                </button>
                <button onClick={closePlayer} className="p-2 bg-gray-700/60 hover:bg-red-500/20 text-gray-300 hover:text-red-400 rounded-xl transition" title="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Video */}
            <div className="flex-1 relative bg-black rounded-2xl overflow-hidden group min-h-0">
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                playsInline
                autoPlay
              />

              {/* Loading */}
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                  <div className="text-center">
                    <Loader2 className="w-12 h-12 text-orange-400 animate-spin mx-auto mb-3" />
                    <p className="text-white text-sm font-medium">
                      {useProxy ? 'Connecting via DRM Proxy…' : 'Loading stream…'}
                    </p>
                    {activeCh && <p className="text-gray-400 text-xs mt-1">{activeCh.name}</p>}
                    {attempt > 0 && <p className="text-yellow-400 text-xs mt-1">Attempt {attempt + 1}</p>}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && !loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-10">
                  <div className="text-center max-w-md px-6">
                    <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
                    <h3 className="text-white font-semibold mb-2">Playback Failed</h3>
                    <p className="text-gray-300 text-sm mb-3 leading-relaxed">{error}</p>

                    {/* DRM proxy hint */}
                    {retryInfo && (
                      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-2.5 mb-4 text-left">
                        <p className="text-yellow-300 text-xs leading-relaxed">{retryInfo}</p>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 justify-center">
                      <button onClick={retryChannel}
                        className="flex items-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-semibold transition">
                        <RefreshCw className="w-4 h-4" />Retry
                      </button>

                      {/* Show proxy button for DRM DASH streams */}
                      {isDRM && isDASH && !useProxy && (
                        <button onClick={retryViaProxy}
                          className="flex items-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold transition">
                          <Radio className="w-4 h-4" />Retry via Proxy
                        </button>
                      )}

                      <button onClick={closePlayer}
                        className="flex items-center gap-2 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm transition">
                        <ArrowLeft className="w-4 h-4" />Back
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Manual play overlay */}
              {manualPlay && !error && !loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
                  <button
                    onClick={() => {
                      const v = videoRef.current;
                      if (v) { v.muted = false; v.play().catch(() => {}); setManualPlay(false); }
                    }}
                    className="flex items-center gap-3 px-8 py-4 bg-orange-500 hover:bg-orange-600 text-white rounded-2xl text-xl font-bold transition shadow-2xl shadow-orange-500/30"
                  >
                    <Play className="w-8 h-8 fill-white" />Click to Play
                  </button>
                </div>
              )}

              {/* Idle state */}
              {!activeCh && !loading && !error && (
                <div className="absolute inset-0 flex items-center justify-center bg-gray-900 z-10">
                  <div className="text-center">
                    <Tv className="w-16 h-16 text-gray-600 mx-auto mb-4" />
                    <p className="text-gray-400 text-lg font-medium">Select a channel</p>
                    <p className="text-gray-600 text-sm mt-1">Choose from the sidebar or grid</p>
                  </div>
                </div>
              )}

              {/* Controls overlay */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20">
                <div className="flex items-center gap-3">
                  <button onClick={() => setMuted(v => !v)} className="text-white hover:text-orange-400 transition">
                    {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </button>
                  <input type="range" min="0" max="1" step="0.05"
                    value={muted ? 0 : volume}
                    onChange={e => { const v = parseFloat(e.target.value); setVolume(v); setMuted(v === 0); }}
                    className="w-20 accent-orange-500"
                  />
                  <div className="flex-1" />
                  <button onClick={() => navigate('prev')} className="text-white hover:text-orange-400 transition flex items-center gap-1 text-sm">
                    <ChevronLeft className="w-4 h-4" />Prev
                  </button>
                  <button onClick={() => navigate('next')} className="text-white hover:text-orange-400 transition flex items-center gap-1 text-sm">
                    Next<ChevronRight className="w-4 h-4" />
                  </button>
                  <button onClick={toggleFS} className="text-white hover:text-orange-400 transition">
                    {fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Stream info bar */}
            {activeCh && showInfo && (
              <div className="bg-gray-800/50 border border-gray-700/30 rounded-xl px-4 py-2.5 text-xs text-gray-400 flex-shrink-0 space-y-1.5">
                <div className="flex items-start gap-2">
                  <span className="text-gray-600 w-16 flex-shrink-0">URL</span>
                  <span className="font-mono break-all text-cyan-400">{activeCh.url}</span>
                </div>
                {useProxy && (
                  <div className="flex items-start gap-2">
                    <span className="text-gray-600 w-16 flex-shrink-0">Proxy</span>
                    <span className="font-mono break-all text-green-400">{buildProxyPlayUrl(activeCh)}</span>
                  </div>
                )}
                {activeCh.kid && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 w-16 flex-shrink-0">KID</span>
                    <span className="font-mono text-red-400">{activeCh.kid}</span>
                  </div>
                )}
                {activeCh.contentKey && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 w-16 flex-shrink-0">KEY</span>
                    <span className="font-mono text-red-400">{activeCh.contentKey}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 w-16 flex-shrink-0">Type</span>
                  <span className="text-purple-400">
                    {isDASH ? 'MPEG-DASH' : isHLS ? 'HLS' : 'Stream'}
                    {isDRM ? ' + ClearKey DRM' : ''}
                    {useProxy ? ' (via backend proxy)' : ' (direct)'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 w-16 flex-shrink-0">Source</span>
                  <span className="text-gray-300">
                    {sources.find(s => activeCh.id.startsWith(s.id + '_'))?.name ?? 'Unknown'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── GRID VIEW ───────────────────────────────────────────────────────── */}
      {!showPlayer && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                <Tv className="w-7 h-7 text-orange-400" />
                IPTV Player
              </h2>
              <p className="text-gray-400 mt-1 text-sm flex items-center gap-2 flex-wrap">
                <span>{enabled.length} channels · {grouped.length} source{grouped.length !== 1 ? 's' : ''}</span>
                {shakaReady
                  ? <span className="text-green-400 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />Player Ready
                    </span>
                  : shakaError
                    ? <span className="text-red-400">⚠ {shakaError}</span>
                    : <span className="text-yellow-400 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />Loading player…
                      </span>
                }
              </p>
            </div>
            <button
              onClick={() => setViewMode(v => v === 'grid' ? 'list' : 'grid')}
              className="p-2.5 bg-gray-700/60 hover:bg-gray-600 text-gray-300 rounded-xl transition"
            >
              {viewMode === 'grid' ? <List className="w-4 h-4" /> : <Grid3x3 className="w-4 h-4" />}
            </button>
          </div>

          {/* Search + group filter */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search channels…"
                className="w-full bg-gray-800/60 border border-gray-700/50 rounded-xl pl-10 pr-10 py-2.5 text-white placeholder-gray-500 text-sm focus:border-orange-500 outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                  <X className="w-4 h-4 text-gray-400 hover:text-white" />
                </button>
              )}
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 flex-shrink-0">
              {allGroups.slice(0, 8).map(g => (
                <button key={g} onClick={() => setSelGroup(g)}
                  className={cn(
                    'px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition',
                    selGroup === g
                      ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20'
                      : 'bg-gray-700/50 text-gray-400 hover:text-white hover:bg-gray-700'
                  )}>
                  {g}
                </button>
              ))}
            </div>
          </div>

          {/* Channel grid — grouped by source */}
          {grouped.length === 0 ? (
            <div className="text-center py-20 bg-gray-800/30 rounded-2xl border border-gray-700/30">
              <Tv className="w-16 h-16 text-gray-600 mx-auto mb-4" />
              <h3 className="text-xl text-gray-400 font-semibold">No Channels</h3>
              <p className="text-gray-500 mt-2 text-sm">Add sources in the Sources tab to load channels</p>
            </div>
          ) : (
            <div className="space-y-10">
              {grouped.map(grp => {
                const grpChs = grp.channels.filter(ch => {
                  const ms = !search || ch.name.toLowerCase().includes(search.toLowerCase());
                  const mg = selGroup === 'All' || ch.group === selGroup;
                  return ms && mg;
                });
                if (grpChs.length === 0) return null;

                return (
                  <div key={grp.sourceId}>
                    {/* Source header */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-1.5 h-7 bg-orange-500 rounded-full" />
                      <h3 className="text-white font-bold text-lg">{grp.sourceName}</h3>
                      <span className="bg-orange-500/15 text-orange-300 text-xs px-2.5 py-0.5 rounded-full font-medium">
                        {grpChs.length} channels
                      </span>
                      <div className="flex-1 h-px bg-gray-700/40" />
                    </div>

                    {viewMode === 'grid' ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                        {grpChs.map(ch => (
                          <ChannelCard key={ch.id} channel={ch} onPlay={() => openChannel(ch)} />
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {grpChs.map(ch => (
                          <ChannelListItem key={ch.id} channel={ch} onPlay={() => openChannel(ch)} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Channel Card ───────────────────────────────────────────────────────────── */
function ChannelCard({ channel, onPlay }: { channel: Channel; onPlay: () => void }) {
  return (
    <button onClick={onPlay}
      className="group bg-gray-800/40 hover:bg-gray-700/60 border border-gray-700/40 hover:border-orange-500/50 rounded-xl overflow-hidden transition-all duration-200 text-left w-full">
      <div className="aspect-video bg-gray-900 flex items-center justify-center relative overflow-hidden">
        {channel.logo ? (
          <img src={channel.logo} alt={channel.name}
            className="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-300"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <Tv className="w-8 h-8 text-gray-600" />
        )}
        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
          <div className="w-12 h-12 rounded-full bg-orange-500 flex items-center justify-center shadow-xl shadow-orange-500/40">
            <Play className="w-6 h-6 text-white fill-white ml-0.5" />
          </div>
        </div>
        {/* Badges */}
        <div className="absolute top-1 right-1 flex flex-col gap-0.5">
          {channel.kid     && <span className="text-[10px] bg-red-600/90 text-white px-1 py-0.5 rounded font-bold">DRM</span>}
          {channel.url.includes('.mpd') && <span className="text-[10px] bg-purple-600/90 text-white px-1 py-0.5 rounded font-bold">DASH</span>}
        </div>
      </div>
      <div className="p-2">
        <div className="text-white text-xs font-semibold truncate">{channel.name}</div>
        {channel.group && <div className="text-gray-500 text-[10px] truncate">{channel.group}</div>}
      </div>
    </button>
  );
}

/* ─── Channel List Item ──────────────────────────────────────────────────────── */
function ChannelListItem({ channel, onPlay }: { channel: Channel; onPlay: () => void }) {
  return (
    <button onClick={onPlay}
      className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/40 hover:bg-gray-700/60 border border-gray-700/40 hover:border-orange-500/40 rounded-xl transition text-left group">
      <div className="w-12 h-8 bg-gray-900 rounded flex items-center justify-center flex-shrink-0 overflow-hidden">
        {channel.logo ? (
          <img src={channel.logo} alt="" className="w-full h-full object-contain"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <Tv className="w-4 h-4 text-gray-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm font-medium truncate">{channel.name}</div>
        {channel.group && <div className="text-gray-500 text-xs">{channel.group}</div>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {channel.kid && <span className="text-red-400 text-xs">🔐</span>}
        {channel.url.includes('.mpd')  && <span className="text-purple-400 text-[10px] bg-purple-500/10 px-1.5 py-0.5 rounded">DASH</span>}
        {channel.url.includes('.m3u8') && <span className="text-blue-400 text-[10px] bg-blue-500/10 px-1.5 py-0.5 rounded">HLS</span>}
        <div className="w-7 h-7 rounded-lg bg-orange-500/20 group-hover:bg-orange-500 flex items-center justify-center transition">
          <Play className="w-3.5 h-3.5 text-orange-400 group-hover:text-white fill-current" />
        </div>
      </div>
    </button>
  );
}
