import React, { useState, useEffect } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { getManifestUrl, getStremioInstallUrl, checkBackendHealth } from '../utils/backendSync';

interface Props { store: AppStore; }

export const InstallTab: React.FC<Props> = ({ store }) => {
  const { settings, streams, groups, setActiveTab } = store;
  const [copied, setCopied] = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState(false);

  // Get real manifest URL from backend utility
  const manifestUrl    = getManifestUrl();
  const stremioDeepLink = getStremioInstallUrl();

  useEffect(() => {
    checkBackendHealth().then(h => setBackendOnline(!!h));
  }, []);

  const copyToClipboard = (text: string, key: string) => {
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

  const steps = [
    {
      num  : 1,
      title: 'Configure Your Streams',
      desc : 'Add M3U sources, organize groups, and run health checks in the tabs above.',
      icon : '⚙️',
      color: 'from-purple-600 to-indigo-600',
      done : streams.length > 0,
    },
    {
      num  : 2,
      title: 'Deploy & Sync',
      desc : 'Deploy to Render/Koyeb/Railway (see Backend tab), then click Sync Streams.',
      icon : '🖥️',
      color: 'from-blue-600 to-cyan-600',
      done : backendOnline,
    },
    {
      num  : 3,
      title: 'Copy Manifest URL & Install',
      desc : 'Copy the manifest URL below → open Stremio → Settings → Addons → "Install from URL" → Paste → Install.',
      icon : '🔌',
      color: 'from-green-600 to-emerald-600',
      done : false,
    },
    {
      num  : 4,
      title: 'Enjoy Your Streams',
      desc : 'All configured channels appear in Stremio organized by your groups. No reinstall needed for future changes!',
      icon : '📺',
      color: 'from-orange-600 to-red-600',
      done : false,
    },
  ];

  return (
    <div className="space-y-6 max-w-3xl">

      {/* Hero */}
      <div className="bg-gradient-to-br from-purple-900/60 to-indigo-900/60 border border-purple-700/40 rounded-2xl p-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-3xl shadow-lg">
            🔌
          </div>
          <div>
            <h2 className="text-white font-bold text-2xl">Stremio Installation Guide</h2>
            <p className="text-purple-300 text-sm">Set up your IPTV addon in 4 simple steps</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4">
          {[
            { label: 'Streams Ready', value: streams.length.toLocaleString(), icon: '📺' },
            { label: 'Groups',        value: groups.length,                   icon: '📂' },
            { label: 'Backend',       value: backendOnline ? 'Online' : 'Offline', icon: backendOnline ? '🟢' : '🔴' },
          ].map(s => (
            <div key={s.label} className="bg-white/5 rounded-xl p-3 text-center border border-white/10">
              <div className="text-xl mb-1">{s.icon}</div>
              <div className="text-white font-bold truncate">{s.value}</div>
              <div className="text-purple-300 text-xs">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        <h3 className="text-white font-semibold text-lg">Installation Steps</h3>
        {steps.map(step => (
          <div key={step.num} className={cn(
            'bg-gray-800 rounded-xl p-5 border transition-all',
            step.done ? 'border-emerald-600/40 bg-emerald-900/10' : 'border-gray-700'
          )}>
            <div className="flex items-start gap-4">
              <div className={cn(
                'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-lg flex-shrink-0 shadow',
                step.color
              )}>
                {step.done ? '✅' : step.icon}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-500 text-sm">Step {step.num}</span>
                  {step.done && <span className="text-xs text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded-full">Done</span>}
                </div>
                <h4 className="text-white font-semibold">{step.title}</h4>
                <p className="text-gray-400 text-sm mt-1">{step.desc}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── MANIFEST URL — Most Important Section ── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg flex items-center gap-2">
          <span>📋</span> Manifest URL (Paste in Stremio)
        </h3>

        {!backendOnline && (
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl px-4 py-3 text-yellow-300 text-sm flex items-start gap-2">
            <span>⚠️</span>
            <div>
              Backend is offline — deploy first (see <button onClick={() => setActiveTab('backend')} className="underline hover:text-yellow-200">Backend tab</button>).
              The URL below is your manifest URL once deployed.
            </div>
          </div>
        )}

        {backendOnline && (
          <div className="bg-emerald-900/20 border border-emerald-700/30 rounded-xl px-4 py-2.5 text-emerald-300 text-sm flex items-center gap-2">
            <span>✅</span> Backend is online — copy the URL below and paste it in Stremio!
          </div>
        )}

        {/* HTTP manifest URL — this is what Stremio needs */}
        <div>
          <label className="text-gray-400 text-xs mb-2 block font-medium">
            Addon Manifest URL — paste this in Stremio → Settings → Addons → Install from URL
          </label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-blue-300 text-sm font-mono break-all">
              {manifestUrl}
            </div>
            <button
              onClick={() => copyToClipboard(manifestUrl, 'manifest')}
              className={cn(
                'px-4 py-3 rounded-lg text-sm font-semibold transition-colors flex-shrink-0 min-w-[90px]',
                copied === 'manifest' ? 'bg-emerald-600 text-white' : 'bg-blue-700 hover:bg-blue-600 text-white'
              )}
            >
              {copied === 'manifest' ? '✓ Copied!' : '📋 Copy'}
            </button>
          </div>
        </div>

        {/* Stremio deep link */}
        <div>
          <label className="text-gray-400 text-xs mb-2 block font-medium">
            Stremio Deep Link (click to open Stremio directly on desktop/mobile)
          </label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2.5 text-purple-300 text-sm font-mono truncate">
              {stremioDeepLink}
            </div>
            <button
              onClick={() => copyToClipboard(stremioDeepLink, 'stremio')}
              className={cn(
                'px-3 py-2.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0',
                copied === 'stremio' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
              )}
            >
              {copied === 'stremio' ? '✓' : '📋'}
            </button>
          </div>
        </div>

        {/* One-click install */}
        <a
          href={stremioDeepLink}
          className="flex items-center justify-center gap-3 w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-lg transition-all shadow-lg active:scale-[0.98]"
        >
          <span>🚀</span> Click to Install in Stremio (Desktop / Mobile)
        </a>

        <p className="text-center text-gray-600 text-xs">
          For Samsung Tizen TV — use manual URL entry (see guide below)
        </p>
      </div>

      {/* Quick info about addon name */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center gap-3">
        <span className="text-2xl">🏷️</span>
        <div>
          <div className="text-white font-medium">Addon: <span className="text-purple-300">{settings.addonName}</span></div>
          <div className="text-gray-500 text-xs">ID: {settings.addonId} · Change in Settings tab</div>
        </div>
        <button
          onClick={() => setActiveTab('backend')}
          className="ml-auto px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded-lg text-sm transition-colors flex-shrink-0"
        >
          🖥️ Backend →
        </button>
      </div>

      {/* Samsung Tizen Notes */}
      <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-5">
        <h3 className="text-yellow-300 font-semibold mb-3 flex items-center gap-2">
          📺 Samsung Tizen OS — Manual Install Steps
        </h3>
        <ol className="space-y-2 text-sm text-yellow-200/80 list-none">
          {[
            'Install Stremio from Samsung Smart Hub app store',
            'Open Stremio → log in with your account',
            'Navigate to Settings (⚙️ gear icon, top right)',
            'Select "Addons" from the sidebar',
            'Click "Install from URL"',
            `Type the manifest URL: ${manifestUrl}`,
            'Press OK/Enter → click Install on confirmation',
            'Go to Discover → TV → your groups appear as categories',
            'Use D-pad remote to navigate channels → press OK to play',
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-yellow-600/30 text-yellow-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span className={i === 5 ? 'font-mono text-yellow-300 break-all' : ''}>{step}</span>
            </li>
          ))}
        </ol>

        <div className="mt-4 bg-emerald-900/20 border border-emerald-700/30 rounded-lg p-3">
          <p className="text-emerald-300 text-xs">
            💡 <strong>Easier:</strong> Install on your phone/PC Stremio app using the button above.
            Same Stremio account = addon syncs to your Samsung TV automatically!
          </p>
        </div>

        <div className="mt-3 bg-blue-900/20 border border-blue-700/30 rounded-lg p-3">
          <p className="text-blue-300 text-xs">
            🔧 <strong>No reinstall needed for changes:</strong> Go to Backend tab → Sync Streams.
            Changes reflect automatically in Stremio without reinstalling.
          </p>
        </div>
      </div>
    </div>
  );
};
