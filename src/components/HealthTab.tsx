import { useState, useRef, useCallback } from 'react';
import { Stream } from '../types';
import { AppStore } from '../store/useAppStore';
import { checkStreams } from '../utils/healthCheck';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

export const HealthTab: React.FC<Props> = ({ store }) => {
  const { streams, updateStreamStatus, bulkDeleteStreams, notify } = store;
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<{ alive: number; dead: number; checked: number }>({ alive: 0, dead: 0, checked: 0 });
  const [filterStatus, setFilterStatus] = useState<'all' | 'alive' | 'dead' | 'unknown'>('all');
  const abortRef = useRef<AbortController | null>(null);

  const filtered = streams.filter(s => {
    if (filterStatus === 'alive') return s.status === 'alive';
    if (filterStatus === 'dead') return s.status === 'dead';
    if (filterStatus === 'unknown') return !s.status || s.status === 'unknown';
    return true;
  });

  const aliveCount = streams.filter(s => s.status === 'alive').length;
  const deadCount = streams.filter(s => s.status === 'dead').length;
  const unknownCount = streams.filter(s => !s.status || s.status === 'unknown').length;
  const checkedCount = streams.filter(s => s.status === 'alive' || s.status === 'dead').length;
  const healthPct = checkedCount > 0 ? Math.round((aliveCount / checkedCount) * 100) : 0;

  const startCheck = useCallback(async (subset?: Stream[]) => {
    const toCheck = subset || streams.filter(s => s.enabled);
    if (!toCheck.length) return notify('No streams to check', 'info');

    abortRef.current = new AbortController();
    setRunning(true);
    setProgress(0);
    setTotal(toCheck.length);
    setResults({ alive: 0, dead: 0, checked: 0 });

    // Mark all as checking
    for (const s of toCheck) {
      await updateStreamStatus(s.id, 'checking');
    }

    let alive = 0, dead = 0, checked = 0;

    await checkStreams(toCheck, async (result, idx, _total) => {
      void _total;
      checked++;
      if (result.status === 'alive') alive++;
      else dead++;
      setProgress(idx);
      setResults({ alive, dead, checked });
      await updateStreamStatus(result.streamId, result.status, result.responseTime);
    }, abortRef.current.signal);

    setRunning(false);
    notify(`Health check complete: ${alive} alive, ${dead} dead`, alive > 0 ? 'success' : 'info');
  }, [streams, updateStreamStatus, notify]);

  const stopCheck = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const removeDeadStreams = async () => {
    const deadIds = streams.filter(s => s.status === 'dead').map(s => s.id);
    if (!deadIds.length) return notify('No dead streams found', 'info');
    await bulkDeleteStreams(deadIds);
    notify(`Removed ${deadIds.length} dead streams`, 'success');
  };

  const progressPct = total > 0 ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Streams', value: streams.length.toLocaleString(), icon: '📺', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
          { label: 'Alive', value: aliveCount.toLocaleString(), icon: '✅', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
          { label: 'Dead', value: deadCount.toLocaleString(), icon: '❌', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
          { label: 'Unchecked', value: unknownCount.toLocaleString(), icon: '❓', color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/20' },
        ].map(card => (
          <div key={card.label} className={cn('rounded-xl p-4 border text-center', card.bg)}>
            <div className="text-2xl mb-1">{card.icon}</div>
            <div className={cn('text-2xl font-bold', card.color)}>{card.value}</div>
            <div className="text-gray-500 text-xs mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      {/* Health Bar */}
      {checkedCount > 0 && (
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-white font-medium">Overall Health</span>
            <span className={cn('font-bold', healthPct > 70 ? 'text-emerald-400' : healthPct > 40 ? 'text-yellow-400' : 'text-red-400')}>
              {healthPct}%
            </span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
            <div className={cn('h-full rounded-full transition-all duration-500',
              healthPct > 70 ? 'bg-emerald-500' : healthPct > 40 ? 'bg-yellow-500' : 'bg-red-500'
            )} style={{ width: `${healthPct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{aliveCount} alive</span>
            <span>{checkedCount} checked</span>
            <span>{deadCount} dead</span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-lg">🔬 Health Check Controls</h3>

        {/* Progress */}
        {running && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-300">Checking streams... ({results.checked}/{total})</span>
              <span className="text-purple-400 font-bold">{progressPct}%</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full transition-all animate-pulse"
                style={{ width: `${progressPct}%` }} />
            </div>
            <div className="flex gap-4 text-xs text-gray-400">
              <span className="text-emerald-400">✅ {results.alive} alive</span>
              <span className="text-red-400">❌ {results.dead} dead</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {!running ? (
            <>
              <button onClick={() => startCheck()}
                className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg">
                <span>🔬</span> Check All Streams ({streams.filter(s => s.enabled).length})
              </button>
              <button onClick={() => startCheck(streams.filter(s => (!s.status || s.status === 'unknown') && s.enabled))}
                className="flex items-center gap-2 px-5 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl font-medium text-sm transition-colors">
                <span>❓</span> Check Unchecked ({unknownCount})
              </button>
              {deadCount > 0 && (
                <button onClick={removeDeadStreams}
                  className="flex items-center gap-2 px-5 py-3 bg-red-700 hover:bg-red-600 text-white rounded-xl font-medium text-sm transition-colors">
                  <span>🗑️</span> Remove Dead ({deadCount})
                </button>
              )}
            </>
          ) : (
            <button onClick={stopCheck}
              className="flex items-center gap-2 px-5 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-medium text-sm transition-colors animate-pulse">
              <span>⏹</span> Stop Check
            </button>
          )}
        </div>
      </div>

      {/* Filter & Stream List */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { v: 'all', l: `All (${streams.length})` },
            { v: 'alive', l: `✅ Alive (${aliveCount})` },
            { v: 'dead', l: `❌ Dead (${deadCount})` },
            { v: 'unknown', l: `❓ Unknown (${unknownCount})` },
          ].map(f => (
            <button key={f.v} onClick={() => setFilterStatus(f.v as typeof filterStatus)}
              className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                filterStatus === f.v ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              )}>
              {f.l}
            </button>
          ))}
        </div>

        <div className="space-y-1 max-h-[50vh] overflow-y-auto">
          {filtered.slice(0, 200).map(stream => (
            <div key={stream.id} className={cn(
              'flex items-center gap-3 bg-gray-800 rounded-lg px-4 py-2.5 border',
              stream.status === 'alive' ? 'border-emerald-700/30' :
                stream.status === 'dead' ? 'border-red-700/30' :
                  stream.status === 'checking' ? 'border-yellow-700/30 animate-pulse' : 'border-gray-700/30'
            )}>
              <span className={cn('text-lg flex-shrink-0',
                stream.status === 'alive' ? '✅' :
                  stream.status === 'dead' ? '❌' :
                    stream.status === 'checking' ? '⏳' : '❓'
              )}>
                {stream.status === 'alive' ? '✅' :
                  stream.status === 'dead' ? '❌' :
                    stream.status === 'checking' ? '⏳' : '❓'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-white text-sm font-medium truncate">{stream.name}</div>
                <div className="text-gray-500 text-xs truncate">{stream.group}</div>
              </div>
              {stream.responseTime && (
                <span className="text-xs text-emerald-400 flex-shrink-0">{stream.responseTime}ms</span>
              )}
              {stream.lastChecked && (
                <span className="text-xs text-gray-600 flex-shrink-0 hidden sm:block">
                  {new Date(stream.lastChecked).toLocaleTimeString()}
                </span>
              )}
            </div>
          ))}
          {filtered.length > 200 && (
            <div className="text-center text-gray-500 text-sm py-3">
              Showing 200 of {filtered.length} streams
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
