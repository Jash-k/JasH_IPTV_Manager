import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

interface ServerStats {
  status?: string;
  uptime?: number;
  channels?: number;
  direct?: number;
  drm?: number;
  tamil?: number;
  multiSource?: number;
  sources?: number;
  groups?: number;
  playlists?: number;
  ts?: string;
}

export default function ServerTab() {
  const { serverUrl, setServerUrl, channels, playlists, sources, groups, drmProxies } = useStore();
  const [stats, setStats]       = useState<ServerStats | null>(null);
  const [syncing, setSyncing]   = useState(false);
  const [syncMsg, setSyncMsg]   = useState('');
  const [loading, setLoading]   = useState(false);
  const [tab, setTab]           = useState<'overview' | 'deploy' | 'api'>('overview');
  const [apiKey, setApiKey]     = useState('');
  const [copied, setCopied]     = useState('');

  const base = serverUrl.replace(/\/$/, '');

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    });
  };

  const fetchStats = async () => {
    if (!base) return;
    setLoading(true);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) setStats(await r.json());
      else setStats(null);
    } catch { setStats(null); }
    try {
      const r2 = await fetch(`${base}/api/stats`);
      if (r2.ok) {
        const d = await r2.json();
        setStats(prev => ({ ...prev, ...d }));
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { if (base) fetchStats(); }, [base]);

  const handleSync = async () => {
    if (!base) { setSyncMsg('❌ Enter server URL first'); return; }
    setSyncing(true);
    setSyncMsg('Syncing...');
    try {
      const key = apiKey || 'iptv-secret';
      const r = await fetch(`${base}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify({ channels, playlists, sources, groups, drmProxies }),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        setSyncMsg(`✅ Synced! ${d.channels} channels (${d.direct} direct, ${d.drm} DRM excluded)`);
        fetchStats();
      } else {
        setSyncMsg('❌ ' + (d.error || JSON.stringify(d)));
      }
    } catch (e: any) {
      setSyncMsg('❌ Error: ' + e.message);
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(''), 6000);
  };

  const tabCls = (t: string) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
      tab === t
        ? 'text-blue-400 border-b-2 border-blue-500 bg-slate-800/60'
        : 'text-slate-400 hover:text-slate-200'
    }`;

  const playlists_urls = [
    { label: '📺 All Channels',    url: `${base}/api/playlist/all.m3u` },
    { label: '🎬 Tamil Only',      url: `${base}/api/playlist/tamil.m3u` },
    { label: '📺 Kodi Format',     url: `${base}/api/playlist/all.m3u?kodi=1` },
    { label: '🎬 Tamil Kodi',      url: `${base}/api/playlist/tamil.m3u?kodi=1` },
  ];

  return (
    <div className="space-y-4">

      {/* ── Server URL + Sync ─────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              🚀 Server
              <span className={`text-xs px-2 py-0.5 rounded-full font-normal ${
                stats ? 'bg-green-700 text-green-200' : 'bg-slate-700 text-slate-400'
              }`}>
                {stats ? `🟢 Live · up ${Math.floor((stats.uptime||0)/60)}m` : '⚪ Offline'}
              </span>
            </h2>
            <p className="text-slate-400 text-xs mt-0.5">
              Direct streams → 302 redirect &nbsp;·&nbsp; DRM stripped &nbsp;·&nbsp; Multi-source best-link
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={fetchStats} disabled={loading}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors">
              {loading ? '⟳' : '🔄'}
            </button>
            <button onClick={handleSync} disabled={syncing || !base}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg font-medium transition-colors">
              {syncing ? 'Syncing...' : '☁️ Sync to Server'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs text-slate-400 mb-1 block">Render URL</label>
            <input
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="https://your-app.onrender.com"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">API Key</label>
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="iptv-secret (from Render env)"
              type="password"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {syncMsg && (
          <div className={`p-2.5 rounded-lg text-sm ${
            syncMsg.startsWith('✅')
              ? 'bg-green-900/40 text-green-300 border border-green-800'
              : 'bg-red-900/40 text-red-300 border border-red-800'
          }`}>
            {syncMsg}
          </div>
        )}
      </div>

      {/* ── Stats Cards ───────────────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { label: 'Total',       val: stats.channels  ?? 0, color: 'blue'   },
            { label: 'Direct',      val: stats.direct    ?? 0, color: 'green'  },
            { label: 'DRM (skip)',  val: stats.drm       ?? 0, color: 'red'    },
            { label: 'Tamil',       val: stats.tamil     ?? 0, color: 'orange' },
            { label: 'Multi-Src',   val: stats.multiSource ?? 0, color: 'purple' },
            { label: 'Sources',     val: stats.sources   ?? 0, color: 'teal'   },
            { label: 'Playlists',   val: stats.playlists ?? 0, color: 'pink'   },
          ].map(({ label, val, color }) => (
            <div key={label} className={`bg-slate-800 rounded-xl p-3 text-center border border-${color}-900/40`}>
              <div className={`text-2xl font-bold text-${color}-400`}>{val}</div>
              <div className="text-xs text-slate-400 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="flex border-b border-slate-700 px-4 pt-2 gap-1">
          {(['overview', 'deploy', 'api'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={tabCls(t)}>
              {t === 'overview' ? '📊 Overview' : t === 'deploy' ? '🚀 Deploy' : '🔌 API'}
            </button>
          ))}
        </div>

        <div className="p-5">

          {/* OVERVIEW */}
          {tab === 'overview' && (
            <div className="space-y-5">

              {/* Playlist URLs */}
              {base && (
                <div>
                  <h3 className="text-slate-300 font-semibold text-sm mb-3">📋 Playlist URLs</h3>
                  <div className="space-y-2">
                    {playlists_urls.map(({ label, url }) => (
                      <div key={url} className="bg-slate-900 rounded-lg p-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-white text-xs font-medium">{label}</div>
                          <div className="text-blue-400 text-xs truncate font-mono">{url}</div>
                        </div>
                        <button onClick={() => copyText(url, label)}
                          className={`px-3 py-1 text-xs rounded shrink-0 transition-colors ${
                            copied === label
                              ? 'bg-green-700 text-green-200'
                              : 'bg-slate-700 hover:bg-slate-600 text-white'
                          }`}>
                          {copied === label ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    ))}

                    {/* Per-playlist URLs */}
                    {playlists.length > 0 && (
                      <div className="mt-3">
                        <div className="text-slate-400 text-xs mb-2">Custom Playlists:</div>
                        {playlists.map(pl => (
                          <div key={pl.id} className="bg-slate-900 rounded-lg p-3 flex items-center gap-3 mb-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-white text-xs font-medium">{pl.name}</div>
                              <div className="text-blue-400 text-xs truncate font-mono">
                                {base}/api/playlist/{pl.id}.m3u
                              </div>
                            </div>
                            <button onClick={() => copyText(`${base}/api/playlist/${pl.id}.m3u`, pl.id)}
                              className={`px-3 py-1 text-xs rounded shrink-0 transition-colors ${
                                copied === pl.id
                                  ? 'bg-green-700 text-green-200'
                                  : 'bg-slate-700 hover:bg-slate-600 text-white'
                              }`}>
                              {copied === pl.id ? '✓ Copied' : 'Copy'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Per-source URLs */}
                    {sources.length > 0 && (
                      <div className="mt-3">
                        <div className="text-slate-400 text-xs mb-2">Per-Source Playlists:</div>
                        {sources.map(src => (
                          <div key={src.id} className="bg-slate-900 rounded-lg p-3 flex items-center gap-3 mb-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-white text-xs font-medium">{src.name}</div>
                              <div className="text-blue-400 text-xs truncate font-mono">
                                {base}/api/playlist/source/{src.id}.m3u{src.tamilFilter ? '  (Tamil ON)' : ''}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button onClick={() => copyText(`${base}/api/playlist/source/${src.id}.m3u`, src.id)}
                                className={`px-2 py-1 text-xs rounded transition-colors ${
                                  copied === src.id
                                    ? 'bg-green-700 text-green-200'
                                    : 'bg-slate-700 hover:bg-slate-600 text-white'
                                }`}>
                                {copied === src.id ? '✓' : 'Copy'}
                              </button>
                              <button onClick={() => copyText(`${base}/api/playlist/source/${src.id}/tamil.m3u`, src.id + 't')}
                                className={`px-2 py-1 text-xs rounded transition-colors ${
                                  copied === src.id + 't'
                                    ? 'bg-green-700 text-green-200'
                                    : 'bg-orange-800 hover:bg-orange-700 text-orange-200'
                                }`}>
                                🎬 Tamil
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Architecture */}
              <div>
                <h3 className="text-slate-300 font-semibold text-sm mb-3">🏗️ How It Works</h3>
                <div className="bg-slate-900 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                  <pre className="whitespace-pre">{`Player (VLC / Kodi / TiviMate / IPTV Smarters)
       │
       ▼ GET /api/playlist/all.m3u
┌──────────────────────────────────────────────────────┐
│            server.cjs  (port 10000)                  │
│                                                      │
│  Direct stream (no DRM):                             │
│  /proxy/redirect/:id  ──► 302 → original URL         │
│  (player talks directly to source — zero overhead)   │
│                                                      │
│  Direct + headers (cookie/UA/referer):               │
│  /proxy/redirect/:id  ──► transparent pipe           │
│                                                      │
│  Multi-source channel:                               │
│  /proxy/best/:name ──► HEAD all links in parallel    │
│                    ──► 302 → fastest live link        │
│                                                      │
│  DRM stream:                                         │
│  EXCLUDED from playlist — not proxied                │
│  (use Kodi + inputstream.adaptive for DRM)           │
└──────────────────────────────────────────────────────┘

💓 Keepalive: server pings /health every 14 min
   (prevents Render free tier from sleeping)
`}</pre>
                </div>
              </div>

              {!base && (
                <div className="text-center py-10 text-slate-500">
                  <div className="text-5xl mb-3">📡</div>
                  <p className="text-sm">Enter your Render URL above then click 🔄 Refresh</p>
                </div>
              )}
            </div>
          )}

          {/* DEPLOY */}
          {tab === 'deploy' && (
            <div className="space-y-4 text-sm">

              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4">
                <h4 className="text-blue-300 font-bold mb-1">🚀 Render.com — Docker Deploy</h4>
                <p className="text-blue-200 text-xs">
                  Multi-stage Docker build: <strong>3 stages</strong> with full layer caching.
                  Deps cached unless package.json changes. Build cached unless src/ changes.
                  Final image: ~120MB (no devDeps, no build tools).
                </p>
              </div>

              {/* Steps */}
              <div className="space-y-3">
                {[
                  {
                    step: '1', title: 'Push to GitHub',
                    code: 'git add . && git commit -m "iptv manager" && git push',
                  },
                  {
                    step: '2', title: 'Create Render Web Service',
                    desc: 'render.com → New → Web Service → connect GitHub repo → Runtime: Docker',
                  },
                  {
                    step: '3', title: 'render.yaml auto-detected',
                    desc: 'Render reads render.yaml → Docker build → 3-stage cached build → server starts in ~60s',
                  },
                  {
                    step: '4', title: 'Enter your URL above → Sync',
                    desc: 'Paste your Render URL → add API key from Render env vars → click ☁️ Sync',
                  },
                  {
                    step: '5', title: 'Copy playlist URL → paste into player',
                    desc: 'Overview tab → copy All Channels URL → paste into VLC / TiviMate / Kodi',
                  },
                ].map(item => (
                  <div key={item.step} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-full bg-blue-700 text-white text-xs font-bold flex items-center justify-center shrink-0">
                      {item.step}
                    </div>
                    <div>
                      <div className="text-white font-medium">{item.title}</div>
                      {item.code ? (
                        <code className="text-green-400 text-xs bg-slate-900 px-2 py-1 rounded block mt-1 font-mono">
                          {item.code}
                        </code>
                      ) : (
                        <div className="text-slate-400 text-xs mt-0.5">{item.desc}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Docker stages */}
              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold text-xs mb-3">🐳 Multi-Stage Dockerfile (fast builds)</h4>
                <div className="font-mono text-xs space-y-1">
                  {[
                    { stage: 'Stage 1: deps',    color: 'text-blue-400',   desc: 'npm install + force Express 4.21 — cached until package.json changes' },
                    { stage: 'Stage 2: builder',  color: 'text-yellow-400', desc: 'npm run build (Vite) — cached until src/ changes' },
                    { stage: 'Stage 3: runner',   color: 'text-green-400',  desc: 'Node 20 Alpine + FFmpeg + curl + tini — ~120MB, no devDeps' },
                  ].map(s => (
                    <div key={s.stage} className="flex gap-3">
                      <span className={`${s.color} shrink-0 w-36`}>{s.stage}</span>
                      <span className="text-slate-400">{s.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Startup time */}
              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold text-xs mb-2">⚡ Startup Time (Render Docker)</h4>
                <div className="space-y-1 text-xs">
                  {[
                    ['Cold start (no cache)',  '3–4 min',  'First deploy — downloads all layers'],
                    ['Warm start (deps cached)', '45–90s', 'Only src/ changed — skips npm install'],
                    ['Hot start (all cached)',  '20–40s',  'Only server.cjs changed'],
                    ['Runtime startup',         '< 2s',   'Node.js boot + DB load'],
                  ].map(([label, time, note]) => (
                    <div key={String(label)} className="flex items-center gap-2">
                      <span className="text-slate-400 w-44">{label}</span>
                      <span className="text-green-400 font-bold w-20">{time}</span>
                      <span className="text-slate-500">{note}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Optimizations */}
              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold text-xs mb-2">✅ Optimizations Applied</h4>
                <div className="space-y-1 text-xs text-slate-400">
                  {[
                    '✅ .dockerignore — excludes node_modules, dist, src/, git, logs',
                    '✅ COPY package*.json first — layer cached until deps change',
                    '✅ Multi-stage build — devDeps never shipped to production',
                    '✅ npm ci --prefer-offline — faster than npm install',
                    '✅ tini as PID 1 — proper signal handling, fast restarts',
                    '✅ Non-root user (nodejs:1001) — production security',
                    '✅ Alpine base — minimal OS (5MB vs 900MB Ubuntu)',
                    '✅ FFmpeg + curl only runtime deps — no python/make/g++',
                    '✅ Keepalive every 14min — Render free tier stays awake',
                  ].map(line => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </div>

              <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 text-xs text-amber-200">
                <strong>⚠️ Free tier note:</strong> Render free tier sleeps after 15 min of inactivity.
                The keepalive ping every 14 min prevents this. For 24/7 live IPTV use
                <strong> Starter ($7/mo)</strong> with Always On.
              </div>
            </div>
          )}

          {/* API */}
          {tab === 'api' && (
            <div className="space-y-4">
              <h4 className="text-slate-300 font-semibold text-sm">📡 Server API Reference</h4>
              <div className="space-y-2">
                {[
                  { m: 'GET',  p: '/health',                          d: 'Server health + uptime + channel count' },
                  { m: 'GET',  p: '/api/stats',                       d: 'Full stats: channels, drm, tamil, multiSource, playlists' },
                  { m: 'GET',  p: '/api/playlist/all.m3u',            d: 'All direct channels (DRM excluded)' },
                  { m: 'GET',  p: '/api/playlist/tamil.m3u',          d: 'Tamil channels only' },
                  { m: 'GET',  p: '/api/playlist/all.m3u?kodi=1',     d: 'Kodi KODIPROP + EXTVLCOPT format' },
                  { m: 'GET',  p: '/api/playlist/:id.m3u',            d: 'Custom playlist by ID (respects pinned/blocked)' },
                  { m: 'GET',  p: '/api/playlist/source/:id.m3u',     d: 'All channels from one source' },
                  { m: 'GET',  p: '/api/playlist/source/:id/tamil.m3u', d: 'Tamil channels from one source' },
                  { m: 'GET',  p: '/proxy/redirect/:id',              d: '302 redirect → original URL (or pipe if headers needed)' },
                  { m: 'GET',  p: '/proxy/best/:name',                d: 'Race all links → 302 to fastest live link' },
                  { m: 'GET',  p: '/api/bestlink/:name',              d: 'Latency-ranked results for all links of a channel' },
                  { m: 'GET',  p: '/api/health/:id',                  d: 'Single channel HEAD check → latency + status' },
                  { m: 'POST', p: '/api/health/batch',                d: 'Batch HEAD check up to 50 channels: { ids: [...] }' },
                  { m: 'GET',  p: '/proxy/cors?url=...',              d: 'Server-side CORS proxy for source fetching' },
                  { m: 'POST', p: '/api/sync',                        d: 'Push full DB from frontend (requires x-api-key header)' },
                  { m: 'GET',  p: '/api/db',                          d: 'Get full DB as JSON (requires x-api-key header)' },
                  { m: 'GET',  p: '/api/channels',                    d: 'List all channels (safe view, no URLs)' },
                  { m: 'PATCH',p: '/api/channel/:id',                 d: 'Update a single channel field' },
                  { m: 'DELETE',p: '/api/channel/:id',               d: 'Delete a channel' },
                  { m: 'GET',  p: '/api/sources',                     d: 'List all sources' },
                  { m: 'GET',  p: '/api/test/:id',                    d: 'Test upstream URL for a channel' },
                ].map(({ m, p, d }) => (
                  <div key={p} className="flex items-start gap-2 bg-slate-900 rounded-lg p-2.5">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${
                      m === 'GET'    ? 'bg-green-900 text-green-300' :
                      m === 'POST'   ? 'bg-blue-900 text-blue-300' :
                      m === 'PATCH'  ? 'bg-yellow-900 text-yellow-300' :
                      'bg-red-900 text-red-300'
                    }`}>{m}</span>
                    <span className="text-blue-300 font-mono text-xs shrink-0">{p}</span>
                    <span className="text-slate-400 text-xs">{d}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
