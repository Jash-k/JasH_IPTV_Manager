import React, { useState } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

export const InstallTab: React.FC<Props> = ({ store }) => {
  const { settings, streams, groups } = store;
  const [copied, setCopied] = useState<string | null>(null);

  const manifestUrl = `https://your-server.com/${settings.addonId}/manifest.json`;
  const stremioUrl = `stremio://${manifestUrl.replace('https://', '')}`;

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
    setTimeout(() => setCopied(null), 2000);
  };

  const manifest = {
    id: settings.addonId,
    version: '1.0.0',
    name: settings.addonName,
    description: 'IPTV addon configured via Jash Addon Configurator',
    resources: ['stream', 'catalog'],
    types: ['tv', 'channel'],
    catalogs: groups.slice(0, 20).map(g => ({
      type: 'tv',
      id: `jash_${g.id}`,
      name: g.name,
    })),
    idPrefixes: ['jash_'],
    behaviorHints: { adult: false, p2p: false },
  };

  const manifestJson = JSON.stringify(manifest, null, 2);

  const steps = [
    {
      num: 1,
      title: 'Configure Your Streams',
      desc: 'Add M3U sources, organize groups, and run health checks in the tabs above.',
      icon: '⚙️',
      color: 'from-purple-600 to-indigo-600',
      done: streams.length > 0,
    },
    {
      num: 2,
      title: 'Deploy the Addon Server',
      desc: 'Host the addon server (Node.js) and configure it to read from this configurator\'s export.',
      icon: '🖥️',
      color: 'from-blue-600 to-cyan-600',
      done: false,
    },
    {
      num: 3,
      title: 'Install in Stremio',
      desc: 'Click "Install in Stremio" or paste the manifest URL in Stremio\'s addon settings.',
      icon: '🔌',
      color: 'from-green-600 to-emerald-600',
      done: false,
    },
    {
      num: 4,
      title: 'Enjoy Your Streams',
      desc: 'All configured channels appear in Stremio, organized by your custom groups.',
      icon: '📺',
      color: 'from-orange-600 to-red-600',
      done: false,
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
            { label: 'Groups', value: groups.length, icon: '📂' },
            { label: 'Addon Name', value: settings.addonName, icon: '🏷️' },
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

      {/* Manifest URL */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg">📋 Addon Manifest</h3>

        <div>
          <label className="text-gray-400 text-sm mb-2 block">Manifest URL (after deployment)</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-700 rounded-lg px-4 py-3 text-gray-300 text-sm font-mono truncate border border-gray-600">
              {manifestUrl}
            </div>
            <button
              onClick={() => copyToClipboard(manifestUrl, 'manifest')}
              className={cn('px-4 py-3 rounded-lg text-sm font-medium transition-colors flex-shrink-0',
                copied === 'manifest' ? 'bg-emerald-600 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'
              )}>
              {copied === 'manifest' ? '✓ Copied' : '📋 Copy'}
            </button>
          </div>
        </div>

        <div>
          <label className="text-gray-400 text-sm mb-2 block">Stremio Deep Link</label>
          <div className="flex gap-2">
            <div className="flex-1 bg-gray-700 rounded-lg px-4 py-3 text-purple-300 text-sm font-mono truncate border border-gray-600">
              {stremioUrl}
            </div>
            <button
              onClick={() => copyToClipboard(stremioUrl, 'stremio')}
              className={cn('px-4 py-3 rounded-lg text-sm font-medium transition-colors flex-shrink-0',
                copied === 'stremio' ? 'bg-emerald-600 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'
              )}>
              {copied === 'stremio' ? '✓ Copied' : '📋 Copy'}
            </button>
          </div>
        </div>

        <a
          href={stremioUrl}
          className="flex items-center justify-center gap-3 w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-lg transition-all shadow-lg"
        >
          <span>🚀</span>
          Install in Stremio
        </a>
      </div>

      {/* Manifest Preview */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-semibold">📄 Manifest Preview</h3>
          <button
            onClick={() => copyToClipboard(manifestJson, 'json')}
            className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              copied === 'json' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            )}>
            {copied === 'json' ? '✓ Copied' : '📋 Copy JSON'}
          </button>
        </div>
        <pre className="bg-gray-900 rounded-lg p-4 text-xs text-gray-300 overflow-x-auto max-h-64 border border-gray-700 font-mono">
          {manifestJson}
        </pre>
      </div>

      {/* Samsung Tizen Notes */}
      <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-5">
        <h3 className="text-yellow-300 font-semibold mb-3 flex items-center gap-2">
          📺 Samsung Tizen OS Notes
        </h3>
        <ul className="space-y-2 text-sm text-yellow-200/80">
          <li className="flex items-start gap-2">
            <span className="text-yellow-400 mt-0.5">•</span>
            Install Stremio on your Samsung TV from the Smart Hub app store
          </li>
          <li className="flex items-start gap-2">
            <span className="text-yellow-400 mt-0.5">•</span>
            Navigate to Settings → Addons → Install from URL in Stremio
          </li>
          <li className="flex items-start gap-2">
            <span className="text-yellow-400 mt-0.5">•</span>
            Paste your manifest URL and confirm installation
          </li>
          <li className="flex items-start gap-2">
            <span className="text-yellow-400 mt-0.5">•</span>
            Use the remote's D-pad to navigate channels — groups appear as categories
          </li>
          <li className="flex items-start gap-2">
            <span className="text-yellow-400 mt-0.5">•</span>
            All future changes via this configurator reflect automatically — no reinstall needed
          </li>
        </ul>
      </div>
    </div>
  );
};
