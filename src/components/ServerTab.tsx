import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ServerStats {
  status?    : string;
  uptime?    : number;
  channels?  : number;   // plain number from /health
  direct?    : number;
  drm?       : number;
  tamil?     : number;
  multiSource?: number;
  sources?   : number;
  playlists? : number;
  groups?    : number;
  keepalive? : boolean;
  version?   : string;
  ts?        : string;
}

type SubTab = 'overview' | 'urls' | 'deploy' | 'api';

// Safe primitive renderer — converts ANYTHING to a safe string/number for JSX
function n(v: unknown, fallback = 0): number {
  const num = Number(v);
  return isNaN(num) ? fallback : num;
}
function s(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return fallback; // ← prevents React error #31
  return String(v);
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, val, color }: { label: string; val: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue:   'text-blue-400   border-blue-500/20   bg-blue-500/5',
    green:  'text-green-400  border-green-500/20  bg-green-500/5',
    orange: 'text-orange-400 border-orange-500/20 bg-orange-500/5',
    purple: 'text-purple-400 border-purple-500/20 bg-purple-500/5',
    teal:   'text-teal-400   border-teal-500/20   bg-teal-500/5',
    pink:   'text-pink-400   border-pink-500/20   bg-pink-500/5',
  };
  const cls = colorMap[color] || colorMap.blue;
  return (
    <div className={`rounded-xl p-3 text-center border ${cls}`}>
      <div className={`text-2xl font-bold ${cls.split(' ')[0]}`}>{val.toLocaleString()}</div>
      <div className="text-xs text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

// ── URL row ───────────────────────────────────────────────────────────────────
function UrlRow({
  label, url, copied, onCopy,
}: {
  label: string; url: string; copied: string;
  onCopy: (url: string, label: string) => void;
}) {
  return (
    <div className="bg-slate-900 rounded-lg p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-slate-300 text-xs font-medium">{label}</div>
        <div className="text-blue-400 text-xs font-mono truncate mt-0.5">{url}</div>
      </div>
      <button
        onClick={() => onCopy(url, label)}
        className={`px-3 py-1 text-xs rounded shrink-0 transition-colors ${
          copied === label
            ? 'bg-green-700 text-green-200'
            : 'bg-slate-700 hover:bg-slate-600 text-white'
        }`}
      >
        {copied === label ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ServerTab() {
  // Pull from store with safe fallbacks — never trust raw values
  const storeServerUrl  = useStore(st => st.serverUrl);
  const setServerUrl    = useStore(st => st.setServerUrl);
  const storeChannels   = useStore(st => st.channels);
  const storePlaylists  = useStore(st => st.playlists);
  const storeSources    = useStore(st => st.sources);

  const channels  = Array.isArray(storeChannels)  ? storeChannels  : [];
  const playlists = Array.isArray(storePlaylists)  ? storePlaylists : [];
  const sources   = Array.isArray(storeSources)    ? storeSources   : [];

  const serverUrl = typeof storeServerUrl === 'string' ? storeServerUrl : '';
  const base      = serverUrl.replace(/\/$/, '');

  const [stats,   setStats]   = useState<ServerStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [subTab,  setSubTab]  = useState<SubTab>('overview');
  const [apiKey,  setApiKey]  = useState('iptv-secret');
  const [copied,  setCopied]  = useState('');
  const [error,   setError]   = useState('');

  // ── Fetch server stats ─────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    setError('');
    setStats(null);
    try {
      const r = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const raw = await r.json() as Record<string, unknown>;
        // Normalise — ensure channels is always a number, never an object
        const normalised: ServerStats = {
          status:      s(raw.status, 'ok'),
          uptime:      n(raw.uptime),
          // Handle legacy { total, direct, drm } shape OR plain number
          channels:    typeof raw.channels === 'object' && raw.channels !== null
                         ? n((raw.channels as Record<string, unknown>).total)
                         : n(raw.channels),
          direct:      typeof raw.channels === 'object' && raw.channels !== null
                         ? n((raw.channels as Record<string, unknown>).direct)
                         : n(raw.direct),
          drm:         n(raw.drm),
          tamil:       n(raw.tamil),
          multiSource: n(raw.multiSource),
          sources:     n(raw.sources),
          playlists:   n(raw.playlists),
          groups:      n(raw.groups),
          keepalive:   raw.keepalive === true,
          version:     s(raw.version, '1.0'),
          ts:          s(raw.ts),
        };
        setStats(normalised);
      } else {
        setError(`Server returned HTTP ${r.status}`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Cannot reach server');
    }
    setLoading(false);
  }, [base]);

  useEffect(() => {
    if (base) fetchStats();
  }, [base, fetchStats]);

  // ── Sync to server ─────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (!base) { setSyncMsg('❌ Enter server URL first'); return; }
    setSyncing(true);
    setSyncMsg('⏳ Syncing...');
    try {
      const payload = {
        channels,
        playlists,
        sources,
        groups: [],
      };
      const r = await fetch(`${base}/api/sync`, {
        method : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key'   : apiKey || 'iptv-secret',
        },
        body  : JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      const raw = await r.json() as Record<string, unknown>;
      if (r.ok && raw.success) {
        setSyncMsg(
          `✅ Synced! ${n(raw.channels)} channels · ${n(raw.direct)} direct · ${n(raw.tamil)} Tamil`
        );
        fetchStats();
      } else {
        setSyncMsg('❌ ' + s(raw.error || JSON.stringify(raw)));
      }
    } catch (e: unknown) {
      setSyncMsg('❌ ' + (e instanceof Error ? e.message : 'Sync failed'));
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(''), 8000);
  };

  // ── Copy helper ────────────────────────────────────────────────────────────
  const copy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    }).catch(() => {});
  }, []);

  // ── Derived values — always safe numbers ───────────────────────────────────
  const statChannels   = stats ? n(stats.channels)   : channels.length;
  const statDirect     = stats ? n(stats.direct)      : channels.length;
  const statTamil      = stats ? n(stats.tamil)       : channels.filter(c => c.isTamil).length;
  const statMulti      = stats ? n(stats.multiSource) : 0;
  const statSources    = stats ? n(stats.sources)     : sources.length;
  const statPlaylists  = stats ? n(stats.playlists)   : playlists.length;
  const statUptime     = stats ? n(stats.uptime)      : 0;

  const isLive   = stats !== null;
  const statusBadge = isLive
    ? `🟢 Live · up ${Math.floor(statUptime / 60)}m`
    : base ? '🔴 Offline' : '⚪ No URL';
  const statusCls = isLive
    ? 'bg-green-800 text-green-200'
    : base ? 'bg-red-900 text-red-300' : 'bg-slate-700 text-slate-400';

  const subTabCls = (t: SubTab) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
      subTab === t
        ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-500'
        : 'text-slate-400 hover:text-slate-200'
    }`;

  // Playlist URLs
  const allM3u   = `${base}/api/playlist/all.m3u`;
  const tamilM3u = `${base}/api/playlist/tamil.m3u`;
  const kodiM3u  = `${base}/api/playlist/all.m3u?kodi=1`;

  return (
    <div className="space-y-4">

      {/* ── Server URL + Sync ─────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2 flex-wrap">
              🚀 Server
              <span className={`text-xs px-2 py-0.5 rounded-full font-normal ${statusCls}`}>
                {statusBadge}
              </span>
            </h2>
            <p className="text-slate-400 text-xs mt-0.5">
              Direct 302 redirect · DRM stripped · Multi-source best-link · Keepalive ✓
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={fetchStats}
              disabled={loading || !base}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
            >
              {loading ? '⟳' : '🔄 Refresh'}
            </button>
            <button
              onClick={handleSync}
              disabled={syncing || !base}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg font-semibold transition-colors"
            >
              {syncing ? '⏳ Syncing…' : '☁️ Sync to Server'}
            </button>
          </div>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs text-slate-400 mb-1 block">Render URL</label>
            <input
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="https://your-app.onrender.com"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">API Key</label>
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="iptv-secret"
              type="password"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Messages */}
        {syncMsg && (
          <div className={`p-2.5 rounded-lg text-sm ${
            syncMsg.startsWith('✅')
              ? 'bg-green-900/40 text-green-300 border border-green-800'
              : syncMsg.startsWith('⏳')
              ? 'bg-blue-900/40 text-blue-300 border border-blue-800'
              : 'bg-red-900/40 text-red-300 border border-red-800'
          }`}>{syncMsg}</div>
        )}
        {error && !isLive && (
          <div className="p-2.5 rounded-lg text-sm bg-yellow-900/30 text-yellow-300 border border-yellow-800">
            ⚠️ {error} — Is the server running? Check your Render URL above.
          </div>
        )}
      </div>

      {/* ── Stat Cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        <StatCard label="Channels"  val={statChannels}  color="blue"   />
        <StatCard label="Direct"    val={statDirect}    color="green"  />
        <StatCard label="Tamil 🎬"  val={statTamil}     color="orange" />
        <StatCard label="Multi-Src" val={statMulti}     color="purple" />
        <StatCard label="Sources"   val={statSources}   color="teal"   />
        <StatCard label="Playlists" val={statPlaylists} color="pink"   />
      </div>

      {/* ── Sub Tabs ─────────────────────────────────────────────────────── */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">

        {/* Tab bar */}
        <div className="flex border-b border-slate-700 px-3 pt-2 gap-1 overflow-x-auto">
          {(['overview', 'urls', 'deploy', 'api'] as SubTab[]).map(t => (
            <button key={t} onClick={() => setSubTab(t)} className={subTabCls(t)}>
              {t === 'overview' ? '📊 Overview'
                : t === 'urls'  ? '📋 Playlist URLs'
                : t === 'deploy'? '🚀 Deploy'
                : '🔌 API Docs'}
            </button>
          ))}
        </div>

        <div className="p-5">

          {/* ── OVERVIEW ────────────────────────────────────────────────── */}
          {subTab === 'overview' && (
            <div className="space-y-5">
              {!base ? (
                <div className="text-center py-12 text-slate-500">
                  <div className="text-6xl mb-3">📡</div>
                  <p className="text-sm font-medium text-slate-400">Enter your Render URL above</p>
                  <p className="text-xs mt-1">Then click ☁️ Sync to Server to push your channels</p>
                </div>
              ) : (
                <>
                  {/* Architecture */}
                  <div>
                    <h3 className="text-slate-300 font-semibold text-sm mb-3">🏗️ Architecture</h3>
                    <div className="bg-slate-900 rounded-lg p-4 font-mono text-xs text-slate-300 overflow-x-auto">
                      <pre className="whitespace-pre leading-relaxed">{`Player (VLC / Kodi / TiviMate / IPTV Smarters)
       │
       ▼  GET /api/playlist/all.m3u
┌────────────────────────────────────────────────────┐
│      server.cjs  (Render · port 10000)             │
│                                                    │
│  ① Direct stream (no auth headers):               │
│     GET /redirect/:id                              │
│     └─► 302 → original URL (zero server load)     │
│                                                    │
│  ② Multi-source same channel name:                │
│     GET /redirect/best/:name                       │
│     └─► HEAD race all links → 302 to fastest      │
│                                                    │
│  ③ DRM streams:                                   │
│     EXCLUDED — stripped at import, never stored   │
│                                                    │
│  💓 Keepalive: ping /health every 14 min          │
└────────────────────────────────────────────────────┘`}</pre>
                    </div>
                  </div>

                  {/* Quick links */}
                  <div>
                    <h3 className="text-slate-300 font-semibold text-sm mb-3">⚡ Quick Playlist Links</h3>
                    <div className="space-y-2">
                      {[
                        { label: '📺 All Channels',  url: allM3u   },
                        { label: '🎬 Tamil Only',    url: tamilM3u },
                        { label: '📺 Kodi Format',   url: kodiM3u  },
                      ].map(({ label, url }) => (
                        <UrlRow key={url} label={label} url={url} copied={copied} onCopy={copy} />
                      ))}
                    </div>
                  </div>

                  {/* Server info */}
                  {isLive && (
                    <div>
                      <h3 className="text-slate-300 font-semibold text-sm mb-3">ℹ️ Server Info</h3>
                      <div className="bg-slate-900 rounded-lg p-4 grid grid-cols-2 gap-3 text-xs">
                        {[
                          ['Status',     '🟢 Live'],
                          ['Version',    s(stats?.version, '1.0')],
                          ['Uptime',     `${Math.floor(statUptime / 60)}m ${statUptime % 60}s`],
                          ['Channels',   String(statChannels)],
                          ['Tamil',      String(statTamil)],
                          ['Keepalive',  stats?.keepalive ? '✅ Active (14 min)' : '—'],
                        ].map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-slate-500">{k}</span>
                            <span className="text-slate-200 font-medium">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── PLAYLIST URLS ────────────────────────────────────────────── */}
          {subTab === 'urls' && (
            <div className="space-y-4">
              <h3 className="text-slate-300 font-semibold text-sm">📋 All Playlist URLs</h3>

              {/* Global */}
              <div>
                <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Global</p>
                <div className="space-y-2">
                  {[
                    { label: '📺 All Channels',       url: `${base}/api/playlist/all.m3u` },
                    { label: '🎬 Tamil Only',          url: `${base}/api/playlist/tamil.m3u` },
                    { label: '📺 All (Kodi format)',   url: `${base}/api/playlist/all.m3u?kodi=1` },
                    { label: '🎬 Tamil (Kodi format)', url: `${base}/api/playlist/tamil.m3u?kodi=1` },
                  ].map(({ label, url }) => (
                    <UrlRow key={url} label={label} url={url} copied={copied} onCopy={copy} />
                  ))}
                </div>
              </div>

              {/* Custom playlists */}
              {playlists.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">
                    Custom Playlists ({playlists.length})
                  </p>
                  <div className="space-y-2">
                    {playlists.map(pl => (
                      <UrlRow
                        key={pl.id}
                        label={`📋 ${s(pl.name)}${pl.tamilOnly ? ' (Tamil)' : ''}`}
                        url={`${base}/api/playlist/${pl.id}.m3u`}
                        copied={copied}
                        onCopy={copy}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Per-source */}
              {sources.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">
                    Per Source ({sources.length})
                  </p>
                  <div className="space-y-2">
                    {sources.map(src => (
                      <div key={src.id} className="space-y-1">
                        <UrlRow
                          label={`📡 ${s(src.name)}`}
                          url={`${base}/api/playlist/source/${src.id}.m3u`}
                          copied={copied}
                          onCopy={copy}
                        />
                        {(src.tamilCount ?? 0) > 0 && (
                          <UrlRow
                            label={`🎬 ${s(src.name)} (Tamil only)`}
                            url={`${base}/api/playlist/source/${src.id}/tamil.m3u`}
                            copied={copied}
                            onCopy={copy}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!base && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  Enter server URL above to generate playlist URLs
                </div>
              )}
            </div>
          )}

          {/* ── DEPLOY ──────────────────────────────────────────────────── */}
          {subTab === 'deploy' && (
            <div className="space-y-4 text-sm">

              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-4">
                <h4 className="text-blue-300 font-bold mb-1">🐳 Docker → Render.com</h4>
                <p className="text-blue-200 text-xs leading-relaxed">
                  Multi-stage Docker build with full layer caching.
                  <strong> Stage 1</strong> (npm ci) cached until package.json changes.
                  <strong> Stage 2</strong> (Vite build) cached until src/ changes.
                  <strong> Stage 3</strong> alpine runner ~120MB — no devDeps.
                </p>
              </div>

              <div className="space-y-3">
                {[
                  { n: '1', title: 'Push to GitHub',
                    code: 'git add . && git commit -m "iptv manager" && git push' },
                  { n: '2', title: 'Create Web Service on Render',
                    desc: 'render.com → New → Web Service → Connect GitHub → Runtime: Docker' },
                  { n: '3', title: 'render.yaml is auto-detected',
                    desc: '3-stage Docker build → server.cjs on port 10000 in ~60–90s' },
                  { n: '4', title: 'Set API_KEY in Render Dashboard',
                    code: 'API_KEY=your-secret  (Environment → Add env var)' },
                  { n: '5', title: 'Enter URL + Sync',
                    desc: 'Paste Render URL above → enter API key → ☁️ Sync to Server' },
                  { n: '6', title: 'Copy Playlist URL → Player',
                    desc: 'Playlist URLs tab → copy → paste into VLC / TiviMate / Kodi / IPTV Smarters' },
                ].map(item => (
                  <div key={item.n} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-full bg-blue-700 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {item.n}
                    </div>
                    <div className="flex-1">
                      <div className="text-white font-medium text-sm">{item.title}</div>
                      {item.code ? (
                        <code className="text-green-400 text-xs bg-slate-900 px-3 py-1.5 rounded block mt-1 font-mono break-all">
                          {item.code}
                        </code>
                      ) : (
                        <div className="text-slate-400 text-xs mt-0.5">{item.desc}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Build times */}
              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold text-xs mb-3 uppercase tracking-wider">
                  ⚡ Build Time (with Docker layer caching)
                </h4>
                <div className="space-y-2">
                  {[
                    { when: 'First deploy',           time: '3–4 min',  note: 'Downloads all Docker layers' },
                    { when: 'src/ changed',            time: '45–90s',   note: 'npm install cached, only Vite runs' },
                    { when: 'server.cjs only changed', time: '20–40s',   note: 'Both stages fully cached' },
                    { when: 'Runtime startup',         time: '< 2s',     note: 'Node.js boot + DB load' },
                  ].map(r => (
                    <div key={r.when} className="flex items-center gap-3 text-xs">
                      <span className="text-slate-400 w-48 shrink-0">{r.when}</span>
                      <span className="text-green-400 font-bold w-16 shrink-0">{r.time}</span>
                      <span className="text-slate-500">{r.note}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Env vars */}
              <div className="bg-slate-900 rounded-lg p-4">
                <h4 className="text-slate-300 font-semibold text-xs mb-3 uppercase tracking-wider">
                  🔑 Environment Variables
                </h4>
                <div className="space-y-1.5 font-mono text-xs">
                  {[
                    { key: 'API_KEY',             val: 'iptv-secret',          req: true  },
                    { key: 'PORT',                val: '10000',                req: false },
                    { key: 'DB_FILE',             val: '/data/db.json',        req: false },
                    { key: 'RENDER_EXTERNAL_URL', val: '(auto-set by Render)', req: false },
                  ].map(e => (
                    <div key={e.key} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${e.req ? 'bg-red-400' : 'bg-slate-600'}`} />
                      <span className="text-yellow-400 shrink-0">{e.key}</span>
                      <span className="text-slate-500">=</span>
                      <span className="text-slate-300">{e.val}</span>
                      {e.req && <span className="text-red-400 text-xs ml-1">required</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 text-xs text-amber-200">
                <strong>⚠️ Free Tier:</strong> Render free tier sleeps after 15 min inactivity.
                The server pings <code className="bg-amber-900/40 px-1 rounded">/health</code> every
                14 min automatically. For 24/7 IPTV upgrade to <strong>Starter ($7/mo)</strong>.
              </div>
            </div>
          )}

          {/* ── API DOCS ─────────────────────────────────────────────────── */}
          {subTab === 'api' && (
            <div className="space-y-3">
              <h4 className="text-slate-300 font-semibold text-sm">🔌 API Reference</h4>
              <div className="space-y-1.5">
                {[
                  { m: 'GET',    p: '/health',                             d: 'Server health · channels · uptime · keepalive status' },
                  { m: 'GET',    p: '/api/stats',                          d: 'Detailed stats: tamil, multiSource, groups, memory' },
                  { m: 'GET',    p: '/api/playlist/all.m3u',               d: 'All active channels (DRM excluded)' },
                  { m: 'GET',    p: '/api/playlist/tamil.m3u',             d: 'Tamil channels only' },
                  { m: 'GET',    p: '/api/playlist/all.m3u?kodi=1',        d: 'Kodi EXTVLCOPT + KODIPROP format' },
                  { m: 'GET',    p: '/api/playlist/:id.m3u',               d: 'Custom playlist (pinned/blocked respected)' },
                  { m: 'GET',    p: '/api/playlist/source/:id.m3u',        d: 'All channels from one source' },
                  { m: 'GET',    p: '/api/playlist/source/:id/tamil.m3u',  d: 'Tamil channels from one source' },
                  { m: 'GET',    p: '/redirect/:id',                       d: '302 redirect → original URL (zero server load)' },
                  { m: 'GET',    p: '/redirect/best/:name',                d: 'Race all sources → 302 to fastest live link' },
                  { m: 'GET',    p: '/api/bestlink/:name',                 d: 'JSON: latency-ranked results for multi-source channel' },
                  { m: 'GET',    p: '/api/health/:id',                     d: 'Single channel HEAD check → {ok, latency, status}' },
                  { m: 'POST',   p: '/api/health/batch',                   d: 'Batch: { ids: ["id1","id2"] } → up to 100 parallel HEAD checks' },
                  { m: 'GET',    p: '/proxy/cors?url=...',                 d: 'Server-side CORS-free fetch for source imports' },
                  { m: 'POST',   p: '/api/sync',                          d: 'Push full DB · requires x-api-key header' },
                  { m: 'GET',    p: '/api/db',                             d: 'Get full DB JSON · requires x-api-key' },
                  { m: 'GET',    p: '/api/channels',                       d: 'Paginated channel list ?page=1&limit=100&q=search&tamil=1' },
                  { m: 'PATCH',  p: '/api/channel/:id',                   d: 'Update single channel field · requires x-api-key' },
                  { m: 'DELETE', p: '/api/channel/:id',                   d: 'Delete a channel · requires x-api-key' },
                  { m: 'GET',    p: '/api/sources',                        d: 'List all sources · requires x-api-key' },
                  { m: 'GET',    p: '/api/test/:id',                       d: 'Test upstream URL reachability for a channel' },
                ].map(({ m, p, d }) => (
                  <div key={p} className="flex items-start gap-2 bg-slate-900 rounded-lg p-2.5">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 min-w-[52px] text-center ${
                      m === 'GET'    ? 'bg-green-900/60 text-green-300' :
                      m === 'POST'   ? 'bg-blue-900/60 text-blue-300' :
                      m === 'PATCH'  ? 'bg-yellow-900/60 text-yellow-300' :
                      'bg-red-900/60 text-red-300'
                    }`}>{m}</span>
                    <span className="text-blue-300 font-mono text-xs shrink-0 pt-0.5">{p}</span>
                    <span className="text-slate-400 text-xs pt-0.5">{d}</span>
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
