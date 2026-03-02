import React, { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

interface ServerStats {
  channels?: number;
  activeChannels?: number;
  tamilChannels?: number;
  drmChannels?: number;
  playlists?: number;
  sources?: number;
  serverVersion?: string;
  uptime?: number;
  playlistUrls?: Array<{ id: string; name: string; url: string; channels: number; tamil: number }>;
}

interface StreamStats {
  ffmpeg?: { available: boolean; version: string; hwAccel: string; videoCodec: string };
  sessions?: { total: number; active: number; viewers: number };
  disk?: { usageMB: number; maxMB: number };
  activeSessions?: Array<{ id: string; name: string; status: string; viewers: number; url: string }>;
}

export default function ServerTab() {
  const { serverUrl, channels, playlists, sources, groups, drmProxies, setServerUrl } = useStore();
  const [stats, setStats]             = useState<ServerStats | null>(null);
  const [streamStats, setStreamStats] = useState<StreamStats | null>(null);
  const [syncing, setSyncing]         = useState(false);
  const [syncMsg, setSyncMsg]         = useState('');
  const [loading, setLoading]         = useState(false);
  const [streamServerUrl, setStreamServerUrl] = useState('');
  const [activeTab, setActiveTab]     = useState<'overview'|'deploy'|'api'|'drm'>('overview');

  const derivedStreamUrl = serverUrl ? serverUrl.replace(':10000', ':10001').replace(/\/$/, '') : '';

  useEffect(() => {
    if (streamServerUrl === '' && derivedStreamUrl) setStreamServerUrl(derivedStreamUrl);
  }, [derivedStreamUrl]);

  const fetchStats = async () => {
    if (!serverUrl) return;
    setLoading(true);
    try {
      const r = await fetch(`${serverUrl}/api/stats`);
      if (r.ok) setStats(await r.json());
    } catch {}

    const sUrl = streamServerUrl || derivedStreamUrl;
    if (sUrl) {
      try {
        const r2 = await fetch(`${sUrl}/api/stats`);
        if (r2.ok) setStreamStats(await r2.json());
      } catch {}
    }
    setLoading(false);
  };

  useEffect(() => { fetchStats(); }, [serverUrl, streamServerUrl]);

  const handleSync = async () => {
    if (!serverUrl) { setSyncMsg('❌ Enter server URL first'); return; }
    setSyncing(true); setSyncMsg('Syncing...');
    try {
      const r = await fetch(`${serverUrl}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels, playlists, sources, groups, drmProxies }),
      });
      const d = await r.json();
      if (d.ok) {
        setSyncMsg(`✅ Synced! ch=${d.synced?.channels} pl=${d.synced?.playlists} drm=${d.synced?.drmProxies}`);
        fetchStats();
      } else setSyncMsg('❌ Sync failed: ' + JSON.stringify(d));
    } catch(e: any) { setSyncMsg('❌ Error: ' + e.message); }
    setSyncing(false);
  };

  const copyUrl = (url: string) => { navigator.clipboard.writeText(url); };

  const tabClass = (t: string) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
      activeTab === t
        ? 'border-blue-500 text-blue-400 bg-slate-800'
        : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              🚀 Full-Stack Server
              <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">Render Deploy</span>
            </h2>
            <p className="text-slate-400 text-sm mt-1">
              Main server (redirect/DRM proxy) + Streaming server (FFmpeg/HLS)
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={fetchStats} disabled={loading}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">
              {loading ? '⟳' : '🔄'} Refresh
            </button>
            <button onClick={handleSync} disabled={syncing || !serverUrl}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors disabled:opacity-50">
              {syncing ? 'Syncing...' : '☁️ Sync to Server'}
            </button>
          </div>
        </div>

        {/* Server URL inputs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Main Server URL (port 10000)</label>
            <div className="flex gap-2">
              <input
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                placeholder="https://your-app.onrender.com"
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
              />
              <div className={`px-2 py-2 rounded-lg text-xs font-bold flex items-center ${stats ? 'bg-green-900 text-green-400' : 'bg-slate-700 text-slate-400'}`}>
                {stats ? '🟢 Live' : '⚪ Off'}
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Streaming Server URL (port 10001)</label>
            <div className="flex gap-2">
              <input
                value={streamServerUrl}
                onChange={e => setStreamServerUrl(e.target.value)}
                placeholder="https://your-app.onrender.com:10001 (or separate service)"
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
              />
              <div className={`px-2 py-2 rounded-lg text-xs font-bold flex items-center ${streamStats ? 'bg-green-900 text-green-400' : 'bg-slate-700 text-slate-400'}`}>
                {streamStats ? '🟢 Live' : '⚪ Off'}
              </div>
            </div>
          </div>
        </div>

        {syncMsg && (
          <div className={`mt-3 p-2 rounded-lg text-sm ${syncMsg.startsWith('✅') ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
            {syncMsg}
          </div>
        )}
      </div>

      {/* Architecture Diagram */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-3">🏗️ Architecture</h3>
        <div className="bg-slate-900 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
          <pre>{`Player (VLC / Kodi / TiviMate / IPTV Smarters)
       │
       ▼  M3U Playlist URL
┌─────────────────────────────────────────────────────┐
│           Main Server  :10000  (server.cjs)          │
│  React UI  │  /api/*  │  /proxy/redirect/:id        │
│            │          │  /proxy/drm/:id (manifest)  │
│            │          │  /proxy/cors?url=...         │
│            │          │  /api/playlist/:id.m3u       │
└────────────┬──────────┴─────────────────────────────┘
             │  DRM channels (needs decryption)
             ▼
┌─────────────────────────────────────────────────────┐
│       DRM Streaming Server  :10001  (FFmpeg)        │
│  /stream/start/:id  →  FFmpeg → HLS segments        │
│  /hls-proxy/manifest/:id  →  Proxy M3U8 (no FFmpeg) │
│  /keys/clearkey/:id  →  W3C EME ClearKey JSON       │
│  /keys/widevine/:id  →  Widevine license proxy      │
│  /keys/playready/:id →  PlayReady SOAP proxy        │
│  /keys/info/:id      →  PSSH+KID inspector          │
└─────────────────────────────────────────────────────┘`}</pre>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="flex border-b border-slate-700 px-4 pt-3 gap-1">
          {(['overview','deploy','api','drm'] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)} className={tabClass(t)}>
              {t === 'overview' ? '📊 Overview' : t === 'deploy' ? '🚀 Deploy' : t === 'api' ? '🔌 API' : '🔐 DRM'}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              {/* Main server stats */}
              {stats ? (
                <div>
                  <h4 className="text-slate-300 font-semibold mb-2 text-sm">Main Server Stats</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {[
                      ['📺 Channels', stats.activeChannels ?? stats.channels ?? 0],
                      ['🇮🇳 Tamil', stats.tamilChannels ?? 0],
                      ['🔐 DRM', stats.drmChannels ?? 0],
                      ['📋 Playlists', stats.playlists ?? 0],
                    ].map(([label, val]) => (
                      <div key={String(label)} className="bg-slate-900 rounded-lg p-3 text-center">
                        <div className="text-lg font-bold text-white">{String(val)}</div>
                        <div className="text-xs text-slate-400">{String(label)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Playlist URLs */}
                  {stats.playlistUrls && stats.playlistUrls.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-slate-300 font-semibold text-sm">📋 Your Playlist URLs</h4>
                      {stats.playlistUrls.map(pl => (
                        <div key={pl.id} className="bg-slate-900 rounded-lg p-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-white text-sm font-medium">{pl.name}</div>
                            <div className="text-blue-400 text-xs truncate">{pl.url}</div>
                            <div className="text-slate-500 text-xs">{pl.channels} channels • {pl.tamil} Tamil</div>
                          </div>
                          <button onClick={() => copyUrl(pl.url)}
                            className="px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white text-xs rounded shrink-0">
                            📋 Copy
                          </button>
                        </div>
                      ))}
                      {/* Built-in playlists */}
                      {serverUrl && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                          {[
                            { label: 'All Channels', url: `${serverUrl}/api/playlist/all.m3u` },
                            { label: 'Tamil Only', url: `${serverUrl}/api/playlist/tamil.m3u` },
                            { label: 'Kodi (all)', url: `${serverUrl}/api/playlist/all.m3u?kodi=1` },
                            streamStats ? { label: '🎬 Stream Server (DRM)', url: `${streamServerUrl || derivedStreamUrl}/playlist/all.m3u` } : null,
                          ].filter(Boolean).map((item: any) => (
                            <div key={item.url} className="bg-slate-900 rounded-lg p-2 flex items-center justify-between gap-2">
                              <div>
                                <div className="text-slate-300 text-xs font-medium">{item.label}</div>
                                <div className="text-blue-400 text-xs truncate max-w-xs">{item.url}</div>
                              </div>
                              <button onClick={() => copyUrl(item.url)}
                                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded shrink-0">
                                Copy
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500">
                  <div className="text-4xl mb-2">📡</div>
                  <p>Enter server URL above and click Refresh</p>
                </div>
              )}

              {/* Streaming server stats */}
              {streamStats && (
                <div>
                  <h4 className="text-slate-300 font-semibold mb-2 text-sm">🎬 Streaming Server (FFmpeg)</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                    {[
                      ['🎬 FFmpeg', streamStats.ffmpeg?.available ? '✅ '+streamStats.ffmpeg.version : '❌ Missing'],
                      ['📡 Active', `${streamStats.sessions?.active ?? 0} sessions`],
                      ['👁️ Viewers', streamStats.sessions?.viewers ?? 0],
                      ['💾 Disk', `${streamStats.disk?.usageMB ?? 0} MB`],
                    ].map(([label, val]) => (
                      <div key={String(label)} className="bg-slate-900 rounded-lg p-3 text-center">
                        <div className="text-sm font-bold text-white truncate">{String(val)}</div>
                        <div className="text-xs text-slate-400">{String(label)}</div>
                      </div>
                    ))}
                  </div>

                  {streamStats.activeSessions && streamStats.activeSessions.length > 0 && (
                    <div className="space-y-1">
                      <h5 className="text-slate-400 text-xs font-medium">Active Streaming Sessions:</h5>
                      {streamStats.activeSessions.map(s => (
                        <div key={s.id} className="bg-slate-900 rounded p-2 flex items-center justify-between text-xs">
                          <span className="text-slate-300">{s.name}</span>
                          <span className={`px-2 py-0.5 rounded ${s.status==='running' ? 'bg-green-900 text-green-400' : 'bg-yellow-900 text-yellow-400'}`}>
                            {s.status} · {s.viewers} viewers
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* DEPLOY TAB */}
          {activeTab === 'deploy' && (
            <div className="space-y-4 text-sm">
              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4">
                <h4 className="text-blue-300 font-bold mb-2">🚀 Render.com Deployment</h4>
                <p className="text-blue-200 text-xs">
                  Both servers run inside one Docker container via <strong>supervisord</strong>.
                  One Render service hosts both ports (10000 + 10001).
                </p>
              </div>

              <div className="space-y-3">
                {[
                  { step: '1', title: 'Push to GitHub', desc: 'git add . && git commit -m "iptv manager" && git push', code: true },
                  { step: '2', title: 'Create Render Service', desc: 'render.com → New → Web Service → connect your repo → Runtime: Docker' },
                  { step: '3', title: 'Auto-detected config', desc: 'render.yaml is auto-read → Docker build runs → both servers start via supervisord' },
                  { step: '4', title: 'Sync your data', desc: 'Enter your Render URL above → click ☁️ Sync to Server' },
                  { step: '5', title: 'Get your playlist URL', desc: 'Copy from Overview tab → paste into VLC/TiviMate/Kodi' },
                ].map(item => (
                  <div key={item.step} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-full bg-blue-700 text-white text-xs font-bold flex items-center justify-center shrink-0">
                      {item.step}
                    </div>
                    <div>
                      <div className="text-white font-medium">{item.title}</div>
                      {item.code ? (
                        <code className="text-green-400 text-xs bg-slate-900 px-2 py-1 rounded block mt-1">{item.desc}</code>
                      ) : (
                        <div className="text-slate-400 text-xs mt-0.5">{item.desc}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold mb-2 text-xs">📁 Files Created for Deployment</h4>
                <div className="space-y-1 font-mono text-xs">
                  {[
                    ['Dockerfile', 'Docker image — Node 20 + FFmpeg + both servers'],
                    ['supervisord.conf', 'Runs main-server (10000) + streaming-server (10001)'],
                    ['render.yaml', 'Render auto-deploy config — Docker runtime + 5GB disk'],
                    ['server.cjs', 'Main API: playlist/redirect/DRM proxy/sync'],
                    ['streaming-server/server.js', 'FFmpeg HLS server: ClearKey/Widevine/PlayReady'],
                    ['streaming-server/src/transcoder.js', 'FFmpeg session manager + DRM resolver'],
                    ['streaming-server/src/drmHandler.js', 'PSSH parser + license fetcher'],
                    ['streaming-server/src/hlsManager.js', 'HLS playlist rewriter + segment proxy'],
                    ['streaming-server/src/routes/stream.js', 'Stream start/stop/status routes'],
                    ['streaming-server/src/routes/keys.js', 'License endpoints: ClearKey/WV/PR/FP'],
                  ].map(([file, desc]) => (
                    <div key={file} className="flex gap-2">
                      <span className="text-green-400 shrink-0">✓</span>
                      <span className="text-blue-300">{file}</span>
                      <span className="text-slate-500 hidden md:block">— {desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 text-xs text-amber-200">
                <strong>⚠️ Note on Render free tier:</strong> Free services sleep after 15min inactivity.
                For live IPTV, use <strong>Starter ($7/mo)</strong> plan with Always On enabled.
                FFmpeg transcoding is CPU-intensive — use <strong>Standard plan</strong> for DRM streams.
              </div>

              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold mb-2 text-xs">🔧 Environment Variables (render.yaml)</h4>
                <div className="font-mono text-xs space-y-1 text-slate-300">
                  {[
                    ['PORT', '10000', 'Main server port'],
                    ['STREAM_PORT', '10001', 'Streaming server port'],
                    ['DB_FILE', '/data/db/db.json', 'Persistent database'],
                    ['OUTPUT_DIR', '/data/hls-output', 'HLS segment storage'],
                    ['VIDEO_CODEC', 'copy', '"copy" = stream copy (no re-encode, fastest)'],
                    ['AUDIO_CODEC', 'copy', '"copy" = pass-through audio'],
                    ['HLS_SEGMENT_TIME', '4', 'Segment duration in seconds'],
                    ['HW_ACCEL', 'none', '"vaapi" or "nvenc" for GPU (if available)'],
                    ['CLEARKEY_PAIRS', '', 'Default kid:key pairs (comma separated)'],
                  ].map(([key, val, desc]) => (
                    <div key={key} className="grid grid-cols-3 gap-2">
                      <span className="text-blue-300">{key}</span>
                      <span className="text-green-400">{val}</span>
                      <span className="text-slate-500 truncate"># {desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* API TAB */}
          {activeTab === 'api' && (
            <div className="space-y-4 text-sm">
              <div className="space-y-3">
                <h4 className="text-slate-300 font-semibold">Main Server API <span className="text-slate-500 text-xs">:10000</span></h4>
                {[
                  ['GET', '/api/playlist/:id.m3u', 'Your custom playlist (auto-updates)'],
                  ['GET', '/api/playlist/all.m3u', 'All channels'],
                  ['GET', '/api/playlist/tamil.m3u', 'Tamil channels only'],
                  ['GET', '/api/playlist/all.m3u?kodi=1', 'Kodi KODIPROP format'],
                  ['GET', '/proxy/redirect/:id', 'Redirect to original stream with spoofed headers'],
                  ['GET', '/proxy/drm/:id', 'Fetch + rewrite DRM manifest (MPD/HLS)'],
                  ['POST', '/proxy/drm-license/:id', 'DRM license endpoint (ClearKey/WV/PR)'],
                  ['GET', '/proxy/cors?url=...', 'CORS proxy for any URL'],
                  ['POST', '/api/sync', 'Sync frontend data to server DB'],
                  ['GET', '/api/drm/pssh/:id', 'Extract PSSH + KIDs from channel manifest'],
                  ['GET', '/api/db/export', 'Export full DB as JSON'],
                  ['POST', '/api/db/import', 'Import DB from JSON'],
                ].map(([method, path, desc]) => (
                  <div key={path} className="flex items-start gap-2 bg-slate-900 rounded p-2">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${
                      method==='GET' ? 'bg-green-900 text-green-300' : 'bg-blue-900 text-blue-300'
                    }`}>{method}</span>
                    <span className="text-blue-300 font-mono text-xs shrink-0">{path}</span>
                    <span className="text-slate-400 text-xs">{desc}</span>
                  </div>
                ))}

                <h4 className="text-slate-300 font-semibold mt-4">Streaming Server API <span className="text-slate-500 text-xs">:10001</span></h4>
                {[
                  ['GET', '/stream/start/:channelId', 'Start FFmpeg session → redirect to HLS'],
                  ['GET', '/stream/:sessionId/master.m3u8', 'Live HLS playlist (FFmpeg output)'],
                  ['GET', '/stream/:sessionId/seg00001.ts', 'HLS segment file'],
                  ['GET', '/stream/key/:channelId', 'AES-128 key for HLS decryption'],
                  ['POST', '/stream/stop/:channelId', 'Stop FFmpeg transcoding'],
                  ['GET', '/stream/sessions', 'All active streaming sessions'],
                  ['GET', '/hls-proxy/manifest/:id?url=...', 'Proxy remote M3U8 (no FFmpeg)'],
                  ['GET', '/hls-proxy/seg/:id?url=...', 'Proxy remote TS segment'],
                  ['GET', '/hls-proxy/key/:id?url=...', 'Proxy remote AES key'],
                  ['POST', '/keys/clearkey/:id', 'ClearKey W3C EME license'],
                  ['POST', '/keys/widevine/:id', 'Widevine binary license proxy'],
                  ['POST', '/keys/playready/:id', 'PlayReady SOAP license proxy'],
                  ['POST', '/keys/fairplay/:id', 'FairPlay SPC→CKC proxy'],
                  ['GET', '/keys/info/:channelId', 'PSSH + KID inspector'],
                  ['GET', '/playlist/all.m3u', 'All channels via streaming server'],
                  ['GET', '/playlist/tamil.m3u', 'Tamil channels via streaming server'],
                ].map(([method, path, desc]) => (
                  <div key={path} className="flex items-start gap-2 bg-slate-900 rounded p-2">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${
                      method==='GET' ? 'bg-green-900 text-green-300' : 'bg-blue-900 text-blue-300'
                    }`}>{method}</span>
                    <span className="text-blue-300 font-mono text-xs shrink-0">{path}</span>
                    <span className="text-slate-400 text-xs">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* DRM TAB */}
          {activeTab === 'drm' && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  {
                    type: 'ClearKey / JioTV',
                    icon: '🔑',
                    color: 'green',
                    desc: 'AES-128 / SAMPLE-AES-CTR. Inline kid:key pairs or license server.',
                    how: [
                      'Parse kid:key from source (JioTV: drmLicense field)',
                      'FFmpeg -decryption_key for ClearKey HLS',
                      'W3C EME JSON response for browser EME',
                      'EXT-X-KEY injection in HLS output',
                      'ContentProtection in MPD output',
                    ],
                    endpoint: '/keys/clearkey/:id',
                    kodiprop: 'inputstream.adaptive.license_type=clearkey',
                  },
                  {
                    type: 'Widevine',
                    icon: '🔒',
                    color: 'purple',
                    desc: 'Binary protobuf challenge forwarded to real license server.',
                    how: [
                      'Extract PSSH box from MPD/HLS manifest',
                      'Parse KIDs from ContentProtection',
                      'Forward binary challenge to license URL',
                      'Inject dashif:Laurl into MPD manifest',
                      'Kodi CDM handles actual decryption',
                    ],
                    endpoint: '/keys/widevine/:id',
                    kodiprop: 'inputstream.adaptive.license_type=com.widevine.alpha',
                  },
                  {
                    type: 'PlayReady',
                    icon: '🛡️',
                    color: 'blue',
                    desc: 'SOAP XML challenge forwarded to PlayReady license server.',
                    how: [
                      'Parse PRO header from MPD',
                      'Extract LA_URL from PRO XML (UTF-16LE)',
                      'Forward SOAP XML challenge to LA_URL',
                      'Inject mspr:la_url into MPD manifest',
                    ],
                    endpoint: '/keys/playready/:id',
                    kodiprop: 'inputstream.adaptive.license_type=com.microsoft.playready',
                  },
                  {
                    type: 'FairPlay',
                    icon: '🍎',
                    color: 'orange',
                    desc: 'SPC (Server Playback Context) to CKC (Content Key Context) proxy.',
                    how: [
                      'Apple HLS FairPlay streaming',
                      'Forward SPC to certificate/license URL',
                      'Return CKC to player',
                    ],
                    endpoint: '/keys/fairplay/:id',
                    kodiprop: 'inputstream.adaptive.license_type=com.apple.fps',
                  },
                ].map(drmt => (
                  <div key={drmt.type} className={`bg-slate-900 rounded-xl p-4 border border-${drmt.color}-900`}>
                    <h4 className="text-white font-semibold mb-1">{drmt.icon} {drmt.type}</h4>
                    <p className="text-slate-400 text-xs mb-2">{drmt.desc}</p>
                    <ul className="space-y-0.5 mb-2">
                      {drmt.how.map(h => (
                        <li key={h} className="text-xs text-slate-400 flex gap-1">
                          <span className="text-green-500">›</span>{h}
                        </li>
                      ))}
                    </ul>
                    <code className="text-xs bg-slate-800 text-blue-300 px-2 py-1 rounded block">
                      POST {drmt.endpoint}
                    </code>
                    <code className="text-xs bg-slate-800 text-yellow-300 px-2 py-1 rounded block mt-1">
                      #KODIPROP:{drmt.kodiprop}
                    </code>
                  </div>
                ))}
              </div>

              <div className="bg-slate-900 rounded-xl p-4">
                <h4 className="text-slate-300 font-semibold mb-2">🎬 FFmpeg DRM Decryption Flow</h4>
                <div className="font-mono text-xs text-slate-300 space-y-1">
                  <div className="text-slate-500"># ClearKey/JioTV — FFmpeg decrypts, outputs clear HLS</div>
                  <div className="text-green-400">ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto \</div>
                  <div className="text-green-400">  -decryption_key &lt;32-hex-key&gt; \</div>
                  <div className="text-green-400">  -i &lt;drm-stream-url&gt; \</div>
                  <div className="text-green-400">  -c copy \</div>
                  <div className="text-green-400">  -hls_key_info_file enc.keyinfo \  &lt;-- re-encrypt output</div>
                  <div className="text-green-400">  -f hls output/master.m3u8</div>
                  <div className="mt-2 text-slate-500"># Output: AES-128 encrypted HLS (universally playable)</div>
                  <div className="mt-1 text-slate-500"># Widevine/PlayReady: manifest rewriting only</div>
                  <div className="text-slate-500"># (server-side WV decryption requires licensed CDM)</div>
                </div>
              </div>

              <div className="bg-slate-900 rounded-xl p-4">
                <h4 className="text-slate-300 font-semibold mb-2">🔍 PSSH Inspector</h4>
                <p className="text-slate-400 text-xs mb-2">
                  Check PSSH boxes and KIDs for any channel's manifest:
                </p>
                {serverUrl ? (
                  <a href={`${serverUrl}/api/drm/pssh/CHANNEL_ID`} target="_blank" rel="noreferrer"
                    className="text-blue-400 text-xs underline">
                    {serverUrl}/api/drm/pssh/CHANNEL_ID
                  </a>
                ) : (
                  <code className="text-blue-400 text-xs">GET /api/drm/pssh/:channelId</code>
                )}
                <div className="mt-2 text-xs text-slate-400">
                  Returns: systemId, drmType (widevine/clearkey/playready), KIDs[], psshBase64
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
