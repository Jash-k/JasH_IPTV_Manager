import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import {
  Server, Copy, Check, RefreshCw, Globe, Shield, Zap,
  Terminal, ExternalLink, CheckCircle, AlertCircle, Clock,
  Database, Film, Radio, Lock, Download, Upload
} from 'lucide-react';

export default function ServerTab() {
  const { playlists, channels, drmProxies, serverUrl, setServerUrl, syncToServer } = useStore();
  const [copied, setCopied]         = useState<string | null>(null);
  const [syncing, setSyncing]       = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [serverStats, setServerStats] = useState<Record<string, unknown> | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [editUrl, setEditUrl]       = useState(serverUrl || '');

  const copyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleSync = async () => {
    if (!serverUrl) { setSyncResult({ ok: false, msg: 'Set server URL first.' }); return; }
    setSyncing(true); setSyncResult(null);
    try {
      await syncToServer();
      setSyncResult({ ok: true, msg: `✅ Synced ${channels.length} channels, ${playlists.length} playlists, ${drmProxies.length} DRM proxies.` });
      fetchStats();
    } catch (e: unknown) {
      setSyncResult({ ok: false, msg: '❌ Sync failed: ' + (e instanceof Error ? e.message : String(e)) });
    }
    setSyncing(false);
  };

  const fetchStats = async () => {
    if (!serverUrl) return;
    setStatsLoading(true);
    try {
      const r = await fetch(`${serverUrl}/api/stats`);
      if (r.ok) setServerStats(await r.json());
    } catch { setServerStats(null); }
    setStatsLoading(false);
  };

  useEffect(() => { if (serverUrl) fetchStats(); }, [serverUrl]);

  const saveUrl = () => {
    const trimmed = editUrl.trim().replace(/\/$/, '');
    setServerUrl(trimmed);
  };

  const tamilChannels = channels.filter(c => {
    const hay = `${c.name} ${c.group} ${c.language || ''}`.toLowerCase();
    return hay.includes('tamil') || hay.includes('sun tv') || hay.includes('vijay') ||
           hay.includes('zee tamil') || hay.includes('kalaignar') || hay.includes('raj tv') ||
           hay.includes('jaya') || hay.includes('polimer') || hay.includes('puthuyugam');
  });

  const stats = serverStats as {
    serverVersion?: string; uptime?: number; channels?: number;
    activeChannels?: number; tamilChannels?: number; drmChannels?: number;
    playlists?: number; sources?: number;
    playlistUrls?: { id: string; name: string; url: string; tamilOnly: boolean; channels: number; tamil: number }[];
  } | null;

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/20 rounded-xl">
            <Server className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Server & Deployment</h2>
            <p className="text-slate-400 text-sm">Full-stack IPTV server with live playlist URLs</p>
          </div>
        </div>
        <button
          onClick={fetchStats}
          disabled={statsLoading || !serverUrl}
          className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-slate-300 transition"
        >
          <RefreshCw className={`w-4 h-4 ${statsLoading ? 'animate-spin' : ''}`} />
          Refresh Stats
        </button>
      </div>

      {/* ── Server URL Config ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <Globe className="w-4 h-4 text-green-400" />
          Server URL
        </h3>
        <div className="flex gap-2">
          <input
            value={editUrl}
            onChange={e => setEditUrl(e.target.value)}
            placeholder="https://your-app.onrender.com"
            className="flex-1 bg-slate-900 text-white rounded-lg px-4 py-2 border border-slate-600 focus:border-blue-500 outline-none text-sm font-mono"
          />
          <button
            onClick={saveUrl}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm font-medium transition"
          >
            Save
          </button>
        </div>
        {serverUrl && (
          <p className="mt-2 text-green-400 text-xs font-mono">✅ {serverUrl}</p>
        )}
      </div>

      {/* ── Live Stats ── */}
      {stats && (
        <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
          <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-400" />
            Server Stats — v{stats.serverVersion}
            <span className="ml-auto text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">LIVE</span>
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Channels',    value: stats.channels,       icon: <Radio className="w-4 h-4" />,    color: 'blue'   },
              { label: 'Active',      value: stats.activeChannels, icon: <CheckCircle className="w-4 h-4" />, color: 'green' },
              { label: 'Tamil',       value: stats.tamilChannels,  icon: <Globe className="w-4 h-4" />,    color: 'orange' },
              { label: 'DRM',         value: stats.drmChannels,    icon: <Lock className="w-4 h-4" />,     color: 'purple' },
            ].map(s => (
              <div key={s.label} className="bg-slate-700/50 rounded-lg p-3 text-center">
                <div className={`text-${s.color}-400 flex justify-center mb-1`}>{s.icon}</div>
                <div className="text-2xl font-bold text-white">{s.value ?? 0}</div>
                <div className="text-slate-400 text-xs">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Playlist URLs */}
          {(stats.playlistUrls || []).length > 0 && (
            <div className="space-y-2">
              <p className="text-slate-400 text-sm font-medium">📺 Live Playlist URLs</p>
              {(stats.playlistUrls || []).map((pl) => (
                <div key={pl.id} className="flex items-center gap-2 bg-slate-700 rounded-lg p-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium">{pl.name}</p>
                    <p className="text-slate-400 text-xs font-mono truncate">{pl.url}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-xs text-blue-400">{pl.channels} channels</span>
                      {pl.tamilOnly && <span className="text-xs text-orange-400">🔶 Tamil Only</span>}
                      {pl.tamil > 0 && <span className="text-xs text-green-400">🎯 {pl.tamil} Tamil</span>}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => copyText(pl.url, `pl-${pl.id}`)}
                      className="p-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-slate-300 transition"
                      title="Copy URL"
                    >
                      {copied === `pl-${pl.id}` ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <a
                      href={pl.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-slate-300 transition"
                      title="Open"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Sync Button ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-blue-400" />
          Push Data to Server
        </h3>
        <p className="text-slate-400 text-sm mb-4">
          Sync all channels, playlists, sources, groups and DRM configs from the UI to the server.
          The server instantly generates updated M3U playlist URLs.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Channels',    value: channels.length,   color: 'blue'   },
            { label: 'Playlists',   value: playlists.length,  color: 'green'  },
            { label: 'DRM Proxies', value: drmProxies.length, color: 'purple' },
            { label: 'Tamil',       value: tamilChannels.length, color: 'orange' },
          ].map(s => (
            <div key={s.label} className="bg-slate-700/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{s.value}</div>
              <div className="text-slate-400 text-xs">{s.label}</div>
            </div>
          ))}
        </div>
        <button
          onClick={handleSync}
          disabled={syncing || !serverUrl}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-semibold transition"
        >
          {syncing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
          {syncing ? 'Syncing…' : 'Sync to Server'}
        </button>
        {syncResult && (
          <div className={`mt-3 p-3 rounded-lg text-sm ${syncResult.ok ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            {syncResult.msg}
          </div>
        )}
      </div>

      {/* ── API Quick Reference ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Terminal className="w-4 h-4 text-purple-400" />
          API Reference
        </h3>
        <div className="space-y-2">
          {[
            { method: 'GET',  path: '/api/playlist/:id.m3u',      desc: 'Live M3U playlist (use in VLC/TiviMate/Kodi)',   color: 'green'  },
            { method: 'GET',  path: '/api/playlists',             desc: 'All playlists with live URLs & channel counts',  color: 'green'  },
            { method: 'POST', path: '/api/sync',                  desc: 'Push full state from frontend to server',        color: 'blue'   },
            { method: 'GET',  path: '/proxy/redirect/:channelId', desc: 'Stream redirect (hides original URL)',            color: 'yellow' },
            { method: 'GET',  path: '/proxy/stream/:channelId',   desc: 'Full stream pipe through server',                color: 'yellow' },
            { method: 'GET',  path: '/proxy/drm/:channelId',      desc: 'DRM manifest proxy (ClearKey/Widevine)',         color: 'red'    },
            { method: 'POST', path: '/proxy/drm-license/:id',     desc: 'DRM license endpoint (ClearKey JWK / Widevine)', color: 'red'    },
            { method: 'GET',  path: '/proxy/cors?url=...',        desc: 'CORS proxy for source fetching',                 color: 'purple' },
            { method: 'GET',  path: '/api/channels?tamil=1',      desc: 'Filter Tamil channels only',                    color: 'orange' },
            { method: 'GET',  path: '/api/stats',                 desc: 'Server statistics & all playlist URLs',          color: 'slate'  },
            { method: 'GET',  path: '/api/db/export',             desc: 'Export full database as JSON',                   color: 'slate'  },
            { method: 'GET',  path: '/health',                    desc: 'Health check endpoint',                          color: 'green'  },
          ].map((ep, i) => (
            <div key={i} className="flex items-start gap-3 p-2.5 bg-slate-700/40 rounded-lg hover:bg-slate-700/70 transition">
              <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded font-mono
                ${ep.method === 'GET'  ? 'bg-green-500/20 text-green-400'  :
                  ep.method === 'POST' ? 'bg-blue-500/20  text-blue-400'   :
                  ep.method === 'PUT'  ? 'bg-yellow-500/20 text-yellow-400' :
                                         'bg-red-500/20   text-red-400'}`}>
                {ep.method}
              </span>
              <code className="text-xs text-slate-300 font-mono flex-1 break-all">{ep.path}</code>
              <span className="text-xs text-slate-500 hidden md:block">{ep.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Render Deployment Guide ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Terminal className="w-4 h-4 text-green-400" />
          Deploy to Render.com — Step by Step
        </h3>
        <div className="space-y-4">
          {[
            {
              step: '1',
              title: 'Push to GitHub',
              color: 'blue',
              code: `git init\ngit add .\ngit commit -m "feat: IPTV Manager full-stack"\ngit remote add origin https://github.com/YOUR/repo.git\ngit push -u origin main`,
            },
            {
              step: '2',
              title: 'Deploy on Render',
              color: 'purple',
              code: `1. Go to https://render.com → New → Web Service\n2. Connect your GitHub repo\n3. Render auto-detects render.yaml → Docker runtime\n4. Click "Create Web Service"\n5. Wait ~3 minutes for build + deploy`,
            },
            {
              step: '3',
              title: 'Connect Frontend to Server',
              color: 'green',
              code: `1. Copy your Render URL: https://iptv-manager-xxxx.onrender.com\n2. In the app → Server Tab → paste URL → Save\n3. Click "Sync to Server"\n4. Copy playlist URL from Live Stats`,
            },
            {
              step: '4',
              title: 'Use Playlist in Player',
              color: 'orange',
              code: `VLC:      Media → Open Network → paste M3U URL\nTiviMate: Add playlist → paste URL\nKodi:     PVR IPTV Simple Client → M3U URL\nOTT Nav:  Add playlist → URL type → paste`,
            },
          ].map((s) => (
            <div key={s.step} className={`border border-${s.color}-500/30 rounded-xl p-4 bg-${s.color}-500/5`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-7 h-7 rounded-full bg-${s.color}-500 text-white text-sm font-bold flex items-center justify-center`}>
                  {s.step}
                </span>
                <h4 className="text-white font-semibold">{s.title}</h4>
              </div>
              <div className="relative">
                <pre className="bg-slate-900 rounded-lg p-3 text-xs text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap">{s.code}</pre>
                <button
                  onClick={() => copyText(s.code, `step-${s.step}`)}
                  className="absolute top-2 right-2 p-1.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-400 transition"
                >
                  {copied === `step-${s.step}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── What Server Does ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-400" />
          How the Server Works
        </h3>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            {
              icon: <Film className="w-5 h-5 text-blue-400" />,
              title: 'Live M3U Generation',
              desc: 'Every /api/playlist/:id.m3u request generates a fresh M3U from db.json. All stream URLs are proxied through the server — original URLs are never exposed.',
            },
            {
              icon: <Shield className="w-5 h-5 text-red-400" />,
              title: 'DRM Bypass (Server-level)',
              desc: 'ClearKey: server injects license URL into DASH/HLS manifests and serves W3C ClearKey JWK JSON. Widevine/PlayReady: server forwards challenge to real license server.',
            },
            {
              icon: <Globe className="w-5 h-5 text-green-400" />,
              title: 'CORS Proxy',
              desc: 'All remote M3U/JSON sources are fetched server-side, bypassing CORS restrictions. Supports GitHub Raw, Gist, PHP endpoints, and direct M3U URLs.',
            },
            {
              icon: <Clock className="w-5 h-5 text-yellow-400" />,
              title: 'Auto-Refresh Sources',
              desc: 'Server checks every 60 seconds for sources with autoRefresh enabled. If their refresh interval has elapsed, the source is re-fetched and status updated.',
            },
            {
              icon: <Radio className="w-5 h-5 text-purple-400" />,
              title: 'Tamil Filter',
              desc: 'The server tags every channel with isTamil on sync. Use /api/channels?tamil=1 or set tamilOnly:true on a playlist to get Tamil-only M3U URLs.',
            },
            {
              icon: <Database className="w-5 h-5 text-orange-400" />,
              title: 'Persistent DB',
              desc: 'All data is stored in db.json on Render\'s persistent disk (1GB). Data survives server restarts. Export/import via /api/db/export and /api/db/import.',
            },
          ].map((f, i) => (
            <div key={i} className="flex gap-3 p-3 bg-slate-700/40 rounded-xl">
              <div className="shrink-0 p-2 bg-slate-700 rounded-lg h-fit">{f.icon}</div>
              <div>
                <p className="text-white font-medium text-sm">{f.title}</p>
                <p className="text-slate-400 text-xs mt-1 leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Player Setup ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
          <Radio className="w-4 h-4 text-blue-400" />
          Player Setup — Playlist URL Format
        </h3>
        <div className="space-y-3">
          {serverUrl && playlists.length > 0 ? (
            playlists.map(pl => {
              const url = `${serverUrl}/api/playlist/${pl.id}.m3u`;
              return (
                <div key={pl.id} className="bg-slate-700 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-medium">{pl.name}</span>
                    <div className="flex gap-1">
                      {pl.tamilOnly && <span className="text-xs bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded-full">Tamil Only</span>}
                      <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
                        {channels.filter(c => !c.group || true).length} ch
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs text-green-400 font-mono bg-slate-800 p-2 rounded-lg truncate">{url}</code>
                    <button onClick={() => copyText(url, `player-${pl.id}`)} className="p-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-slate-300 transition">
                      {copied === `player-${pl.id}` ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="p-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-slate-300 transition">
                      <Download className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-8">
              <AlertCircle className="w-10 h-10 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400 text-sm">
                {!serverUrl ? 'Set server URL above first.' : 'No playlists yet — create one in the Playlists tab.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Files Created ── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-slate-400" />
          Deployment Files in Repo
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {[
            { file: 'server.cjs',    desc: 'Express 4 backend (CommonJS — works with type:module)',  badge: 'Backend'    },
            { file: 'Dockerfile',    desc: 'Docker build: Node 20 + installs Express 4 + builds UI', badge: 'Docker'     },
            { file: 'render.yaml',   desc: 'Render.com auto-deploy config with 1GB disk',            badge: 'Render'     },
            { file: 'src/App.tsx',   desc: 'React frontend with full IPTV CRUD manager',             badge: 'Frontend'   },
            { file: '.gitignore',    desc: 'Excludes node_modules, dist, db.json, logs',             badge: 'Git'        },
            { file: 'README.md',     desc: 'Full deployment and usage documentation',                badge: 'Docs'       },
          ].map(f => (
            <div key={f.file} className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg">
              <code className="text-xs text-green-400 font-mono flex-1">{f.file}</code>
              <span className="text-xs bg-slate-600 text-slate-300 px-2 py-0.5 rounded">{f.badge}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
