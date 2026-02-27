import { useState, useEffect, useCallback } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import {
  syncConfigToBackend,
  checkBackendHealth,
  getManifestUrl,
  getMovieManifestUrl,
  getStremioInstallUrl,
  getMovieStremioInstallUrl,
  getShortPlaylistUrls,
  clearBackendCache,
} from '../utils/backendSync';

interface HealthData {
  status: string; uptime: number; publicUrl: string; cache: number;
  iptv: { streams: number; groups: number; autoCombined: number; catalogs: number; version: string; manifestUrl: string };
  movies: { streams: number; uniqueMovies: number; catalogs: number; version: string; manifestUrl: string };
}

interface Props { store: AppStore; }

export const BackendPanel: React.FC<Props> = ({ store }) => {
  const { streams, groups, sources, settings, combinedChannels, notify } = store;

  const [health,        setHealth]        = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError,   setHealthError]   = useState(false);
  const [syncing,       setSyncing]       = useState(false);
  const [lastSyncMsg,   setLastSyncMsg]   = useState<{ ok: boolean; msg: string } | null>(null);
  const [autoSync,      setAutoSync]      = useState(false);
  const [copied,        setCopied]        = useState<string | null>(null);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [showSamsungGuide, setShowSamsungGuide] = useState(false);

  const manifestUrl      = getManifestUrl();
  const movieManifestUrl = getMovieManifestUrl();
  const stremioDeepLink  = getStremioInstallUrl();
  const movieDeepLink    = getMovieStremioInstallUrl();
  const shortUrls        = getShortPlaylistUrls();
  const enabledStreams   = streams.filter(s => s.enabled);

  // ── Health check ────────────────────────────────────────────────────────────
  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(false);
    const h = await checkBackendHealth();
    if (h.online && h.data) {
      setHealth(h.data as unknown as HealthData);
      setHealthError(false);
    } else {
      setHealth(null);
      setHealthError(true);
    }
    setHealthLoading(false);
  }, []);

  useEffect(() => {
    checkHealth();
    const iv = setInterval(checkHealth, 30_000);
    return () => clearInterval(iv);
  }, [checkHealth]);

  // ── IPTV Sync ───────────────────────────────────────────────────────────────
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncConfigToBackend({
        streams          : enabledStreams,
        groups,
        combinedChannels : combinedChannels.filter(c => c.enabled !== false),
        settings         : settings as unknown as Record<string, unknown>,
      });
      setLastSyncMsg({ ok: result.ok, msg: result.message });
      if (result.ok) {
        notify(result.message, 'success');
        setTimeout(checkHealth, 1000);
      } else {
        notify(result.message, 'error');
      }
    } finally { setSyncing(false); }
  }, [enabledStreams, groups, combinedChannels, settings, notify, checkHealth]);

  useEffect(() => {
    if (!autoSync) return;
    const t = setTimeout(() => handleSync(), 2500);
    return () => clearTimeout(t);
  }, [autoSync, streams.length, handleSync]);

  // ── Copy ────────────────────────────────────────────────────────────────────
  const copy = useCallback(async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const el = document.createElement('textarea'); el.value = text;
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
    }
    setCopied(key); setTimeout(() => setCopied(null), 2500);
    notify('Copied!', 'success');
  }, [notify]);

  // ── Clear cache ──────────────────────────────────────────────────────────────
  const handleClearCache = useCallback(async () => {
    setCacheClearing(true);
    const r = await clearBackendCache();
    setCacheClearing(false);
    if (r.ok) { notify(`Cache cleared (${r.cleared} entries)`, 'success'); checkHealth(); }
    else notify('Could not reach backend', 'error');
  }, [notify, checkHealth]);

  const isOnline  = !!health;
  const isOffline = healthError && !healthLoading;

  return (
    <div className="space-y-5">

      {/* ── Status Card ──────────────────────────────────────────────────────── */}
      <div className={cn(
        'rounded-2xl p-5 border',
        isOnline ? 'bg-emerald-900/20 border-emerald-700/40' :
        isOffline ? 'bg-red-900/20 border-red-700/40' : 'bg-gray-800 border-gray-700'
      )}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-bold text-lg flex items-center gap-2">
            <span>{isOnline ? '🟢' : isOffline ? '🔴' : '⚪'}</span> Backend Status
          </h3>
          <button onClick={checkHealth} disabled={healthLoading}
            className="text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5">
            <span className={healthLoading ? 'animate-spin inline-block' : ''}>🔄</span>
            {healthLoading ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        {healthLoading && !health && (
          <p className="text-gray-400 text-sm flex items-center gap-2">
            <span className="animate-spin inline-block">⏳</span> Checking backend…
          </p>
        )}

        {isOffline && (
          <div className="space-y-3">
            <p className="text-red-300 text-sm font-medium">Backend not reachable.</p>
            <div className="bg-gray-900/60 rounded-lg p-3 text-xs font-mono text-gray-300 space-y-1">
              <div className="text-gray-500"># Build + start backend:</div>
              <div className="text-emerald-400">npm run build</div>
              <div className="text-emerald-400">node backend/server.js</div>
            </div>
          </div>
        )}

        {isOnline && health && (
          <div className="space-y-4">
            {/* IPTV stats */}
            <div>
              <div className="text-xs text-gray-500 font-medium mb-2 uppercase tracking-wider">📺 IPTV Addon</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Streams',    value: health.iptv?.streams?.toLocaleString() ?? '0',  icon: '📺', color: 'text-blue-400' },
                  { label: 'Groups',     value: health.iptv?.groups ?? 0,                        icon: '📂', color: 'text-purple-400' },
                  { label: '⭐ Combined',value: health.iptv?.autoCombined ?? 0,                  icon: '⭐', color: 'text-yellow-400' },
                  { label: 'Catalogs',   value: health.iptv?.catalogs ?? 0,                      icon: '📋', color: 'text-emerald-400' },
                ].map(s => (
                  <div key={s.label} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-2.5 text-center">
                    <div className="text-base mb-0.5">{s.icon}</div>
                    <div className={cn('text-lg font-bold', s.color)}>{s.value}</div>
                    <div className="text-gray-500 text-xs">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Movie stats */}
            <div>
              <div className="text-xs text-gray-500 font-medium mb-2 uppercase tracking-wider">🎬 Movie Addon</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Streams',   value: health.movies?.streams?.toLocaleString() ?? '0',  icon: '🎬', color: 'text-orange-400' },
                  { label: 'Movies',    value: health.movies?.uniqueMovies?.toLocaleString() ?? '0', icon: '🎥', color: 'text-yellow-400' },
                  { label: 'Catalogs',  value: health.movies?.catalogs ?? 0,                       icon: '📋', color: 'text-pink-400' },
                  { label: 'Uptime',    value: `${Math.floor((health.uptime || 0) / 60)}m`,        icon: '⏱️', color: 'text-emerald-400' },
                ].map(s => (
                  <div key={s.label} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-2.5 text-center">
                    <div className="text-base mb-0.5">{s.icon}</div>
                    <div className={cn('text-lg font-bold', s.color)}>{s.value}</div>
                    <div className="text-gray-500 text-xs">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>🌐</span>
              <span className="font-mono text-blue-300 break-all">{health.publicUrl}</span>
              <span className="text-emerald-400 ml-auto">● Online · v{health.iptv?.version}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Sync ─────────────────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><span>🔄</span> Sync IPTV Streams</h3>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-gray-700/40 rounded-xl p-3">
            <div className="text-blue-400 font-bold text-xl">{enabledStreams.length.toLocaleString()}</div>
            <div className="text-gray-500 text-xs">Enabled Streams</div>
          </div>
          <div className="bg-gray-700/40 rounded-xl p-3">
            <div className="text-purple-400 font-bold text-xl">{groups.length}</div>
            <div className="text-gray-500 text-xs">Groups</div>
          </div>
          <div className="bg-gray-700/40 rounded-xl p-3">
            <div className="text-emerald-400 font-bold text-xl">{sources.length}</div>
            <div className="text-gray-500 text-xs">Sources</div>
          </div>
        </div>

        {lastSyncMsg && (
          <div className={cn('px-4 py-3 rounded-lg text-sm',
            lastSyncMsg.ok ? 'bg-emerald-900/30 border border-emerald-700/40 text-emerald-300'
                           : 'bg-orange-900/30 border border-orange-700/40 text-orange-300')}>
            {lastSyncMsg.msg}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button onClick={handleSync} disabled={syncing || !enabledStreams.length}
            className={cn(
              'flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg',
              syncing ? 'bg-violet-800 text-violet-300 cursor-wait animate-pulse' :
              enabledStreams.length ? 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white active:scale-95'
                                   : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            )}>
            <span className={syncing ? 'animate-spin inline-block' : ''}>🔄</span>
            {syncing ? 'Syncing…' : `Sync ${enabledStreams.length.toLocaleString()} IPTV Streams`}
          </button>

          <div className="flex items-center gap-2 bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-3">
            <span className="text-gray-400 text-sm">Auto-sync</span>
            <button onClick={() => setAutoSync(v => !v)}
              className={cn('w-10 h-6 rounded-full transition-all relative', autoSync ? 'bg-violet-500' : 'bg-gray-600')}>
              <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', autoSync ? 'left-4' : 'left-0.5')} />
            </button>
          </div>

          {isOnline && (health?.cache || 0) > 0 && (
            <button onClick={handleClearCache} disabled={cacheClearing}
              className="flex items-center gap-2 px-4 py-3 bg-gray-700 hover:bg-red-900/50 border border-gray-600 hover:border-red-700/50 text-gray-300 hover:text-red-300 rounded-xl text-sm transition-all">
              {cacheClearing ? '⏳' : '🗑️'} Clear Cache ({health?.cache})
            </button>
          )}
        </div>
      </div>

      {/* ── Install IPTV Addon ────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><span>📺</span> Install IPTV Addon in Stremio</h3>

        {/* M3U Playlist */}
        <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-xl p-4 space-y-2">
          <div className="text-emerald-300 font-medium text-sm flex items-center gap-2"><span>📻</span> M3U Playlist URLs (Tivimate · OTT Navigator · VLC)</div>
          {Object.entries(shortUrls).map(([key, url]) => (
            <div key={key} className="flex items-center gap-2">
              <div className="flex-1 bg-gray-900 border border-emerald-700/40 rounded-lg px-3 py-2 font-mono text-emerald-300 text-xs truncate">{url}</div>
              <button onClick={() => copy(url, `pl-${key}`)}
                className={cn('px-3 py-2 rounded-lg text-xs font-semibold transition-all flex-shrink-0',
                  copied === `pl-${key}` ? 'bg-emerald-600 text-white' : 'bg-emerald-800 hover:bg-emerald-700 text-emerald-200')}>
                {copied === `pl-${key}` ? '✅' : '📋'}
              </button>
            </div>
          ))}
        </div>

        {/* Manifest URL */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4 space-y-2">
          <div className="text-blue-300 font-medium text-sm">📋 Stremio Manifest URL — paste in Stremio → Addons → Install from URL</div>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-blue-600/50 rounded-lg px-4 py-3 text-blue-300 text-sm font-mono break-all">{manifestUrl}</div>
            <button onClick={() => copy(manifestUrl, 'manifest')}
              className={cn('px-4 py-3 rounded-lg text-sm font-semibold transition-colors flex-shrink-0 min-w-[80px]',
                copied === 'manifest' ? 'bg-emerald-600 text-white' : 'bg-blue-700 hover:bg-blue-600 text-white')}>
              {copied === 'manifest' ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
        </div>

        <a href={stremioDeepLink}
          className="flex items-center justify-center gap-3 w-full py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm transition-all shadow-lg active:scale-[0.98]">
          🚀 Install IPTV Addon in Stremio
        </a>

        <a href={`https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`} target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm font-medium transition-colors">
          🌐 Install via Stremio Web
        </a>
      </div>

      {/* ── Install Movie Addon ───────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><span>🎬</span> Install Movie Addon in Stremio</h3>

        <div className="bg-orange-900/20 border border-orange-700/40 rounded-xl p-4 space-y-2">
          <div className="text-orange-300 font-medium text-sm">📋 Movie Manifest URL — paste in Stremio → Addons → Install from URL</div>
          <p className="text-orange-200/60 text-xs">Separate from IPTV addon — movies with TMDB metadata, rating/genre/year filters, quality variants (4K, 1080p, 720p)</p>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-orange-600/50 rounded-lg px-4 py-3 text-orange-300 text-sm font-mono break-all">{movieManifestUrl}</div>
            <button onClick={() => copy(movieManifestUrl, 'movie-manifest')}
              className={cn('px-4 py-3 rounded-lg text-sm font-semibold transition-colors flex-shrink-0 min-w-[80px]',
                copied === 'movie-manifest' ? 'bg-emerald-600 text-white' : 'bg-orange-700 hover:bg-orange-600 text-white')}>
              {copied === 'movie-manifest' ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
        </div>

        <a href={movieDeepLink}
          className="flex items-center justify-center gap-3 w-full py-3.5 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white rounded-xl font-semibold text-sm transition-all shadow-lg active:scale-[0.98]">
          🎬 Install Movie Addon in Stremio
        </a>

        <a href={`https://web.stremio.com/#/addons?addon=${encodeURIComponent(movieManifestUrl)}`} target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm font-medium transition-colors">
          🌐 Install Movie Addon via Stremio Web
        </a>

        <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 space-y-2 text-xs text-yellow-200/70">
          <div className="font-semibold text-yellow-300">🎬 Movie Addon Features in Stremio:</div>
          <div className="grid grid-cols-2 gap-1.5">
            {['All Movies catalog', '4K Ultra HD catalog', '1080p HD catalog', '⭐ Top Rated (7+)', '📅 By Year filter', '🎭 Genre filter', '🔍 Search by title', 'Quality variants (4K/1080p/720p)'].map(f => (
              <div key={f} className="flex items-center gap-1"><span className="text-yellow-400">✓</span> {f}</div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Samsung TV Guide ─────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700">
        <button onClick={() => setShowSamsungGuide(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-white font-medium hover:bg-white/5 transition-colors rounded-xl">
          <span className="flex items-center gap-2"><span>📺</span> Samsung Tizen TV — Manual Install Guide</span>
          <span className="text-gray-400">{showSamsungGuide ? '▲' : '▼'}</span>
        </button>

        {showSamsungGuide && (
          <div className="px-5 pb-5 space-y-4 border-t border-gray-700 pt-4">
            <div className="space-y-3">
              {[
                { step:'1', icon:'📺', title:'Open Stremio on Samsung TV', desc:'Launch from Smart Hub, log in.' },
                { step:'2', icon:'⚙️', title:'Go to Settings → Addons',    desc:'Press Menu or navigate to gear icon.' },
                { step:'3', icon:'🔗', title:'Click "Install from URL"',     desc:'Button at top of Addons page.' },
                { step:'4', icon:'⌨️', title:'Type the Manifest URL',        desc:'Use on-screen keyboard. Type carefully.', url: manifestUrl, highlight: true },
                { step:'5', icon:'✅', title:'Confirm Install',               desc:'Press OK. Select Install in dialog.' },
                { step:'6', icon:'📡', title:'Browse Channels',              desc:'Discover → TV. Groups = categories. D-pad to navigate.' },
              ].map(s => (
                <div key={s.step} className={cn('flex gap-3 p-3 rounded-lg', s.highlight ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-gray-700/30')}>
                  <div className="w-7 h-7 rounded-full bg-violet-600/40 flex items-center justify-center text-violet-300 font-bold text-xs flex-shrink-0">{s.step}</div>
                  <div>
                    <div className="text-white text-sm font-medium">{s.icon} {s.title}</div>
                    <div className="text-gray-400 text-xs mt-0.5">{s.desc}</div>
                    {s.highlight && s.url && (
                      <div className="mt-2 bg-gray-900 border border-yellow-600/40 rounded px-3 py-2 text-yellow-300 text-xs font-mono break-all">{s.url}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-emerald-900/20 border border-emerald-700/30 rounded-xl p-4 text-xs text-emerald-200/70">
              <div className="font-semibold text-emerald-300 mb-1">💡 Easier: Install on Phone/PC First</div>
              Install the addon on your phone or PC Stremio (same account) → it syncs to Samsung TV automatically!
            </div>
          </div>
        )}
      </div>

      {/* ── Deploy Guide ──────────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><span>🚀</span> Deploy to Cloud</h3>
        <div className="space-y-3">
          {[
            { platform:'Render.com', icon:'🟣', color:'border-purple-700/40 bg-purple-900/10',
              badge:'⭐ Recommended', badgeColor:'text-purple-300', url:'https://render.com',
              steps:['Push to GitHub','New → Web Service → connect repo','Build: npm install --include=dev && npm run build','Start: node backend/server.js','PORT=10000, PUBLIC_URL=https://app.onrender.com'] },
            { platform:'Koyeb.com', icon:'🔵', color:'border-blue-700/40 bg-blue-900/10',
              badge:'✓ No Sleep', badgeColor:'text-blue-300', url:'https://koyeb.com',
              steps:['Push to GitHub','New App → GitHub','Build: npm install --include=dev && npm run build','Start: node backend/server.js','PORT=8000, PUBLIC_URL=https://app.koyeb.app'] },
            { platform:'Railway.app', icon:'🟤', color:'border-orange-700/40 bg-orange-900/10',
              badge:'✓ Fast', badgeColor:'text-orange-300', url:'https://railway.app',
              steps:['npm install -g @railway/cli && railway login','railway init && railway up','railway variables set PORT=3000','railway variables set PUBLIC_URL=https://app.railway.app'] },
          ].map(d => (
            <div key={d.platform} className={cn('rounded-xl p-4 border space-y-2', d.color)}>
              <div className="flex items-center justify-between">
                <h4 className="text-white font-medium">{d.icon} {d.platform} <span className={cn('text-xs', d.badgeColor)}>{d.badge}</span></h4>
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-white">Open ↗</a>
              </div>
              <ol className="space-y-0.5 text-xs text-gray-400 list-decimal list-inside font-mono">
                {d.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
          ))}
        </div>

        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
          <div className="text-white text-sm font-medium">Environment Variables</div>
          <div className="space-y-1.5 text-xs font-mono">
            {[
              { key:'PORT',             val:'7000',                           desc:'HTTP port' },
              { key:'PUBLIC_URL',       val:'https://your-app.onrender.com', desc:'⚠️ REQUIRED — your full URL' },
              { key:'ADDON_NAME',       val:'Jash IPTV',                      desc:'IPTV addon display name' },
              { key:'MOVIE_ADDON_NAME', val:'Jash Movies',                   desc:'Movie addon display name' },
              { key:'DEBUG',            val:'true',                           desc:'Verbose HLS logging' },
            ].map(v => (
              <div key={v.key} className="flex gap-3 items-start">
                <span className="text-yellow-400 w-36 flex-shrink-0">{v.key}</span>
                <span className="text-emerald-300 flex-1">{v.val}</span>
                <span className="text-gray-600 hidden sm:block"># {v.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
};
