import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, Source, ServerConfig, Tab } from './types';
import { fetchSource, parseSource } from './utils/parser';
import { cn } from './utils/cn';
import ShakaPlayer from './components/ShakaPlayer';
import {
  Globe, Tv2, Radio, Rocket, RefreshCw, Download,
  Plus, Trash2, Clock, CheckCircle2, AlertCircle,
  Loader2, X, Link2, Search, Filter,
  ToggleLeft, ToggleRight, Copy, ExternalLink,
  Wifi, WifiOff, Settings, ChevronDown, ChevronUp,
  FileText, Zap, Shield, Database, Activity, Play
} from 'lucide-react';

// ─── Notification ─────────────────────────────────────────────────────────────
function Notification({ msg, type }: { msg: string; type: 'success' | 'error' | 'info' }) {
  const colors = {
    success: 'bg-emerald-900/90 border-emerald-500/50 text-emerald-200',
    error:   'bg-red-900/90 border-red-500/50 text-red-200',
    info:    'bg-blue-900/90 border-blue-500/50 text-blue-200',
  };
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border text-sm font-medium shadow-xl animate-fade-in ${colors[type]}`}>
      {msg}
    </div>
  );
}

// ─── Local Storage helpers ────────────────────────────────────────────────────
function loadSources(): Source[] {
  try { return JSON.parse(localStorage.getItem('jash_sources') || '[]'); } catch { return []; }
}
function saveSources(s: Source[]) {
  localStorage.setItem('jash_sources', JSON.stringify(s));
}
function loadChannels(): Channel[] {
  try { return JSON.parse(localStorage.getItem('jash_channels') || '[]'); } catch { return []; }
}
function saveChannels(c: Channel[]) {
  localStorage.setItem('jash_channels', JSON.stringify(c));
}
function loadServerConfig(): ServerConfig {
  try {
    return JSON.parse(localStorage.getItem('jash_server') || 'null') || {
      serverUrl: window.location.origin,
      port: 7000,
      playlistName: 'Jash IPTV',
      keepAliveEnabled: true,
      keepAliveInterval: 14,
    };
  } catch {
    return {
      serverUrl: window.location.origin,
      port: 7000,
      playlistName: 'Jash IPTV',
      keepAliveEnabled: true,
      keepAliveInterval: 14,
    };
  }
}
function saveServerConfig(c: ServerConfig) {
  localStorage.setItem('jash_server', JSON.stringify(c));
}

function getBackendBase(): string {
  const { protocol, hostname, port } = window.location;
  if (port === '5173' || port === '5174' || port === '3000') {
    return `${protocol}//${hostname}:7000`;
  }
  return `${protocol}//${window.location.host}`;
}

// ─── Copy helper ──────────────────────────────────────────────────────────────
function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    });
  }, []);
  return { copied, copy };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  SOURCES TAB
// ═══════════════════════════════════════════════════════════════════════════════
function SourcesTab({
  sources, setSources, channels, setChannels, notify
}: {
  sources: Source[];
  setSources: React.Dispatch<React.SetStateAction<Source[]>>;
  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [newUrl, setNewUrl]       = useState('');
  const [newName, setNewName]     = useState('');
  const [newFormat, setNewFormat] = useState<'auto' | 'm3u' | 'json'>('auto');
  const [newInterval, setNewInterval] = useState(60);
  const [loading, setLoading]     = useState<Record<string, boolean>>({});
  const [errors, setErrors]       = useState<Record<string, string>>({});
  const [showAdd, setShowAdd]     = useState(false);
  const [log, setLog]             = useState<string[]>([]);
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const addLog = (msg: string) => setLog(p => [...p.slice(-8), msg]);

  const refreshSource = useCallback(async (source: Source) => {
    setLoading(prev => ({ ...prev, [source.id]: true }));
    setErrors(prev => { const n = { ...prev }; delete n[source.id]; return n; });
    addLog(`⏳ Fetching "${source.name}"…`);
    addLog(`🔗 URL: ${source.url.slice(0, 80)}${source.url.length > 80 ? '…' : ''}`);

    try {
      const content = await fetchSource(source.url);
      addLog(`📥 Received ${(content.length / 1024).toFixed(1)} KB — parsing…`);
      const { all, tamil } = parseSource(content, source.format, source.id);
      addLog(`✅ ${all.length} parsed → ${tamil.length} Tamil channels`);

      setSources(prev => prev.map(s =>
        s.id === source.id ? { ...s, lastRefresh: Date.now(), totalParsed: all.length, tamilFiltered: tamil.length } : s
      ));
      setChannels(prev => {
        const without = prev.filter(ch => !ch.id.startsWith(`${source.id}_`));
        return [...without, ...tamil];
      });
      notify(`✅ ${tamil.length} Tamil channels from "${source.name}"`, 'success');
    } catch (e) {
      const raw = String(e).replace('Error: ', '');
      // Show a friendly, actionable message
      let msg = raw;
      if (raw.includes('404'))         msg = `404 Not Found — check the URL is correct and publicly accessible`;
      else if (raw.includes('403'))    msg = `403 Forbidden — the server blocked this request`;
      else if (raw.includes('CORS') || raw.includes('cors')) msg = `CORS blocked — backend server must be running at port 7000`;
      else if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) msg = `Network error — check backend is running (port 7000 in dev)`;
      else if (raw.includes('timeout') || raw.includes('Timeout')) msg = `Timeout — URL took too long to respond`;
      else if (raw.includes('empty'))  msg = `Empty response — URL returned no content`;
      setErrors(prev => ({ ...prev, [source.id]: msg }));
      addLog(`❌ Error: ${msg}`);
      notify(`Failed: ${msg}`, 'error');
    } finally {
      setLoading(prev => ({ ...prev, [source.id]: false }));
    }
  }, [setSources, setChannels, notify]);

  // Auto-refresh timers
  useEffect(() => {
    const timers = timersRef.current;
    sources.forEach(src => {
      if (src.enabled && src.refreshInterval > 0) {
        if (!timers[src.id]) {
          timers[src.id] = setInterval(() => refreshSource(src), src.refreshInterval * 60 * 1000);
        }
      } else {
        if (timers[src.id]) { clearInterval(timers[src.id]); delete timers[src.id]; }
      }
    });
    return () => { Object.values(timers).forEach(clearInterval); };
  }, [sources, refreshSource]);

  const addSource = async () => {
    if (!newUrl.trim()) return;
    let hostname = '';
    try { hostname = new URL(newUrl).hostname; } catch { hostname = 'source'; }
    const source: Source = {
      id: crypto.randomUUID(),
      name: newName.trim() || hostname,
      url: newUrl.trim(),
      format: newFormat,
      lastRefresh: null,
      refreshInterval: newInterval,
      totalParsed: 0,
      tamilFiltered: 0,
      enabled: true,
    };
    setSources(prev => [...prev, source]);
    setNewUrl(''); setNewName(''); setShowAdd(false);
    await refreshSource(source);
  };

  const removeSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
    setChannels(prev => prev.filter(ch => !ch.id.startsWith(`${id}_`)));
    if (timersRef.current[id]) { clearInterval(timersRef.current[id]); delete timersRef.current[id]; }
    notify('Source removed', 'info');
  };

  const toggleSource = (id: string) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const sourceChannelCount = (srcId: string) =>
    channels.filter(ch => ch.id.startsWith(`${srcId}_`)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Globe className="w-7 h-7 text-cyan-400" />
            Source Manager
          </h2>
          <p className="text-gray-400 mt-1">Import M3U/JSON — Tamil channels extracted automatically</p>
        </div>
        <button onClick={() => setShowAdd(!showAdd)}
          className={cn('flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all',
            showAdd
              ? 'bg-gray-700 text-gray-300'
              : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40'
          )}>
          {showAdd ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showAdd ? 'Cancel' : 'Add Source'}
        </button>
      </div>

      {/* Tamil filter badge */}
      <div className="bg-gradient-to-r from-orange-500/10 to-amber-500/10 border border-orange-500/30 rounded-xl p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
          <span className="text-xl">🎯</span>
        </div>
        <div>
          <h4 className="text-orange-300 font-semibold">Tamil Language Filter Active</h4>
          <p className="text-orange-200/60 text-sm mt-1">
            All sources are filtered to Tamil channels only — Sun TV, Vijay, Zee Tamil, Colors Tamil, Polimer, KTV, Jaya TV, and 50+ more keywords matched automatically.
          </p>
        </div>
      </div>

      {/* Log output */}
      {log.length > 0 && (
        <div className="bg-gray-900/80 border border-gray-700/50 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700/50">
            <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Fetch Log</span>
            <button onClick={() => setLog([])} className="text-gray-600 hover:text-gray-400 text-xs transition">✕ Clear</button>
          </div>
          <div className="p-3 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className={cn(
                'leading-relaxed',
                l.startsWith('✅') ? 'text-emerald-400' :
                l.startsWith('❌') ? 'text-red-400' :
                l.startsWith('📥') ? 'text-blue-400' :
                l.startsWith('🔗') ? 'text-gray-500' :
                l.startsWith('⏳') ? 'text-yellow-400' :
                'text-gray-300'
              )}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 space-y-4">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">
            <Link2 className="w-5 h-5 text-cyan-400" />
            Add New Source
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-gray-400 text-sm mb-1.5">Source URL *</label>
              <input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/user/repo/main/playlist.m3u"
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none transition text-sm" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Source Name</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="My Tamil IPTV Source"
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-500 outline-none transition text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Format</label>
                <select value={newFormat} onChange={e => setNewFormat(e.target.value as 'auto' | 'm3u' | 'json')}
                  className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white focus:border-cyan-500 outline-none transition text-sm">
                  <option value="auto">Auto Detect</option>
                  <option value="m3u">M3U</option>
                  <option value="json">JSON</option>
                </select>
              </div>
              <div>
                <label className="block text-gray-400 text-sm mb-1.5">Auto Refresh (min)</label>
                <input type="number" value={newInterval} onChange={e => setNewInterval(Number(e.target.value))}
                  min={0} placeholder="0 = off"
                  className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:border-cyan-500 outline-none transition text-sm" />
              </div>
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button onClick={addSource} disabled={!newUrl.trim()}
              className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-xl font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-lg hover:shadow-cyan-500/25 transition">
              <Download className="w-4 h-4" />
              Import & Filter Tamil
            </button>
          </div>
        </div>
      )}

      {/* Sources list */}
      {sources.length === 0 ? (
        <div className="text-center py-16 bg-gray-800/30 rounded-2xl border border-gray-700/30">
          <Globe className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h3 className="text-xl text-gray-400 font-semibold">No Sources Added</h3>
          <p className="text-gray-500 mt-2 max-w-md mx-auto">Add an M3U or JSON URL. Tamil channels are automatically extracted.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sources.map(src => (
            <div key={src.id} className={cn(
              'bg-gray-800/40 border rounded-2xl p-5 transition-all',
              src.enabled ? 'border-gray-700/50' : 'border-gray-700/30 opacity-60'
            )}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2">
                    <button onClick={() => toggleSource(src.id)}
                      className={cn('w-10 h-5 rounded-full transition-all relative flex-shrink-0',
                        src.enabled ? 'bg-cyan-500' : 'bg-gray-600')}>
                      <div className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                        src.enabled ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                    <h4 className="text-white font-semibold truncate">{src.name}</h4>
                    {loading[src.id] && <Loader2 className="w-4 h-4 text-cyan-400 animate-spin flex-shrink-0" />}
                  </div>
                  <p className="text-gray-500 text-xs truncate font-mono mb-3">{src.url}</p>
                  <div className="flex flex-wrap gap-2">
                    <span className="inline-flex items-center gap-1 bg-gray-700/50 text-cyan-400 px-3 py-1 rounded-lg text-xs font-bold uppercase">{src.format}</span>
                    {src.refreshInterval > 0 && (
                      <span className="inline-flex items-center gap-1.5 bg-blue-500/10 text-blue-300 px-3 py-1 rounded-lg text-xs">
                        <Clock className="w-3 h-3" />Every {src.refreshInterval}m
                      </span>
                    )}
                    {src.lastRefresh && (
                      <span className="inline-flex items-center gap-1.5 bg-green-500/10 text-green-300 px-3 py-1 rounded-lg text-xs">
                        <CheckCircle2 className="w-3 h-3" />
                        {src.totalParsed} total → {src.tamilFiltered} Tamil
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5 bg-orange-500/10 text-orange-300 px-3 py-1 rounded-lg text-xs font-semibold">
                      📺 {sourceChannelCount(src.id)} active
                    </span>
                    {src.lastRefresh && (
                      <span className="text-gray-500 text-xs self-center">
                        Updated {new Date(src.lastRefresh).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  {errors[src.id] && (
                    <div className="flex items-center gap-2 mt-2 text-red-400 text-xs">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{errors[src.id]}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => refreshSource(src)} disabled={loading[src.id]}
                    className="p-2.5 bg-gray-700/50 hover:bg-cyan-500/20 text-gray-400 hover:text-cyan-400 rounded-xl transition disabled:opacity-40" title="Refresh now">
                    <RefreshCw className={cn('w-4 h-4', loading[src.id] && 'animate-spin')} />
                  </button>
                  <button onClick={() => removeSource(src.id)}
                    className="p-2.5 bg-gray-700/50 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-xl transition" title="Remove source">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {sources.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Sources',        value: sources.length,                                        color: 'text-cyan-400' },
            { label: 'Active',         value: sources.filter(s => s.enabled).length,                 color: 'text-green-400' },
            { label: 'Total Parsed',   value: sources.reduce((a, s) => a + s.totalParsed, 0),        color: 'text-blue-400' },
            { label: 'Tamil Channels', value: channels.length,                                        color: 'text-orange-400' },
          ].map(s => (
            <div key={s.label} className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-4 text-center">
              <div className={cn('text-2xl font-bold', s.color)}>{s.value.toLocaleString()}</div>
              <div className="text-gray-500 text-xs mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  CHANNELS TAB
// ═══════════════════════════════════════════════════════════════════════════════
function ChannelsTab({
  channels, setChannels, sources, notify
}: {
  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  sources: Source[];
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [search, setSearch]   = useState('');
  const [group, setGroup]     = useState('All');
  const [page, setPage]       = useState(1);
  const PAGE = 50;

  const groups = ['All', ...Array.from(new Set(channels.map(c => c.group || 'Uncategorized'))).sort()];

  const filtered = channels.filter(c => {
    const inGroup = group === 'All' || (c.group || 'Uncategorized') === group;
    const inSearch = !search || c.name.toLowerCase().includes(search.toLowerCase());
    return inGroup && inSearch;
  });

  const paginated = filtered.slice(0, page * PAGE);
  const hasMore = paginated.length < filtered.length;

  const toggleChannel = (id: string) => {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));
  };

  const deleteChannel = (id: string) => {
    setChannels(prev => prev.filter(c => c.id !== id));
    notify('Channel removed', 'info');
  };

  const deleteSelected = (ids: string[]) => {
    setChannels(prev => prev.filter(c => !ids.includes(c.id)));
    notify(`${ids.length} channels removed`, 'info');
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.id)));
    }
  };

  const sourceOf = (ch: Channel) => sources.find(s => ch.id.startsWith(`${s.id}_`))?.name || '?';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Tv2 className="w-7 h-7 text-orange-400" />
            Tamil Channels
          </h2>
          <p className="text-gray-400 mt-1">{channels.length.toLocaleString()} channels · {channels.filter(c => c.enabled).length} enabled</p>
        </div>
        {selected.size > 0 && (
          <button onClick={() => { deleteSelected([...selected]); setSelected(new Set()); }}
            className="flex items-center gap-2 px-4 py-2 bg-red-800/50 hover:bg-red-700/50 text-red-300 border border-red-700/50 rounded-xl text-sm font-semibold transition">
            <Trash2 className="w-4 h-4" />Delete {selected.size}
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-48 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search channels…"
            className="w-full bg-gray-800/50 border border-gray-700/50 rounded-xl pl-10 pr-4 py-2.5 text-white placeholder-gray-500 focus:border-orange-500 outline-none text-sm" />
        </div>
        <select value={group} onChange={e => { setGroup(e.target.value); setPage(1); }}
          className="bg-gray-800/50 border border-gray-700/50 rounded-xl px-4 py-2.5 text-white focus:border-orange-500 outline-none text-sm">
          {groups.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <button onClick={selectAll}
          className="px-4 py-2.5 bg-gray-800/50 border border-gray-700/50 hover:border-gray-600 text-gray-300 rounded-xl text-sm transition">
          {selected.size === filtered.length && filtered.length > 0 ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Channel list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 bg-gray-800/30 rounded-2xl border border-gray-700/30">
          <Tv2 className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">{channels.length === 0 ? 'No channels yet. Add sources first.' : 'No channels match your filter.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {paginated.map(ch => (
            <div key={ch.id} className={cn(
              'flex items-center gap-3 bg-gray-800/40 border rounded-xl px-4 py-3 transition-all group',
              selected.has(ch.id) ? 'border-orange-500/50 bg-orange-500/5' : 'border-gray-700/40 hover:border-gray-600/50',
              !ch.enabled && 'opacity-50'
            )}>
              <input type="checkbox" checked={selected.has(ch.id)} onChange={() => toggleSelect(ch.id)}
                className="w-4 h-4 rounded border-gray-600 accent-orange-500 flex-shrink-0" />
              {ch.logo ? (
                <img src={ch.logo} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0 bg-gray-700"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <div className="w-8 h-8 rounded bg-gray-700/50 flex items-center justify-center flex-shrink-0 text-gray-500 text-xs">📺</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm font-medium truncate">{ch.name}</span>
                  {ch.kid && (
                    <span className="text-xs bg-red-900/50 text-red-300 border border-red-800/50 px-1.5 py-0.5 rounded font-mono flex-shrink-0">🔐 CK</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-gray-500 text-xs truncate">{ch.group || 'Uncategorized'}</span>
                  <span className="text-gray-700 text-xs">·</span>
                  <span className="text-gray-600 text-xs truncate">{sourceOf(ch)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => toggleChannel(ch.id)}
                  className="p-1.5 hover:bg-gray-700/50 text-gray-400 hover:text-white rounded-lg transition" title="Toggle">
                  {ch.enabled ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4" />}
                </button>
                <button onClick={() => deleteChannel(ch.id)}
                  className="p-1.5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-lg transition" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {hasMore && (
            <button onClick={() => setPage(p => p + 1)}
              className="w-full py-3 bg-gray-800/30 border border-gray-700/30 hover:border-gray-600/50 text-gray-400 hover:text-white rounded-xl text-sm transition">
              Load more ({filtered.length - paginated.length} remaining)
            </button>
          )}
        </div>
      )}

      {/* Group stats */}
      {channels.length > 0 && (
        <div>
          <h3 className="text-gray-400 text-sm font-semibold mb-3 flex items-center gap-2">
            <Filter className="w-4 h-4" />Groups
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {groups.filter(g => g !== 'All').map(g => {
              const count = channels.filter(c => (c.group || 'Uncategorized') === g).length;
              return (
                <button key={g} onClick={() => { setGroup(g); setPage(1); }}
                  className={cn(
                    'text-left px-3 py-2.5 rounded-xl border text-sm transition-all',
                    group === g
                      ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                      : 'bg-gray-800/30 border-gray-700/30 hover:border-gray-600/50 text-gray-300'
                  )}>
                  <div className="font-medium truncate">{g}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{count} channels</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  GENERATOR TAB
// ═══════════════════════════════════════════════════════════════════════════════
function GeneratorTab({
  channels, serverConfig, setServerConfig, notify
}: {
  channels: Channel[];
  serverConfig: ServerConfig;
  setServerConfig: React.Dispatch<React.SetStateAction<ServerConfig>>;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const { copied, copy } = useCopy();
  const [filterGroup, setFilterGroup] = useState('All');
  const [preview, setPreview]         = useState(false);
  const [syncing, setSyncing]         = useState(false);
  const [syncResult, setSyncResult]   = useState<Record<string, unknown> | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  const base = getBackendBase();
  const enabled = channels.filter(c => c.enabled);
  const groups  = ['All', ...Array.from(new Set(enabled.map(c => c.group || 'Uncategorized'))).sort()];
  const filtered = filterGroup === 'All' ? enabled : enabled.filter(c => (c.group || 'Uncategorized') === filterGroup);

  const M3U_URL    = `${base}/p.m3u`;
  const DRM_URL    = `${base}/drm-playlist.m3u`;
  const STREMIO_URL = `${base}/manifest.json`;
  const INSTALL_URL = `stremio://${base.replace(/^https?:\/\//, '')}/manifest.json`;

  // Check backend health
  useEffect(() => {
    fetch(`${base}/health`).then(r => r.ok ? setBackendOnline(true) : setBackendOnline(false)).catch(() => setBackendOnline(false));
  }, [base]);

  // Generate M3U content
  const generateM3U = (streams: Channel[]): string => {
    const lines = [`#EXTM3U x-playlist-name="${serverConfig.playlistName}"`];
    for (const ch of streams) {
      let extinf = `#EXTINF:-1`;
      extinf += ` tvg-name="${ch.name.replace(/"/g, '')}"`;
      if (ch.logo)  extinf += ` tvg-logo="${ch.logo}"`;
      extinf += ` group-title="${(ch.group || 'Uncategorized').replace(/"/g, '')}"`;
      extinf += `,${ch.name}`;
      lines.push(extinf);
      if (ch.kid && ch.contentKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.kid}:${ch.contentKey}`);
      }
      lines.push(ch.url);
      lines.push('');
    }
    return lines.join('\n');
  };

  const downloadM3U = () => {
    const content = generateM3U(filtered);
    const blob = new Blob([content], { type: 'application/x-mpegurl' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${serverConfig.playlistName.replace(/\s+/g, '-')}.m3u`;
    a.click(); URL.revokeObjectURL(url);
    notify(`Downloaded ${filtered.length} channels`, 'success');
  };

  const syncToBackend = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const payload = {
        streams: enabled.map((ch, i) => ({
          id         : ch.id,
          name       : ch.name,
          url        : ch.url,
          logo       : ch.logo,
          group      : ch.group || 'Uncategorized',
          sourceId   : ch.id.split('_')[0] || 'manual',
          enabled    : ch.enabled,
          order      : i,
          licenseType: ch.kid ? 'clearkey' : undefined,
          licenseKey : ch.kid && ch.contentKey ? `${ch.kid}:${ch.contentKey}` : undefined,
        })),
        settings: {
          addonName          : serverConfig.playlistName,
          sortAlphabetically : true,
          combineMultiQuality: true,
        },
      };
      const r   = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const res = await r.json();
      setSyncResult(res);
      if (res.ok) {
        notify(`✅ ${res.streams} channels synced to backend`, 'success');
        setBackendOnline(true);
      } else {
        notify(`Sync failed: ${res.error}`, 'error');
      }
    } catch (e) {
      notify(`Sync error: ${String(e)}`, 'error');
      setBackendOnline(false);
    } finally {
      setSyncing(false);
    }
  };

  const m3uPreview = generateM3U(filtered.slice(0, 5));

  const CopyBtn = ({ text, k }: { text: string; k: string }) => (
    <button onClick={() => copy(text, k)}
      className="p-1.5 rounded-lg hover:bg-gray-700/50 text-gray-400 hover:text-white transition flex-shrink-0">
      {copied === k ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </button>
  );

  const UrlRow = ({ label, url, k }: { label: string; url: string; k: string }) => (
    <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-3">
      <div className="text-gray-500 text-xs font-semibold uppercase tracking-wide mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-cyan-300 font-mono text-xs flex-1 truncate">{url}</span>
        <CopyBtn text={url} k={k} />
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="p-1.5 rounded-lg hover:bg-gray-700/50 text-gray-400 hover:text-white transition">
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white flex items-center gap-3">
          <Radio className="w-7 h-7 text-purple-400" />
          Playlist Generator
        </h2>
        <p className="text-gray-400 mt-1">{enabled.length} enabled channels ready to export</p>
      </div>

      {/* Backend status */}
      <div className={cn('flex items-center gap-3 px-4 py-3 rounded-xl border text-sm',
        backendOnline === true  ? 'bg-emerald-900/20 border-emerald-700/50 text-emerald-300' :
        backendOnline === false ? 'bg-red-900/20 border-red-700/50 text-red-300' :
        'bg-gray-800/30 border-gray-700/50 text-gray-400')}>
        {backendOnline === true  ? <Wifi className="w-4 h-4" /> :
         backendOnline === false ? <WifiOff className="w-4 h-4" /> :
         <Activity className="w-4 h-4 animate-pulse" />}
        <span className="font-medium">Backend: {backendOnline === true ? 'Online ✓' : backendOnline === false ? 'Offline — sync to activate URLs' : 'Checking…'}</span>
      </div>

      {/* Settings */}
      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Settings className="w-4 h-4 text-gray-400" />Playlist Settings
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Playlist Name</label>
            <input value={serverConfig.playlistName} onChange={e => setServerConfig(p => ({ ...p, playlistName: e.target.value }))}
              className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-purple-500 outline-none text-sm" />
          </div>
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Filter Group</label>
            <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)}
              className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-purple-500 outline-none text-sm">
              {groups.map(g => <option key={g} value={g}>{g === 'All' ? `All Groups (${enabled.length})` : `${g} (${enabled.filter(c => (c.group||'Uncategorized')===g).length})`}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Download */}
      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Download className="w-4 h-4 text-emerald-400" />Download Playlist
        </h3>
        <p className="text-gray-400 text-sm">{filtered.length} channels · {filtered.filter(c => c.kid).length} DRM channels</p>
        <div className="flex flex-wrap gap-3">
          <button onClick={downloadM3U} disabled={filtered.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-semibold text-sm disabled:opacity-40 transition shadow-lg shadow-emerald-900/30">
            <Download className="w-4 h-4" />
            Download .m3u ({filtered.length} channels)
          </button>
          <button onClick={() => setPreview(!preview)}
            className="flex items-center gap-2 px-4 py-2.5 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-xl text-sm transition">
            <FileText className="w-4 h-4" />
            {preview ? 'Hide' : 'Preview'} M3U
            {preview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
        {preview && (
          <div className="relative">
            <pre className="bg-gray-900/80 border border-gray-700/50 rounded-xl p-4 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre max-h-60 overflow-y-auto">
              {m3uPreview}
              {filtered.length > 5 && `\n… and ${filtered.length - 5} more channels`}
            </pre>
            <button onClick={() => copy(generateM3U(filtered), 'full-m3u')}
              className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition">
              {copied === 'full-m3u' ? '✓ Copied' : 'Copy All'}
            </button>
          </div>
        )}
      </div>

      {/* Backend sync */}
      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-yellow-400" />Sync to Backend Server
        </h3>
        <p className="text-gray-400 text-sm">Push channels to the backend to activate Stremio addon and server-side DRM proxy.</p>
        <button onClick={syncToBackend} disabled={syncing || enabled.length === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm disabled:opacity-40 transition shadow-lg shadow-purple-900/30">
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {syncing ? 'Syncing…' : `Sync ${enabled.length} Channels`}
        </button>
        {syncResult && (
          <div className={cn('p-3 rounded-xl text-xs font-mono border',
            (syncResult as {ok?: boolean}).ok ? 'bg-emerald-900/20 border-emerald-700/50 text-emerald-300' : 'bg-red-900/20 border-red-700/50 text-red-300')}>
            {JSON.stringify(syncResult, null, 2)}
          </div>
        )}
      </div>

      {/* URLs */}
      {backendOnline && (
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Globe className="w-4 h-4 text-cyan-400" />Playlist URLs
          </h3>
          <UrlRow label="📻 M3U Playlist (TiviMate · OTT Navigator · VLC)" url={M3U_URL} k="m3u" />
          <UrlRow label="🔐 DRM Proxy M3U (encrypted channels — recommended)" url={DRM_URL} k="drm" />
          <UrlRow label="📺 Stremio Manifest" url={STREMIO_URL} k="manifest" />
          <div className="bg-gray-900/60 border border-purple-700/30 rounded-xl p-3">
            <div className="text-gray-500 text-xs font-semibold uppercase tracking-wide mb-1.5">🔌 Stremio Install Link</div>
            <div className="flex items-center gap-2">
              <span className="text-purple-300 font-mono text-xs flex-1 truncate">{INSTALL_URL}</span>
              <CopyBtn text={INSTALL_URL} k="install" />
              <a href={INSTALL_URL}
                className="px-3 py-1.5 bg-purple-700/50 hover:bg-purple-600/50 text-purple-200 text-xs rounded-lg transition font-semibold">
                Install
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  DEPLOY TAB
// ═══════════════════════════════════════════════════════════════════════════════
function DeployTab({
  channels, serverConfig, setServerConfig, notify
}: {
  channels: Channel[];
  serverConfig: ServerConfig;
  setServerConfig: React.Dispatch<React.SetStateAction<ServerConfig>>;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const { copied, copy } = useCopy();
  const base = getBackendBase();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [checking, setChecking] = useState(false);

  const checkHealth = async () => {
    setChecking(true);
    try {
      const r = await fetch(`${base}/health`);
      setHealth(await r.json());
    } catch {
      setHealth(null);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { checkHealth(); }, []);

  void channels;
  const CODE_BLOCK = (code: string) => (
    <div className="relative group">
      <pre className="bg-gray-900/90 border border-gray-700/50 rounded-xl p-4 text-xs text-green-300 font-mono overflow-x-auto">
        {code}
      </pre>
      <button onClick={() => { copy(code, code.slice(0, 20)); notify('Copied!', 'success'); }}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded">
        {copied === code.slice(0, 20) ? '✓' : 'Copy'}
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white flex items-center gap-3">
          <Rocket className="w-7 h-7 text-rose-400" />
          Deploy & Install
        </h2>
        <p className="text-gray-400 mt-1">Deploy to cloud and install in Stremio</p>
      </div>

      {/* Health */}
      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4 text-green-400" />Backend Health
          </h3>
          <button onClick={checkHealth} disabled={checking}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-lg text-xs transition">
            <RefreshCw className={cn('w-3.5 h-3.5', checking && 'animate-spin')} />
            Refresh
          </button>
        </div>
        {health ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Status',   value: (health as {status?: string}).status === 'ok' ? '✅ OK' : '❌', color: 'text-green-400' },
              { label: 'Channels', value: String((health as {streams?: number}).streams || 0), color: 'text-cyan-400' },
              { label: 'Groups',   value: String((health as {groups?: number}).groups || 0), color: 'text-purple-400' },
              { label: 'DRM',      value: String((health as {drmChannels?: number}).drmChannels || 0), color: 'text-red-400' },
            ].map(s => (
              <div key={s.label} className="bg-gray-900/50 border border-gray-700/30 rounded-xl p-3 text-center">
                <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
                <div className="text-gray-500 text-xs mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-gray-500 text-sm">
            <WifiOff className="w-8 h-8 mx-auto mb-2 text-gray-600" />
            Backend offline or not deployed yet
          </div>
        )}
        {health && (
          <div className="bg-gray-900/50 border border-gray-700/30 rounded-xl p-3 space-y-1.5">
            {[
              { label: 'Manifest URL',  url: `${base}/manifest.json`, k: 'm' },
              { label: 'M3U Playlist',  url: `${base}/p.m3u`,         k: 'p' },
              { label: 'DRM Playlist',  url: `${base}/drm-playlist.m3u`, k: 'd' },
              { label: 'Install Page',  url: `${base}/install`,        k: 'i' },
            ].map(({ label, url, k }) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-gray-500 text-xs w-28 flex-shrink-0">{label}</span>
                <span className="text-cyan-300 font-mono text-xs flex-1 truncate">{url}</span>
                <button onClick={() => copy(url, k)}
                  className="p-1 rounded hover:bg-gray-700/50 text-gray-500 hover:text-white transition">
                  {copied === k ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stremio install */}
      <div className="bg-gradient-to-r from-purple-900/30 to-indigo-900/30 border border-purple-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />Install in Stremio
        </h3>
        <div className="space-y-3">
          <a href={`stremio://${base.replace(/^https?:\/\//, '')}/manifest.json`}
            className="flex items-center justify-center gap-2 w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm transition shadow-lg shadow-purple-900/30">
            📺 Install in Stremio App
          </a>
          <a href={`https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${base}/manifest.json`)}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 bg-gradient-to-r from-blue-700/50 to-blue-600/50 hover:from-blue-600/50 hover:to-blue-500/50 text-blue-200 border border-blue-700/50 rounded-xl font-semibold text-sm transition">
            🌐 Install via Stremio Web
          </a>
          <a href={`${base}/install`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 bg-gray-800/50 hover:bg-gray-700/50 text-gray-300 border border-gray-700/50 rounded-xl text-sm transition">
            <ExternalLink className="w-4 h-4" />Open Install Page
          </a>
        </div>
        <div className="bg-gray-900/40 border border-gray-700/30 rounded-xl p-3">
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wide mb-2">Samsung Tizen TV Steps</p>
          {['Open Stremio on TV', 'Navigate to ☰ Menu', 'Go to Addons', 'Click ⚙️ on any addon → Custom addon URL', `Paste: ${base}/manifest.json`, 'Select Install → Channels appear'].map((s, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <span className="w-5 h-5 rounded-full bg-purple-900/50 border border-purple-700/50 text-purple-300 text-xs flex items-center justify-center flex-shrink-0">{i + 1}</span>
              <span className="text-gray-400 text-xs">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Deploy guides */}
      <div className="space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Rocket className="w-4 h-4 text-rose-400" />Deployment Guides
        </h3>

        {/* Render */}
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-900/50 flex items-center justify-center text-sm">🚀</div>
            <div>
              <h4 className="text-white font-semibold text-sm">Render.com</h4>
              <p className="text-gray-500 text-xs">Free tier · Auto-sleep after 15min idle</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[['Build Command', 'npm install --include=dev && npm run build'], ['Start Command', 'node backend/server.js'], ['Port', '10000'], ['ENV: PUBLIC_URL', 'https://your-app.onrender.com']].map(([k, v]) => (
              <div key={k} className="bg-gray-900/50 rounded-lg p-2.5">
                <div className="text-gray-500 text-xs mb-1">{k}</div>
                <div className="text-green-300 font-mono text-xs break-all">{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Koyeb */}
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-900/50 flex items-center justify-center text-sm">⚡</div>
            <div>
              <h4 className="text-white font-semibold text-sm">Koyeb.com ⭐ Recommended</h4>
              <p className="text-gray-500 text-xs">Free tier · Never sleeps · Global CDN</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[['Build Command', 'npm install --include=dev && npm run build'], ['Start Command', 'node backend/server.js'], ['Port', '8000'], ['ENV: PUBLIC_URL', 'https://your-app.koyeb.app']].map(([k, v]) => (
              <div key={k} className="bg-gray-900/50 rounded-lg p-2.5">
                <div className="text-gray-500 text-xs mb-1">{k}</div>
                <div className="text-green-300 font-mono text-xs break-all">{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Railway */}
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-900/50 flex items-center justify-center text-sm">🚂</div>
            <div>
              <h4 className="text-white font-semibold text-sm">Railway.app</h4>
              <p className="text-gray-500 text-xs">$5 free credit · CLI deployment</p>
            </div>
          </div>
          {CODE_BLOCK(`npm install -g @railway/cli
railway login
railway init
railway variables set PORT=8000 PUBLIC_URL=https://your-app.up.railway.app
railway up`)}
        </div>

        {/* Server config */}
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Database className="w-4 h-4 text-gray-400" />Server Configuration
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-400 text-xs mb-1.5">Server URL</label>
              <input value={serverConfig.serverUrl} onChange={e => setServerConfig(p => ({ ...p, serverUrl: e.target.value }))}
                placeholder="https://your-app.onrender.com"
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-rose-500 outline-none text-sm" />
            </div>
            <div>
              <label className="block text-gray-400 text-xs mb-1.5">Playlist Name</label>
              <input value={serverConfig.playlistName} onChange={e => setServerConfig(p => ({ ...p, playlistName: e.target.value }))}
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-rose-500 outline-none text-sm" />
            </div>
          </div>
          <label className="flex items-center gap-3 cursor-pointer group">
            <button onClick={() => setServerConfig(p => ({ ...p, keepAliveEnabled: !p.keepAliveEnabled }))}
              className={cn('w-10 h-5 rounded-full transition-all relative',
                serverConfig.keepAliveEnabled ? 'bg-rose-500' : 'bg-gray-600')}>
              <div className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                serverConfig.keepAliveEnabled ? 'left-[22px]' : 'left-0.5')} />
            </button>
            <span className="text-gray-300 text-sm">Keep-alive ping (prevents Render sleep)</span>
          </label>
          <button onClick={() => { saveServerConfig(serverConfig); notify('Server config saved', 'success'); }}
            className="px-5 py-2.5 bg-rose-700/50 hover:bg-rose-600/50 text-rose-200 border border-rose-700/50 rounded-xl text-sm font-semibold transition">
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HEADER
// ═══════════════════════════════════════════════════════════════════════════════
function Header({
  tab, setTab, channelCount
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  channelCount: number;
}) {
  const TABS: { id: Tab; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: 'sources',   label: 'Sources',   icon: <Globe className="w-4 h-4" /> },
    { id: 'channels',  label: 'Channels',  icon: <Tv2 className="w-4 h-4" />,   badge: channelCount > 0 ? String(channelCount) : undefined },
    { id: 'player',    label: 'Player',    icon: <Play className="w-4 h-4" />,   badge: channelCount > 0 ? '▶' : undefined },
    { id: 'generator', label: 'Generator', icon: <Radio className="w-4 h-4" /> },
    { id: 'deploy',    label: 'Deploy',    icon: <Rocket className="w-4 h-4" /> },
  ];

  const COLOR: Record<Tab, string> = {
    sources  : 'text-cyan-400   border-cyan-400',
    channels : 'text-orange-400 border-orange-400',
    player   : 'text-yellow-400 border-yellow-400',
    generator: 'text-purple-400 border-purple-400',
    deploy   : 'text-rose-400   border-rose-400',
  };

  return (
    <header className="bg-gray-900/95 border-b border-gray-800 sticky top-0 z-20 backdrop-blur-md">
      <div className="max-w-screen-xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-sm shadow-lg shadow-purple-900/40">📡</div>
            <div>
              <span className="text-white font-bold text-base tracking-tight">Jash IPTV</span>
              <span className="text-gray-600 text-xs ml-2 hidden sm:inline">Tamil Addon Manager</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-orange-400 font-semibold mr-2 hidden md:flex items-center gap-1">
              🇮🇳 Tamil Filter
            </span>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-px">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap relative',
                tab === t.id
                  ? `${COLOR[t.id]} bg-white/5`
                  : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-white/5'
              )}>
              {t.icon}{t.label}
              {t.badge && (
                <span className="bg-orange-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[1.25rem] text-center leading-none">
                  {Number(t.badge) > 999 ? '999+' : t.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  APP ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export function App() {
  const [tab, setTab]               = useState<Tab>('sources');
  const [sources, setSources]       = useState<Source[]>(loadSources);
  const [channels, setChannels]     = useState<Channel[]>(loadChannels);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(loadServerConfig);
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Persist to localStorage whenever state changes
  useEffect(() => { saveSources(sources); },       [sources]);
  useEffect(() => { saveChannels(channels); },     [channels]);
  useEffect(() => { saveServerConfig(serverConfig); }, [serverConfig]);

  const notify = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  }, []);

  const props = { sources, setSources, channels, setChannels, notify };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {notification && <Notification msg={notification.msg} type={notification.type} />}

      <Header tab={tab} setTab={setTab} channelCount={channels.filter(c => c.enabled).length} />

      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {tab === 'sources'   && <SourcesTab   {...props} />}
        {tab === 'channels'  && <ChannelsTab  channels={channels} setChannels={setChannels} sources={sources} notify={notify} />}
        {tab === 'player'    && <ShakaPlayer  channels={channels} sources={sources} />}
        {tab === 'generator' && <GeneratorTab channels={channels} serverConfig={serverConfig} setServerConfig={setServerConfig} notify={notify} />}
        {tab === 'deploy'    && <DeployTab    channels={channels} serverConfig={serverConfig} setServerConfig={setServerConfig} notify={notify} />}
      </main>

      <footer className="border-t border-gray-800 py-4 px-4 mt-12">
        <div className="max-w-screen-xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-600">
          <div className="flex items-center gap-2">
            <span className="text-purple-500">📡</span>
            <span className="font-semibold text-gray-500">JASH IPTV</span>
            <span>· Tamil Stremio Addon Manager · Samsung Tizen Optimized</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-orange-400/70">🇮🇳 Tamil Filter ON</span>
            <span>{channels.filter(c => c.enabled).length.toLocaleString()} channels ready</span>
            <span>{sources.length} sources</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
