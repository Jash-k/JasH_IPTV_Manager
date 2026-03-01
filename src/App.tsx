import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, Source, ServerConfig, Tab, Playlist } from './types';
import { fetchSource, parseSource } from './utils/parser';
import { cn } from './utils/cn';
import ShakaPlayer from './components/ShakaPlayer';
import {
  Globe, Tv2, Radio, Rocket, RefreshCw, Download,
  Plus, Trash2, Clock, CheckCircle2, AlertCircle,
  Loader2, X, Link2, Search, Filter,
  ToggleLeft, ToggleRight, Copy, ExternalLink,
  Wifi, WifiOff, Settings, ChevronDown, ChevronUp,
  FileText, Zap, Shield, Database, Activity, Play,
  ListMusic, Edit2, Eye, EyeOff
} from 'lucide-react';

// ─── Notification ─────────────────────────────────────────────────────────────
function Notification({ msg, type }: { msg: string; type: 'success' | 'error' | 'info' }) {
  const colors = {
    success: 'bg-emerald-900/90 border-emerald-500/50 text-emerald-200',
    error:   'bg-red-900/90 border-red-500/50 text-red-200',
    info:    'bg-blue-900/90 border-blue-500/50 text-blue-200',
  };
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border text-sm font-medium shadow-xl ${colors[type]}`}>
      {msg}
    </div>
  );
}

// ─── Local Storage helpers ────────────────────────────────────────────────────
function loadSources(): Source[] {
  try {
    const raw = JSON.parse(localStorage.getItem('jash_sources') || '[]') as Source[];
    return raw.map(s => ({ ...s, tamilFilter: s.tamilFilter ?? true }));
  } catch { return []; }
}
function saveSources(s: Source[]) { localStorage.setItem('jash_sources', JSON.stringify(s)); }
function loadChannels(): Channel[] {
  try { return JSON.parse(localStorage.getItem('jash_channels') || '[]'); } catch { return []; }
}
function saveChannels(c: Channel[]) { localStorage.setItem('jash_channels', JSON.stringify(c)); }
function loadPlaylists(): Playlist[] {
  try { return JSON.parse(localStorage.getItem('jash_playlists') || '[]'); } catch { return []; }
}
function savePlaylists(p: Playlist[]) { localStorage.setItem('jash_playlists', JSON.stringify(p)); }
function loadServerConfig(): ServerConfig {
  try {
    return JSON.parse(localStorage.getItem('jash_server') || 'null') || {
      serverUrl: window.location.origin, port: 7000,
      playlistName: 'Jash IPTV', keepAliveEnabled: true, keepAliveInterval: 14,
    };
  } catch {
    return { serverUrl: window.location.origin, port: 7000, playlistName: 'Jash IPTV', keepAliveEnabled: true, keepAliveInterval: 14 };
  }
}
function saveServerConfig(c: ServerConfig) { localStorage.setItem('jash_server', JSON.stringify(c)); }

function getBackendBase(): string {
  const { protocol, hostname, port } = window.location;
  if (port === '5173' || port === '5174' || port === '3000') return `${protocol}//${hostname}:7000`;
  return `${protocol}//${window.location.host}`;
}

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 2000); });
  }, []);
  return { copied, copy };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  TOGGLE SWITCH COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
function Toggle({
  checked, onChange, label, subLabel, color = 'cyan'
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  subLabel?: string;
  color?: 'cyan' | 'orange' | 'green' | 'purple';
}) {
  const trackColor = {
    cyan:   checked ? 'bg-cyan-500'   : 'bg-gray-600',
    orange: checked ? 'bg-orange-500' : 'bg-gray-600',
    green:  checked ? 'bg-green-500'  : 'bg-gray-600',
    purple: checked ? 'bg-purple-500' : 'bg-gray-600',
  }[color];

  return (
    <button onClick={onChange} className="flex items-center gap-3 group">
      <div className={cn('relative w-12 h-6 rounded-full transition-all duration-300 flex-shrink-0', trackColor)}>
        <div className={cn(
          'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-300',
          checked ? 'left-[26px]' : 'left-0.5'
        )} />
      </div>
      <div className="text-left">
        <div className={cn('text-sm font-semibold transition-colors', checked ? 'text-white' : 'text-gray-400')}>
          {label}
        </div>
        {subLabel && <div className="text-xs text-gray-500">{subLabel}</div>}
      </div>
    </button>
  );
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
    addLog(`🔗 ${source.url.slice(0, 80)}${source.url.length > 80 ? '…' : ''}`);

    try {
      const content = await fetchSource(source.url);
      addLog(`📥 ${(content.length / 1024).toFixed(1)} KB — parsing…`);
      const { all, tamil } = parseSource(content, source.format, source.id);
      const useChannels = source.tamilFilter ? tamil : all;
      addLog(`✅ ${all.length} total → ${tamil.length} Tamil → using ${useChannels.length} channels (filter ${source.tamilFilter ? 'ON' : 'OFF'})`);

      setSources(prev => prev.map(s =>
        s.id === source.id ? { ...s, lastRefresh: Date.now(), totalParsed: all.length, tamilFiltered: tamil.length } : s
      ));
      setChannels(prev => {
        const without = prev.filter(ch => !ch.id.startsWith(`${source.id}_`));
        return [...without, ...useChannels];
      });
      notify(`✅ ${useChannels.length} channels from "${source.name}"`, 'success');
    } catch (e) {
      const raw = String(e).replace('Error: ', '');
      let msg = raw;
      if (raw.includes('404'))       msg = `404 Not Found — check URL is correct and publicly accessible`;
      else if (raw.includes('403'))  msg = `403 Forbidden — server blocked this request`;
      else if (raw.includes('CORS')) msg = `CORS blocked — backend server must be running (port 7000 in dev)`;
      else if (raw.includes('Failed to fetch')) msg = `Network error — check backend is running`;
      else if (raw.includes('timeout'))         msg = `Timeout — URL took too long`;
      else if (raw.includes('empty'))           msg = `Empty response — URL returned no content`;
      setErrors(prev => ({ ...prev, [source.id]: msg }));
      addLog(`❌ ${msg}`);
      notify(`Failed: ${msg}`, 'error');
    } finally {
      setLoading(prev => ({ ...prev, [source.id]: false }));
    }
  }, [setSources, setChannels, notify]);

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
      id: crypto.randomUUID(), name: newName.trim() || hostname,
      url: newUrl.trim(), format: newFormat,
      lastRefresh: null, refreshInterval: newInterval,
      totalParsed: 0, tamilFiltered: 0,
      enabled: true, tamilFilter: true,
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

  const toggleEnable = (id: string) => {
    setSources(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const toggleTamilFilter = async (id: string) => {
    const src = sources.find(s => s.id === id);
    if (!src) return;
    const updated = { ...src, tamilFilter: !src.tamilFilter };
    setSources(prev => prev.map(s => s.id === id ? updated : s));
    // Re-apply filter immediately
    if (src.lastRefresh) {
      notify(`Tamil filter ${updated.tamilFilter ? 'ON' : 'OFF'} — re-fetching…`, 'info');
      await refreshSource(updated);
    }
  };

  const sourceChannelCount = (srcId: string) =>
    channels.filter(ch => ch.id.startsWith(`${srcId}_`)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Globe className="w-7 h-7 text-cyan-400" />Source Manager
          </h2>
          <p className="text-gray-400 mt-1">Import M3U/JSON — Tamil filter per source</p>
        </div>
        <button onClick={() => setShowAdd(!showAdd)}
          className={cn('flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all',
            showAdd ? 'bg-gray-700 text-gray-300'
                    : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40'
          )}>
          {showAdd ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showAdd ? 'Cancel' : 'Add Source'}
        </button>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="bg-gray-900/80 border border-gray-700/50 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700/50">
            <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Fetch Log</span>
            <button onClick={() => setLog([])} className="text-gray-600 hover:text-gray-400 text-xs transition">✕ Clear</button>
          </div>
          <div className="p-3 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
            {log.map((l, i) => (
              <div key={i} className={cn('leading-relaxed',
                l.startsWith('✅') ? 'text-emerald-400' :
                l.startsWith('❌') ? 'text-red-400' :
                l.startsWith('📥') ? 'text-blue-400' :
                l.startsWith('🔗') ? 'text-gray-500' :
                l.startsWith('⏳') ? 'text-yellow-400' : 'text-gray-300'
              )}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-6 space-y-4">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">
            <Link2 className="w-5 h-5 text-cyan-400" />Add New Source
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
              <Download className="w-4 h-4" />Import Source
            </button>
          </div>
        </div>
      )}

      {/* Sources list */}
      {sources.length === 0 ? (
        <div className="text-center py-16 bg-gray-800/30 rounded-2xl border border-gray-700/30">
          <Globe className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h3 className="text-xl text-gray-400 font-semibold">No Sources Added</h3>
          <p className="text-gray-500 mt-2 max-w-md mx-auto">Add an M3U or JSON URL. Use Tamil Filter to auto-extract only Tamil channels.</p>
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
                  {/* Source name + loading */}
                  <div className="flex items-center gap-2 mb-3">
                    {loading[src.id] && <Loader2 className="w-4 h-4 text-cyan-400 animate-spin flex-shrink-0" />}
                    <h4 className="text-white font-semibold truncate">{src.name}</h4>
                  </div>
                  <p className="text-gray-500 text-xs truncate font-mono mb-4">{src.url}</p>

                  {/* ─── TOGGLES ─────────────────────────────────────────── */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 p-4 bg-gray-900/40 rounded-xl border border-gray-700/30">
                    {/* Enable / Disable toggle */}
                    <Toggle
                      checked={src.enabled}
                      onChange={() => toggleEnable(src.id)}
                      label={src.enabled ? 'Enabled' : 'Disabled'}
                      subLabel={src.enabled ? 'Source is active' : 'Source is paused'}
                      color="green"
                    />
                    {/* Tamil Filter toggle */}
                    <Toggle
                      checked={src.tamilFilter}
                      onChange={() => { void toggleTamilFilter(src.id); }}
                      label={src.tamilFilter ? 'Tamil Filter ON' : 'Tamil Filter OFF'}
                      subLabel={src.tamilFilter ? 'Only Tamil channels' : 'All channels included'}
                      color="orange"
                    />
                  </div>
                  {/* ─────────────────────────────────────────────────────── */}

                  {/* Stats badges */}
                  <div className="flex flex-wrap gap-2">
                    <span className="inline-flex items-center gap-1 bg-gray-700/50 text-cyan-400 px-3 py-1 rounded-lg text-xs font-bold uppercase">{src.format}</span>
                    {src.refreshInterval > 0 && (
                      <span className="inline-flex items-center gap-1.5 bg-blue-500/10 text-blue-300 px-3 py-1 rounded-lg text-xs">
                        <Clock className="w-3 h-3" />Every {src.refreshInterval}m
                      </span>
                    )}
                    {src.lastRefresh && (
                      <span className="inline-flex items-center gap-1.5 bg-green-500/10 text-green-300 px-3 py-1 rounded-lg text-xs">
                        <CheckCircle2 className="w-3 h-3" />{src.totalParsed} total → {src.tamilFiltered} Tamil
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5 bg-purple-500/10 text-purple-300 px-3 py-1 rounded-lg text-xs font-semibold">
                      📺 {sourceChannelCount(src.id)} active
                    </span>
                    {src.lastRefresh && (
                      <span className="text-gray-500 text-xs self-center">
                        Updated {new Date(src.lastRefresh).toLocaleTimeString()}
                      </span>
                    )}
                  </div>

                  {errors[src.id] && (
                    <div className="flex items-center gap-2 mt-3 text-red-400 text-xs">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{errors[src.id]}</span>
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex flex-col items-center gap-2 flex-shrink-0">
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
            { label: 'Sources',        value: sources.length,                                 color: 'text-cyan-400' },
            { label: 'Active',         value: sources.filter(s => s.enabled).length,          color: 'text-green-400' },
            { label: 'Total Parsed',   value: sources.reduce((a, s) => a + s.totalParsed, 0), color: 'text-blue-400' },
            { label: 'Active Channels',value: channels.length,                                color: 'text-orange-400' },
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
  const [search, setSearch] = useState('');
  const [group, setGroup]   = useState('All');
  const [page, setPage]     = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const PAGE = 50;

  const groups = ['All', ...Array.from(new Set(channels.map(c => c.group || 'Uncategorized'))).sort()];
  const filtered = channels.filter(c => {
    const inGroup  = group === 'All' || (c.group || 'Uncategorized') === group;
    const inSearch = !search || c.name.toLowerCase().includes(search.toLowerCase());
    return inGroup && inSearch;
  });
  const paginated = filtered.slice(0, page * PAGE);

  const toggleChannel = (id: string) => setChannels(prev => prev.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c));
  const deleteChannel = (id: string) => { setChannels(prev => prev.filter(c => c.id !== id)); notify('Channel removed', 'info'); };
  const deleteSelected = (ids: string[]) => { setChannels(prev => prev.filter(c => !ids.includes(c.id))); notify(`${ids.length} channels removed`, 'info'); };
  const toggleSelect = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => selected.size === filtered.length ? setSelected(new Set()) : setSelected(new Set(filtered.map(c => c.id)));
  const sourceOf = (ch: Channel) => sources.find(s => ch.id.startsWith(`${s.id}_`))?.name || '?';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <Tv2 className="w-7 h-7 text-orange-400" />Channels
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
                <div className="w-8 h-8 rounded bg-gray-700/50 flex items-center justify-center flex-shrink-0 text-xs">📺</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white text-sm font-medium truncate">{ch.name}</span>
                  {ch.kid && <span className="text-xs bg-red-900/50 text-red-300 border border-red-800/50 px-1.5 py-0.5 rounded font-mono flex-shrink-0">🔐 CK</span>}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-gray-500 text-xs truncate">{ch.group || 'Uncategorized'}</span>
                  <span className="text-gray-700 text-xs">·</span>
                  <span className="text-gray-600 text-xs truncate">{sourceOf(ch)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => toggleChannel(ch.id)}
                  className="p-1.5 hover:bg-gray-700/50 text-gray-400 hover:text-white rounded-lg transition">
                  {ch.enabled ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4" />}
                </button>
                <button onClick={() => deleteChannel(ch.id)}
                  className="p-1.5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded-lg transition">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {paginated.length < filtered.length && (
            <button onClick={() => setPage(p => p + 1)}
              className="w-full py-3 bg-gray-800/30 border border-gray-700/30 hover:border-gray-600/50 text-gray-400 hover:text-white rounded-xl text-sm transition">
              Load more ({filtered.length - paginated.length} remaining)
            </button>
          )}
        </div>
      )}

      {channels.length > 0 && (
        <div>
          <h3 className="text-gray-400 text-sm font-semibold mb-3 flex items-center gap-2"><Filter className="w-4 h-4" />Groups</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {groups.filter(g => g !== 'All').map(g => {
              const count = channels.filter(c => (c.group || 'Uncategorized') === g).length;
              return (
                <button key={g} onClick={() => { setGroup(g); setPage(1); }}
                  className={cn('text-left px-3 py-2.5 rounded-xl border text-sm transition-all',
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
// ██  PLAYLISTS TAB — CRUD
// ═══════════════════════════════════════════════════════════════════════════════
function PlaylistsTab({
  playlists, setPlaylists, channels, sources, notify
}: {
  playlists: Playlist[];
  setPlaylists: React.Dispatch<React.SetStateAction<Playlist[]>>;
  channels: Channel[];
  sources: Source[];
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const emptyForm = (): Playlist => ({
    id: crypto.randomUUID(), name: '', description: '',
    sourceIds: sources.map(s => s.id),
    tamilOnly: false, enabledOnly: true,
    groupFilter: '', sortBy: 'name',
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  const [form, setForm] = useState<Playlist>(emptyForm);

  const getPlaylistChannels = (pl: Playlist): Channel[] => {
    let chs = channels;
    if (pl.sourceIds.length > 0) chs = chs.filter(ch => pl.sourceIds.some(sid => ch.id.startsWith(`${sid}_`)));
    if (pl.tamilOnly)    chs = chs.filter(ch => ch.group?.toLowerCase().includes('tamil') || ch.name?.toLowerCase().match(/(sun|vijay|zee tamil|colors tamil|polimer|ktv|kalaignar|jaya|puthuyugam|makkal|thanthi|raj tv|mega|adithya)/i) !== null);
    if (pl.enabledOnly)  chs = chs.filter(ch => ch.enabled);
    if (pl.groupFilter)  chs = chs.filter(ch => (ch.group || 'Uncategorized').toLowerCase().includes(pl.groupFilter.toLowerCase()));
    if (pl.sortBy === 'name')   chs = [...chs].sort((a, b) => a.name.localeCompare(b.name));
    if (pl.sortBy === 'group')  chs = [...chs].sort((a, b) => (a.group || '').localeCompare(b.group || ''));
    return chs;
  };

  const generateM3U = (pl: Playlist): string => {
    const chs = getPlaylistChannels(pl);
    const lines = [`#EXTM3U x-playlist-name="${pl.name}"`];
    for (const ch of chs) {
      let extinf = `#EXTINF:-1 tvg-name="${ch.name}" tvg-logo="${ch.logo}" group-title="${ch.group || 'Uncategorized'}",${ch.name}`;
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

  const downloadPlaylist = (pl: Playlist) => {
    const content = generateM3U(pl);
    const blob = new Blob([content], { type: 'application/x-mpegurl' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${pl.name.replace(/\s+/g, '-')}.m3u`;
    a.click(); URL.revokeObjectURL(url);
    notify(`Downloaded "${pl.name}" (${getPlaylistChannels(pl).length} channels)`, 'success');
  };

  const savePlaylist = () => {
    if (!form.name.trim()) { notify('Playlist name is required', 'error'); return; }
    const updated = { ...form, updatedAt: Date.now() };
    if (editing) {
      setPlaylists(prev => prev.map(p => p.id === updated.id ? updated : p));
      notify(`Updated "${updated.name}"`, 'success');
    } else {
      setPlaylists(prev => [...prev, updated]);
      notify(`Created "${updated.name}"`, 'success');
    }
    setEditing(null); setCreating(false); setForm(emptyForm());
  };

  const deletePlaylist = (id: string) => {
    setPlaylists(prev => prev.filter(p => p.id !== id));
    notify('Playlist deleted', 'info');
  };

  const duplicatePlaylist = (pl: Playlist) => {
    const dup: Playlist = { ...pl, id: crypto.randomUUID(), name: `Copy of ${pl.name}`, createdAt: Date.now(), updatedAt: Date.now() };
    setPlaylists(prev => [...prev, dup]);
    notify(`Duplicated "${pl.name}"`, 'success');
  };

  const startEdit = (pl: Playlist) => { setEditing(pl); setForm({ ...pl }); setCreating(true); };
  const startCreate = () => { setEditing(null); setForm(emptyForm()); setCreating(true); };

  const groups = Array.from(new Set(channels.map(c => c.group || 'Uncategorized'))).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <ListMusic className="w-7 h-7 text-indigo-400" />Playlists
          </h2>
          <p className="text-gray-400 mt-1">{playlists.length} playlists · Create, edit, download, share</p>
        </div>
        <button onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl font-semibold text-sm shadow-lg shadow-indigo-900/30 hover:shadow-indigo-900/50 transition-all">
          <Plus className="w-4 h-4" />New Playlist
        </button>
      </div>

      {/* Create / Edit Form */}
      {creating && (
        <div className="bg-gray-800/50 border border-indigo-700/30 rounded-2xl p-6 space-y-5">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">
            <Edit2 className="w-5 h-5 text-indigo-400" />
            {editing ? `Edit "${editing.name}"` : 'Create New Playlist'}
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Playlist Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="My Tamil Playlist"
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:border-indigo-500 outline-none text-sm" />
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:border-indigo-500 outline-none text-sm" />
            </div>
          </div>

          {/* Sources selection */}
          <div>
            <label className="block text-gray-400 text-sm mb-2">Include Sources</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sources.map(src => (
                <label key={src.id} className={cn(
                  'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all',
                  form.sourceIds.includes(src.id)
                    ? 'bg-indigo-900/30 border-indigo-600/50 text-indigo-200'
                    : 'bg-gray-900/40 border-gray-700/30 text-gray-400 hover:border-gray-600'
                )}>
                  <input type="checkbox"
                    checked={form.sourceIds.includes(src.id)}
                    onChange={() => setForm(f => ({
                      ...f,
                      sourceIds: f.sourceIds.includes(src.id)
                        ? f.sourceIds.filter(id => id !== src.id)
                        : [...f.sourceIds, src.id]
                    }))}
                    className="accent-indigo-500 w-4 h-4" />
                  <span className="text-sm font-medium truncate">{src.name}</span>
                  <span className="text-xs text-gray-500 ml-auto flex-shrink-0">{channels.filter(ch => ch.id.startsWith(`${src.id}_`)).length}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Filter options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-gray-900/40 rounded-xl border border-gray-700/30">
            <Toggle checked={form.tamilOnly} onChange={() => setForm(f => ({ ...f, tamilOnly: !f.tamilOnly }))}
              label="Tamil Channels Only" subLabel="Filter to Tamil content" color="orange" />
            <Toggle checked={form.enabledOnly} onChange={() => setForm(f => ({ ...f, enabledOnly: !f.enabledOnly }))}
              label="Enabled Channels Only" subLabel="Skip disabled channels" color="green" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Group Filter</label>
              <select value={form.groupFilter} onChange={e => setForm(f => ({ ...f, groupFilter: e.target.value }))}
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-indigo-500 outline-none text-sm">
                <option value="">All Groups</option>
                {groups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-sm mb-1.5">Sort By</label>
              <select value={form.sortBy} onChange={e => setForm(f => ({ ...f, sortBy: e.target.value as Playlist['sortBy'] }))}
                className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white focus:border-indigo-500 outline-none text-sm">
                <option value="none">Original Order</option>
                <option value="name">Channel Name A–Z</option>
                <option value="group">Group A–Z</option>
                <option value="source">By Source</option>
              </select>
            </div>
          </div>

          {/* Preview count */}
          <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-xl px-4 py-3 flex items-center gap-3">
            <Eye className="w-4 h-4 text-indigo-400" />
            <span className="text-indigo-300 text-sm">
              This playlist will contain <strong>{getPlaylistChannels(form).length}</strong> channels
            </span>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button onClick={() => { setCreating(false); setEditing(null); }}
              className="px-5 py-2.5 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-xl text-sm font-semibold transition">
              Cancel
            </button>
            <button onClick={savePlaylist} disabled={!form.name.trim()}
              className="px-5 py-2.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40 transition">
              {editing ? 'Save Changes' : 'Create Playlist'}
            </button>
          </div>
        </div>
      )}

      {/* Playlists list */}
      {playlists.length === 0 && !creating ? (
        <div className="text-center py-20 bg-gray-800/30 rounded-2xl border border-gray-700/30">
          <ListMusic className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h3 className="text-xl text-gray-400 font-semibold">No Playlists Yet</h3>
          <p className="text-gray-500 mt-2">Create a playlist to organize and export your channels.</p>
          <button onClick={startCreate}
            className="mt-4 px-5 py-2.5 bg-indigo-700/50 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-700/50 rounded-xl text-sm font-semibold transition">
            Create First Playlist
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {playlists.map(pl => {
            const plChannels = getPlaylistChannels(pl);
            const isPreview = previewId === pl.id;
            return (
              <div key={pl.id} className="bg-gray-800/40 border border-gray-700/40 rounded-2xl overflow-hidden">
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-white font-bold text-lg truncate">{pl.name}</h3>
                        <span className="bg-indigo-900/50 text-indigo-300 border border-indigo-700/50 px-2.5 py-0.5 rounded-full text-xs font-semibold flex-shrink-0">
                          {plChannels.length} ch
                        </span>
                      </div>
                      {pl.description && <p className="text-gray-400 text-sm mb-3">{pl.description}</p>}

                      {/* Filter badges */}
                      <div className="flex flex-wrap gap-2 mb-3">
                        {pl.sourceIds.length > 0 && pl.sourceIds.length < sources.length && (
                          <span className="bg-blue-900/30 text-blue-300 border border-blue-700/30 px-2.5 py-1 rounded-lg text-xs">
                            {pl.sourceIds.length} source{pl.sourceIds.length !== 1 ? 's' : ''}
                          </span>
                        )}
                        {pl.tamilOnly && (
                          <span className="bg-orange-900/30 text-orange-300 border border-orange-700/30 px-2.5 py-1 rounded-lg text-xs">🇮🇳 Tamil Only</span>
                        )}
                        {pl.enabledOnly && (
                          <span className="bg-green-900/30 text-green-300 border border-green-700/30 px-2.5 py-1 rounded-lg text-xs">✓ Enabled Only</span>
                        )}
                        {pl.groupFilter && (
                          <span className="bg-purple-900/30 text-purple-300 border border-purple-700/30 px-2.5 py-1 rounded-lg text-xs">
                            Group: {pl.groupFilter}
                          </span>
                        )}
                        {pl.sortBy !== 'none' && (
                          <span className="bg-gray-700/50 text-gray-300 px-2.5 py-1 rounded-lg text-xs">Sort: {pl.sortBy}</span>
                        )}
                      </div>
                      <p className="text-gray-600 text-xs">
                        Created {new Date(pl.createdAt).toLocaleDateString()} · Updated {new Date(pl.updatedAt).toLocaleDateString()}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2 flex-shrink-0">
                      <button onClick={() => downloadPlaylist(pl)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-emerald-700/40 hover:bg-emerald-700/70 text-emerald-300 border border-emerald-700/40 rounded-xl text-xs font-semibold transition">
                        <Download className="w-3.5 h-3.5" />Download
                      </button>
                      <button onClick={() => startEdit(pl)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-indigo-700/40 hover:bg-indigo-700/70 text-indigo-300 border border-indigo-700/40 rounded-xl text-xs font-semibold transition">
                        <Edit2 className="w-3.5 h-3.5" />Edit
                      </button>
                      <button onClick={() => duplicatePlaylist(pl)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-gray-700/40 hover:bg-gray-700/70 text-gray-300 border border-gray-700/40 rounded-xl text-xs transition">
                        <Copy className="w-3.5 h-3.5" />Duplicate
                      </button>
                      <button onClick={() => setPreviewId(isPreview ? null : pl.id)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-gray-700/40 hover:bg-gray-700/70 text-gray-300 border border-gray-700/40 rounded-xl text-xs transition">
                        {isPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {isPreview ? 'Hide' : 'Preview'}
                      </button>
                      <button onClick={() => deletePlaylist(pl.id)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-red-900/30 hover:bg-red-900/60 text-red-300 border border-red-800/30 rounded-xl text-xs transition">
                        <Trash2 className="w-3.5 h-3.5" />Delete
                      </button>
                    </div>
                  </div>
                </div>

                {/* Preview panel */}
                {isPreview && (
                  <div className="border-t border-gray-700/50 bg-gray-900/40 p-4">
                    <h4 className="text-gray-400 text-xs font-semibold uppercase tracking-wide mb-3">
                      Preview — {plChannels.length} channels
                    </h4>
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
                      {plChannels.slice(0, 50).map(ch => (
                        <div key={ch.id} className="flex items-center gap-2 py-1.5 px-2 bg-gray-800/50 rounded-lg">
                          {ch.logo && (
                            <img src={ch.logo} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          )}
                          <span className="text-white text-xs font-medium truncate flex-1">{ch.name}</span>
                          <span className="text-gray-500 text-xs flex-shrink-0">{ch.group || 'Uncategorized'}</span>
                          {ch.kid && <span className="text-red-400 text-xs flex-shrink-0">🔐</span>}
                        </div>
                      ))}
                      {plChannels.length > 50 && (
                        <div className="text-center text-gray-500 text-xs py-2">…and {plChannels.length - 50} more</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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

  const base    = getBackendBase();
  const enabled = channels.filter(c => c.enabled);
  const groups  = ['All', ...Array.from(new Set(enabled.map(c => c.group || 'Uncategorized'))).sort()];
  const filtered = filterGroup === 'All' ? enabled : enabled.filter(c => (c.group || 'Uncategorized') === filterGroup);

  const M3U_URL    = `${base}/p.m3u`;
  const DRM_URL    = `${base}/drm-playlist.m3u`;
  const STREMIO_URL = `${base}/manifest.json`;
  const INSTALL_URL = `stremio://${base.replace(/^https?:\/\//, '')}/manifest.json`;

  useEffect(() => {
    fetch(`${base}/health`).then(r => r.ok ? setBackendOnline(true) : setBackendOnline(false)).catch(() => setBackendOnline(false));
  }, [base]);

  const generateM3U = (streams: Channel[]): string => {
    const lines = [`#EXTM3U x-playlist-name="${serverConfig.playlistName}"`];
    for (const ch of streams) {
      let extinf = `#EXTINF:-1 tvg-name="${ch.name.replace(/"/g, '')}" tvg-logo="${ch.logo}" group-title="${(ch.group || 'Uncategorized').replace(/"/g, '')}",${ch.name}`;
      lines.push(extinf);
      if (ch.kid && ch.contentKey) {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.kid}:${ch.contentKey}`);
      }
      lines.push(ch.url); lines.push('');
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
      const mfUrl2  = localStorage.getItem('mf_url')  || '';
      const mfPass2 = localStorage.getItem('mf_pass') || '';
      const payload = {
        streams: enabled.map((ch, i) => ({
          id: ch.id, name: ch.name, url: ch.url, logo: ch.logo,
          group: ch.group || 'Uncategorized',
          sourceId: ch.id.split('_')[0] || 'manual',
          enabled: ch.enabled, order: i,
          licenseType: ch.kid ? 'clearkey' : undefined,
          licenseKey: ch.kid && ch.contentKey ? `${ch.kid}:${ch.contentKey}` : undefined,
          kid: ch.kid || undefined, contentKey: ch.contentKey || undefined,
          cookie: ch.language || undefined,
        })),
        settings: {
          addonName: serverConfig.playlistName, sortAlphabetically: true,
          combineMultiQuality: true, mediaflowUrl: mfUrl2, mediaflowPassword: mfPass2,
        },
      };
      const r   = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const res = await r.json() as Record<string, unknown>;
      setSyncResult(res);
      if (res.ok) {
        notify(`✅ ${res.streams as number} channels synced`, 'success');
        setBackendOnline(true);
      } else {
        notify(`Sync failed: ${String(res.error)}`, 'error');
      }
    } catch (e) {
      notify(`Sync error: ${String(e)}`, 'error');
      setBackendOnline(false);
    } finally { setSyncing(false); }
  };

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
          <Radio className="w-7 h-7 text-purple-400" />Playlist Generator
        </h2>
        <p className="text-gray-400 mt-1">{enabled.length} enabled channels ready</p>
      </div>

      <div className={cn('flex items-center gap-3 px-4 py-3 rounded-xl border text-sm',
        backendOnline === true  ? 'bg-emerald-900/20 border-emerald-700/50 text-emerald-300' :
        backendOnline === false ? 'bg-red-900/20 border-red-700/50 text-red-300' :
        'bg-gray-800/30 border-gray-700/50 text-gray-400')}>
        {backendOnline === true  ? <Wifi className="w-4 h-4" /> :
         backendOnline === false ? <WifiOff className="w-4 h-4" /> :
         <Activity className="w-4 h-4 animate-pulse" />}
        <span className="font-medium">Backend: {backendOnline === true ? 'Online ✓' : backendOnline === false ? 'Offline' : 'Checking…'}</span>
      </div>

      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><Settings className="w-4 h-4 text-gray-400" />Settings</h3>
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
              {groups.map(g => <option key={g} value={g}>{g === 'All' ? `All (${enabled.length})` : `${g} (${enabled.filter(c => (c.group||'Uncategorized')===g).length})`}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><Download className="w-4 h-4 text-emerald-400" />Download</h3>
        <p className="text-gray-400 text-sm">{filtered.length} channels · {filtered.filter(c => c.kid).length} DRM</p>
        <div className="flex flex-wrap gap-3">
          <button onClick={downloadM3U} disabled={filtered.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-semibold text-sm disabled:opacity-40 transition">
            <Download className="w-4 h-4" />Download .m3u ({filtered.length} channels)
          </button>
          <button onClick={() => setPreview(!preview)}
            className="flex items-center gap-2 px-4 py-2.5 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-xl text-sm transition">
            <FileText className="w-4 h-4" />{preview ? 'Hide' : 'Preview'} M3U
            {preview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
        {preview && (
          <div className="relative">
            <pre className="bg-gray-900/80 border border-gray-700/50 rounded-xl p-4 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre max-h-60 overflow-y-auto">
              {generateM3U(filtered.slice(0, 5))}
              {filtered.length > 5 && `\n… and ${filtered.length - 5} more`}
            </pre>
            <button onClick={() => copy(generateM3U(filtered), 'full-m3u')}
              className="absolute top-2 right-2 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition">
              {copied === 'full-m3u' ? '✓ Copied' : 'Copy All'}
            </button>
          </div>
        )}
      </div>

      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><Zap className="w-4 h-4 text-yellow-400" />Sync to Backend</h3>
        <p className="text-gray-400 text-sm">Push channels to backend — activates Stremio addon + DRM proxy.</p>
        <button onClick={syncToBackend} disabled={syncing || enabled.length === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm disabled:opacity-40 transition">
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {syncing ? 'Syncing…' : `Sync ${enabled.length} Channels`}
        </button>
        {syncResult && (
          <div className={cn('p-3 rounded-xl text-xs font-mono border',
            syncResult.ok ? 'bg-emerald-900/20 border-emerald-700/50 text-emerald-300' : 'bg-red-900/20 border-red-700/50 text-red-300')}>
            {JSON.stringify(syncResult, null, 2)}
          </div>
        )}
      </div>

      {backendOnline && (
        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
          <h3 className="text-white font-semibold flex items-center gap-2"><Globe className="w-4 h-4 text-cyan-400" />Playlist URLs</h3>
          <UrlRow label="📻 M3U (TiviMate · OTT Navigator · VLC)" url={M3U_URL} k="m3u" />
          <UrlRow label="🔐 DRM Proxy M3U" url={DRM_URL} k="drm" />
          <UrlRow label="📺 Stremio Manifest" url={STREMIO_URL} k="manifest" />
          <div className="bg-gray-900/60 border border-purple-700/30 rounded-xl p-3">
            <div className="text-gray-500 text-xs font-semibold uppercase tracking-wide mb-1.5">🔌 Stremio Install</div>
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
  const [health, setHealth]     = useState<Record<string, unknown> | null>(null);
  const [checking, setChecking] = useState(false);
  const [mfUrl, setMfUrl]       = useState(() => localStorage.getItem('mf_url') || '');
  const [mfPass, setMfPass]     = useState(() => localStorage.getItem('mf_pass') || '');
  const [mfStatus, setMfStatus] = useState<'idle'|'testing'|'ok'|'fail'>('idle');
  const [mfMsg, setMfMsg]       = useState('');
  void channels;

  const checkHealth = async () => {
    setChecking(true);
    try { const r = await fetch(`${base}/health`); setHealth(await r.json() as Record<string, unknown>); }
    catch { setHealth(null); }
    finally { setChecking(false); }
  };

  const testMF = async () => {
    if (!mfUrl || !mfPass) { setMfMsg('Enter MediaFlow URL and password first'); setMfStatus('fail'); return; }
    setMfStatus('testing'); setMfMsg('');
    try {
      const r = await fetch(`${mfUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { setMfStatus('ok'); setMfMsg('MediaFlow online ✓'); localStorage.setItem('mf_url', mfUrl); localStorage.setItem('mf_pass', mfPass); }
      else { setMfStatus('fail'); setMfMsg(`HTTP ${r.status}`); }
    } catch(e) { setMfStatus('fail'); setMfMsg(`Cannot reach: ${String(e)}`); }
  };

  useEffect(() => { void checkHealth(); }, []);

  const CODE = (code: string) => (
    <div className="relative group">
      <pre className="bg-gray-900/90 border border-gray-700/50 rounded-xl p-4 text-xs text-green-300 font-mono overflow-x-auto">{code}</pre>
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
          <Rocket className="w-7 h-7 text-rose-400" />Deploy & Install
        </h2>
        <p className="text-gray-400 mt-1">Deploy to cloud and install in Stremio</p>
      </div>

      {/* Health */}
      <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center gap-2"><Activity className="w-4 h-4 text-green-400" />Backend Health</h3>
          <button onClick={() => void checkHealth()} disabled={checking}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-lg text-xs transition">
            <RefreshCw className={cn('w-3.5 h-3.5', checking && 'animate-spin')} />Refresh
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
            <WifiOff className="w-8 h-8 mx-auto mb-2 text-gray-600" />Backend offline or not deployed yet
          </div>
        )}
        {health && (
          <div className="bg-gray-900/50 border border-gray-700/30 rounded-xl p-3 space-y-1.5">
            {[
              { label: 'Manifest', url: `${base}/manifest.json`, k: 'm' },
              { label: 'M3U',      url: `${base}/p.m3u`,         k: 'p' },
              { label: 'DRM M3U', url: `${base}/drm-playlist.m3u`, k: 'd' },
              { label: 'Install',  url: `${base}/install`,        k: 'i' },
            ].map(({ label, url, k }) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-gray-500 text-xs w-20 flex-shrink-0">{label}</span>
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
        <h3 className="text-white font-semibold flex items-center gap-2"><Shield className="w-4 h-4 text-purple-400" />Install in Stremio</h3>
        <div className="space-y-3">
          <a href={`stremio://${base.replace(/^https?:\/\//, '')}/manifest.json`}
            className="flex items-center justify-center gap-2 w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl font-semibold text-sm transition">
            📺 Install in Stremio App
          </a>
          <a href={`https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${base}/manifest.json`)}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 bg-blue-700/30 hover:bg-blue-700/50 text-blue-200 border border-blue-700/50 rounded-xl font-semibold text-sm transition">
            🌐 Stremio Web
          </a>
          <a href={`${base}/install`} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 bg-gray-800/50 hover:bg-gray-700/50 text-gray-300 border border-gray-700/50 rounded-xl text-sm transition">
            <ExternalLink className="w-4 h-4" />Install Page
          </a>
        </div>
        <div className="bg-gray-900/40 border border-gray-700/30 rounded-xl p-3">
          <p className="text-gray-500 text-xs font-semibold uppercase tracking-wide mb-2">Samsung Tizen TV</p>
          {['Open Stremio on TV', 'Go to ☰ Menu → Addons', 'Click ⚙️ → Custom addon URL', `Paste: ${base}/manifest.json`, 'Select Install'].map((s, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <span className="w-5 h-5 rounded-full bg-purple-900/50 border border-purple-700/50 text-purple-300 text-xs flex items-center justify-center flex-shrink-0">{i + 1}</span>
              <span className="text-gray-400 text-xs">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* MediaFlow */}
      <div className="bg-gradient-to-r from-emerald-900/20 to-teal-900/20 border border-emerald-700/40 rounded-2xl p-5 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-emerald-400" />🌊 MediaFlow Proxy
          <a href="https://github.com/mhdzumair/mediaflow-proxy" target="_blank" rel="noopener noreferrer"
            className="text-xs text-emerald-400 hover:text-emerald-300 underline ml-auto">github ↗</a>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">MediaFlow URL</label>
            <input value={mfUrl} onChange={e => setMfUrl(e.target.value)} placeholder="https://your-mediaflow.domain.com"
              className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:border-emerald-500 outline-none text-sm" />
          </div>
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">API Password</label>
            <input value={mfPass} onChange={e => setMfPass(e.target.value)} type="password" placeholder="api_password"
              className="w-full bg-gray-900/50 border border-gray-600/50 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:border-emerald-500 outline-none text-sm" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void testMF()} disabled={mfStatus === 'testing'}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-700/50 hover:bg-emerald-600/50 text-emerald-200 border border-emerald-700/50 rounded-xl text-sm transition">
            {mfStatus === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}Test
          </button>
          <button onClick={() => { localStorage.setItem('mf_url', mfUrl); localStorage.setItem('mf_pass', mfPass); notify('Saved', 'success'); }}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700/50 hover:bg-gray-600/50 text-gray-200 border border-gray-700/50 rounded-xl text-sm transition">
            <Database className="w-3.5 h-3.5" />Save
          </button>
        </div>
        {mfMsg && (
          <div className={cn('px-3 py-2 rounded-lg text-xs', mfStatus === 'ok' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-red-900/40 text-red-300')}>
            {mfMsg}
          </div>
        )}
        {CODE(`docker run -d -p 8888:8888 -e API_PASSWORD=${mfPass || 'your_secret'} --name mediaflow mhdzumair/mediaflow-proxy`)}
      </div>

      {/* Deploy guides */}
      <div className="space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2"><Rocket className="w-4 h-4 text-rose-400" />Deployment</h3>
        {[
          { icon: '🚀', name: 'Render.com', note: 'Free · sleeps after 15min', port: '10000', color: 'emerald' },
          { icon: '⚡', name: 'Koyeb ⭐ Best', note: 'Free · never sleeps', port: '8000', color: 'blue' },
          { icon: '🚂', name: 'Railway', note: '$5 credit · no sleep', port: '8000', color: 'purple' },
        ].map(d => (
          <div key={d.name} className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-xl">{d.icon}</span>
              <div>
                <h4 className="text-white font-semibold text-sm">{d.name}</h4>
                <p className="text-gray-500 text-xs">{d.note}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[['Build', 'npm install --include=dev && npm run build'], ['Start', 'node backend/server.js'], ['Port', d.port], ['ENV: PUBLIC_URL', `https://your-app.${d.name.toLowerCase().replace(/[^a-z]/g,'')}.app`]].map(([k, v]) => (
                <div key={k} className="bg-gray-900/50 rounded-lg p-2.5">
                  <div className="text-gray-500 text-xs mb-1">{k}</div>
                  <div className="text-green-300 font-mono text-xs break-all">{v}</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="bg-gray-800/40 border border-gray-700/40 rounded-2xl p-5 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2"><Database className="w-4 h-4 text-gray-400" />Server Config</h3>
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
          <Toggle checked={serverConfig.keepAliveEnabled} onChange={() => setServerConfig(p => ({ ...p, keepAliveEnabled: !p.keepAliveEnabled }))}
            label="Keep-alive ping" subLabel="Prevents Render free-tier sleep" color="cyan" />
          <button onClick={() => { saveServerConfig(serverConfig); notify('Config saved', 'success'); }}
            className="px-5 py-2.5 bg-rose-700/50 hover:bg-rose-600/50 text-rose-200 border border-rose-700/50 rounded-xl text-sm font-semibold transition">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ██  HEADER
// ═══════════════════════════════════════════════════════════════════════════════
function Header({ tab, setTab, channelCount }: { tab: Tab; setTab: (t: Tab) => void; channelCount: number }) {
  const TABS: { id: Tab; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: 'sources',   label: 'Sources',   icon: <Globe className="w-4 h-4" /> },
    { id: 'channels',  label: 'Channels',  icon: <Tv2 className="w-4 h-4" />, badge: channelCount > 0 ? String(channelCount) : undefined },
    { id: 'player',    label: 'Player',    icon: <Play className="w-4 h-4" />, badge: channelCount > 0 ? '▶' : undefined },
    { id: 'playlists', label: 'Playlists', icon: <ListMusic className="w-4 h-4" /> },
    { id: 'generator', label: 'Generator', icon: <Radio className="w-4 h-4" /> },
    { id: 'deploy',    label: 'Deploy',    icon: <Rocket className="w-4 h-4" /> },
  ];

  const COLOR: Record<Tab, string> = {
    sources  : 'text-cyan-400   border-cyan-400',
    channels : 'text-orange-400 border-orange-400',
    player   : 'text-yellow-400 border-yellow-400',
    playlists: 'text-indigo-400 border-indigo-400',
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
          <span className="text-xs text-orange-400 font-semibold hidden md:flex items-center gap-1">🇮🇳 Tamil</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-px">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap',
                tab === t.id ? `${COLOR[t.id]} bg-white/5` : 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-white/5'
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
  const [tab, setTab]                   = useState<Tab>('sources');
  const [sources, setSources]           = useState<Source[]>(loadSources);
  const [channels, setChannels]         = useState<Channel[]>(loadChannels);
  const [playlists, setPlaylists]       = useState<Playlist[]>(loadPlaylists);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(loadServerConfig);
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  useEffect(() => { saveSources(sources); },     [sources]);
  useEffect(() => { saveChannels(channels); },   [channels]);
  useEffect(() => { savePlaylists(playlists); }, [playlists]);
  useEffect(() => { saveServerConfig(serverConfig); }, [serverConfig]);

  const notify = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {notification && <Notification msg={notification.msg} type={notification.type} />}
      <Header tab={tab} setTab={setTab} channelCount={channels.filter(c => c.enabled).length} />
      <main className="max-w-screen-xl mx-auto px-4 py-6">
        {tab === 'sources'   && <SourcesTab   sources={sources} setSources={setSources} channels={channels} setChannels={setChannels} notify={notify} />}
        {tab === 'channels'  && <ChannelsTab  channels={channels} setChannels={setChannels} sources={sources} notify={notify} />}
        {tab === 'player'    && <ShakaPlayer  channels={channels} sources={sources} />}
        {tab === 'playlists' && <PlaylistsTab playlists={playlists} setPlaylists={setPlaylists} channels={channels} sources={sources} notify={notify} />}
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
            <span className="text-orange-400/70">🇮🇳 Tamil Filter</span>
            <span>{channels.filter(c => c.enabled).length.toLocaleString()} channels</span>
            <span>{sources.length} sources</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
