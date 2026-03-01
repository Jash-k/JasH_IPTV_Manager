import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, Source } from '../types';
import { cn } from '../utils/cn';
import {
  Search, ArrowLeft, ChevronLeft, ChevronRight,
  Volume2, VolumeX, Maximize, Minimize,
  Info, RefreshCw, LayoutGrid, List, X, Loader2
} from 'lucide-react';

// ─── Backend Base URL ─────────────────────────────────────────────────────────
function getBackendBase(): string {
  const { protocol, hostname, port } = window.location;
  if (port === '5173' || port === '5174' || port === '3000') {
    return `${protocol}//${hostname}:7000`;
  }
  return `${protocol}//${window.location.host}`;
}

// ─── Shaka Player Loader ──────────────────────────────────────────────────────
let shakaPromise: Promise<typeof window.shaka> | null = null;
function ensureShaka(): Promise<typeof window.shaka> {
  if (shakaPromise) return shakaPromise;
  shakaPromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && (window as unknown as {shaka?: typeof window.shaka}).shaka) {
      resolve((window as unknown as {shaka: typeof window.shaka}).shaka);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.11/shaka-player.compiled.min.js';
    script.onload = () => {
      const shaka = (window as unknown as {shaka?: typeof window.shaka}).shaka;
      if (shaka) resolve(shaka);
      else reject(new Error('Shaka Player failed to load'));
    };
    script.onerror = () => reject(new Error('Failed to load Shaka Player script'));
    document.head.appendChild(script);
  });
  return shakaPromise;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface PlayableChannel extends Channel {
  sourceName: string;
}

// ─── Build Proxy URL ──────────────────────────────────────────────────────────
/**
 * Build a backend proxy URL for a channel.
 * DASH+DRM → /proxy/mpd/:id (backend fetches, decrypts, returns HLS)
 * HLS       → /proxy/hls/:id (backend rewrites segment URLs)
 * Direct    → direct URL
 */
function buildProxyUrl(ch: Channel, backendBase: string): { url: string; isProxy: boolean } {
  const url = ch.url.toLowerCase();
  const hasDrm = !!(ch.kid && ch.contentKey);

  // Encode channel payload for backend
  const payload = {
    url: ch.url,
    kid: ch.kid || '',
    key: ch.contentKey || '',
    cookie: ch.language || '',      // language field stores cookie in our schema
    name: ch.name,
    logo: ch.logo,
    group: ch.group,
    referer: 'https://www.jiotv.com/',
    userAgent: 'plaYtv/7.1.3 (Linux;Android 13) ygx/69.1 ExoPlayerLib/824.0',
  };
  const encodedId = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  if (url.includes('.mpd') || url.includes('/dash/') || url.includes('format=mpd')) {
    // DASH stream — route through backend MPD→HLS proxy (handles DRM decrypt)
    const proxyUrl = hasDrm
      ? `${backendBase}/proxy/mpd/${encodedId}?key_id=${ch.kid}&key=${ch.contentKey}`
      : `${backendBase}/proxy/mpd/${encodedId}`;
    return { url: proxyUrl, isProxy: true };
  }

  if (url.includes('.m3u8') || url.includes('/hls/') || url.includes('index.m3u')) {
    // HLS stream — route through backend HLS proxy (rewrites segment URLs with auth)
    const proxyUrl = `${backendBase}/proxy/hls/${encodedId}`;
    return { url: proxyUrl, isProxy: true };
  }

  // Direct stream
  return { url: ch.url, isProxy: false };
}

// ─── Error message mapping ────────────────────────────────────────────────────
function friendlyError(e: unknown): string {
  const msg = String(e);
  if (msg.includes('4000') || msg.includes('MEDIA_ERR'))    return 'Stream not supported by this browser';
  if (msg.includes('4001') || msg.includes('BAD_HTTP'))     return 'Stream unreachable (403/404)';
  if (msg.includes('4015') || msg.includes('malformed'))    return 'Invalid or malformed stream URL';
  if (msg.includes('3016') || msg.includes('DRM'))          return 'DRM error — trying proxy…';
  if (msg.includes('timeout') || msg.includes('Timeout'))   return 'Stream timed out';
  if (msg.includes('NETWORK'))                              return 'Network error — check connection';
  return msg.split('\n')[0].slice(0, 120);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  SHAKA PLAYER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function ShakaPlayer({
  channels,
  sources,
}: {
  channels: Channel[];
  sources: Source[];
}) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const playerRef   = useRef<unknown>(null);
  const [activeCh, setActiveCh]   = useState<PlayableChannel | null>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [retries, setRetries]     = useState(0);
  const [muted, setMuted]         = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showInfo, setShowInfo]   = useState(false);
  const [searchQ, setSearchQ]     = useState('');
  const [groupFilter, setGroupFilter] = useState('All');
  const [viewMode, setViewMode]   = useState<'grid' | 'list'>('grid');
  const [showSidebar, setShowSidebar] = useState(true);
  const [shakaReady, setShakaReady]  = useState(false);
  const backendBase = getBackendBase();

  // Map channels to include source name
  const allChannels: PlayableChannel[] = channels.map(ch => ({
    ...ch,
    sourceName: sources.find(s => ch.id.startsWith(`${s.id}_`))?.name || 'Unknown Source',
  }));

  // Group by source name for the grid view
  const sourceGroups = Array.from(
    allChannels.reduce((map, ch) => {
      const key = ch.sourceName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ch);
      return map;
    }, new Map<string, PlayableChannel[]>())
  );

  const groups = ['All', ...Array.from(new Set(allChannels.map(c => c.group || 'Uncategorized'))).sort()];

  const filtered = allChannels.filter(c => {
    const inGroup  = groupFilter === 'All' || (c.group || 'Uncategorized') === groupFilter;
    const inSearch = !searchQ || c.name.toLowerCase().includes(searchQ.toLowerCase()) || c.sourceName.toLowerCase().includes(searchQ.toLowerCase());
    return inGroup && inSearch;
  });

  // Load Shaka on mount
  useEffect(() => {
    ensureShaka().then(() => setShakaReady(true)).catch(e => console.error('Shaka load failed:', e));
    return () => { destroyPlayer(); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!showPlayer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') backToGrid();
      if (e.key === 'ArrowLeft')  prevChannel();
      if (e.key === 'ArrowRight') nextChannel();
      if (e.key === 'm' || e.key === 'M') toggleMute();
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showPlayer, activeCh, filtered]);

  const destroyPlayer = async () => {
    try {
      if (playerRef.current) {
        const p = playerRef.current as {destroy?: () => Promise<void>};
        await p.destroy?.();
        playerRef.current = null;
      }
    } catch {}
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.src = '';
    }
  };

  const openChannel = useCallback(async (ch: PlayableChannel) => {
    setActiveCh(ch);
    setShowPlayer(true);
    setLoading(true);
    setError('');
    setRetries(0);

    // Wait for video element to mount
    await new Promise(r => setTimeout(r, 100));

    const video = videoRef.current;
    if (!video) { setError('Video element not available'); setLoading(false); return; }

    await destroyPlayer();

    const { url: proxyUrl, isProxy } = buildProxyUrl(ch, backendBase);
    const hasDrm = !!(ch.kid && ch.contentKey);

    console.log(`[Player] ${ch.name} | proxy=${isProxy} | drm=${hasDrm} | url=${proxyUrl.slice(0, 80)}`);

    // ── Try native video first (MP4/direct) ────────────────────────────────
    const isNativeFriendly = !ch.url.toLowerCase().includes('.mpd') && !ch.url.toLowerCase().includes('.m3u8') && !hasDrm;
    if (isNativeFriendly && !isProxy) {
      try {
        video.src = ch.url;
        await video.play();
        setLoading(false);
        return;
      } catch { /* fall through to Shaka */ }
    }

    // ── Shaka Player ───────────────────────────────────────────────────────
    if (!shakaReady) {
      setError('Shaka Player not loaded yet. Please wait a moment and try again.');
      setLoading(false);
      return;
    }

    const shaka = (window as unknown as {shaka: typeof window.shaka}).shaka;
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      setError('Browser does not support MSE/EME. Try Chrome or Firefox.');
      setLoading(false);
      return;
    }

    try {
      const player = new shaka.Player(video);
      playerRef.current = player;

      // Configure Shaka
      player.configure({
        streaming: {
          bufferingGoal: 15,
          rebufferingGoal: 2,
          bufferBehind: 15,
          retryParameters: { timeout: 20000, maxAttempts: 5, baseDelay: 500, backoffFactor: 1.5, fuzzFactor: 0.5 },
          useNativeHlsOnSafari: true,
          failureCallback: () => {},
        },
        manifest: {
          retryParameters: { timeout: 20000, maxAttempts: 3, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5 },
        },
        // ClearKey DRM (direct mode — Shaka handles in-browser decryption)
        ...(hasDrm && !isProxy ? {
          drm: {
            clearKeys: { [ch.kid!]: ch.contentKey! },
          },
        } : {}),
      });

      // Network filter — inject auth headers for direct streams
      if (!isProxy) {
        player.getNetworkingEngine().registerRequestFilter((_type: unknown, request: {headers: Record<string, string>; uris: string[]}) => {
          request.headers['User-Agent']  = 'plaYtv/7.1.3 (Linux;Android 13) ygx/69.1 ExoPlayerLib/824.0';
          request.headers['Referer']     = 'https://www.jiotv.com/';
          if (ch.language) { // language field stores cookie
            request.headers['Cookie'] = ch.language;
          }
        });
      }

      player.addEventListener('error', (event: {detail?: unknown}) => {
        const errMsg = friendlyError(event.detail);
        console.error('[Shaka] Error:', errMsg);
        setError(errMsg);
        setLoading(false);
      });

      // Load stream
      await player.load(proxyUrl);
      await video.play().catch(() => {});
      setLoading(false);
      setError('');
    } catch (e) {
      const errMsg = friendlyError(e);
      console.error('[Player] Load failed:', errMsg, e);
      setError(errMsg);
      setLoading(false);
    }
  }, [shakaReady, backendBase]);

  const backToGrid = async () => {
    await destroyPlayer();
    setShowPlayer(false);
    setActiveCh(null);
    setError('');
    setLoading(false);
  };

  const prevChannel = () => {
    if (!activeCh) return;
    const idx = filtered.findIndex(c => c.id === activeCh.id);
    if (idx > 0) openChannel(filtered[idx - 1]);
  };

  const nextChannel = () => {
    if (!activeCh) return;
    const idx = filtered.findIndex(c => c.id === activeCh.id);
    if (idx < filtered.length - 1) openChannel(filtered[idx + 1]);
  };

  const retryPlay = () => {
    if (!activeCh) return;
    setRetries(r => r + 1);
    openChannel(activeCh);
  };

  const toggleMute = () => {
    if (videoRef.current) { videoRef.current.muted = !videoRef.current.muted; setMuted(v => !v); }
  };

  const toggleFullscreen = () => {
    const el = document.getElementById('jash-player-container');
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().then(() => setFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setFullscreen(false)).catch(() => {});
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Video element — ALWAYS mounted so ref is valid */}
      <div className={showPlayer ? 'block' : 'hidden'}>
        <div id="jash-player-container" className="bg-black rounded-2xl overflow-hidden">
          {/* Player header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-900/80 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <button onClick={backToGrid}
                className="flex items-center gap-2 text-gray-400 hover:text-white transition text-sm">
                <ArrowLeft className="w-4 h-4" />Back
              </button>
              {activeCh && (
                <div className="flex items-center gap-2">
                  {activeCh.logo && (
                    <img src={activeCh.logo} alt="" className="w-6 h-6 rounded object-cover"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  <span className="text-white font-semibold text-sm">{activeCh.name}</span>
                  {activeCh.kid && (
                    <span className="text-xs bg-red-900/60 text-red-300 px-1.5 py-0.5 rounded font-mono">🔐 DRM→Proxy</span>
                  )}
                  <span className="text-gray-600 text-xs">·</span>
                  <span className="text-gray-400 text-xs">{activeCh.group}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowSidebar(v => !v)}
                className="p-1.5 hover:bg-gray-700/50 text-gray-400 hover:text-white rounded-lg transition text-xs">
                {showSidebar ? '⟩ Hide' : '⟨ List'}
              </button>
              <button onClick={() => setShowInfo(v => !v)}
                className="p-1.5 hover:bg-gray-700/50 text-gray-400 hover:text-white rounded-lg transition">
                <Info className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex" style={{ height: 'calc(100vh - 16rem)', minHeight: '400px' }}>
            {/* Video area */}
            <div className="flex-1 relative bg-black min-w-0">
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                playsInline
                controls={false}
              />

              {/* Loading overlay */}
              {loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
                  <Loader2 className="w-12 h-12 text-purple-400 animate-spin mb-3" />
                  <p className="text-white text-sm font-medium">Loading stream…</p>
                  {activeCh?.kid && (
                    <p className="text-gray-400 text-xs mt-1">Setting up DRM proxy…</p>
                  )}
                  {retries > 0 && <p className="text-yellow-400 text-xs mt-1">Retry #{retries}</p>}
                </div>
              )}

              {/* Error overlay */}
              {error && !loading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10 p-6">
                  <div className="text-4xl mb-3">⚠️</div>
                  <p className="text-red-300 text-sm font-medium text-center mb-4 max-w-sm">{error}</p>
                  <div className="flex gap-3">
                    <button onClick={retryPlay}
                      className="flex items-center gap-2 px-4 py-2 bg-purple-700/60 hover:bg-purple-600/60 text-purple-200 rounded-xl text-sm font-semibold transition">
                      <RefreshCw className="w-4 h-4" />Retry
                    </button>
                    <button onClick={backToGrid}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 rounded-xl text-sm transition">
                      <X className="w-4 h-4" />Back
                    </button>
                  </div>
                </div>
              )}

              {/* Video controls */}
              <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-3 z-10">
                <button onClick={toggleMute}
                  className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-lg transition">
                  {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
                <div className="flex-1" />
                <button onClick={prevChannel}
                  className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-lg transition"
                  title="Previous (←)">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={nextChannel}
                  className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-lg transition"
                  title="Next (→)">
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button onClick={toggleFullscreen}
                  className="p-2 bg-black/50 hover:bg-black/70 text-white rounded-lg transition">
                  {fullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </button>
              </div>

              {/* Stream info panel */}
              {showInfo && activeCh && (
                <div className="absolute top-0 left-0 right-0 bg-black/80 backdrop-blur-sm p-3 z-10 border-b border-gray-700">
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div><span className="text-gray-500">Name:</span> <span className="text-white">{activeCh.name}</span></div>
                    <div><span className="text-gray-500">Group:</span> <span className="text-white">{activeCh.group}</span></div>
                    <div><span className="text-gray-500">Source:</span> <span className="text-cyan-300">{activeCh.sourceName}</span></div>
                    <div><span className="text-gray-500">DRM:</span> <span className={activeCh.kid ? 'text-red-300' : 'text-green-300'}>{activeCh.kid ? `ClearKey → Proxy` : 'None'}</span></div>
                    <div className="col-span-2 break-all"><span className="text-gray-500">URL:</span> <span className="text-blue-300">{activeCh.url.slice(0, 80)}{activeCh.url.length > 80 ? '…' : ''}</span></div>
                    {activeCh.kid && (
                      <div className="col-span-2 break-all"><span className="text-gray-500">Proxy:</span> <span className="text-purple-300">{backendBase}/proxy/mpd/…</span></div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Channel sidebar */}
            {showSidebar && (
              <div className="w-72 flex-shrink-0 bg-gray-900/90 border-l border-gray-800 flex flex-col overflow-hidden">
                {/* Sidebar search */}
                <div className="p-2 border-b border-gray-800">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                    <input
                      value={searchQ}
                      onChange={e => setSearchQ(e.target.value)}
                      placeholder="Search…"
                      className="w-full bg-gray-800/80 border border-gray-700/50 rounded-lg pl-8 pr-3 py-1.5 text-white placeholder-gray-500 focus:border-purple-500 outline-none text-xs"
                    />
                  </div>
                </div>

                {/* Channel list */}
                <div className="flex-1 overflow-y-auto">
                  {filtered.map(ch => (
                    <button
                      key={ch.id}
                      onClick={() => openChannel(ch)}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-all border-l-2',
                        activeCh?.id === ch.id
                          ? 'bg-purple-900/40 border-purple-500 text-white'
                          : 'border-transparent hover:bg-gray-800/60 text-gray-300 hover:text-white'
                      )}
                    >
                      {ch.logo ? (
                        <img src={ch.logo} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0 bg-gray-800"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <div className="w-7 h-7 rounded bg-gray-700/60 flex items-center justify-center flex-shrink-0 text-xs">📺</div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium truncate">{ch.name}</span>
                          {ch.kid && <span className="text-xs text-red-400 flex-shrink-0">🔐</span>}
                        </div>
                        <div className="text-gray-500 text-xs truncate">{ch.group}</div>
                      </div>
                      {activeCh?.id === ch.id && loading && (
                        <Loader2 className="w-3 h-3 text-purple-400 animate-spin flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* GRID VIEW */}
      {!showPlayer && (
        <div className="space-y-5">
          {/* Header */}
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <span className="text-2xl">▶️</span>
              IPTV Player
            </h2>
            <p className="text-gray-400 mt-1">
              {allChannels.length.toLocaleString()} channels · Click to play · DRM streams auto-proxied
            </p>
          </div>

          {/* Proxy info banner */}
          <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-blue-400 text-lg flex-shrink-0">🔐</span>
            <div>
              <p className="text-blue-300 text-sm font-semibold">Built-in DRM Proxy Active</p>
              <p className="text-blue-200/60 text-xs mt-0.5">
                DASH+DRM streams are automatically routed through <code className="bg-blue-900/40 px-1 rounded">{backendBase}/proxy/mpd/…</code>
                — no player-side DRM support needed. Backend decrypts CENC (AES-CTR/CBC) segments transparently.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap gap-3">
            <div className="flex-1 min-w-48 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                placeholder="Search channels…"
                className="w-full bg-gray-800/50 border border-gray-700/50 rounded-xl pl-10 pr-4 py-2.5 text-white placeholder-gray-500 focus:border-purple-500 outline-none text-sm"
              />
            </div>
            <select
              value={groupFilter}
              onChange={e => setGroupFilter(e.target.value)}
              className="bg-gray-800/50 border border-gray-700/50 rounded-xl px-4 py-2.5 text-white focus:border-purple-500 outline-none text-sm"
            >
              {groups.map(g => (
                <option key={g} value={g}>
                  {g === 'All' ? `All Groups (${allChannels.length})` : `${g} (${allChannels.filter(c => (c.group||'Uncategorized')===g).length})`}
                </option>
              ))}
            </select>
            <div className="flex gap-1 bg-gray-800/50 border border-gray-700/50 rounded-xl p-1">
              <button onClick={() => setViewMode('grid')}
                className={cn('p-1.5 rounded-lg transition', viewMode === 'grid' ? 'bg-purple-700/60 text-white' : 'text-gray-400 hover:text-white')}>
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button onClick={() => setViewMode('list')}
                className={cn('p-1.5 rounded-lg transition', viewMode === 'list' ? 'bg-purple-700/60 text-white' : 'text-gray-400 hover:text-white')}>
                <List className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Channel display */}
          {allChannels.length === 0 ? (
            <div className="text-center py-20 bg-gray-800/30 rounded-2xl border border-gray-700/30">
              <div className="text-5xl mb-4">📺</div>
              <h3 className="text-xl text-gray-400 font-semibold">No Channels</h3>
              <p className="text-gray-500 mt-2">Add M3U/JSON sources in the Sources tab first.</p>
            </div>
          ) : groupFilter !== 'All' ? (
            /* Filtered view */
            viewMode === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {filtered.map(ch => (
                  <ChannelCard key={ch.id} ch={ch} onPlay={() => openChannel(ch)} />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map(ch => (
                  <ChannelRow key={ch.id} ch={ch} onPlay={() => openChannel(ch)} />
                ))}
              </div>
            )
          ) : (
            /* Grouped by source */
            sourceGroups.map(([sourceName, chs]) => {
              const visibleChs = searchQ
                ? chs.filter(c => c.name.toLowerCase().includes(searchQ.toLowerCase()))
                : chs;
              if (visibleChs.length === 0) return null;
              return (
                <div key={sourceName}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="h-px flex-1 bg-gray-800" />
                    <span className="text-gray-400 text-sm font-semibold px-3 py-1 bg-gray-800/50 border border-gray-700/50 rounded-full">
                      📡 {sourceName} <span className="text-gray-600">({visibleChs.length})</span>
                    </span>
                    <div className="h-px flex-1 bg-gray-800" />
                  </div>
                  {viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                      {visibleChs.map(ch => (
                        <ChannelCard key={ch.id} ch={ch} onPlay={() => openChannel(ch)} />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {visibleChs.map(ch => (
                        <ChannelRow key={ch.id} ch={ch} onPlay={() => openChannel(ch)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── Channel Card (Grid) ──────────────────────────────────────────────────────
function ChannelCard({ ch, onPlay }: { ch: PlayableChannel; onPlay: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button onClick={onPlay}
      className="bg-gray-800/50 hover:bg-gray-800 border border-gray-700/40 hover:border-purple-500/50 rounded-xl overflow-hidden transition-all group text-left w-full">
      <div className="relative aspect-video bg-gray-900 flex items-center justify-center overflow-hidden">
        {ch.logo && !imgFailed ? (
          <img src={ch.logo} alt={ch.name} className="w-full h-full object-cover"
            onError={() => setImgFailed(true)} />
        ) : (
          <div className="text-3xl">📺</div>
        )}
        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center">
          <div className="w-10 h-10 bg-purple-600/80 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all scale-75 group-hover:scale-100">
            <span className="text-white text-sm">▶</span>
          </div>
        </div>
        {/* DRM badge */}
        {ch.kid && (
          <div className="absolute top-1.5 right-1.5 text-xs bg-red-900/80 text-red-300 px-1.5 py-0.5 rounded font-mono">
            🔐
          </div>
        )}
        {/* Live dot */}
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-black/60 rounded px-1.5 py-0.5">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-white text-xs font-bold">LIVE</span>
        </div>
      </div>
      <div className="px-2.5 py-2">
        <div className="text-white text-xs font-semibold truncate">{ch.name}</div>
        <div className="text-gray-500 text-xs truncate mt-0.5">{ch.group}</div>
      </div>
    </button>
  );
}

// ─── Channel Row (List) ───────────────────────────────────────────────────────
function ChannelRow({ ch, onPlay }: { ch: PlayableChannel; onPlay: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button onClick={onPlay}
      className="w-full flex items-center gap-3 bg-gray-800/40 hover:bg-gray-800/70 border border-gray-700/40 hover:border-purple-500/40 rounded-xl px-3 py-2.5 transition-all group text-left">
      <div className="w-10 h-10 rounded-lg bg-gray-900 flex items-center justify-center flex-shrink-0 overflow-hidden">
        {ch.logo && !imgFailed
          ? <img src={ch.logo} alt={ch.name} className="w-full h-full object-cover" onError={() => setImgFailed(true)} />
          : <span className="text-lg">📺</span>
        }
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-medium truncate">{ch.name}</span>
          {ch.kid && <span className="text-xs bg-red-900/50 text-red-300 px-1.5 py-0.5 rounded font-mono flex-shrink-0">🔐</span>}
        </div>
        <div className="text-gray-500 text-xs truncate">{ch.group} · {ch.sourceName}</div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
        <span className="text-gray-400 text-xs">LIVE</span>
        <div className="w-7 h-7 bg-purple-700/40 group-hover:bg-purple-700/70 rounded-lg flex items-center justify-center ml-2 transition">
          <span className="text-white text-xs">▶</span>
        </div>
      </div>
    </button>
  );
}
