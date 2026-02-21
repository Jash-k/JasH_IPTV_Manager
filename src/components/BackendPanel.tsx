/**
 * JASH ADDON — Backend Panel
 * Shows the live backend status, sync controls, manifest URL,
 * and stream handler info for the deployed Stremio addon.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import {
  syncConfigToBackend,
  checkBackendHealth,
  getManifestUrl,
  getStremioInstallUrl,
  clearBackendCache,
  BackendHealth,
  SyncResult,
} from '../utils/backendSync';

interface Props { store: AppStore; }

export const BackendPanel: React.FC<Props> = ({ store }) => {
  const { streams, groups, sources, settings, notify } = store;

  const [health, setHealth]           = useState<BackendHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState(false);

  const [syncing, setSyncing]         = useState(false);
  const [lastSync, setLastSync]       = useState<SyncResult | null>(null);
  const [autoSync, setAutoSync]       = useState(false);

  const [copied, setCopied]           = useState<string | null>(null);
  const [cacheClearing, setCacheClearing] = useState(false);

  const manifestUrl    = getManifestUrl();
  const stremioInstall = getStremioInstallUrl();
  const enabledStreams  = streams.filter(s => s.enabled);

  // ── Check backend health ───────────────────────────────────────────────────
  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(false);
    const h = await checkBackendHealth();
    setHealth(h);
    setHealthError(!h);
    setHealthLoading(false);
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30_000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  // ── Sync config to backend ─────────────────────────────────────────────────
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncConfigToBackend({
        streams : enabledStreams,
        groups,
        sources,
        settings,
      });
      setLastSync(result);
      if (result.ok) {
        notify(`✅ Synced ${result.streams?.toLocaleString()} streams to backend`, 'success');
        // Refresh health after sync
        setTimeout(checkHealth, 1000);
      } else {
        notify(`⚠️ Sync: ${result.error}`, 'error');
      }
    } finally {
      setSyncing(false);
    }
  }, [enabledStreams, groups, sources, settings, notify, checkHealth]);

  // Auto-sync on stream change if enabled
  useEffect(() => {
    if (!autoSync) return;
    const t = setTimeout(() => handleSync(), 2000);
    return () => clearTimeout(t);
  }, [autoSync, streams.length, handleSync]);

  // ── Copy to clipboard ──────────────────────────────────────────────────────
  const copy = useCallback(async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2500);
    notify('Copied to clipboard!', 'success');
  }, [notify]);

  // ── Clear cache ────────────────────────────────────────────────────────────
  const handleClearCache = useCallback(async () => {
    setCacheClearing(true);
    const ok = await clearBackendCache();
    setCacheClearing(false);
    if (ok) {
      notify('Stream cache cleared', 'success');
      checkHealth();
    } else {
      notify('Could not reach backend', 'error');
    }
  }, [notify, checkHealth]);

  const isOnline  = !!health;
  const isOffline = healthError && !healthLoading;

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-violet-900/50 to-purple-900/50 border border-violet-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            🖥️
          </div>
          <div>
            <h2 className="text-white font-bold text-xl">Backend & Stremio Addon</h2>
            <p className="text-violet-300/80 text-sm">
              Live HLS extraction · Samsung Tizen optimized · Sync streams to your deployed server
            </p>
          </div>
        </div>

        {/* Architecture explanation */}
        <div className="bg-violet-950/50 border border-violet-700/30 rounded-xl p-4 text-xs space-y-1.5 text-violet-200/80">
          <div className="font-semibold text-violet-300 mb-2">🏗️ How it works when deployed:</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
            {[
              { icon: '⚙️', title: 'Configure', desc: 'Add sources, edit streams, organize groups in this UI' },
              { icon: '🔄', title: 'Sync', desc: 'Click Sync — pushes all stream data to the backend server' },
              { icon: '📺', title: 'Watch', desc: 'Stremio fetches /stream/tv/:id.json — backend extracts real HLS URL' },
            ].map(step => (
              <div key={step.title} className="bg-violet-900/40 rounded-lg p-3">
                <div className="text-xl mb-1">{step.icon}</div>
                <div className="text-violet-200 font-medium text-xs">{step.title}</div>
                <div className="text-violet-300/60 text-xs mt-1">{step.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Backend Status ─────────────────────────────────────────────────── */}
      <div className={cn(
        'rounded-xl p-5 border space-y-4',
        isOnline  ? 'bg-emerald-900/20 border-emerald-700/40' :
        isOffline ? 'bg-red-900/20 border-red-700/40' :
                    'bg-gray-800 border-gray-700'
      )}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <span>{isOnline ? '🟢' : isOffline ? '🔴' : '⚪'}</span>
            Backend Status
          </h3>
          <button
            onClick={checkHealth}
            disabled={healthLoading}
            className="text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <span className={healthLoading ? 'animate-spin inline-block' : ''}>🔄</span>
            Refresh
          </button>
        </div>

        {healthLoading && !health && (
          <div className="text-gray-400 text-sm flex items-center gap-2">
            <span className="animate-spin inline-block">⏳</span>
            Checking backend…
          </div>
        )}

        {isOffline && (
          <div className="space-y-2">
            <p className="text-red-300 text-sm">
              Backend server is not reachable. This is normal if:
            </p>
            <ul className="text-red-300/70 text-xs space-y-1 ml-4 list-disc">
              <li>You're running only the React dev server (<code>npm run dev</code>) — start the backend separately</li>
              <li>The server hasn't started yet after deployment</li>
              <li>The PORT or PUBLIC_URL environment variable is misconfigured</li>
            </ul>
            <div className="bg-gray-900/60 rounded-lg p-3 text-xs font-mono text-gray-300 space-y-1">
              <div className="text-gray-500"># Start the backend (after npm run build):</div>
              <div className="text-emerald-400">node backend/server.js</div>
              <div className="text-gray-500 mt-2"># Or with environment:</div>
              <div className="text-emerald-400">PORT=7000 PUBLIC_URL=https://your-app.onrender.com node backend/server.js</div>
            </div>
          </div>
        )}

        {isOnline && health && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Streams',  value: health.streams.toLocaleString(), icon: '📺', color: 'text-blue-400' },
              { label: 'Groups',   value: health.groups,                   icon: '📂', color: 'text-purple-400' },
              { label: 'Cache',    value: health.cache,                    icon: '⚡', color: 'text-yellow-400' },
              { label: 'Uptime',   value: `${Math.floor(health.uptime / 60)}m`, icon: '⏱️', color: 'text-emerald-400' },
            ].map(s => (
              <div key={s.label} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-3 text-center">
                <div className="text-lg mb-0.5">{s.icon}</div>
                <div className={cn('text-lg font-bold', s.color)}>{s.value}</div>
                <div className="text-gray-500 text-xs">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {isOnline && health && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>🌐</span>
            <span className="font-mono">{health.publicUrl}</span>
            <span className="text-emerald-400 ml-auto">● Online</span>
          </div>
        )}
      </div>

      {/* ── Sync Configuration ─────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🔄</span> Sync Streams to Backend
        </h3>

        <p className="text-gray-400 text-sm">
          Push your current stream configuration to the backend server. 
          After syncing, Stremio will see your updated streams immediately — no reinstall needed.
        </p>

        {/* Sync stats */}
        <div className="bg-gray-700/40 border border-gray-600/50 rounded-xl p-4 grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-blue-400 font-bold text-xl">{enabledStreams.length.toLocaleString()}</div>
            <div className="text-gray-500 text-xs">Enabled Streams</div>
          </div>
          <div>
            <div className="text-purple-400 font-bold text-xl">{groups.length}</div>
            <div className="text-gray-500 text-xs">Groups</div>
          </div>
          <div>
            <div className="text-emerald-400 font-bold text-xl">{sources.length}</div>
            <div className="text-gray-500 text-xs">Sources</div>
          </div>
        </div>

        {/* Last sync result */}
        {lastSync && (
          <div className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-lg text-sm',
            lastSync.ok
              ? 'bg-emerald-900/30 border border-emerald-700/40 text-emerald-300'
              : 'bg-orange-900/30 border border-orange-700/40 text-orange-300'
          )}>
            <span>{lastSync.ok ? '✅' : '⚠️'}</span>
            <span>
              {lastSync.ok
                ? `Synced ${lastSync.streams?.toLocaleString()} streams to ${lastSync.backendUrl}`
                : lastSync.error
              }
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleSync}
            disabled={syncing || !enabledStreams.length}
            className={cn(
              'flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg',
              syncing
                ? 'bg-violet-800 text-violet-300 cursor-wait animate-pulse'
                : enabledStreams.length
                  ? 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white active:scale-95'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            )}
          >
            <span className={syncing ? 'animate-spin inline-block' : ''}>🔄</span>
            {syncing ? 'Syncing…' : `Sync ${enabledStreams.length.toLocaleString()} Streams`}
          </button>

          {/* Auto-sync toggle */}
          <div className="flex items-center gap-2 bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-3">
            <span className="text-gray-400 text-sm">Auto-sync</span>
            <button
              onClick={() => setAutoSync(v => !v)}
              className={cn('w-10 h-6 rounded-full transition-all relative',
                autoSync ? 'bg-violet-500' : 'bg-gray-600'
              )}
            >
              <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all',
                autoSync ? 'left-4' : 'left-0.5'
              )} />
            </button>
          </div>

          {/* Clear cache */}
          {isOnline && (health?.cache || 0) > 0 && (
            <button
              onClick={handleClearCache}
              disabled={cacheClearing}
              className="flex items-center gap-2 px-4 py-3 bg-gray-700 hover:bg-red-900/50 hover:border-red-700/50 border border-gray-600 text-gray-300 hover:text-red-300 rounded-xl text-sm transition-all"
            >
              {cacheClearing ? '⏳' : '🗑️'} Clear Cache ({health?.cache})
            </button>
          )}
        </div>

        {autoSync && (
          <div className="text-xs text-violet-300/70 flex items-center gap-2">
            <span className="animate-pulse">🟣</span>
            Auto-sync is ON — changes will sync to backend within 2 seconds
          </div>
        )}
      </div>

      {/* ── Manifest & Install URLs ─────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🔌</span> Install in Stremio
        </h3>

        {/* Manifest URL */}
        <div>
          <label className="text-gray-400 text-xs font-medium mb-1.5 block">Addon Manifest URL</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-blue-300 text-sm font-mono truncate">
              {manifestUrl}
            </div>
            <button
              onClick={() => copy(manifestUrl, 'manifest')}
              className={cn(
                'px-4 py-3 rounded-lg text-sm font-medium transition-colors flex-shrink-0',
                copied === 'manifest' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
              )}
            >
              {copied === 'manifest' ? '✓ Copied' : '📋'}
            </button>
          </div>
        </div>

        {/* Stremio deep link */}
        <div>
          <label className="text-gray-400 text-xs font-medium mb-1.5 block">Stremio Deep Link</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-purple-300 text-sm font-mono truncate">
              {stremioInstall}
            </div>
            <button
              onClick={() => copy(stremioInstall, 'stremio')}
              className={cn(
                'px-4 py-3 rounded-lg text-sm font-medium transition-colors flex-shrink-0',
                copied === 'stremio' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
              )}
            >
              {copied === 'stremio' ? '✓ Copied' : '📋'}
            </button>
          </div>
        </div>

        <a
          href={stremioInstall}
          className="flex items-center justify-center gap-3 w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-base transition-all shadow-lg"
        >
          <span>🚀</span> Install in Stremio
        </a>

        <div className="grid grid-cols-2 gap-3 text-xs text-center text-gray-500">
          <div className="bg-gray-700/40 rounded-lg p-2">
            Click link above → Stremio opens → Confirm install
          </div>
          <div className="bg-gray-700/40 rounded-lg p-2">
            Or paste manifest URL in Stremio → Settings → Addons
          </div>
        </div>
      </div>

      {/* ── Deployment Guide ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🚀</span> Deploy to Cloud (Render / Koyeb / Railway)
        </h3>

        <div className="space-y-3">
          {[
            {
              platform: 'Render.com',
              icon: '🟣',
              color: 'border-purple-700/40 bg-purple-900/10',
              steps: [
                'Push code to GitHub',
                'New → Web Service → connect repo',
                'Build: npm run build',
                'Start: node backend/server.js',
                'Set PUBLIC_URL = https://your-app.onrender.com',
              ],
              url: 'https://render.com',
            },
            {
              platform: 'Koyeb.com',
              icon: '🔵',
              color: 'border-blue-700/40 bg-blue-900/10',
              steps: [
                'Push code to GitHub',
                'New App → GitHub repo',
                'Build: npm run build',
                'Start: node backend/server.js',
                'Set PUBLIC_URL env var',
              ],
              url: 'https://koyeb.com',
            },
            {
              platform: 'Railway.app',
              icon: '🟤',
              color: 'border-orange-700/40 bg-orange-900/10',
              steps: [
                'railway login && railway init',
                'railway up',
                'Set start command: node backend/server.js',
                'Set PORT & PUBLIC_URL env vars',
              ],
              url: 'https://railway.app',
            },
          ].map(d => (
            <div key={d.platform} className={cn('rounded-xl p-4 border space-y-2', d.color)}>
              <div className="flex items-center justify-between">
                <h4 className="text-white font-medium flex items-center gap-2">
                  <span>{d.icon}</span> {d.platform}
                </h4>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-white transition-colors"
                >
                  Open ↗
                </a>
              </div>
              <ol className="space-y-1 text-xs text-gray-400 list-decimal list-inside">
                {d.steps.map((s, i) => (
                  <li key={i} className="font-mono">{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        {/* Environment variables reference */}
        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
          <h4 className="text-white text-sm font-medium">Environment Variables</h4>
          <div className="space-y-2 text-xs font-mono">
            {[
              { key: 'PORT',        val: '7000',                              desc: 'HTTP server port' },
              { key: 'PUBLIC_URL',  val: 'https://your-app.onrender.com',    desc: 'Your public domain' },
              { key: 'DEBUG',       val: 'true',                              desc: 'Verbose logging (optional)' },
            ].map(v => (
              <div key={v.key} className="flex gap-3 items-start">
                <span className="text-yellow-400 w-28 flex-shrink-0">{v.key}</span>
                <span className="text-emerald-300 flex-1">{v.val}</span>
                <span className="text-gray-600 hidden sm:block"># {v.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Stream Handler Info ───────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🧩</span> Backend HLS Stream Handler
        </h3>
        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 text-xs space-y-2 font-mono">
          <div className="text-gray-500">// Stremio calls this endpoint for every stream:</div>
          <div className="text-blue-300">GET /stream/tv/jash:{'{'}base64url(streamUrl){'}'}.json</div>
          <div className="text-gray-500 mt-2">// Backend handler pipeline:</div>
          <div className="text-gray-400">1. Check in-memory cache (5 min TTL)</div>
          <div className="text-gray-400">2. Detect HLS vs direct stream</div>
          <div className="text-gray-400">3. Fetch M3U8 playlist (Samsung Tizen UA)</div>
          <div className="text-yellow-300">4. extractRealStreamUrl() — your exact algorithm</div>
          <div className="text-yellow-300">   → Master playlist: pick middle-quality variant</div>
          <div className="text-yellow-300">   → Media playlist: extract first .ts/.m4s segment</div>
          <div className="text-emerald-300">5. Return resolved URL → Stremio plays it</div>
          <div className="text-gray-500">// Fallback: return original URL on any error</div>
        </div>
        <div className="text-xs text-gray-500 leading-relaxed">
          The backend runs the <strong className="text-white">same HLS extraction logic</strong> as your working addon —
          fetching playlists server-side with the Samsung Tizen User-Agent, resolving master→variant→segment chains,
          and selecting the <strong className="text-white">middle quality variant</strong> for Samsung TV stability.
          All processing happens in Node.js so Stremio receives a direct playable URL — no HLS handling issues on Tizen OS.
        </div>
      </div>
    </div>
  );
};
