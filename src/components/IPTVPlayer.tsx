import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { Stream } from '../types';
import { useAppStore } from '../store/useAppStore';

declare global {
  interface Window {
    dashjs: any;
    MediaSource: typeof MediaSource;
    WebKitMediaSource: any;
  }
}

interface PlayerState {
  playing: boolean;
  muted: boolean;
  volume: number;
  fullscreen: boolean;
  loading: boolean;
  error: string | null;
  currentTime: number;
  duration: number;
  buffered: number;
  showControls: boolean;
  pip: boolean;
  isLive: boolean;
}

interface IPTVPlayerProps {
  initialStream?: Stream | null;
  onClose?: () => void;
  embedded?: boolean;
}

// ── Detect stream format ───────────────────────────────────────────────────────
function detectFormat(stream: Stream): 'hls' | 'dash' | 'ts' | 'direct' {
  if (stream.streamType === 'dash') return 'dash';
  const url = (stream.url || '').toLowerCase().split('?')[0];
  if (url.endsWith('.mpd') || url.includes('/dash/')) return 'dash';
  if (url.endsWith('.ts') || url.includes('.ts?')) return 'ts';
  if (url.endsWith('.m3u8') || url.endsWith('.m3u') || url.includes('m3u8')) return 'hls';
  if (url.includes('playlist') || url.includes('index.m3u')) return 'hls';
  if (url.includes('chunklist') || url.includes('stream.m3u')) return 'hls';
  return 'direct';
}

// ── Build headers object ───────────────────────────────────────────────────────
function buildHeaders(stream: Stream): Record<string, string> {
  const h: Record<string, string> = {};
  if (stream.userAgent) h['User-Agent'] = stream.userAgent;
  if (stream.referer) h['Referer'] = stream.referer;
  if (stream.cookie) h['Cookie'] = stream.cookie;
  if (stream.httpHeaders) Object.assign(h, stream.httpHeaders);
  return h;
}

// ── Load dash.js from CDN ──────────────────────────────────────────────────────
let dashLoadPromise: Promise<any> | null = null;
function loadDashJs(): Promise<any> {
  if (window.dashjs) return Promise.resolve(window.dashjs);
  if (dashLoadPromise) return dashLoadPromise;
  dashLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.dashjs.org/v4.7.4/dash.all.min.js';
    script.onload = () => {
      if (window.dashjs) resolve(window.dashjs);
      else reject(new Error('dash.js failed to initialize'));
    };
    script.onerror = () => reject(new Error('Failed to load dash.js'));
    document.head.appendChild(script);
  });
  return dashLoadPromise;
}

// ── Convert hex ClearKey to Base64url ─────────────────────────────────────────
function hexToBase64url(hex: string): string {
  hex = hex.replace(/\s/g, '');
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Build ClearKey protection data for dash.js ────────────────────────────────
function buildClearKeyProtData(licenseKey: string) {
  // licenseKey format: "kid1:key1,kid2:key2" or "kid1:key1"
  const pairs = licenseKey.split(',').map(p => p.trim()).filter(Boolean);
  const clearkeys: Record<string, string> = {};
  const jwkKeys: any[] = [];

  pairs.forEach(pair => {
    const [kid, key] = pair.split(':').map(s => s.trim());
    if (!kid || !key) return;
    const kidB64 = hexToBase64url(kid);
    const keyB64 = hexToBase64url(key);
    clearkeys[kidB64] = keyB64;
    jwkKeys.push({ kty: 'oct', kid: kidB64, k: keyB64 });
  });

  return {
    'org.w3.clearkey': {
      clearkeys,
      // Some dash.js versions need this format
      serverURL: 'data:application/json;base64,' +
        btoa(JSON.stringify({ keys: jwkKeys, type: 'temporary' })),
    },
  };
}

const IPTVPlayer: React.FC<IPTVPlayerProps> = ({ initialStream, onClose, embedded = false }) => {
  const { streams } = useAppStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<any>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentStreamRef = useRef<Stream | null>(null);

  const [currentStream, setCurrentStream] = useState<Stream | null>(initialStream || null);
  const [playerState, setPlayerState] = useState<PlayerState>({
    playing: false, muted: false, volume: 1, fullscreen: false,
    loading: false, error: null, currentTime: 0, duration: 0, buffered: 0,
    showControls: true, pip: false, isLive: true,
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [qualityLevels, setQualityLevels] = useState<{ label: string; index: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [streamInfo, setStreamInfo] = useState({ codec: '', resolution: '', bitrate: '', format: '' });
  const [loadingMsg, setLoadingMsg] = useState('Loading stream...');

  // Filtered stream list
  const groups = ['All', ...Array.from(new Set(
    streams.filter(s => s.enabled).map(s => s.group || 'Ungrouped')
  )).sort()];

  const filtered = streams.filter(s => {
    if (!s.enabled) return false;
    const matchGroup = selectedGroup === 'All' || s.group === selectedGroup;
    const matchSearch = !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchGroup && matchSearch;
  });

  // ── Destroy all player instances ──────────────────────────────────────────
  const destroyPlayer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (_) {}
      hlsRef.current = null;
    }
    if (dashRef.current) {
      try { dashRef.current.reset(); } catch (_) {}
      dashRef.current = null;
    }
    // Clean up MediaSource for .ts direct play
    if (mediaSourceRef.current) {
      try {
        if (mediaSourceRef.current.readyState === 'open') {
          mediaSourceRef.current.endOfStream();
        }
      } catch (_) {}
      mediaSourceRef.current = null;
      sourceBufferRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      try { videoRef.current.src = ''; videoRef.current.load(); } catch (_) {}
    }
  }, []);

  // ── Play via HLS.js (handles .m3u8, master playlists, .ts segments) ───────
  const playHLS = useCallback((stream: Stream) => {
    const video = videoRef.current;
    if (!video) return;
    const headers = buildHeaders(stream);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 20000,
        levelLoadingTimeOut: 20000,
        // Retry config
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        xhrSetup: (xhr, _url) => {
          Object.entries(headers).forEach(([k, v]) => {
            try { xhr.setRequestHeader(k, v); } catch (_) {}
          });
        },
      });

      hlsRef.current = hls;
      hls.loadSource(stream.url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        setLoadingMsg('Manifest loaded...');
        const levels = data.levels.map((l, i) => ({
          label: l.height ? `${l.height}p` : l.bitrate ? `${Math.round(l.bitrate / 1000)}k` : `Q${i + 1}`,
          index: i,
        }));
        setQualityLevels(levels);
        setStreamInfo(p => ({ ...p, format: 'HLS' }));
        video.play()
          .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
          .catch(() => setPlayerState(p => ({ ...p, loading: false })));
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        setCurrentQuality(data.level);
        const lvl = hls.levels[data.level];
        if (lvl) {
          setStreamInfo(p => ({
            ...p,
            resolution: lvl.height ? `${lvl.width || '?'}x${lvl.height}` : p.resolution,
            bitrate: lvl.bitrate ? `${Math.round(lvl.bitrate / 1000)}kbps` : p.bitrate,
            codec: lvl.videoCodec || p.codec,
          }));
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        setPlayerState(p => p.loading ? { ...p, loading: false } : p);
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setLoadingMsg(`Network error, retrying... (${data.details})`);
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          setLoadingMsg('Media error, recovering...');
          hls.recoverMediaError();
        } else {
          setPlayerState(p => ({
            ...p, loading: false,
            error: `HLS Error: ${data.details}\n${data.type}`,
          }));
        }
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari / WebKit)
      video.src = stream.url;
      setStreamInfo(p => ({ ...p, format: 'HLS (Native)' }));
      video.play()
        .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
        .catch(e => setPlayerState(p => ({
          ...p, loading: false,
          error: `Native HLS error: ${e.message}`,
        })));
    } else {
      setPlayerState(p => ({
        ...p, loading: false,
        error: 'HLS not supported in this browser. Try Chrome or Firefox.',
      }));
    }
  }, []);

  // ── Play via dash.js (DASH .mpd + ClearKey DRM) ───────────────────────────
  const playDASH = useCallback(async (stream: Stream) => {
    const video = videoRef.current;
    if (!video) return;

    setLoadingMsg('Loading DASH player...');

    let dashjs: any;
    try {
      dashjs = await loadDashJs();
    } catch (e: any) {
      setPlayerState(p => ({ ...p, loading: false, error: `dash.js load failed: ${e.message}` }));
      return;
    }

    const player = dashjs.MediaPlayer().create();
    dashRef.current = player;

    // Settings for stability
    player.updateSettings({
      streaming: {
        buffer: { bufferTimeAtTopQuality: 12, bufferTimeAtTopQualityLongForm: 20 },
        abr: { autoSwitchBitrate: { video: true } },
        liveCatchup: { enabled: true },
      },
    });

    // ── ClearKey DRM ──────────────────────────────────────────────────────────
    if (stream.licenseType === 'clearkey' && stream.licenseKey) {
      try {
        const protData = buildClearKeyProtData(stream.licenseKey);
        player.setProtectionData(protData);
        setLoadingMsg('Setting up ClearKey DRM...');
      } catch (e: any) {
        console.warn('[DASH] ClearKey setup error:', e.message);
      }
    } else if (stream.licenseType === 'widevine' && stream.licenseKey) {
      try {
        player.setProtectionData({
          'com.widevine.alpha': { serverURL: stream.licenseKey },
        });
      } catch (_) {}
    }

    // ── Custom request headers ────────────────────────────────────────────────
    const headers = buildHeaders(stream);
    if (Object.keys(headers).length > 0) {
      try {
        player.extend('RequestModifier', function () {
          return {
            modifyRequestHeader: (xhr: XMLHttpRequest, _request: any) => {
              Object.entries(headers).forEach(([k, v]) => {
                try { xhr.setRequestHeader(k, v as string); } catch (_) {}
              });
              return xhr;
            },
            modifyRequestURL: (url: string) => url,
          };
        }, true);
      } catch (_) {}
    }

    // ── Events ────────────────────────────────────────────────────────────────
    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
      setPlayerState(p => ({ ...p, loading: false, playing: true, error: null }));
      setStreamInfo(p => ({ ...p, format: stream.licenseType ? `DASH+${stream.licenseType.toUpperCase()}` : 'DASH' }));
      try {
        const bitrateList = player.getBitrateInfoListFor('video');
        if (bitrateList && bitrateList.length > 0) {
          const levels = bitrateList.map((b: any, i: number) => ({
            label: b.height ? `${b.height}p` : `${Math.round((b.bitrate || 0) / 1000)}k`,
            index: i,
          }));
          setQualityLevels(levels);
        }
      } catch (_) {}
    });

    player.on(dashjs.MediaPlayer.events.CAN_PLAY, () => {
      setPlayerState(p => ({ ...p, loading: false }));
    });

    player.on(dashjs.MediaPlayer.events.PLAYBACK_PLAYING, () => {
      setPlayerState(p => ({ ...p, playing: true, loading: false, error: null }));
    });

    player.on(dashjs.MediaPlayer.events.PLAYBACK_PAUSED, () => {
      setPlayerState(p => ({ ...p, playing: false }));
    });

    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, (e: any) => {
      if (e.mediaType === 'video') setCurrentQuality(e.newQuality);
    });

    player.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
      const msg = e.error?.message || e.error?.code || JSON.stringify(e.error || 'DASH error');
      console.error('[DASH] Error:', e);
      // DRM errors — show helpful message
      if (String(msg).includes('KEY') || String(msg).includes('DRM') || String(msg).includes('protection')) {
        setPlayerState(p => ({
          ...p, loading: false,
          error: `🔐 DRM Error: ${msg}\n\nClearKey DRM streams may not play in all browsers.\nTry Chrome or use an external player.`,
        }));
      } else {
        setPlayerState(p => ({ ...p, loading: false, error: `DASH Error: ${msg}` }));
      }
    });

    player.on(dashjs.MediaPlayer.events.PROTECTION_CREATED, () => {
      setLoadingMsg('DRM initialized...');
    });

    player.initialize(video, stream.url, true);
  }, []);

  // ── Play a raw .ts segment directly ──────────────────────────────────────
  const playTS = useCallback((stream: Stream) => {
    const video = videoRef.current;
    if (!video) return;
    // For .ts files, try direct src first (some browsers can play)
    video.src = stream.url;
    setStreamInfo(p => ({ ...p, format: 'MPEG-TS' }));
    video.play()
      .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
      .catch(() => {
        // Fallback: treat as HLS stream (sometimes .ts is actually an HLS segment
        // or the actual stream is at the base URL as HLS)
        const hlsUrl = stream.url.replace(/\.ts(\?.*)?$/, '.m3u8$1');
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hlsRef.current = hls;
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setStreamInfo(p => ({ ...p, format: 'HLS (from TS)' }));
            video.play()
              .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
              .catch(() => setPlayerState(p => ({
                ...p, loading: false,
                error: 'Cannot play MPEG-TS stream. Try downloading and playing locally.',
              })));
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) {
              // Last resort — just set src directly
              hls.destroy();
              hlsRef.current = null;
              video.src = stream.url;
              video.play()
                .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
                .catch(err => setPlayerState(p => ({
                  ...p, loading: false,
                  error: `TS playback failed: ${err.message}`,
                })));
            }
          });
        } else {
          setPlayerState(p => ({
            ...p, loading: false,
            error: 'MPEG-TS direct playback not supported. Stream may need external player.',
          }));
        }
      });
  }, []);

  // ── Main play dispatcher ──────────────────────────────────────────────────
  const playStream = useCallback(async (stream: Stream) => {
    const video = videoRef.current;
    if (!video) return;

    destroyPlayer();
    currentStreamRef.current = stream;
    setPlayerState(p => ({ ...p, loading: true, error: null, playing: false, isLive: true }));
    setQualityLevels([]);
    setCurrentQuality(-1);
    setStreamInfo({ codec: '', resolution: '', bitrate: '', format: '' });
    setRetryCount(0);
    setLoadingMsg('Detecting stream type...');

    const format = detectFormat(stream);
    setStreamInfo(p => ({ ...p, format }));
    setLoadingMsg(`Loading ${format.toUpperCase()} stream...`);

    try {
      if (format === 'dash') {
        await playDASH(stream);
      } else if (format === 'ts') {
        // .ts files — try via HLS.js first (it handles TS segments natively)
        playTS(stream);
      } else if (format === 'hls') {
        playHLS(stream);
      } else {
        // Direct stream
        video.src = stream.url;
        setStreamInfo(p => ({ ...p, format: 'Direct' }));
        video.play()
          .then(() => setPlayerState(p => ({ ...p, loading: false, playing: true, error: null })))
          .catch(e => {
            // Try HLS as fallback for undetected HLS URLs
            if (Hls.isSupported()) {
              playHLS(stream);
            } else {
              setPlayerState(p => ({ ...p, loading: false, error: `Playback failed: ${e.message}` }));
            }
          });
      }
    } catch (err: any) {
      setPlayerState(p => ({ ...p, loading: false, error: `Failed: ${err.message}` }));
    }
  }, [destroyPlayer, playDASH, playHLS, playTS]);

  // Auto-play initial stream
  useEffect(() => {
    if (initialStream) {
      setCurrentStream(initialStream);
      playStream(initialStream);
    }
    return () => { destroyPlayer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Video element event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setPlayerState(p => ({ ...p, playing: true, loading: false }));
    const onPause = () => setPlayerState(p => ({ ...p, playing: false }));
    const onWaiting = () => setPlayerState(p => ({ ...p, loading: true }));
    const onCanPlay = () => setPlayerState(p => ({ ...p, loading: false }));
    const onCanPlayThrough = () => setPlayerState(p => ({ ...p, loading: false }));
    const onVolumeChange = () =>
      setPlayerState(p => ({ ...p, volume: video.volume, muted: video.muted }));
    const onTimeUpdate = () => {
      const dur = video.duration;
      const isLive = !isFinite(dur) || dur === 0;
      const buffered = video.buffered.length > 0 && dur > 0
        ? (video.buffered.end(video.buffered.length - 1) / dur) * 100 : 0;
      setPlayerState(p => ({
        ...p, currentTime: video.currentTime,
        duration: dur || 0, buffered, isLive,
      }));
    };
    const onLoadedMetadata = () => {
      const dur = video.duration;
      setPlayerState(p => ({
        ...p,
        duration: dur || 0,
        isLive: !isFinite(dur) || dur === 0,
        loading: false,
      }));
      setStreamInfo(p => ({
        ...p,
        resolution: video.videoWidth && video.videoHeight
          ? `${video.videoWidth}x${video.videoHeight}` : p.resolution,
      }));
    };
    const onEnded = () => { nextStream(); };
    const onError = () => {
      const err = video.error;
      if (!err) return;
      const msgs: Record<number, string> = {
        1: 'Playback aborted',
        2: 'Network error while loading stream',
        3: 'Media decoding error (codec not supported?)',
        4: 'Stream format not supported by this browser',
      };
      // Only show error if we're not already in loading state (which handles its own errors)
      if (!dashRef.current && !hlsRef.current) {
        setPlayerState(p => ({
          ...p, loading: false,
          error: msgs[err.code] || `Video error (code ${err.code})`,
        }));
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('canplaythrough', onCanPlayThrough);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('canplaythrough', onCanPlayThrough);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controls auto-hide
  const showControlsTemp = useCallback(() => {
    setPlayerState(p => ({ ...p, showControls: true }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPlayerState(p => (p.playing ? { ...p, showControls: false } : p));
    }, 3000);
  }, []);

  // Player controls
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    // Also for dash
    if (dashRef.current) {
      try {
        if (dashRef.current.isPaused()) dashRef.current.play();
        else dashRef.current.pause();
      } catch (_) {}
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  };

  const setVolume = (vol: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = vol;
    video.muted = vol === 0;
  };

  const seek = (pos: number) => {
    const video = videoRef.current;
    if (!video || playerState.isLive) return;
    video.currentTime = pos;
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {});
      setPlayerState(p => ({ ...p, fullscreen: true }));
    } else {
      document.exitFullscreen().catch(() => {});
      setPlayerState(p => ({ ...p, fullscreen: false }));
    }
  };

  const togglePip = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPlayerState(p => ({ ...p, pip: false }));
      } else {
        await video.requestPictureInPicture();
        setPlayerState(p => ({ ...p, pip: true }));
      }
    } catch (_) {}
  };

  const selectQuality = (index: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = index;
      setCurrentQuality(index);
    }
    if (dashRef.current) {
      try {
        dashRef.current.setQualityFor('video', index);
        setCurrentQuality(index);
      } catch (_) {}
    }
    setShowQuality(false);
  };

  const selectStream = (stream: Stream) => {
    setCurrentStream(stream);
    playStream(stream);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const nextStream = () => {
    const idx = filtered.findIndex(s => s.id === currentStream?.id);
    if (idx < filtered.length - 1) selectStream(filtered[idx + 1]);
  };

  const prevStream = () => {
    const idx = filtered.findIndex(s => s.id === currentStream?.id);
    if (idx > 0) selectStream(filtered[idx - 1]);
  };

  const retryPlayback = () => {
    if (currentStream) {
      setRetryCount(r => r + 1);
      playStream(currentStream);
    }
  };

  const formatTime = (s: number) => {
    if (!isFinite(s) || s === 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const formatBadge = (fmt: string) => {
    if (!fmt) return null;
    const colors: Record<string, string> = {
      'HLS': 'bg-green-600',
      'DASH': 'bg-purple-600',
      'DASH+CLEARKEY': 'bg-red-600',
      'MPEG-TS': 'bg-blue-600',
      'Direct': 'bg-gray-600',
      'HLS (Native)': 'bg-green-700',
      'HLS (from TS)': 'bg-teal-600',
    };
    const color = colors[fmt.toUpperCase()] || 'bg-gray-600';
    return (
      <span className={`${color} text-white text-xs px-2 py-0.5 rounded font-mono`}>
        {fmt}
      </span>
    );
  };

  const containerClass = embedded
    ? 'flex flex-col h-full bg-black'
    : 'fixed inset-0 z-50 flex flex-col bg-black';

  return (
    <div ref={containerRef} className={containerClass}>
      {/* ── Top Bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/95 border-b border-white/10 z-30 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setSidebarOpen(s => !s)}
            className="text-white p-1.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
            <span className="text-orange-400 font-bold text-sm">JASH IPTV</span>
          </div>
          {currentStream && (
            <div className="flex items-center gap-2 ml-2 min-w-0">
              {currentStream.logo && (
                <img src={currentStream.logo} alt="" className="h-6 w-6 object-contain rounded flex-shrink-0"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              )}
              <span className="text-white text-sm font-medium truncate">{currentStream.name}</span>
              {currentStream.group && (
                <span className="text-gray-400 text-xs bg-white/10 px-2 py-0.5 rounded-full flex-shrink-0 hidden sm:block">
                  {currentStream.group}
                </span>
              )}
              {streamInfo.format && formatBadge(streamInfo.format)}
              {currentStream.licenseType && (
                <span className="bg-red-600 text-white text-xs px-1.5 py-0.5 rounded flex-shrink-0">
                  🔐 {currentStream.licenseType.toUpperCase()}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => setShowInfo(s => !s)}
            className={`p-1.5 rounded transition-colors ${showInfo ? 'text-orange-400 bg-orange-500/20' : 'text-white/60 hover:text-white hover:bg-white/10'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          {onClose && (
            <button onClick={onClose}
              className="text-white/60 p-1.5 rounded hover:bg-red-500/80 hover:text-white transition-colors ml-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <div className={`${sidebarOpen ? 'w-72' : 'w-0'} transition-all duration-300 overflow-hidden flex-shrink-0 bg-gray-950 border-r border-white/10 flex flex-col z-20`}>
          <div className="p-3 border-b border-white/10 space-y-2">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input type="text" placeholder="Search channels..."
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-white/5 text-white text-xs rounded pl-8 pr-3 py-2 border border-white/10 focus:outline-none focus:border-orange-500 placeholder-gray-500" />
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
              {groups.map(g => (
                <button key={g} onClick={() => setSelectedGroup(g)}
                  className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full transition-colors ${selectedGroup === g
                    ? 'bg-orange-500 text-white' : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'}`}>
                  {g}
                </button>
              ))}
            </div>
            <div className="text-xs text-gray-500">{filtered.length} channels</div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filtered.map((stream, idx) => {
              const isActive = currentStream?.id === stream.id;
              const fmt = detectFormat(stream);
              return (
                <button key={stream.id} onClick={() => selectStream(stream)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/10 transition-colors text-left border-b border-white/5 ${isActive ? 'bg-orange-500/15 border-l-2 border-l-orange-500' : ''}`}>
                  <span className="text-xs text-gray-600 w-5 text-right flex-shrink-0">{idx + 1}</span>
                  <div className="w-7 h-7 flex-shrink-0 bg-white/5 rounded overflow-hidden flex items-center justify-center">
                    {stream.logo ? (
                      <img src={stream.logo} alt="" className="w-full h-full object-contain"
                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="text-gray-500 text-sm">📺</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs font-medium truncate ${isActive ? 'text-orange-400' : 'text-white'}`}>
                      {stream.name}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {stream.group && <span className="text-xs text-gray-600 truncate max-w-20">{stream.group}</span>}
                      {stream.licenseType && <span className="text-xs text-red-400">🔐</span>}
                      {fmt === 'dash' && <span className="text-xs text-purple-400 bg-purple-500/20 px-1 rounded">MPD</span>}
                      {fmt === 'ts' && <span className="text-xs text-blue-400 bg-blue-500/20 px-1 rounded">TS</span>}
                    </div>
                  </div>
                  {isActive && <div className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse flex-shrink-0" />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-center text-gray-600 py-12 text-sm">No channels found</div>
            )}
          </div>
        </div>

        {/* ── Player Area ──────────────────────────────────────────────── */}
        <div className="flex-1 relative bg-black flex flex-col"
          onMouseMove={showControlsTemp}
          onTouchStart={showControlsTemp}>
          <div className="flex-1 relative">
            {/* Video element */}
            <video ref={videoRef}
              className="absolute inset-0 w-full h-full object-contain"
              playsInline crossOrigin="anonymous"
              onClick={togglePlay}
              onDoubleClick={toggleFullscreen}
            />

            {/* Loading overlay */}
            {playerState.loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
                <div className="flex flex-col items-center gap-4 text-center px-4">
                  <div className="relative w-16 h-16">
                    <div className="absolute inset-0 border-4 border-orange-500/20 rounded-full" />
                    <div className="absolute inset-0 border-4 border-transparent border-t-orange-500 rounded-full animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center text-xl">📺</div>
                  </div>
                  <div>
                    <p className="text-white text-sm font-medium">{loadingMsg}</p>
                    {retryCount > 0 && (
                      <p className="text-gray-400 text-xs mt-1">Attempt #{retryCount + 1}</p>
                    )}
                  </div>
                  {streamInfo.format && (
                    <div className="flex items-center gap-2">
                      {formatBadge(streamInfo.format)}
                      {currentStream?.licenseType && (
                        <span className="text-red-400 text-xs">🔐 {currentStream.licenseType}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Error overlay */}
            {playerState.error && !playerState.loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                <div className="text-center max-w-lg px-6 py-8 bg-gray-900/90 rounded-2xl border border-red-500/20">
                  <div className="text-5xl mb-4">⚠️</div>
                  <p className="text-red-400 font-semibold mb-3 text-base">Playback Error</p>
                  <p className="text-gray-300 text-sm mb-2 whitespace-pre-line leading-relaxed">
                    {playerState.error}
                  </p>
                  {currentStream && (
                    <div className="mt-1 mb-4 text-xs text-gray-500 bg-black/40 rounded p-2 font-mono break-all">
                      {currentStream.url.slice(0, 80)}{currentStream.url.length > 80 ? '…' : ''}
                    </div>
                  )}
                  <div className="flex flex-col sm:flex-row gap-2 justify-center">
                    <button onClick={retryPlayback}
                      className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm transition-colors font-medium">
                      ↺ Retry
                    </button>
                    {currentStream && detectFormat(currentStream) !== 'hls' && (
                      <button onClick={() => { if (currentStream) { const s = { ...currentStream, streamType: undefined as any, url: currentStream.url }; playHLS(s); } }}
                        className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-lg text-sm transition-colors">
                        Try as HLS
                      </button>
                    )}
                    <a href={currentStream?.url} target="_blank" rel="noreferrer"
                      className="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-lg text-sm transition-colors text-center">
                      ↗ Open URL
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* Welcome / no stream */}
            {!currentStream && !playerState.loading && !playerState.error && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <div className="text-7xl mb-4 animate-pulse">📺</div>
                  <p className="text-white text-xl font-bold mb-2">JASH IPTV Player</p>
                  <p className="text-gray-500 text-sm mb-1">Select a channel from the list</p>
                  <p className="text-gray-600 text-xs">Supports HLS · DASH · TS · DRM ClearKey</p>
                </div>
              </div>
            )}

            {/* Stream info panel */}
            {showInfo && currentStream && (
              <div className="absolute top-3 right-3 bg-black/95 border border-white/10 rounded-xl p-4 text-xs w-72 z-20 shadow-2xl">
                <div className="font-semibold text-orange-400 mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Stream Info
                </div>
                <div className="space-y-1.5">
                  {([
                    ['Channel', currentStream.name],
                    ['Group', currentStream.group || '—'],
                    ['Format', streamInfo.format || detectFormat(currentStream).toUpperCase()],
                    ['DRM', currentStream.licenseType ? currentStream.licenseType.toUpperCase() : 'None'],
                    ...(streamInfo.resolution ? [['Resolution', streamInfo.resolution]] : []),
                    ...(streamInfo.bitrate ? [['Bitrate', streamInfo.bitrate]] : []),
                    ...(streamInfo.codec ? [['Codec', streamInfo.codec]] : []),
                    ...(qualityLevels.length > 0 ? [['Qualities', `${qualityLevels.length} levels`]] : []),
                  ] as [string, string][]).map(([label, val]) => (
                    <div key={label as string} className="flex justify-between gap-3">
                      <span className="text-gray-500">{label as string}</span>
                      <span className={`text-right truncate max-w-40 ${label === 'DRM' && val !== 'None' ? 'text-red-400' : 'text-gray-200'}`}>
                        {val as string}
                      </span>
                    </div>
                  ))}
                  <div className="border-t border-white/10 pt-2 mt-2">
                    <p className="text-gray-500 mb-1">URL</p>
                    <p className="text-gray-400 break-all text-xs leading-relaxed">
                      {currentStream.url.slice(0, 70)}{currentStream.url.length > 70 ? '…' : ''}
                    </p>
                  </div>
                  {currentStream.cookie && (
                    <div className="border-t border-white/10 pt-2">
                      <p className="text-gray-500">Cookie</p>
                      <p className="text-yellow-400 text-xs break-all mt-0.5">
                        {currentStream.cookie.slice(0, 40)}…
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Player Controls */}
            <div className={`absolute bottom-0 left-0 right-0 transition-opacity duration-300 z-10 ${playerState.showControls || !playerState.playing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <div className="bg-gradient-to-t from-black via-black/60 to-transparent p-3 pt-8">

                {/* Progress / LIVE bar */}
                {!playerState.isLive && playerState.duration > 0 ? (
                  <div className="mb-3 relative h-1 bg-white/20 rounded-full cursor-pointer group"
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      seek(((e.clientX - rect.left) / rect.width) * playerState.duration);
                    }}>
                    <div className="absolute left-0 top-0 h-full bg-white/30 rounded-full"
                      style={{ width: `${playerState.buffered}%` }} />
                    <div className="absolute left-0 top-0 h-full bg-orange-500 rounded-full transition-all"
                      style={{ width: `${(playerState.currentTime / playerState.duration) * 100}%` }} />
                    <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-orange-500 rounded-full shadow-lg opacity-0 group-hover:opacity-100 -ml-1.5 transition-opacity"
                      style={{ left: `${(playerState.currentTime / playerState.duration) * 100}%` }} />
                  </div>
                ) : (
                  <div className="mb-3 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-red-400 text-xs font-bold tracking-wider">LIVE</span>
                    {streamInfo.format && <span className="text-gray-500 text-xs">· {streamInfo.format}</span>}
                  </div>
                )}

                {/* Controls row */}
                <div className="flex items-center gap-2">
                  <button onClick={prevStream} className="text-white/60 hover:text-white p-1.5 transition-colors" title="Previous">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                    </svg>
                  </button>

                  <button onClick={togglePlay}
                    className="w-10 h-10 bg-orange-500 hover:bg-orange-600 rounded-full flex items-center justify-center transition-colors shadow-lg flex-shrink-0">
                    {playerState.playing ? (
                      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <button onClick={nextStream} className="text-white/60 hover:text-white p-1.5 transition-colors" title="Next">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z" />
                    </svg>
                  </button>

                  {/* Volume */}
                  <div className="flex items-center gap-1.5 group">
                    <button onClick={toggleMute} className="text-white/60 hover:text-white transition-colors">
                      {playerState.muted || playerState.volume === 0 ? (
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                        </svg>
                      )}
                    </button>
                    <input type="range" min={0} max={1} step={0.05}
                      value={playerState.muted ? 0 : playerState.volume}
                      onChange={e => setVolume(parseFloat(e.target.value))}
                      className="w-16 h-1 accent-orange-500 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>

                  {/* Time display */}
                  {!playerState.isLive && playerState.duration > 0 && (
                    <span className="text-white/50 text-xs hidden sm:block">
                      {formatTime(playerState.currentTime)} / {formatTime(playerState.duration)}
                    </span>
                  )}

                  <div className="flex-1" />

                  {/* Quality selector */}
                  {qualityLevels.length > 1 && (
                    <div className="relative">
                      <button onClick={() => setShowQuality(s => !s)}
                        className="text-white/60 hover:text-white text-xs bg-white/10 hover:bg-white/20 px-2 py-1 rounded transition-colors flex items-center gap-1">
                        {currentQuality === -1 ? 'AUTO' : qualityLevels[currentQuality]?.label || `Q${currentQuality}`}
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M7 10l5 5 5-5z" />
                        </svg>
                      </button>
                      {showQuality && (
                        <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 border border-white/10 rounded-lg overflow-hidden shadow-2xl backdrop-blur">
                          <div className="text-xs text-gray-500 px-3 py-1.5 border-b border-white/10">Quality</div>
                          <button onClick={() => selectQuality(-1)}
                            className={`block w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentQuality === -1 ? 'text-orange-400' : 'text-white'}`}>
                            Auto
                          </button>
                          {[...qualityLevels].reverse().map(q => (
                            <button key={q.index} onClick={() => selectQuality(q.index)}
                              className={`block w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentQuality === q.index ? 'text-orange-400' : 'text-white'}`}>
                              {q.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* PiP */}
                  {'pictureInPictureEnabled' in document && (
                    <button onClick={togglePip}
                      className={`p-1.5 rounded transition-colors ${playerState.pip ? 'text-orange-400' : 'text-white/60 hover:text-white'}`} title="Picture in Picture">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.99 2 1.99L21 21c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z" />
                      </svg>
                    </button>
                  )}

                  {/* Fullscreen */}
                  <button onClick={toggleFullscreen}
                    className="text-white/60 hover:text-white p-1.5 rounded transition-colors" title="Fullscreen">
                    {playerState.fullscreen ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default IPTVPlayer;
