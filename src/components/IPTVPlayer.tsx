import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import * as dashjs from 'dashjs';
import { Stream } from '../types';

interface IPTVPlayerProps {
  streams: Stream[];
  initialStream?: Stream | null;
  onClose?: () => void;
  embedded?: boolean;
}

type PlaybackEngine = 'hls' | 'dash' | 'native' | null;

interface PlayerState {
  playing: boolean;
  loading: boolean;
  error: string | null;
  retryCount: number;
  engine: PlaybackEngine;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  showControls: boolean;
  showSidebar: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  showInfo: boolean;
}

function buildCustomXHRLoader(headers: Record<string, string>) {
  // Custom XHR loader for dashjs to inject headers into every request
  function CustomLoader(this: any) {
    const loader = new XMLHttpRequest();
    let aborted = false;

    this.load = function (config: any, httpReq: any, callbacks: any) {
      const req = httpReq || config;
      const url = req.url || config.url;
      const method = 'GET';

      loader.open(method, url, true);
      loader.responseType = req.responseType || 'text';
      loader.withCredentials = false;

      // Inject custom headers
      Object.entries(headers).forEach(([k, v]) => {
        try { loader.setRequestHeader(k, v); } catch (_) { /* skip */ }
      });

      loader.onload = function () {
        if (aborted) return;
        if (loader.status >= 200 && loader.status < 300) {
          callbacks.success({
            url: loader.responseURL || url,
            data: loader.response,
            status: loader.status,
            responseType: loader.responseType,
          });
        } else {
          callbacks.error({
            request: req,
            response: loader,
            loader: this,
          });
        }
      };

      loader.onerror = function () {
        if (!aborted) callbacks.error({ request: req, response: loader });
      };

      loader.ontimeout = function () {
        if (!aborted) callbacks.error({ request: req, response: loader });
      };

      if (req.timeout) loader.timeout = req.timeout;
      loader.send();
    };

    this.abort = function () {
      aborted = true;
      loader.abort();
    };
  }

  return CustomLoader;
}

function parseClearKey(licenseKey: string): { clearkeys: Record<string, string> } | null {
  try {
    // Format: "kid_hex:key_hex" or "kid_base64:key_base64"
    const parts = licenseKey.split(':');
    if (parts.length < 2) return null;

    let kid = parts[0].trim();
    let key = parts[1].trim();

    // Convert hex to base64url if needed
    const hexToBase64url = (hex: string) => {
      const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
      const b64 = btoa(String.fromCharCode(...bytes));
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    };

    // If it looks like hex (32 chars = 16 bytes = 128-bit key)
    if (/^[0-9a-fA-F]{32}$/.test(kid)) {
      kid = hexToBase64url(kid);
    }
    if (/^[0-9a-fA-F]{32}$/.test(key)) {
      key = hexToBase64url(key);
    }

    return { clearkeys: { [kid]: key } };
  } catch {
    return null;
  }
}

function detectStreamType(url: string): 'hls' | 'dash' | 'native' {
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.mpd')) return 'dash';
  if (u.endsWith('.m3u8') || u.endsWith('.m3u')) return 'hls';
  if (u.endsWith('.ts') || u.endsWith('.mp4') || u.endsWith('.mkv')) return 'native';
  if (u.includes('.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('.m3u')) return 'hls';
  return 'hls'; // default assumption for IPTV
}

export default function IPTVPlayer({ streams, initialStream, onClose, embedded }: IPTVPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [currentStream, setCurrentStream] = useState<Stream | null>(initialStream || streams[0] || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('All');
  const [state, setState] = useState<PlayerState>({
    playing: false,
    loading: false,
    error: null,
    retryCount: 0,
    engine: null,
    volume: 1,
    muted: false,
    fullscreen: false,
    showControls: true,
    showSidebar: true,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    showInfo: false,
  });

  const groups = ['All', ...Array.from(new Set(streams.map(s => s.group).filter(Boolean)))];

  const filteredStreams = streams.filter(s => {
    const matchGroup = selectedGroup === 'All' || s.group === selectedGroup;
    const matchSearch = !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchGroup && matchSearch && s.enabled !== false;
  });

  const destroyEngines = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (dashRef.current) {
      try {
        dashRef.current.reset();
        dashRef.current.destroy();
      } catch (_) { /* ignore */ }
      dashRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }, []);

  const buildHeaders = useCallback((stream: Stream): Record<string, string> => {
    const headers: Record<string, string> = {
      'User-Agent': stream.userAgent || 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36',
    };
    if (stream.cookie) headers['Cookie'] = stream.cookie;
    if (stream.referer) headers['Referer'] = stream.referer;
    if (stream.httpHeaders) {
      try {
        const h = typeof stream.httpHeaders === 'string'
          ? JSON.parse(stream.httpHeaders)
          : stream.httpHeaders;
        Object.assign(headers, h);
      } catch { /* ignore */ }
    }
    return headers;
  }, []);

  const playWithHLS = useCallback((video: HTMLVideoElement, url: string, stream: Stream) => {
    const headers = buildHeaders(stream);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        xhrSetup: (xhr: XMLHttpRequest, xhrUrl: string) => {
          Object.entries(headers).forEach(([k, v]) => {
            try { xhr.setRequestHeader(k, v); } catch (_) { /* skip */ }
          });
          // Suppress unused variable warning
          void xhrUrl;
        },
        fetchSetup: (context: any, initParams: any) => {
          return new Request(context.url, {
            ...initParams,
            headers: {
              ...initParams?.headers,
              ...headers,
            },
          });
        },
      });

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setState(p => ({ ...p, engine: 'hls', loading: false, error: null }));
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_e: any, data: any) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setState(p => {
              if (p.retryCount < 3) {
                hls.startLoad();
                return { ...p, retryCount: p.retryCount + 1, error: `Network error, retrying (${p.retryCount + 1}/3)...` };
              }
              return { ...p, error: `HLS Network Error: ${data.details}`, loading: false };
            });
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setState(p => ({ ...p, error: `HLS Fatal: ${data.details}`, loading: false }));
          }
        }
      });

      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = url;
      video.play().catch(() => {});
      setState(p => ({ ...p, engine: 'hls', loading: false }));
    } else {
      setState(p => ({ ...p, error: 'HLS not supported in this browser', loading: false }));
    }
  }, [buildHeaders]);

  const playWithDASH = useCallback((video: HTMLVideoElement, url: string, stream: Stream) => {
    const headers = buildHeaders(stream);
    const player = dashjs.MediaPlayer().create();

    // Custom XHR loader to inject all headers (Cookie, User-Agent, etc.)
    const CustomXHR = buildCustomXHRLoader(headers);

    player.updateSettings({
      streaming: {
        abr: {
          autoSwitchBitrate: { video: true, audio: true },
        },
        buffer: {
          bufferTimeAtTopQuality: 30,
          bufferTimeAtTopQualityLongForm: 60,
          bufferToKeep: 20,
        },
        retryAttempts: {
          MPD: 3,
          MediaSegment: 5,
          InitializationSegment: 5,
          BitstreamSwitchingSegment: 3,
          IndexSegment: 3,
          other: 3,
        },
        retryIntervals: {
          MPD: 500,
          MediaSegment: 1000,
          InitializationSegment: 1000,
          BitstreamSwitchingSegment: 500,
          IndexSegment: 500,
          other: 1000,
        },
        liveCatchup: {
          enabled: true,
          mode: 'liveCatchupModeDefault',
        },
      },
    });

    // Inject custom XHR loader
    try {
      (player as any).registerCustomCapabilitiesFilter && (player as any).registerCustomCapabilitiesFilter(() => true);
    } catch (_) { /* ignore */ }

    // Set custom request modifier to inject headers into all requests
    // Header injection via request interceptor

    // Use addRequestInterceptor if available (dashjs 4.x+)
    try {
      (player as any).addRequestInterceptor((request: any) => {
        if (request.headers) {
          Object.entries(headers).forEach(([k, v]) => {
            request.headers[k] = v;
          });
        } else {
          request.headers = { ...headers };
        }
        return Promise.resolve(request);
      });
    } catch (_) {
      // Fallback: use xhrCustom
      try {
        player.updateSettings({
          streaming: {
            // @ts-ignore
            xhrWithCredentials: false,
          }
        });
      } catch (_2) { /* ignore */ }
    }

    // Set up ClearKey DRM
    if (stream.licenseType === 'clearkey' && stream.licenseKey) {
      const ckData = parseClearKey(stream.licenseKey);
      if (ckData) {
        player.setProtectionData({
          'org.w3.clearkey': {
            clearkeys: ckData.clearkeys,
            serverURL: '',
          }
        });
      }
    } else if (stream.licenseType === 'widevine' && stream.licenseKey) {
      player.setProtectionData({
        'com.widevine.alpha': {
          serverURL: stream.licenseKey,
          httpRequestHeaders: headers,
          withCredentials: false,
        }
      });
    }

    player.initialize(video, url, true);

    player.on(dashjs.MediaPlayer.events.CAN_PLAY, () => {
      setState(p => ({ ...p, engine: 'dash', loading: false, error: null }));
      video.play().catch(() => {});
    });

    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
      setState(p => ({ ...p, engine: 'dash', loading: false, error: null }));
    });

    player.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
      const msg = e?.error?.message || e?.error || 'DASH playback error';
      const code = e?.error?.code || '';
      // Don't show protection errors as fatal immediately - DRM may still work
      if (String(code).includes('protection') || String(msg).includes('protection')) {
        console.warn('[DASH] Protection warning:', msg);
        return;
      }
      setState(p => ({ ...p, error: `DASH: ${msg}`, loading: false }));
    });

    player.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, (e: any) => {
      const msg = e?.error || 'DASH playback failed';
      setState(p => ({ ...p, error: `Playback: ${msg}`, loading: false }));
    });

    // Suppress unused variable warning
    void CustomXHR;

    dashRef.current = player;
  }, [buildHeaders]);

  const playStream = useCallback((stream: Stream) => {
    const video = videoRef.current;
    if (!video) return;

    destroyEngines();
    setState(p => ({
      ...p,
      loading: true,
      error: null,
      retryCount: 0,
      playing: false,
      engine: null,
      currentTime: 0,
      duration: 0,
      buffered: 0,
    }));

    const url = stream.url;
    if (!url) {
      setState(p => ({ ...p, error: 'No stream URL', loading: false }));
      return;
    }

    const type = detectStreamType(url);

    if (type === 'dash') {
      playWithDASH(video, url, stream);
    } else if (type === 'hls') {
      playWithHLS(video, url, stream);
    } else {
      // Native: .ts, .mp4, .mkv
      const headers = buildHeaders(stream);
      // For .ts files we wrap with HLS.js if possible
      if (url.endsWith('.ts') && Hls.isSupported()) {
        // Treat as HLS fragment — use blob approach
        fetch(url, { headers })
          .then(r => r.blob())
          .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            video.src = blobUrl;
            video.play().catch(() => {});
            setState(p => ({ ...p, engine: 'native', loading: false }));
          })
          .catch(err => {
            setState(p => ({ ...p, error: `Failed to load .ts: ${err.message}`, loading: false }));
          });
      } else {
        video.src = url;
        video.play().catch(err => {
          setState(p => ({ ...p, error: `Native playback failed: ${err.message}`, loading: false }));
        });
        setState(p => ({ ...p, engine: 'native', loading: false }));
      }
    }

    setCurrentStream(stream);
  }, [destroyEngines, playWithDASH, playWithHLS, buildHeaders]);

  // Play initial stream
  useEffect(() => {
    if (initialStream) {
      setCurrentStream(initialStream);
      setTimeout(() => playStream(initialStream), 100);
    } else if (streams.length > 0 && !currentStream) {
      setCurrentStream(streams[0]);
    }
  }, [initialStream]); // eslint-disable-line

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      destroyEngines();
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [destroyEngines]);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => setState(p => ({ ...p, playing: true, loading: false, error: null }));
    const onPause = () => setState(p => ({ ...p, playing: false }));
    const onWaiting = () => setState(p => ({ ...p, loading: true }));
    const onCanPlay = () => setState(p => ({ ...p, loading: false }));
    const onTimeUpdate = () => {
      const buffered = video.buffered.length > 0
        ? (video.buffered.end(video.buffered.length - 1) / (video.duration || 1)) * 100
        : 0;
      setState(p => ({
        ...p,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        buffered,
      }));
    };
    const onError = () => {
      const err = video.error;
      const msgs: Record<number, string> = {
        1: 'Aborted', 2: 'Network error', 3: 'Decode error (incompatible format)',
        4: 'Source not supported',
      };
      setState(p => ({
        ...p,
        error: err ? (msgs[err.code] || err.message) : 'Unknown playback error',
        loading: false,
      }));
    };
    const onVolumeChange = () => setState(p => ({ ...p, volume: video.volume, muted: video.muted }));

    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('error', onError);
    video.addEventListener('volumechange', onVolumeChange);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('error', onError);
      video.removeEventListener('volumechange', onVolumeChange);
    };
  }, []);

  // Fullscreen change
  useEffect(() => {
    const onFSChange = () => {
      setState(p => ({ ...p, fullscreen: !!document.fullscreenElement }));
    };
    document.addEventListener('fullscreenchange', onFSChange);
    return () => document.removeEventListener('fullscreenchange', onFSChange);
  }, []);

  const showControlsTemporarily = useCallback(() => {
    setState(p => ({ ...p, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setState(p => ({ ...p, showControls: false }));
    }, 3000);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  const setVolume = useCallback((v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const seekTo = useCallback((pct: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = (pct / 100) * video.duration;
  }, []);

  const navigateStream = useCallback((dir: 'prev' | 'next') => {
    const idx = filteredStreams.findIndex(s => s.id === currentStream?.id);
    if (idx === -1) return;
    const next = dir === 'prev' ? idx - 1 : idx + 1;
    if (next >= 0 && next < filteredStreams.length) {
      playStream(filteredStreams[next]);
    }
  }, [filteredStreams, currentStream, playStream]);

  const formatTime = (s: number) => {
    if (!s || !isFinite(s)) return 'LIVE';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const engineBadge = state.engine ? (
    <span className={`text-xs px-2 py-0.5 rounded font-bold ${
      state.engine === 'dash' ? 'bg-purple-600 text-white' :
      state.engine === 'hls' ? 'bg-blue-600 text-white' :
      'bg-gray-600 text-white'
    }`}>
      {state.engine.toUpperCase()}
    </span>
  ) : null;

  return (
    <div
      ref={containerRef}
      className={`flex ${embedded ? 'h-full' : 'fixed inset-0 z-50'} bg-black`}
      onMouseMove={showControlsTemporarily}
      onTouchStart={showControlsTemporarily}
    >
      {/* SIDEBAR */}
      <div className={`${state.showSidebar ? 'w-72' : 'w-0'} flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col transition-all duration-300 overflow-hidden`}>
        {/* Sidebar Header */}
        <div className="p-3 border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-white font-bold text-sm">📺 Channels</span>
            <span className="text-gray-400 text-xs">{filteredStreams.length}</span>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search channels..."
            className="w-full bg-gray-800 text-white text-xs px-2 py-1.5 rounded border border-gray-600 focus:outline-none focus:border-orange-500"
          />
        </div>

        {/* Group tabs */}
        <div className="flex gap-1 p-2 overflow-x-auto flex-shrink-0 border-b border-gray-700">
          {groups.slice(0, 8).map(g => (
            <button
              key={g}
              onClick={() => setSelectedGroup(g)}
              className={`text-xs px-2 py-1 rounded whitespace-nowrap flex-shrink-0 ${
                selectedGroup === g
                  ? 'bg-orange-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {g.length > 12 ? g.slice(0, 12) + '…' : g}
            </button>
          ))}
        </div>

        {/* Channel List */}
        <div className="flex-1 overflow-y-auto">
          {filteredStreams.map((stream, idx) => {
            const isActive = stream.id === currentStream?.id;
            const type = detectStreamType(stream.url);
            return (
              <div
                key={stream.id}
                onClick={() => playStream(stream)}
                className={`flex items-center gap-2 p-2 cursor-pointer border-b border-gray-800 hover:bg-gray-800 transition-colors ${
                  isActive ? 'bg-orange-900/40 border-l-2 border-l-orange-500' : ''
                }`}
              >
                <span className="text-gray-500 text-xs w-5 text-center flex-shrink-0">{idx + 1}</span>
                {stream.logo ? (
                  <img src={stream.logo} alt="" className="w-8 h-8 object-contain rounded flex-shrink-0 bg-gray-800"
                    onError={e => (e.currentTarget.style.display = 'none')} />
                ) : (
                  <div className="w-8 h-8 rounded bg-gray-700 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs text-gray-500">📺</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-medium truncate ${isActive ? 'text-orange-400' : 'text-white'}`}>
                    {stream.name}
                  </div>
                  <div className="flex gap-1 mt-0.5">
                    {type === 'dash' && (
                      <span className="text-[10px] bg-purple-700 text-white px-1 rounded">MPD</span>
                    )}
                    {stream.licenseType === 'clearkey' && (
                      <span className="text-[10px] bg-red-700 text-white px-1 rounded">🔐CK</span>
                    )}
                    {stream.licenseType === 'widevine' && (
                      <span className="text-[10px] bg-red-700 text-white px-1 rounded">🔐WV</span>
                    )}
                    {isActive && state.playing && (
                      <span className="text-[10px] text-orange-400 animate-pulse">● LIVE</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* MAIN PLAYER */}
      <div className="flex-1 flex flex-col min-w-0 relative">

        {/* Top bar */}
        <div className={`absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/80 to-transparent p-3 flex items-center gap-3 transition-opacity duration-300 ${state.showControls ? 'opacity-100' : 'opacity-0'}`}>
          <button
            onClick={() => setState(p => ({ ...p, showSidebar: !p.showSidebar }))}
            className="text-white bg-black/50 hover:bg-black/80 px-2 py-1 rounded text-sm"
            title="Toggle sidebar"
          >
            ☰
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-white font-bold text-sm truncate">{currentStream?.name || 'No channel selected'}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-gray-400 text-xs">{currentStream?.group}</span>
              {engineBadge}
              {state.engine === 'dash' && currentStream?.licenseType && (
                <span className="text-xs bg-red-700 text-white px-1.5 py-0.5 rounded">
                  🔐 {currentStream.licenseType.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setState(p => ({ ...p, showInfo: !p.showInfo }))}
            className="text-white bg-black/50 hover:bg-black/80 px-2 py-1 rounded text-xs"
          >
            ℹ️
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-white bg-red-600/80 hover:bg-red-600 px-2 py-1 rounded text-sm font-bold"
            >
              ✕
            </button>
          )}
        </div>

        {/* Video element */}
        <div className="flex-1 relative bg-black flex items-center justify-center" onClick={togglePlay}>
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            playsInline
            crossOrigin="anonymous"
            onDoubleClick={toggleFullscreen}
          />

          {/* Loading spinner */}
          {state.loading && !state.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
              <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mb-3" />
              <div className="text-white text-sm">
                {currentStream?.name || 'Loading...'}
              </div>
              {state.retryCount > 0 && (
                <div className="text-orange-400 text-xs mt-1">Retry {state.retryCount}/3</div>
              )}
            </div>
          )}

          {/* Error overlay */}
          {state.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 pointer-events-none p-4">
              <div className="text-5xl mb-3">⚠️</div>
              <div className="text-white font-bold text-lg mb-2">Playback Error</div>
              <div className="text-red-400 text-sm text-center max-w-md mb-4">{state.error}</div>
              <div className="text-gray-400 text-xs text-center mb-4">
                {detectStreamType(currentStream?.url || '') === 'dash' ? (
                  <span>DASH stream — cookie/DRM injection active. Check network or DRM key.</span>
                ) : (
                  <span>HLS stream — check source URL and connectivity.</span>
                )}
              </div>
              <button
                onClick={e => { e.stopPropagation(); if (currentStream) playStream(currentStream); }}
                className="pointer-events-auto bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded font-medium text-sm"
              >
                🔄 Retry
              </button>
            </div>
          )}

          {/* No stream selected */}
          {!currentStream && !state.loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
              <div className="text-6xl mb-4">📺</div>
              <div className="text-white font-bold text-xl mb-2">Select a Channel</div>
              <div className="text-gray-400 text-sm">Choose from the sidebar to start watching</div>
            </div>
          )}

          {/* Info panel */}
          {state.showInfo && currentStream && (
            <div className="absolute top-16 right-3 bg-black/90 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 max-w-xs pointer-events-none">
              <div className="font-bold text-white mb-2">Stream Info</div>
              <div className="space-y-1">
                <div><span className="text-gray-500">Name:</span> {currentStream.name}</div>
                <div><span className="text-gray-500">Group:</span> {currentStream.group}</div>
                <div><span className="text-gray-500">Engine:</span> {state.engine?.toUpperCase() || '—'}</div>
                <div><span className="text-gray-500">Type:</span> {detectStreamType(currentStream.url).toUpperCase()}</div>
                {currentStream.licenseType && (
                  <div><span className="text-gray-500">DRM:</span> {currentStream.licenseType}</div>
                )}
                {currentStream.userAgent && (
                  <div><span className="text-gray-500">UA:</span> <span className="break-all">{currentStream.userAgent.slice(0, 40)}…</span></div>
                )}
                {currentStream.cookie && (
                  <div><span className="text-gray-500">Cookie:</span> ✓ Present</div>
                )}
                <div className="break-all"><span className="text-gray-500">URL:</span> {currentStream.url.slice(0, 60)}…</div>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Controls */}
        <div className={`absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 to-transparent p-3 transition-opacity duration-300 ${state.showControls ? 'opacity-100' : 'opacity-0'}`}>

          {/* Progress bar */}
          {state.duration > 0 && (
            <div className="mb-2 relative h-1 bg-gray-700 rounded cursor-pointer group"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                seekTo(((e.clientX - rect.left) / rect.width) * 100);
              }}
            >
              <div className="absolute inset-y-0 left-0 bg-gray-600 rounded" style={{ width: `${state.buffered}%` }} />
              <div className="absolute inset-y-0 left-0 bg-orange-500 rounded" style={{ width: `${(state.currentTime / state.duration) * 100}%` }} />
            </div>
          )}

          <div className="flex items-center gap-3">
            {/* Prev */}
            <button onClick={() => navigateStream('prev')} className="text-white hover:text-orange-400 text-lg" title="Previous">⏮</button>

            {/* Play/Pause */}
            <button onClick={togglePlay} className="text-white hover:text-orange-400 text-2xl w-8 text-center" title={state.playing ? 'Pause' : 'Play'}>
              {state.playing ? '⏸' : '▶'}
            </button>

            {/* Next */}
            <button onClick={() => navigateStream('next')} className="text-white hover:text-orange-400 text-lg" title="Next">⏭</button>

            {/* Time */}
            <span className="text-gray-300 text-xs tabular-nums">
              {formatTime(state.currentTime)} / {formatTime(state.duration)}
            </span>

            <div className="flex-1" />

            {/* LIVE badge */}
            {(!state.duration || state.duration === Infinity) && state.playing && (
              <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse inline-block" />
                LIVE
              </span>
            )}

            {/* Volume */}
            <div className="flex items-center gap-1.5">
              <button onClick={toggleMute} className="text-white hover:text-orange-400 text-sm">
                {state.muted || state.volume === 0 ? '🔇' : state.volume < 0.5 ? '🔉' : '🔊'}
              </button>
              <input
                type="range" min={0} max={1} step={0.05} value={state.muted ? 0 : state.volume}
                onChange={e => setVolume(Number(e.target.value))}
                className="w-16 accent-orange-500 cursor-pointer"
              />
            </div>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white hover:text-orange-400 text-sm" title="Fullscreen">
              {state.fullscreen ? '⛶' : '⛶'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
