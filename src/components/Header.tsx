import { Tab } from '../types';
import { cn } from '../utils/cn';

interface Props {
  activeTab: Tab;
  setActiveTab: (t: Tab) => void;
  streamCount: number;
  sourceCount: number;
  backendOnline?: boolean;
}

const tabs: { id: Tab; label: string; icon: string; highlight?: string; badge?: string }[] = [
  { id: 'sources',    label: 'Sources',   icon: '📡' },
  { id: 'streams',    label: 'Streams',   icon: '📺' },
  { id: 'groups',     label: 'Groups',    icon: '📂' },
  { id: 'health',     label: 'Health',    icon: '❤️' },
  { id: 'statistics', label: 'Stats',     icon: '📊' },
  { id: 'models',     label: 'Models',    icon: '🎯', highlight: 'rose',   badge: 'NEW' },
  { id: 'handler',    label: 'Handler',   icon: '🧩', highlight: 'blue',   badge: 'HLS' },
  { id: 'export',     label: 'Export',    icon: '⬇️', highlight: 'green',  badge: '↓'   },
  { id: 'backend',    label: 'Backend',   icon: '🖥️', highlight: 'violet', badge: 'LIVE'},
  { id: 'player',     label: 'Player',    icon: '▶️',  highlight: 'orange', badge: 'TV'  },
  { id: 'settings',   label: 'Settings',  icon: '⚙️' },
  { id: 'install',    label: 'Install',   icon: '🔌' },
];

export const Header: React.FC<Props> = ({
  activeTab, setActiveTab, streamCount, sourceCount, backendOnline,
}) => {
  return (
    <header className="bg-gray-900 border-b border-gray-700 sticky top-0 z-40">
      <div className="max-w-screen-2xl mx-auto px-4">

        {/* Top bar */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-xl shadow-lg">
              📡
            </div>
            <div>
              <h1 className="text-white font-bold text-xl tracking-tight">JASH ADDON</h1>
              <p className="text-gray-400 text-xs">Stremio IPTV Configurator · Samsung Tizen Optimized</p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <div className="flex items-center gap-1.5 bg-gray-800 px-3 py-1.5 rounded-lg">
              <span className="text-purple-400 font-bold">📡</span>
              <span className="text-gray-300 font-semibold">{sourceCount}</span>
              <span className="text-gray-500 text-xs">sources</span>
            </div>
            <div className="flex items-center gap-1.5 bg-gray-800 px-3 py-1.5 rounded-lg">
              <span className="text-blue-400 font-bold">📺</span>
              <span className="text-gray-300 font-semibold">{streamCount.toLocaleString()}</span>
              <span className="text-gray-500 text-xs">streams</span>
            </div>
            {/* Backend online indicator */}
            <div className={cn(
              'hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
              backendOnline
                ? 'bg-violet-900/40 border-violet-700/50 text-violet-300'
                : 'bg-gray-800 border-gray-700 text-gray-500'
            )}>
              <span className={cn('w-2 h-2 rounded-full', backendOnline ? 'bg-violet-400 animate-pulse' : 'bg-gray-600')} />
              {backendOnline ? 'Backend ●' : 'Backend ○'}
            </div>
            <div className="hidden sm:flex items-center gap-1.5 bg-green-900/40 border border-green-700/50 px-3 py-1.5 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-green-400 text-xs font-medium">LIVE</span>
            </div>
          </div>
        </div>

        {/* Nav Tabs */}
        <nav className="flex gap-1 pb-0 overflow-x-auto scrollbar-hide">
          {tabs.map(tab => {
            const isActive = activeTab === tab.id;
            const isBlue   = tab.highlight === 'blue';
            const isGreen  = tab.highlight === 'green';
            const isViolet = tab.highlight === 'violet';
            const isIndigo = tab.highlight === 'indigo';
            const isRose   = tab.highlight === 'rose';
            const isOrange = tab.highlight === 'orange';
            const isYellow = tab.highlight === 'yellow';

            const activeClass = isBlue   ? 'bg-blue-900/60 text-blue-300 border-blue-500'
              : isGreen   ? 'bg-emerald-900/60 text-emerald-300 border-emerald-500'
              : isViolet  ? 'bg-violet-900/60 text-violet-300 border-violet-500'
              : isIndigo  ? 'bg-indigo-900/60 text-indigo-300 border-indigo-500'
              : isRose    ? 'bg-rose-900/60 text-rose-300 border-rose-500'
              : isOrange  ? 'bg-orange-900/60 text-orange-300 border-orange-500'
              : isYellow  ? 'bg-yellow-900/60 text-yellow-300 border-yellow-500'
              :             'bg-gray-800 text-white border-purple-500';

            const inactiveClass = isBlue   ? 'text-blue-400 border-transparent hover:text-blue-300 hover:bg-blue-900/30'
              : isGreen   ? 'text-emerald-400 border-transparent hover:text-emerald-300 hover:bg-emerald-900/30'
              : isViolet  ? 'text-violet-400 border-transparent hover:text-violet-300 hover:bg-violet-900/30'
              : isIndigo  ? 'text-indigo-400 border-transparent hover:text-indigo-300 hover:bg-indigo-900/30'
              : isRose    ? 'text-rose-400 border-transparent hover:text-rose-300 hover:bg-rose-900/30'
              : isOrange  ? 'text-orange-400 border-transparent hover:text-orange-300 hover:bg-orange-900/30'
              : isYellow  ? 'text-yellow-400 border-transparent hover:text-yellow-300 hover:bg-yellow-900/30'
              :             'text-gray-400 border-transparent hover:text-gray-200 hover:bg-gray-800/50';

            const badgeClass = isBlue   ? 'bg-blue-500/20 text-blue-400 border-blue-500/40'
              : isGreen   ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
              : isIndigo  ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/40'
              : isRose    ? 'bg-rose-500/20 text-rose-400 border-rose-500/40'
              : isOrange  ? 'bg-orange-500/20 text-orange-400 border-orange-500/40'
              : isYellow  ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40'
              :             'bg-violet-500/20 text-violet-400 border-violet-500/40';

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-t-lg transition-all whitespace-nowrap border-b-2 focus:outline-none focus:ring-2 focus:ring-purple-500',
                  isActive ? activeClass : inactiveClass
                )}
              >
                <span>{tab.icon}</span>
                <span className="hidden sm:inline">{tab.label}</span>
                {tab.badge && tab.highlight && !isActive && (
                  <span className={cn('hidden sm:inline text-xs px-1.5 py-0.5 rounded-full leading-none border', badgeClass)}>
                    {isViolet && backendOnline ? (
                      <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
                        {tab.badge}
                      </span>
                    ) : tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
