import { useState, useCallback, useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { Header } from './components/Header';
import { Notification } from './components/Notification';
import { SourcesTab } from './components/SourcesTab';
import { StreamsTab } from './components/StreamsTab';
import { GroupsTab } from './components/GroupsTab';
import { HealthTab } from './components/HealthTab';
import { StatisticsTab } from './components/StatisticsTab';
import { SettingsTab } from './components/SettingsTab';
import { InstallTab } from './components/InstallTab';
import { ExportPanel } from './components/ExportPanel';
import { StreamHandlerTab } from './components/StreamHandlerTab';
import { BackendPanel } from './components/BackendPanel';
import { SelectionModelsTab } from './components/SelectionModelsTab';
import IPTVPlayer from './components/IPTVPlayer';
import { checkBackendHealth } from './utils/backendSync';
import { Stream } from './types';

export function App() {
  const store = useAppStore();
  const { activeTab, setActiveTab, loading, notification, streams, sources, downloadM3U } = store;

  const [floatDownloading, setFloatDownloading] = useState(false);
  const [backendOnline, setBackendOnline]       = useState(false);
  const [playerStream, setPlayerStream]         = useState<Stream | null>(null);

  // Poll backend health every 30s
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const h = await checkBackendHealth();
      if (mounted) setBackendOnline(!!h);
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const handleOpenPlayer = useCallback((stream: Stream) => {
    setPlayerStream(stream);
    setActiveTab('player');
  }, [setActiveTab]);

  const handleFloatDownload = useCallback(() => {
    setFloatDownloading(true);
    downloadM3U({ playlistName: 'Jash IPTV' });
    setTimeout(() => setFloatDownloading(false), 1500);
  }, [downloadM3U]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-6">
        <div className="relative w-20 h-20">
          <div className="absolute inset-0 rounded-full border-4 border-purple-500/20" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-purple-500 animate-spin" />
          <div className="absolute inset-3 rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-2xl shadow-lg">
            📡
          </div>
        </div>
        <div className="text-center">
          <h2 className="text-white text-xl font-bold mb-1">JASH ADDON</h2>
          <p className="text-gray-400 text-sm">Loading your configuration...</p>
        </div>
      </div>
    );
  }

  const isPlayerTab = activeTab === 'player';

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {notification && <Notification msg={notification.msg} type={notification.type} />}

      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        streamCount={streams.length}
        sourceCount={sources.length}
        backendOnline={backendOnline}
      />

      {/* Player tab — full screen below header */}
      {isPlayerTab ? (
        <div className="fixed inset-0 top-[calc(3.5rem+2.75rem)] bg-black z-30">
          <IPTVPlayer
            streams={streams}
            initialStream={playerStream}
            onClose={() => { setActiveTab('streams'); setPlayerStream(null); }}
            embedded={true}
          />
        </div>
      ) : (
        <main className="max-w-screen-2xl mx-auto px-4 py-6">
          <div className="animate-fade-in">
            {activeTab === 'sources'    && <SourcesTab         store={store} />}
            {activeTab === 'streams'    && <StreamsTab         store={store} onOpenPlayer={handleOpenPlayer} />}
            {activeTab === 'groups'     && <GroupsTab          store={store} />}
            {activeTab === 'health'     && <HealthTab          store={store} />}
            {activeTab === 'statistics' && <StatisticsTab      store={store} />}
            {activeTab === 'models'     && <SelectionModelsTab store={store} />}
            {activeTab === 'handler'    && <StreamHandlerTab   store={store} />}
            {activeTab === 'export'     && <ExportPanel        store={store} />}
            {activeTab === 'backend'    && <BackendPanel       store={store} />}
            {activeTab === 'settings'   && <SettingsTab        store={store} />}
            {activeTab === 'install'    && <InstallTab         store={store} />}
          </div>
        </main>
      )}

      {!isPlayerTab && (
        <footer className="border-t border-gray-800 mt-12 py-5 px-4">
          <div className="max-w-screen-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-600">
            <div className="flex items-center gap-2">
              <span className="text-purple-500">📡</span>
              <span className="font-semibold text-gray-500">JASH ADDON</span>
              <span>— Stremio IPTV Configurator · Samsung Tizen Optimized</span>
            </div>
            <div className="flex items-center gap-4">
              <span className={backendOnline ? 'text-violet-400' : 'text-gray-600'}>
                {backendOnline ? '🖥️ Backend Online' : '🖥️ Backend Offline'}
              </span>
              <span className="text-gray-700">•</span>
              <span className="text-blue-500">🧩 HLS Extraction</span>
              <span className="text-gray-700">•</span>
              <span>{streams.length.toLocaleString()} streams</span>
              <span className="text-gray-700">•</span>
              <span>{sources.length} sources</span>
            </div>
          </div>
        </footer>
      )}

      {/* Floating action buttons */}
      {streams.length > 0 && !isPlayerTab &&
        activeTab !== 'export' && activeTab !== 'handler' && activeTab !== 'backend' && (
        <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
          <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-xl px-3 py-1.5 text-xs text-gray-300 shadow-lg">
            <span className="text-emerald-400 font-bold">{streams.filter(s => s.enabled).length.toLocaleString()}</span>
            <span>enabled</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setActiveTab('player')} title="Open IPTV Player"
              className="flex items-center gap-2 bg-gradient-to-r from-orange-600 to-rose-600 hover:from-orange-500 hover:to-rose-500 text-white px-4 py-3 rounded-xl font-semibold text-sm transition-all shadow-xl active:scale-95">
              <span className="text-lg">▶️</span>
              <span className="hidden sm:inline">Player</span>
            </button>
            <button onClick={handleFloatDownload} title="Download M3U"
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white px-4 py-3 rounded-xl font-semibold text-sm transition-all shadow-xl active:scale-95">
              <span className="text-lg">{floatDownloading ? '✅' : '⬇️'}</span>
              <span className="hidden sm:inline">{floatDownloading ? 'Done!' : 'M3U'}</span>
            </button>
            <button onClick={() => setActiveTab('backend')} title="Backend"
              className={`p-3 rounded-xl text-sm transition-all shadow-xl active:scale-95 border ${
                backendOnline ? 'bg-violet-800/80 hover:bg-violet-700 border-violet-600/50 text-white' : 'bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-400'
              }`}>
              <span className="text-lg">🖥️</span>
            </button>
            <button onClick={() => setActiveTab('handler')} title="HLS Handler"
              className="bg-blue-800/80 hover:bg-blue-700 border border-blue-600/50 text-white p-3 rounded-xl text-sm transition-all shadow-xl active:scale-95">
              <span className="text-lg">🧩</span>
            </button>
          </div>
        </div>
      )}

      {/* Back button from player tab */}
      {isPlayerTab && (
        <div className="fixed bottom-6 left-6 z-40">
          <button
            onClick={() => { setActiveTab('streams'); setPlayerStream(null); }}
            className="flex items-center gap-2 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 text-white px-4 py-2.5 rounded-xl text-sm transition-all shadow-xl">
            ← Back to Streams
          </button>
        </div>
      )}
    </div>
  );
}
