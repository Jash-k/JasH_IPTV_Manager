import React, { useState, useEffect } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { getManifestUrl, getBackendBase, checkBackendHealth } from '../utils/backendSync';

interface Props { store: AppStore; }

export const InstallTab: React.FC<Props> = ({ store }) => {
  const { settings, streams, groups, setActiveTab } = store;
  const [copied, setCopied]           = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);
  const [checking, setChecking]       = useState(true);

  const manifestUrl = getManifestUrl();
  // Stremio deep link: stremio://HOST:PORT/manifest.json (no protocol prefix)
  const hostPart    = getBackendBase().replace(/^https?:\/\//, '');
  const deepLink    = `stremio://${hostPart}/manifest.json`;

  useEffect(() => {
    setChecking(true);
    checkBackendHealth()
      .then(h => setBackendOnline(!!h))
      .finally(() => setChecking(false));
  }, []);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
    setCopied(key);
    setTimeout(() => setCopied(null), 2500);
  };

  const CopyBtn = ({ text, id, label = '📋 Copy' }: { text: string; id: string; label?: string }) => (
    <button
      onClick={() => copy(text, id)}
      className={cn(
        'px-4 py-2.5 rounded-lg text-sm font-semibold transition-all flex-shrink-0 min-w-[90px]',
        copied === id
          ? 'bg-emerald-600 text-white scale-95'
          : 'bg-blue-700 hover:bg-blue-600 text-white'
      )}
    >
      {copied === id ? '✓ Copied!' : label}
    </button>
  );

  return (
    <div className="space-y-6 max-w-3xl">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-br from-purple-900/60 to-indigo-900/60 border border-purple-700/40 rounded-2xl p-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-3xl shadow-lg">
            🔌
          </div>
          <div>
            <h2 className="text-white font-bold text-2xl">Install in Stremio</h2>
            <p className="text-purple-300 text-sm">Works on PC, Mobile & Samsung Tizen TV</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Streams',  value: streams.length.toLocaleString(), icon: '📺' },
            { label: 'Groups',   value: groups.length,                   icon: '📂' },
            { label: 'Backend',  value: checking ? '…' : backendOnline ? 'Online' : 'Offline',
              icon: checking ? '⏳' : backendOnline ? '🟢' : '🔴' },
          ].map(s => (
            <div key={s.label} className="bg-white/5 rounded-xl p-3 text-center border border-white/10">
              <div className="text-xl mb-1">{s.icon}</div>
              <div className="text-white font-bold truncate">{s.value}</div>
              <div className="text-purple-300 text-xs">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Backend status warning ─────────────────────────────────────── */}
      {!checking && !backendOnline && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-xl p-4 flex items-start gap-3">
          <span className="text-red-400 text-xl flex-shrink-0">⚠️</span>
          <div>
            <div className="text-red-300 font-medium">Backend is offline</div>
            <div className="text-red-200/70 text-sm mt-1">
              Deploy your project first (
              <button onClick={() => setActiveTab('backend')} className="underline hover:text-red-200">Backend tab</button>
              ), then sync your streams. The manifest URL below will work once deployed.
            </div>
          </div>
        </div>
      )}

      {!checking && backendOnline && (
        <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-xl p-3 flex items-center gap-3">
          <span className="text-emerald-400">✅</span>
          <span className="text-emerald-300 text-sm font-medium">
            Backend is online — copy the manifest URL below and paste it in Stremio!
          </span>
        </div>
      )}

      {/* ── METHOD 1: Paste in Stremio (Primary method) ──────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div className="bg-gradient-to-r from-blue-900/40 to-indigo-900/40 border-b border-gray-700 px-5 py-3 flex items-center gap-2">
          <span className="text-blue-300 font-semibold">Method 1 — Paste URL in Stremio</span>
          <span className="text-xs text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full ml-auto">✓ Works on ALL devices</span>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            <label className="text-gray-400 text-xs font-medium block">
              📋 Manifest URL — paste this in Stremio → Settings → Addons → Install from URL
            </label>
            <div className="flex gap-2">
              <div className="flex-1 bg-gray-900 border border-blue-600/50 rounded-lg px-4 py-3 text-blue-300 text-sm font-mono break-all select-all">
                {manifestUrl}
              </div>
              <CopyBtn text={manifestUrl} id="manifest" label="📋 Copy" />
            </div>
          </div>

          <div className="bg-gray-700/40 rounded-xl p-4 space-y-2">
            <div className="text-white text-sm font-medium">Step-by-step:</div>
            <ol className="space-y-1.5 text-sm text-gray-300">
              {[
                'Open Stremio on any device (PC, phone, TV)',
                'Click the ⚙️ Settings icon (top-right)',
                'Go to Addons → scroll to top → click "Install from URL"',
                `Paste: ${manifestUrl}`,
                'Click Install → confirm → Done! ✅',
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-600/30 text-blue-300 text-xs flex items-center justify-center flex-shrink-0 mt-0.5 font-bold">
                    {i + 1}
                  </span>
                  <span className={i === 3 ? 'font-mono text-blue-300 text-xs break-all' : ''}>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {/* ── METHOD 2: Deep Link (Desktop/Mobile) ─────────────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <div className="bg-gradient-to-r from-purple-900/40 to-pink-900/40 border-b border-gray-700 px-5 py-3 flex items-center gap-2">
          <span className="text-purple-300 font-semibold">Method 2 — One-click Install (Desktop/Mobile)</span>
          <span className="text-xs text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded-full ml-auto">🖥️ PC & 📱 Mobile</span>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-gray-400 text-sm">
            If Stremio is installed on your device, clicking the button below opens it directly with the addon ready to install.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-purple-300 text-xs font-mono truncate">
              {deepLink}
            </div>
            <CopyBtn text={deepLink} id="deeplink" label="📋" />
          </div>
          <a
            href={deepLink}
            className="flex items-center justify-center gap-3 w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-base transition-all shadow-lg active:scale-[0.98]"
          >
            <span>🚀</span> Click to Install in Stremio
          </a>
          <p className="text-gray-600 text-xs text-center">
            Requires Stremio desktop or mobile app to be installed on this device
          </p>
        </div>
      </div>

      {/* ── METHOD 3: Samsung Tizen ───────────────────────────────────── */}
      <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl overflow-hidden">
        <div className="border-b border-yellow-700/30 px-5 py-3 flex items-center gap-2">
          <span className="text-yellow-300 font-semibold">📺 Samsung Tizen TV — Manual Install</span>
          <span className="text-xs text-yellow-200/60 ml-auto">Use Method 1 URL</span>
        </div>
        <div className="p-5 space-y-4">
          {/* Easier tip first */}
          <div className="bg-emerald-900/30 border border-emerald-700/30 rounded-xl p-4">
            <div className="text-emerald-300 font-medium text-sm mb-1">💡 Easiest Way</div>
            <p className="text-emerald-200/70 text-sm">
              Install the addon on your <strong>phone or PC Stremio app</strong> using Method 1 above.
              Since you use the same Stremio account, the addon <strong>syncs to your Samsung TV automatically!</strong>
            </p>
          </div>

          {/* Manual steps */}
          <div className="text-yellow-300 text-sm font-medium">Or install manually on the TV:</div>
          <div className="space-y-2">
            {[
              { icon: '📺', title: 'Open Stremio on Samsung TV', desc: 'Launch from Smart Hub. Sign in with your account.' },
              { icon: '⚙️', title: 'Press Menu or navigate to Settings', desc: 'Look for the gear icon top-right. Press OK on the remote.' },
              { icon: '🔌', title: 'Go to Addons', desc: 'Select "Addons" from the settings sidebar menu.' },
              { icon: '🔗', title: 'Tap "Install from URL"', desc: 'Button at the top of the Addons page.' },
              {
                icon     : '⌨️',
                title    : 'Type the Manifest URL',
                desc     : `Using the on-screen keyboard, enter exactly:`,
                highlight: manifestUrl,
              },
              { icon: '✅', title: 'Press OK → Install', desc: 'Stremio shows a confirmation. Select Install.' },
              { icon: '📡', title: 'Open Discover → TV', desc: 'Your channel groups appear as categories. Use D-pad to navigate and OK to play.' },
            ].map((step, i) => (
              <div key={i} className="flex items-start gap-3 bg-yellow-900/10 rounded-lg p-3 border border-yellow-800/20">
                <div className="w-7 h-7 rounded-full bg-yellow-600/30 flex items-center justify-center text-yellow-300 font-bold text-sm flex-shrink-0">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-medium flex items-center gap-2">
                    <span>{step.icon}</span> {step.title}
                  </div>
                  <div className="text-yellow-200/60 text-xs mt-1">{step.desc}</div>
                  {'highlight' in step && step.highlight && (
                    <div className="mt-2 flex gap-2">
                      <div className="flex-1 bg-gray-900/80 border border-yellow-600/40 rounded-lg px-3 py-2 text-yellow-300 text-xs font-mono break-all">
                        {step.highlight}
                      </div>
                      <CopyBtn text={step.highlight} id={`tv-step-${i}`} label="Copy" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Remote tips */}
          <div className="bg-gray-800/60 rounded-xl p-4 grid grid-cols-2 gap-2 text-xs text-gray-400">
            <div>⬆⬇⬅➡ — Navigate</div>
            <div>OK/Enter — Select / Play</div>
            <div>Back — Go back</div>
            <div>Menu — Settings</div>
          </div>
        </div>
      </div>

      {/* ── Addon info & no-reinstall note ───────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏷️</span>
          <div className="flex-1">
            <div className="text-white font-medium">Addon: <span className="text-purple-300">{settings.addonName}</span></div>
            <div className="text-gray-500 text-xs">ID: {settings.addonId} · Change in Settings tab</div>
          </div>
          <button
            onClick={() => setActiveTab('backend')}
            className="px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded-lg text-sm transition-colors"
          >
            🖥️ Backend →
          </button>
        </div>
        <div className="bg-blue-900/20 border border-blue-700/30 rounded-lg p-3">
          <p className="text-blue-300 text-xs">
            🔧 <strong>No reinstall needed for future changes.</strong> Go to Backend tab → Sync Streams after editing channels.
            Stremio automatically detects the new version and updates your channel list.
          </p>
        </div>
      </div>

    </div>
  );
};
