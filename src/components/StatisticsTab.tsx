import { useMemo } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { countExportableStreams } from '../utils/m3uExporter';

interface Props { store: AppStore; }

export const StatisticsTab: React.FC<Props> = ({ store }) => {
  const { streams, sources, groups, exportConfigData, importConfigData, downloadM3U, setActiveTab, notify } = store;
  const exportCount = countExportableStreams(streams);

  const stats = useMemo(() => {
    const alive = streams.filter(s => s.status === 'alive').length;
    const dead = streams.filter(s => s.status === 'dead').length;
    const enabled = streams.filter(s => s.enabled).length;
    const checked = alive + dead;
    const healthPct = checked > 0 ? Math.round((alive / checked) * 100) : 0;

    const byGroup = groups.map(g => ({
      name: g.name,
      count: streams.filter(s => s.group === g.name).length,
      alive: streams.filter(s => s.group === g.name && s.status === 'alive').length,
    })).sort((a, b) => b.count - a.count).slice(0, 10);

    const bySource = sources.map(src => ({
      name: src.name,
      count: streams.filter(s => s.sourceId === src.id).length,
      type: src.type,
    })).sort((a, b) => b.count - a.count);

    const duplicates = (() => {
      const urlMap = new Map<string, number>();
      streams.forEach(s => urlMap.set(s.url, (urlMap.get(s.url) || 0) + 1));
      return [...urlMap.entries()].filter(([, c]) => c > 1).length;
    })();

    return { alive, dead, enabled, checked, healthPct, byGroup, bySource, duplicates };
  }, [streams, sources, groups]);

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        await importConfigData(config);
      } catch {
        notify('Invalid configuration file', 'error');
      }
    };
    input.click();
  };

  return (
    <div className="space-y-6">
      {/* Main Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Sources', value: sources.length, icon: '📡', color: 'from-purple-600 to-purple-700' },
          { label: 'Streams', value: streams.length.toLocaleString(), icon: '📺', color: 'from-blue-600 to-blue-700' },
          { label: 'Groups', value: groups.length, icon: '📂', color: 'from-indigo-600 to-indigo-700' },
          { label: 'Alive', value: stats.alive.toLocaleString(), icon: '✅', color: 'from-emerald-600 to-emerald-700' },
          { label: 'Dead', value: stats.dead.toLocaleString(), icon: '❌', color: 'from-red-600 to-red-700' },
          { label: 'Health', value: `${stats.healthPct}%`, icon: '❤️', color: 'from-pink-600 to-pink-700' },
        ].map(s => (
          <div key={s.label} className={cn('bg-gradient-to-br rounded-xl p-4 text-white text-center shadow-lg', s.color)}>
            <div className="text-2xl mb-1">{s.icon}</div>
            <div className="text-2xl font-bold">{s.value}</div>
            <div className="text-white/70 text-xs mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top Groups */}
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
          <h3 className="text-white font-semibold mb-4">📂 Top Groups by Streams</h3>
          <div className="space-y-2">
            {stats.byGroup.length === 0 && <p className="text-gray-500 text-sm">No groups yet</p>}
            {stats.byGroup.map((g, i) => {
              const max = stats.byGroup[0]?.count || 1;
              const pct = Math.round((g.count / max) * 100);
              return (
                <div key={g.name} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500 text-xs w-4">{i + 1}</span>
                      <span className="text-white truncate max-w-[180px]">{g.name}</span>
                    </div>
                    <span className="text-gray-400 text-xs">{g.count.toLocaleString()}</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sources Breakdown */}
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
          <h3 className="text-white font-semibold mb-4">📡 Sources Breakdown</h3>
          <div className="space-y-2">
            {stats.bySource.length === 0 && <p className="text-gray-500 text-sm">No sources yet</p>}
            {stats.bySource.map(s => {
              const max = stats.bySource[0]?.count || 1;
              const pct = Math.round((s.count / max) * 100);
              return (
                <div key={s.name} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white truncate max-w-[200px]">{s.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 capitalize">{s.type}</span>
                      <span className="text-gray-400 text-xs">{s.count.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center gap-3">
          <span className="text-3xl">🔄</span>
          <div>
            <div className="text-white font-bold text-xl">{stats.duplicates}</div>
            <div className="text-gray-500 text-sm">Duplicate URLs</div>
          </div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center gap-3">
          <span className="text-3xl">▶️</span>
          <div>
            <div className="text-white font-bold text-xl">{stats.enabled.toLocaleString()}</div>
            <div className="text-gray-500 text-sm">Enabled Streams</div>
          </div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center gap-3">
          <span className="text-3xl">🔬</span>
          <div>
            <div className="text-white font-bold text-xl">{stats.checked.toLocaleString()}</div>
            <div className="text-gray-500 text-sm">Health Checked</div>
          </div>
        </div>
      </div>

      {/* Export / Import */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold">💾 Backup, Restore & Download</h3>

        {/* M3U Download highlight */}
        <div className="bg-gradient-to-r from-emerald-900/40 to-teal-900/40 border border-emerald-700/40 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">⬇️</span>
            <div>
              <div className="text-white font-semibold">Download M3U Playlist</div>
              <div className="text-emerald-300/70 text-sm">
                {exportCount.toLocaleString()} enabled streams · compatible with VLC, Kodi, Tivimate &amp; more
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => downloadM3U({ playlistName: 'Jash IPTV' })}
              disabled={!exportCount}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ⬇️ Download
            </button>
            <button
              onClick={() => setActiveTab('export')}
              className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white rounded-xl font-medium text-sm transition-colors"
            >
              🎛️ Options
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button onClick={exportConfigData}
            className="flex items-center justify-center gap-3 px-5 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl font-medium transition-all shadow-lg">
            <span className="text-2xl">📤</span>
            <div className="text-left">
              <div className="font-semibold">Export Configuration</div>
              <div className="text-sm text-white/70">Download as JSON backup</div>
            </div>
          </button>
          <button onClick={handleImport}
            className="flex items-center justify-center gap-3 px-5 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-medium transition-all shadow-lg">
            <span className="text-2xl">📥</span>
            <div className="text-left">
              <div className="font-semibold">Import Configuration</div>
              <div className="text-sm text-white/70">Restore from JSON backup</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
