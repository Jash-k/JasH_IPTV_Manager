import { useState, useEffect } from 'react';
import { getBackendBase } from '../utils/backendSync';

interface InstallInfo {
  manifestUrl   : string;
  stremioUrl    : string;
  webInstallUrl : string;
  configureUrl  : string;
  playlistUrl   : string;
  shortUrls     : Record<string, string>;
  version       : string;
  streams       : number;
  addonId       : string;
  addonName     : string;
}

export const InstallTab: React.FC<{ store: any }> = ({ store }) => {
  const { streams } = store;
  const [info,       setInfo]      = useState<InstallInfo | null>(null);
  const [loading,    setLoading]   = useState(true);
  const [error,      setError]     = useState('');
  const [copied,     setCopied]    = useState('');

  const base = getBackendBase();

  // Fallback install info built from known base URL
  const fallback: InstallInfo = {
    manifestUrl  : `${base}/manifest.json`,
    stremioUrl   : `stremio://${base.replace(/^https?:\/\//, '')}/manifest.json`,
    webInstallUrl: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${base}/manifest.json`)}`,
    configureUrl : `${base}/`,
    playlistUrl  : `${base}/playlist.m3u`,
    shortUrls    : {
      m3u     : `${base}/p.m3u`,
      iptv    : `${base}/iptv.m3u`,
      live    : `${base}/live.m3u`,
      channels: `${base}/channels.m3u`,
    },
    version  : '1.0.0',
    streams  : streams.filter((s: any) => s.enabled !== false).length,
    addonId  : 'community.jash-iptv',
    addonName: 'Jash IPTV',
  };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const r = await fetch(`${base}/api/install`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (mounted) setInfo(data);
      } catch (e: any) {
        if (mounted) {
          setInfo(fallback);
          setError('Backend offline — showing estimated URLs. Deploy and sync first.');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [base]);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    });
  };

  const data = info || fallback;

  const CopyBtn = ({ text, id }: { text: string; id: string }) => (
    <button
      onClick={() => copy(text, id)}
      className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
        copied === id
          ? 'bg-green-500/20 text-green-400 border border-green-500/40'
          : 'bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600'
      }`}
    >
      {copied === id ? '✅ Copied' : '📋 Copy'}
    </button>
  );

  const UrlRow = ({ label, url, id, accent = 'purple' }: { label: string; url: string; id: string; accent?: string }) => {
    const colors: Record<string, string> = {
      purple: 'border-purple-700/40 bg-purple-950/20',
      blue  : 'border-blue-700/40 bg-blue-950/20',
      green : 'border-green-700/40 bg-green-950/20',
      orange: 'border-orange-700/40 bg-orange-950/20',
      teal  : 'border-teal-700/40 bg-teal-950/20',
    };
    return (
      <div className={`border rounded-xl p-3 mb-2 ${colors[accent] || colors.purple}`}>
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-200 break-all flex-1">{url}</span>
          <CopyBtn text={url} id={id} />
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-purple-500/30 border-t-purple-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Fetching install info from backend…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">

      {/* Header */}
      <div className="bg-gradient-to-r from-purple-900/40 to-indigo-900/40 border border-purple-700/40 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-3xl shadow-xl flex-shrink-0">
            📡
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-bold text-white mb-1">{data.addonName}</h2>
            <p className="text-purple-300 text-sm mb-3">Stremio IPTV Addon · Samsung Tizen Optimized · v{data.version}</p>
            <div className="flex flex-wrap gap-2">
              <span className="bg-green-500/20 border border-green-500/40 text-green-400 px-3 py-1 rounded-full text-xs font-semibold">
                ✅ {data.streams > 0 ? `${data.streams.toLocaleString()} streams ready` : 'Ready to install'}
              </span>
              <span className="bg-purple-500/20 border border-purple-500/40 text-purple-300 px-3 py-1 rounded-full text-xs font-semibold">
                🔖 v{data.version}
              </span>
              <span className="bg-blue-500/20 border border-blue-500/40 text-blue-300 px-3 py-1 rounded-full text-xs font-semibold">
                📡 {data.addonId}
              </span>
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-3 bg-yellow-900/30 border border-yellow-700/40 rounded-lg p-3 text-yellow-400 text-sm">
            ⚠️ {error}
          </div>
        )}
      </div>

      {/* Primary Install — Big Buttons */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6">
        <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <span>🎬</span> Install in Stremio
        </h3>

        <div className="grid sm:grid-cols-2 gap-3 mb-5">
          {/* Stremio App deep-link */}
          <a
            href={data.stremioUrl}
            className="flex flex-col items-center gap-2 bg-gradient-to-br from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white p-5 rounded-xl font-bold transition-all shadow-lg hover:shadow-purple-500/30 active:scale-95 text-center"
          >
            <span className="text-3xl">🎬</span>
            <span className="text-lg">Install in Stremio</span>
            <span className="text-purple-200 text-xs font-normal">Opens Stremio app directly</span>
          </a>

          {/* Web Stremio */}
          <a
            href={data.webInstallUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-col items-center gap-2 bg-gradient-to-br from-blue-700 to-blue-800 hover:from-blue-600 hover:to-blue-700 text-white p-5 rounded-xl font-bold transition-all shadow-lg active:scale-95 text-center"
          >
            <span className="text-3xl">🌐</span>
            <span className="text-lg">Stremio Web</span>
            <span className="text-blue-200 text-xs font-normal">Install via browser</span>
          </a>
        </div>

        {/* Manifest URL */}
        <UrlRow
          label="📋 Manifest URL — paste in Stremio → Search addons → paste URL"
          url={data.manifestUrl}
          id="manifest"
          accent="purple"
        />

        <UrlRow
          label="🎬 Stremio Deep-link (copy & open in browser)"
          url={data.stremioUrl}
          id="stremio"
          accent="blue"
        />
      </div>

      {/* M3U Playlist URLs */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6">
        <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <span>📻</span> M3U Playlist URLs
          <span className="text-xs font-normal text-gray-400 ml-1">— use in Tivimate, OTT Navigator, IPTV Smarters, VLC, Kodi</span>
        </h3>

        <UrlRow label="🔗 Main playlist (recommended)" url={data.playlistUrl} id="playlist" accent="green" />
        <UrlRow label="⚡ Short URL — easiest to type" url={data.shortUrls?.m3u || `${base}/p.m3u`} id="short" accent="teal" />
        <UrlRow label="📺 Alternative" url={data.shortUrls?.iptv || `${base}/iptv.m3u`} id="iptv" accent="teal" />
        <UrlRow label="📺 Alternative" url={data.shortUrls?.live || `${base}/live.m3u`} id="live" accent="teal" />

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          {[
            { player: 'Tivimate',        icon: '📺', tip: 'Playlist → Add Playlist → M3U URL' },
            { player: 'OTT Navigator',   icon: '🧭', tip: 'Sources → New Source → M3U' },
            { player: 'IPTV Smarters',   icon: '📡', tip: 'Add User → M3U URL' },
            { player: 'GSE IPTV',        icon: '🎯', tip: 'Remote Playlists → M3U URL' },
            { player: 'VLC',             icon: '🎬', tip: 'Media → Open Network Stream' },
            { player: 'Kodi PVR',        icon: '🖥️', tip: 'Add-ons → PVR IPTV Simple Client' },
          ].map(p => (
            <div key={p.player} className="bg-gray-800 border border-gray-700 rounded-lg p-2.5">
              <div className="font-semibold text-gray-300">{p.icon} {p.player}</div>
              <div className="text-gray-500 mt-0.5">{p.tip}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Samsung Tizen TV Guide */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6">
        <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <span>📺</span> Samsung Tizen TV Installation
        </h3>
        <div className="space-y-3">
          {[
            { n: 1, title: 'Install Stremio',       desc: 'Samsung TV App Store → Search "Stremio" → Install' },
            { n: 2, title: 'Open Stremio',           desc: 'Launch Stremio, create account or sign in' },
            { n: 3, title: 'Go to Addons',           desc: 'Remote: navigate to ≡ Menu → Addons (🧩 icon)' },
            { n: 4, title: 'Add Addon by URL',       desc: 'Press the search icon, select "Add addon URL"' },
            { n: 5, title: 'Enter manifest URL',     desc: `Type: ${data.manifestUrl.replace('https://', '')}` },
            { n: 6, title: 'Install',                desc: 'Press OK / Confirm — addon installs immediately' },
            { n: 7, title: 'Browse channels',        desc: 'Go to TV section → your group catalogs appear' },
            { n: 8, title: 'Future changes',         desc: 'Open configurator → add/edit sources → Sync → changes auto-reflect, no reinstall needed' },
          ].map(step => (
            <div key={step.n} className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-purple-900/60 border border-purple-600/50 flex items-center justify-center text-purple-400 text-xs font-bold flex-shrink-0">
                {step.n}
              </div>
              <div>
                <div className="text-white text-sm font-semibold">{step.title}</div>
                <div className="text-gray-400 text-xs">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stremio Filters Info */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6">
        <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <span>🔍</span> Stremio Catalog Filters
        </h3>
        <p className="text-gray-400 text-sm mb-4">
          Your addon supports multiple filters in Stremio's catalog view:
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {[
            { icon: '🔍', name: 'Search',    desc: 'Type to search channels by name within any group' },
            { icon: '📂', name: 'Genre',     desc: 'Filter by group/genre — one catalog per group' },
            { icon: '⭐', name: 'Best',      desc: '"⭐ Best Streams" catalog shows auto-combined multi-source channels' },
            { icon: '📄', name: 'Pagination',desc: 'Loads 100 channels per page automatically' },
          ].map(f => (
            <div key={f.name} className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="text-lg mb-1">{f.icon} <span className="text-white font-semibold text-sm">{f.name}</span></div>
              <div className="text-gray-400 text-xs">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick reference */}
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6">
        <h3 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
          <span>🔗</span> All Endpoints Quick Reference
        </h3>
        <div className="space-y-2 font-mono text-xs">
          {[
            { path: '/manifest.json',     desc: 'Stremio addon manifest',          color: 'text-purple-400' },
            { path: '/catalog/tv/jash_cat_0.json', desc: 'First group catalog',   color: 'text-blue-400'   },
            { path: '/stream/tv/:id.json',desc: 'Stream resolver (HLS extraction)',color: 'text-green-400'  },
            { path: '/playlist.m3u',      desc: 'Full M3U playlist',              color: 'text-teal-400'   },
            { path: '/p.m3u',             desc: 'Short M3U URL',                  color: 'text-teal-400'   },
            { path: '/health',            desc: 'Health check JSON',              color: 'text-yellow-400' },
            { path: '/api/sync',          desc: 'POST — sync config from UI',     color: 'text-orange-400' },
            { path: '/api/install',       desc: 'GET — all install URLs',         color: 'text-indigo-400' },
          ].map(e => (
            <div key={e.path} className="flex items-center gap-3 bg-gray-800/60 rounded-lg px-3 py-2">
              <span className={`${e.color} w-64 flex-shrink-0`}>{base}{e.path}</span>
              <span className="text-gray-500">—</span>
              <span className="text-gray-400">{e.desc}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};
