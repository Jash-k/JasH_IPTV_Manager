/**
 * JASH ADDON — Backend Panel
 * Backend status, sync controls, Stremio install (with Samsung TV guide),
 * and stream handler info.
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
  const { streams, groups, sources, settings, combinedChannels, notify } = store;

  const [health,        setHealth]        = useState<BackendHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError,   setHealthError]   = useState(false);

  const [syncing,   setSyncing]   = useState(false);
  const [lastSync,  setLastSync]  = useState<SyncResult | null>(null);
  const [autoSync,  setAutoSync]  = useState(false);

  const [copied,         setCopied]         = useState<string | null>(null);
  const [cacheClearing,  setCacheClearing]  = useState(false);

  const [showInstallGuide, setShowInstallGuide] = useState(false);

  const manifestUrl    = getManifestUrl();
  const stremioDeepLink = getStremioInstallUrl();
  const enabledStreams  = streams.filter(s => s.enabled);

  // ── Health check ────────────────────────────────────────────────────────────
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
    const iv = setInterval(checkHealth, 30_000);
    return () => clearInterval(iv);
  }, [checkHealth]);

  // ── Sync ────────────────────────────────────────────────────────────────────
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncConfigToBackend({
        streams          : enabledStreams,
        groups,
        sources,
        settings,
        combinedChannels : combinedChannels.filter(c => c.enabled !== false),
      });
      setLastSync(result);
      if (result.ok) {
        notify(`✅ Synced ${result.streams?.toLocaleString()} streams to backend`, 'success');
        setTimeout(checkHealth, 1000);
      } else {
        notify(`⚠️ Sync failed: ${result.error}`, 'error');
      }
    } finally {
      setSyncing(false);
    }
  }, [enabledStreams, groups, sources, settings, notify, checkHealth]);

  // Auto-sync when streams change
  useEffect(() => {
    if (!autoSync) return;
    const t = setTimeout(() => handleSync(), 2500);
    return () => clearTimeout(t);
  }, [autoSync, streams.length, handleSync]);

  // ── Copy ────────────────────────────────────────────────────────────────────
  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
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

  // ── Clear cache ──────────────────────────────────────────────────────────────
  const handleClearCache = useCallback(async () => {
    setCacheClearing(true);
    const ok = await clearBackendCache();
    setCacheClearing(false);
    if (ok) { notify('Stream cache cleared', 'success'); checkHealth(); }
    else { notify('Could not reach backend', 'error'); }
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
              Live HLS extraction · Samsung Tizen optimized · Sync streams to deployed server
            </p>
          </div>
        </div>
        <div className="bg-violet-950/50 border border-violet-700/30 rounded-xl p-4 text-xs space-y-1.5 text-violet-200/80">
          <div className="font-semibold text-violet-300 mb-2">🏗️ How it works when deployed:</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
            {[
              { icon: '⚙️', title: 'Configure', desc: 'Add sources, edit streams, organize groups in this UI' },
              { icon: '🔄', title: 'Sync',      desc: 'Click Sync — pushes all stream data to the backend server' },
              { icon: '📺', title: 'Watch',     desc: 'Stremio fetches stream endpoint — backend extracts real HLS URL' },
            ].map(s => (
              <div key={s.title} className="bg-violet-900/40 rounded-lg p-3">
                <div className="text-xl mb-1">{s.icon}</div>
                <div className="text-violet-200 font-medium text-xs">{s.title}</div>
                <div className="text-violet-300/60 text-xs mt-1">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Backend Status ──────────────────────────────────────────────────── */}
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
            {healthLoading ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        {healthLoading && !health && (
          <div className="text-gray-400 text-sm flex items-center gap-2">
            <span className="animate-spin inline-block">⏳</span> Checking backend…
          </div>
        )}

        {isOffline && (
          <div className="space-y-3">
            <p className="text-red-300 text-sm font-medium">Backend server is not reachable.</p>
            <ul className="text-red-300/70 text-xs space-y-1 ml-4 list-disc">
              <li>Running <code className="bg-red-900/40 px-1 rounded">npm run dev</code>? Start backend separately with <code className="bg-red-900/40 px-1 rounded">node backend/server.js</code></li>
              <li>Deployed but offline? Check your platform logs</li>
              <li>Wrong PORT or PUBLIC_URL environment variable</li>
            </ul>
            <div className="bg-gray-900/60 rounded-lg p-3 text-xs font-mono text-gray-300 space-y-1">
              <div className="text-gray-500"># Build then start backend:</div>
              <div className="text-emerald-400">npm run build</div>
              <div className="text-emerald-400">node backend/server.js</div>
            </div>
          </div>
        )}

        {isOnline && health && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Streams', value: health.streams.toLocaleString(), icon: '📺', color: 'text-blue-400' },
                { label: 'Groups',  value: health.groups,                   icon: '📂', color: 'text-purple-400' },
                { label: 'Cache',   value: health.cache,                    icon: '⚡', color: 'text-yellow-400' },
                { label: 'Uptime',  value: `${Math.floor(health.uptime / 60)}m`, icon: '⏱️', color: 'text-emerald-400' },
              ].map(s => (
                <div key={s.label} className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-3 text-center">
                  <div className="text-lg mb-0.5">{s.icon}</div>
                  <div className={cn('text-lg font-bold', s.color)}>{s.value}</div>
                  <div className="text-gray-500 text-xs">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400 flex-wrap">
              <span>🌐</span>
              <span className="font-mono text-blue-300 break-all">{health.publicUrl}</span>
              <span className="text-emerald-400 ml-auto">● Online</span>
            </div>
          </>
        )}
      </div>

      {/* ── Sync Configuration ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🔄</span> Sync Streams to Backend
        </h3>

        <p className="text-gray-400 text-sm">
          Push your stream configuration to the backend. The manifest version bumps automatically
          so Stremio detects changes — <strong className="text-violet-300">no reinstall needed</strong>.
        </p>

        <div className="bg-violet-900/20 border border-violet-700/30 rounded-xl px-4 py-3 text-xs text-violet-200/80 space-y-1">
          <div className="font-semibold text-violet-300 mb-1">🔄 Instant reflect — how it works:</div>
          <div>1. Click Sync → backend writes new config + bumps manifest version</div>
          <div>2. Stremio sees the new version on next catalog open → re-fetches automatically</div>
          <div>3. Updated channels appear ✅ — stream cache also cleared for fresh HLS extraction</div>
          <div className="text-violet-300/50 mt-1 italic">
            Tip: If Stremio still shows old data, pull-to-refresh in Stremio or restart the app.
          </div>
        </div>

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
                ? `Synced ${lastSync.streams?.toLocaleString()} streams to backend`
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
              className={cn('w-10 h-6 rounded-full transition-all relative', autoSync ? 'bg-violet-500' : 'bg-gray-600')}
            >
              <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', autoSync ? 'left-4' : 'left-0.5')} />
            </button>
          </div>

          {/* Clear cache */}
          {isOnline && (health?.cache || 0) > 0 && (
            <button
              onClick={handleClearCache}
              disabled={cacheClearing}
              className="flex items-center gap-2 px-4 py-3 bg-gray-700 hover:bg-red-900/50 border border-gray-600 hover:border-red-700/50 text-gray-300 hover:text-red-300 rounded-xl text-sm transition-all"
            >
              {cacheClearing ? '⏳' : '🗑️'} Clear Cache ({health?.cache})
            </button>
          )}
        </div>

        {autoSync && (
          <div className="text-xs text-violet-300/70 flex items-center gap-2">
            <span className="animate-pulse">🟣</span>
            Auto-sync is ON — changes sync to backend within 2.5 seconds
          </div>
        )}
      </div>

      {/* ── Install in Stremio ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🔌</span> Install in Stremio
        </h3>

        {/* ⚠️ Important: HTTP Manifest URL (what you paste in Stremio) */}
        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2 text-blue-300 font-medium text-sm">
            <span>📋</span> Step 1 — Copy this Manifest URL
          </div>
          <p className="text-blue-200/70 text-xs">
            This is what you paste into Stremio → Settings → Addons → "Install from URL"
          </p>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-blue-600/50 rounded-lg px-4 py-3 text-blue-300 text-sm font-mono break-all">
              {manifestUrl}
            </div>
            <button
              onClick={() => copy(manifestUrl, 'manifest')}
              className={cn(
                'px-4 py-3 rounded-lg text-sm font-semibold transition-colors flex-shrink-0 min-w-[80px]',
                copied === 'manifest' ? 'bg-emerald-600 text-white' : 'bg-blue-700 hover:bg-blue-600 text-white'
              )}
            >
              {copied === 'manifest' ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
        </div>

        {/* Stremio deep link (for desktop/mobile Stremio app) */}
        <div className="space-y-2">
          <div className="text-gray-400 text-xs font-medium">Or use Stremio deep link (click to open Stremio directly):</div>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-purple-300 text-xs font-mono truncate">
              {stremioDeepLink}
            </div>
            <button
              onClick={() => copy(stremioDeepLink, 'stremio')}
              className={cn(
                'px-3 py-2.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0',
                copied === 'stremio' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
              )}
            >
              {copied === 'stremio' ? '✓' : '📋'}
            </button>
          </div>
        </div>

        {/* One-click install button */}
        <a
          href={stremioDeepLink}
          className="flex items-center justify-center gap-3 w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-base transition-all shadow-lg active:scale-[0.98]"
        >
          <span>🚀</span> Click to Install in Stremio (Desktop/Mobile)
        </a>

        <p className="text-gray-600 text-xs text-center">
          Works on Windows, Mac, Android Stremio app · For Samsung TV see guide below
        </p>

        {/* Samsung TV install guide */}
        <button
          onClick={() => setShowInstallGuide(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 bg-yellow-900/20 border border-yellow-700/30 rounded-xl text-yellow-300 text-sm font-medium hover:bg-yellow-900/30 transition-colors"
        >
          <span className="flex items-center gap-2"><span>📺</span> Samsung Tizen TV — Manual Install Guide</span>
          <span>{showInstallGuide ? '▲' : '▼'}</span>
        </button>

        {showInstallGuide && (
          <div className="bg-yellow-900/10 border border-yellow-700/20 rounded-xl p-4 space-y-4">
            <p className="text-yellow-200/80 text-sm">
              Samsung Tizen Stremio does not support deep links. You must enter the manifest URL manually.
            </p>

            {/* Step-by-step */}
            <div className="space-y-3">
              {[
                {
                  step: '1',
                  title: 'Open Stremio on your Samsung TV',
                  desc: 'Launch Stremio from Smart Hub. Log in with your account.',
                  icon: '📺',
                },
                {
                  step: '2',
                  title: 'Go to Settings',
                  desc: 'Press the remote Menu button or navigate to the gear icon (top-right corner of Stremio).',
                  icon: '⚙️',
                },
                {
                  step: '3',
                  title: 'Open Addons',
                  desc: 'In Settings, select "Addons" from the left sidebar.',
                  icon: '🔌',
                },
                {
                  step: '4',
                  title: 'Install from URL',
                  desc: 'Click "Install from URL" button at the top of the Addons page.',
                  icon: '🔗',
                },
                {
                  step: '5',
                  title: 'Type the Manifest URL',
                  desc: 'Using the on-screen keyboard, carefully type your manifest URL shown above. It must start with https://.',
                  icon: '⌨️',
                  highlight: true,
                },
                {
                  step: '6',
                  title: 'Confirm Install',
                  desc: 'Press OK/Enter. Stremio will show a confirmation dialog — select Install.',
                  icon: '✅',
                },
                {
                  step: '7',
                  title: 'Find Your Channels',
                  desc: 'Go to Discover → TV. Your groups appear as separate channel categories. Use D-pad to navigate.',
                  icon: '📡',
                },
              ].map(s => (
                <div key={s.step} className={cn(
                  'flex items-start gap-3 p-3 rounded-lg',
                  s.highlight ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-gray-800/40'
                )}>
                  <div className="w-8 h-8 rounded-full bg-yellow-600/30 flex items-center justify-center text-yellow-300 font-bold text-sm flex-shrink-0">
                    {s.step}
                  </div>
                  <div>
                    <div className="text-white text-sm font-medium flex items-center gap-2">
                      <span>{s.icon}</span> {s.title}
                    </div>
                    <div className="text-yellow-200/60 text-xs mt-1">{s.desc}</div>
                    {s.highlight && (
                      <div className="mt-2 bg-gray-900/80 border border-yellow-600/40 rounded-lg px-3 py-2 text-yellow-300 text-xs font-mono break-all">
                        {manifestUrl}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* TV remote tips */}
            <div className="bg-gray-800/60 rounded-xl p-4 space-y-2">
              <div className="text-yellow-300 font-medium text-sm">📡 Remote Navigation Tips</div>
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
                <div>⬆⬇⬅➡ — Navigate channels</div>
                <div>OK/Enter — Select / Play</div>
                <div>Back — Go up one level</div>
                <div>Menu — Open settings</div>
              </div>
            </div>

            {/* Easier alternative */}
            <div className="bg-emerald-900/20 border border-emerald-700/30 rounded-xl p-4">
              <div className="text-emerald-300 font-medium text-sm mb-2">💡 Easier Alternative</div>
              <p className="text-emerald-200/70 text-xs">
                Install the addon on your <strong>phone or PC Stremio app</strong> using the Copy button above.
                Since you're logged in with the same account, the addon syncs to your Samsung TV automatically!
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Deploy Guide ────────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🚀</span> Deploy to Cloud
        </h3>

        <div className="space-y-3">
          {[
            {
              platform: 'Render.com',
              icon: '🟣',
              color: 'border-purple-700/40 bg-purple-900/10',
              badge: '⭐ Recommended',
              badgeColor: 'text-purple-300',
              steps: [
                'Push code to GitHub',
                'New → Web Service → connect repo',
                'Build: npm install --include=dev && npm run build',
                'Start: node backend/server.js',
                'PORT=10000, PUBLIC_URL=https://your-app.onrender.com',
              ],
              url: 'https://render.com',
            },
            {
              platform: 'Koyeb.com',
              icon: '🔵',
              color: 'border-blue-700/40 bg-blue-900/10',
              badge: '✓ No Sleep',
              badgeColor: 'text-blue-300',
              steps: [
                'Push code to GitHub',
                'New App → GitHub → connect repo',
                'Build: npm install --include=dev && npm run build',
                'Start: node backend/server.js',
                'PORT=8000, PUBLIC_URL=https://your-app.koyeb.app',
              ],
              url: 'https://koyeb.com',
            },
            {
              platform: 'Railway.app',
              icon: '🟤',
              color: 'border-orange-700/40 bg-orange-900/10',
              badge: '✓ Fast',
              badgeColor: 'text-orange-300',
              steps: [
                'npm install -g @railway/cli && railway login',
                'railway init && railway up',
                'railway variables set PORT=3000',
                'railway variables set PUBLIC_URL=https://your-app.railway.app',
              ],
              url: 'https://railway.app',
            },
          ].map(d => (
            <div key={d.platform} className={cn('rounded-xl p-4 border space-y-2', d.color)}>
              <div className="flex items-center justify-between">
                <h4 className="text-white font-medium flex items-center gap-2">
                  <span>{d.icon}</span> {d.platform}
                  <span className={cn('text-xs', d.badgeColor)}>{d.badge}</span>
                </h4>
                <a href={d.url} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-gray-400 hover:text-white transition-colors">
                  Open ↗
                </a>
              </div>
              <ol className="space-y-1 text-xs text-gray-400 list-decimal list-inside">
                {d.steps.map((s, i) => <li key={i} className="font-mono">{s}</li>)}
              </ol>
            </div>
          ))}
        </div>

        {/* Environment Variables */}
        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
          <h4 className="text-white text-sm font-medium">Environment Variables</h4>
          <div className="space-y-2 text-xs font-mono">
            {[
              { key: 'PORT',       val: '7000',                           desc: 'HTTP server port (platform sets automatically)' },
              { key: 'PUBLIC_URL', val: 'https://your-app.onrender.com', desc: '⚠️ Your full public URL — REQUIRED' },
              { key: 'DEBUG',      val: 'true',                           desc: 'Verbose HLS extraction logging (optional)' },
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

      {/* ── Backend Stream Handler Info ─────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🧩</span> Backend HLS Stream Handler
        </h3>
        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 text-xs space-y-2 font-mono">
          <div className="text-gray-500">// Stremio calls this on stream select:</div>
          <div className="text-blue-300">GET /stream/tv/jash:{'{'}base64url(streamUrl){'}'}.json</div>
          <div className="text-gray-500 mt-2">// Server pipeline:</div>
          <div className="text-gray-400">1. Decode stream ID → get playlist URL</div>
          <div className="text-gray-400">2. Check in-memory cache (5 min TTL)</div>
          <div className="text-gray-400">3. Detect HLS vs direct stream (.m3u8?)</div>
          <div className="text-gray-400">4. Fetch M3U8 playlist (Samsung Tizen UA)</div>
          <div className="text-yellow-300">5. extractRealStreamUrl() ← your exact algorithm</div>
          <div className="text-yellow-300">   Master playlist → sort by BANDWIDTH → pick MIDDLE index</div>
          <div className="text-yellow-300">   Media playlist  → extract first .ts/.m4s segment URL</div>
          <div className="text-emerald-300">6. Return resolved URL → Stremio plays it ✅</div>
          <div className="text-gray-500">7. On error → fallback to original URL</div>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed">
          The backend uses the <strong className="text-white">middle-quality variant</strong> selection
          (not highest — Samsung TVs buffer at max bitrate, not lowest — poor quality).
          Middle = the Samsung stability sweet spot. HLS extraction runs server-side so Stremio
          receives a direct playable URL, bypassing Tizen OS HLS handling issues.
        </p>
      </div>

    </div>
  );
};
