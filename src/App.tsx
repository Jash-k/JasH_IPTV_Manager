import { Toaster } from 'react-hot-toast';
import { useStore } from './store/useStore';
import SourcesTab from './components/SourcesTab';
import ChannelsTab from './components/ChannelsTab';
import GroupsTab from './components/GroupsTab';
import PlaylistsTab from './components/PlaylistsTab';
import DrmTab from './components/DrmTab';
import ServerTab from './components/ServerTab';
import { Tv2, Database, Layers, List, Shield, Server, Menu, X, Star } from 'lucide-react';
import { useState } from 'react';
import { TabType } from './types';

const TABS: { id: TabType; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'sources', label: 'Sources', icon: <Database className="w-4 h-4" />, color: 'text-blue-400' },
  { id: 'channels', label: 'Channels', icon: <Tv2 className="w-4 h-4" />, color: 'text-green-400' },
  { id: 'groups', label: 'Groups', icon: <Layers className="w-4 h-4" />, color: 'text-yellow-400' },
  { id: 'playlists', label: 'Playlists', icon: <List className="w-4 h-4" />, color: 'text-purple-400' },
  { id: 'drm', label: 'DRM Proxy', icon: <Shield className="w-4 h-4" />, color: 'text-red-400' },
  { id: 'server', label: 'Server', icon: <Server className="w-4 h-4" />, color: 'text-orange-400' },
];

export default function App() {
  const { activeTab, setActiveTab, channels, sources, playlists, drmProxies, showTamilOnly, setShowTamilOnly } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const tamilCount = channels.filter(c => c.isTamil).length;
  const activeChannels = channels.filter(c => c.isActive).length;

  const renderTab = () => {
    switch (activeTab) {
      case 'sources': return <SourcesTab />;
      case 'channels': return <ChannelsTab />;
      case 'groups': return <GroupsTab />;
      case 'playlists': return <PlaylistsTab />;
      case 'drm': return <DrmTab />;
      case 'server': return <ServerTab />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <Toaster
        position="top-right"
        toastOptions={{
          style: { background: '#1f2937', color: '#fff', border: '1px solid #374151' },
          success: { iconTheme: { primary: '#4ade80', secondary: '#1f2937' } },
          error: { iconTheme: { primary: '#f87171', secondary: '#1f2937' } },
        }}
      />

      {/* Top Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-4 py-3 flex items-center justify-between shrink-0 z-50">
        <div className="flex items-center gap-3">
          <button onClick={() => setSidebarOpen(!sidebarOpen)}
            className="md:hidden p-1.5 text-gray-400 hover:text-white transition-colors">
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Tv2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-sm leading-none">IPTV Manager</h1>
              <p className="text-gray-500 text-xs leading-none mt-0.5">Pro · Proxy · DRM · Tamil</p>
            </div>
          </div>
        </div>

        {/* Quick Stats + Tamil Filter */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span className="text-gray-400">{sources.length} src</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-gray-400">{activeChannels.toLocaleString()} ch</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
              <span className="text-gray-400">{playlists.length} pl</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
              <span className="text-gray-400">{drmProxies.length} drm</span>
            </div>
          </div>

          {/* Global Tamil Toggle */}
          {tamilCount > 0 && (
            <button
              onClick={() => {
                setShowTamilOnly(!showTamilOnly);
                if (activeTab !== 'channels') setActiveTab('channels');
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                showTamilOnly
                  ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30'
                  : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-orange-600 hover:text-orange-400'
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${showTamilOnly ? 'fill-white' : ''}`} />
              Tamil
              <span className={`text-xs px-1 py-0.5 rounded font-bold ${showTamilOnly ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
                {tamilCount}
              </span>
            </button>
          )}

          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-green-400 text-xs font-medium hidden sm:inline">Live</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className={`
          fixed inset-y-0 left-0 z-40 w-56 bg-gray-900 border-r border-gray-800 pt-16 flex flex-col transition-transform duration-200
          md:relative md:inset-auto md:translate-x-0 md:pt-0 md:z-auto shrink-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
            <p className="text-gray-600 text-xs font-semibold uppercase tracking-wider px-3 mb-3 mt-2">Navigation</p>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => { setActiveTab(tab.id); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.id ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
                }`}>
                <span className={activeTab === tab.id ? tab.color : ''}>{tab.icon}</span>
                {tab.label}
                {tab.id === 'channels' && channels.length > 0 && (
                  <span className="ml-auto text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{channels.length}</span>
                )}
                {tab.id === 'sources' && sources.length > 0 && (
                  <span className="ml-auto text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{sources.length}</span>
                )}
                {tab.id === 'playlists' && playlists.length > 0 && (
                  <span className="ml-auto text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{playlists.length}</span>
                )}
                {tab.id === 'drm' && drmProxies.length > 0 && (
                  <span className="ml-auto text-xs bg-purple-900/60 text-purple-400 px-1.5 py-0.5 rounded-full">{drmProxies.length}</span>
                )}
              </button>
            ))}
          </nav>

          {/* Tamil Quick Filter in Sidebar */}
          {tamilCount > 0 && (
            <div className="px-3 pb-2">
              <button
                onClick={() => { setShowTamilOnly(!showTamilOnly); setActiveTab('channels'); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  showTamilOnly ? 'bg-orange-500 text-white' : 'bg-orange-500/10 text-orange-400 border border-orange-500/20 hover:bg-orange-500/20'
                }`}
              >
                <Star className={`w-4 h-4 ${showTamilOnly ? 'fill-white' : 'fill-orange-400'}`} />
                🎬 Tamil Channels
                <span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-bold ${showTamilOnly ? 'bg-orange-400 text-orange-900' : 'bg-orange-500/20 text-orange-400'}`}>
                  {tamilCount}
                </span>
              </button>
            </div>
          )}

          {/* Sidebar Footer */}
          <div className="p-4 border-t border-gray-800">
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-400 font-medium mb-1">Server Status</p>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-green-400 text-xs">Auto-Sync Active</span>
              </div>
              <p className="text-gray-600 text-xs truncate font-mono">{window.location.origin}</p>
            </div>
          </div>
        </aside>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          {/* Tab Header */}
          <div className="sticky top-0 z-20 bg-gray-950 border-b border-gray-800 px-6 py-4">
            <div className="flex items-center gap-3">
              {TABS.find(t => t.id === activeTab) && (
                <>
                  <span className={TABS.find(t => t.id === activeTab)!.color}>
                    {TABS.find(t => t.id === activeTab)!.icon}
                  </span>
                  <h2 className="text-white font-semibold text-lg">
                    {TABS.find(t => t.id === activeTab)!.label}
                  </h2>
                </>
              )}
              {showTamilOnly && activeTab === 'channels' && (
                <span className="flex items-center gap-1 text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2.5 py-1 rounded-full font-semibold">
                  <Star className="w-3 h-3 fill-orange-400" /> Tamil Filter ON
                </span>
              )}
            </div>

            {/* Mobile bottom nav */}
            <div className="flex md:hidden gap-1 mt-3 overflow-x-auto pb-1">
              {TABS.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    activeTab === tab.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
                  }`}>
                  <span className={activeTab === tab.id ? tab.color : ''}>{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6">
            {renderTab()}
          </div>
        </main>
      </div>
    </div>
  );
}
