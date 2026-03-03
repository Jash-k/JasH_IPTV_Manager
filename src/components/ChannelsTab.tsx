import React, { useState, useMemo, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { Channel } from '../types';
import {
  Search, Trash2, Edit2, Save, X, ChevronDown, ChevronUp,
  Heart, Wifi, WifiOff, Loader, Activity,
  Copy, Check, GitMerge, Globe, Plus, CheckSquare,
  Square, MoveRight, Filter, RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';

const PAGE_SIZE = 50;

// ── Blank channel template ────────────────────────────────────────────────────
const BLANK: Omit<Channel, 'id'> = {
  name: '', url: '', group: 'Uncategorized', logo: '',
  isActive: true, enabled: true, order: 0,
  sourceId: 'manual', streamType: 'hls',
};

// ── Form fields config ────────────────────────────────────────────────────────
interface EditState {
  name: string; url: string; group: string; logo: string;
  userAgent: string; referer: string; cookie: string; streamType: string;
}

const FIELD_CONFIG: [string, keyof EditState, string, string][] = [
  ['Channel Name *', 'name',      'text', 'e.g. Sun TV'],
  ['Stream URL *',   'url',       'url',  'https://...m3u8'],
  ['Logo URL',       'logo',      'url',  'https://logo.png'],
  ['User-Agent',     'userAgent', 'text', 'Mozilla/5.0...'],
  ['Referer',        'referer',   'url',  'https://referer.com/'],
  ['Cookie',         'cookie',    'text', 'session=abc123'],
];

// ── Health badge ──────────────────────────────────────────────────────────────
function HealthBadge({ ch }: { ch: Channel }) {
  if (!ch.healthStatus || ch.healthStatus === 'unknown') return null;
  if (ch.healthStatus === 'checking')
    return <Loader className="w-3.5 h-3.5 animate-spin text-yellow-400" />;
  if (ch.healthStatus === 'ok')
    return (
      <span className="flex items-center gap-1 text-xs text-green-400 font-medium">
        <Wifi className="w-3 h-3" />
        {ch.healthLatency ? `${ch.healthLatency}ms` : 'Live'}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-red-400">
      <WifiOff className="w-3 h-3" /> Dead
    </span>
  );
}

// ── Route badge ───────────────────────────────────────────────────────────────
function RouteBadge({ ch }: { ch: Channel }) {
  const u = (ch.url || '').toLowerCase();
  const ext = u.includes('.m3u8') || u.includes('/hls/') ? 'HLS'
    : u.includes('.mpd') || u.includes('/dash/') ? 'DASH'
    : u.includes('.ts') ? 'TS' : 'STR';
  return (
    <span className="flex items-center gap-1 text-xs bg-green-500/10 border border-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full whitespace-nowrap">
      <Globe className="w-2.5 h-2.5" /> 302·{ext}
    </span>
  );
}

// ── Multi-source panel — shows all source links, each has its own 302 redirect
function MultiSourcePanel({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const { sources, serverUrl } = useStore();
  const base = serverUrl || window.location.origin;
  const [copied, setCopied] = useState<string | null>(null);

  const links = ch.combinedLinks || [];

  const copyLink = (key: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
    toast.success('URL copied!');
  };

  return (
    <div className="mt-2 mx-3 mb-3 bg-gray-900 border border-blue-500/30 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-blue-400" />
          <span className="text-white font-medium text-sm">Multi-Source — {ch.name}</span>
          <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
            {links.length} sources
          </span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
      </div>

      <p className="text-xs text-gray-400">
        Each source has its own 302 redirect URL. All redirect directly to their original stream.
      </p>

      <div className="space-y-2">
        {links.map((link, i) => {
          const src = sources.find(s => s.id === link.sourceId);
          const redirectUrl = `${base}/redirect/${link.channelId}`;
          return (
            <div key={link.channelId + i}
              className="flex items-center gap-3 p-2.5 rounded-lg border bg-gray-800 border-gray-700">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-white text-xs font-medium">{src?.name || link.sourceName || link.sourceId}</span>
                  <span className="text-xs bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                    302 redirect
                  </span>
                </div>
                <p className="text-gray-500 text-xs font-mono truncate mt-0.5">{redirectUrl}</p>
              </div>
              <button onClick={() => copyLink(link.channelId, redirectUrl)}
                className="p-1.5 text-gray-400 hover:text-blue-400 rounded">
                {copied === link.channelId
                  ? <Check className="w-3.5 h-3.5 text-green-400" />
                  : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Channel form modal (Add / Edit) ───────────────────────────────────────────
function ChannelModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: Channel;
  onSave: (v: EditState) => void;
  onClose: () => void;
}) {
  const { groups } = useStore();
  const [v, setV] = useState<EditState>({
    name:       initial?.name       || '',
    url:        initial?.url        || '',
    group:      initial?.group      || 'Uncategorized',
    logo:       initial?.logo       || '',
    userAgent:  initial?.userAgent  || '',
    referer:    initial?.referer    || '',
    cookie:     initial?.cookie     || '',
    streamType: initial?.streamType || 'hls',
  });

  const f = (k: keyof EditState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setV(prev => ({ ...prev, [k]: e.target.value }));

  const handleSave = () => {
    if (!v.name.trim())        { toast.error('Channel name is required'); return; }
    if (!v.url.trim())         { toast.error('Stream URL is required'); return; }
    if (!v.url.startsWith('http')) { toast.error('URL must start with http/https'); return; }
    onSave(v);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold text-lg">
            {initial ? '✏️ Edit Channel' : '➕ Add Channel'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {FIELD_CONFIG.map(([label, key, type, placeholder]) => (
          <div key={key}>
            <label className="text-gray-400 text-sm mb-1 block">{label}</label>
            <input type={type} value={v[key]} onChange={f(key)} placeholder={placeholder}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors" />
          </div>
        ))}

        {/* Group selector */}
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Group</label>
          <select value={v.group} onChange={f('group')}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
            {groups.length === 0 && <option value="Uncategorized">Uncategorized</option>}
            {groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
          </select>
        </div>

        {/* Stream type */}
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Stream Type</label>
          <div className="flex gap-2">
            {(['hls', 'dash', 'direct'] as const).map(t => (
              <button key={t} onClick={() => setV(prev => ({ ...prev, streamType: t }))}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${v.streamType === t
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}>
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="p-3 bg-green-900/20 border border-green-500/20 rounded-lg text-xs text-green-400 flex items-center gap-2">
          <Globe className="w-4 h-4 shrink-0" />
          This channel uses pure 302 redirect — zero server load. No DRM streams.
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
          <button onClick={handleSave}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium">
            <Save className="w-4 h-4" /> {initial ? 'Save Changes' : 'Add Channel'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk move to group dialog ──────────────────────────────────────────────────
function BulkMoveModal({
  count,
  onMove,
  onClose,
}: {
  count: number;
  onMove: (groupName: string) => void;
  onClose: () => void;
}) {
  const { groups } = useStore();
  const [target, setTarget] = useState('');
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Move {count} Channels</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Target Group</label>
          <select value={target} onChange={e => setTarget(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
            <option value="">Select group…</option>
            {groups.map(g => <option key={g.id} value={g.name}>{g.name} ({g.channelCount || 0})</option>)}
          </select>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
          <button onClick={() => { if (!target) { toast.error('Select a group'); return; } onMove(target); }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <MoveRight className="w-4 h-4" /> Move
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main ChannelsTab ──────────────────────────────────────────────────────────
export default function ChannelsTab() {
  const {
    channels, sources,
    showTamilOnly, setShowTamilOnly,
    addChannel, updateChannel, deleteChannel, toggleChannel,
    moveChannelToGroup, serverUrl, getFilteredChannels,
  } = useStore();

  const [search,       setSearch]       = useState('');
  const [groupFilter,  setGroupFilter]  = useState('');
  const [routeFilter,  setRouteFilter]  = useState<'all' | 'multi' | 'tamil'>('all');
  const [page,         setPage]         = useState(1);
  const [editCh,       setEditCh]       = useState<Channel | null>(null);
  const [showAdd,      setShowAdd]      = useState(false);
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [checking,     setChecking]     = useState<Record<string, boolean>>({});
  const [batchChecking,setBatchChecking]= useState(false);
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [showBulkMove, setShowBulkMove] = useState(false);

  const base = serverUrl || window.location.origin;

  // ── Filtered + paged channels ────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return getFilteredChannels().filter(ch => {
      if (groupFilter && ch.group !== groupFilter) return false;
      if (routeFilter === 'multi'  && !ch.multiSource) return false;
      if (routeFilter === 'tamil'  && !ch.isTamil)    return false;
      if (q && !ch.name.toLowerCase().includes(q) && !(ch.group || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [channels, search, groupFilter, routeFilter, showTamilOnly, getFilteredChannels]);

  const paged      = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const tamilCount = channels.filter(ch => ch.isTamil).length;
  const multiCount = channels.filter(ch => ch.multiSource).length;
  const groupNames = [...new Set(channels.map(ch => ch.group || 'Uncategorized'))].sort();

  // ── Selection helpers ────────────────────────────────────────────────────
  const allPageSelected = paged.length > 0 && paged.every(ch => selected.has(ch.id));

  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelected(prev => { const n = new Set(prev); paged.forEach(ch => n.delete(ch.id)); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); paged.forEach(ch => n.add(ch.id)); return n; });
    }
  };

  const clearSelection = () => setSelected(new Set());

  // ── Health checks ────────────────────────────────────────────────────────
  const checkHealth = useCallback(async (ch: Channel) => {
    setChecking(c => ({ ...c, [ch.id]: true }));
    updateChannel(ch.id, { healthStatus: 'checking' });
    try {
      const resp = await fetch(`${base}/api/health/${ch.id}`, { signal: AbortSignal.timeout(12000) });
      const data = await resp.json();
      updateChannel(ch.id, { healthStatus: data.ok ? 'ok' : 'error', healthLatency: data.latency });
      data.ok
        ? toast.success(`✅ ${ch.name}: Live (${data.latency}ms)`)
        : toast.error(`❌ ${ch.name}: Dead (HTTP ${data.status})`);
    } catch {
      updateChannel(ch.id, { healthStatus: 'error' });
      toast.error('Health check failed — is server running?');
    } finally {
      setChecking(c => { const n = { ...c }; delete n[ch.id]; return n; });
    }
  }, [base, updateChannel]);

  const batchCheck = async () => {
    setBatchChecking(true);
    const ids = paged.map(ch => ch.id);
    ids.forEach(id => updateChannel(id, { healthStatus: 'checking' }));
    try {
      const resp = await fetch(`${base}/api/health/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.ok) {
        const data = await resp.json();
        Object.entries(data.results || {}).forEach(([id, r]) => {
          const result = r as { ok: boolean; latency: number };
          updateChannel(id, { healthStatus: result.ok ? 'ok' : 'error', healthLatency: result.latency });
        });
        const live = Object.values(data.results || {}).filter((r) => (r as { ok: boolean }).ok).length;
        toast.success(`🏥 ${live}/${ids.length} live`);
      }
    } catch {
      ids.forEach(id => updateChannel(id, { healthStatus: 'error' }));
      toast.error('Batch check failed');
    } finally {
      setBatchChecking(false);
    }
  };

  // ── CRUD handlers ────────────────────────────────────────────────────────
  const handleAdd = (v: EditState) => {
    addChannel({
      ...BLANK,
      name: v.name, url: v.url, group: v.group,
      logo:       v.logo       || undefined,
      userAgent:  v.userAgent  || undefined,
      referer:    v.referer    || undefined,
      cookie:     v.cookie     || undefined,
      streamType: (v.streamType as Channel['streamType']) || 'hls',
      order:      channels.length,
    });
    toast.success('✅ Channel added');
    setShowAdd(false);
  };

  const handleEdit = (v: EditState) => {
    if (!editCh) return;
    updateChannel(editCh.id, {
      name: v.name, url: v.url, group: v.group,
      logo:       v.logo       || undefined,
      userAgent:  v.userAgent  || undefined,
      referer:    v.referer    || undefined,
      cookie:     v.cookie     || undefined,
      streamType: (v.streamType as Channel['streamType']) || 'hls',
    });
    toast.success('✅ Channel updated');
    setEditCh(null);
  };

  const handleDelete = (ch: Channel) => {
    deleteChannel(ch.id);
    toast.success(`🗑️ ${ch.name} removed`);
  };

  const handleBulkDelete = () => {
    if (!confirm(`Delete ${selected.size} channels?`)) return;
    selected.forEach(id => deleteChannel(id));
    toast.success(`🗑️ ${selected.size} channels deleted`);
    clearSelection();
  };

  const handleBulkMove = (groupName: string) => {
    selected.forEach(id => moveChannelToGroup(id, groupName));
    toast.success(`✅ Moved ${selected.size} channels to "${groupName}"`);
    setShowBulkMove(false);
    clearSelection();
  };

  const handleBulkToggle = (active: boolean) => {
    selected.forEach(id => {
      const ch = channels.find(c => c.id === id);
      if (ch && ch.isActive !== active) toggleChannel(id);
    });
    toast.success(`${active ? 'Enabled' : 'Disabled'} ${selected.size} channels`);
    clearSelection();
  };

  const copyUrl = (url: string, label = 'URL copied!') => {
    navigator.clipboard.writeText(url);
    toast.success(label);
  };

  return (
    <div className="space-y-4">
      {/* Modals */}
      {showAdd  && <ChannelModal onSave={handleAdd}  onClose={() => setShowAdd(false)} />}
      {editCh   && <ChannelModal initial={editCh} onSave={handleEdit} onClose={() => setEditCh(null)} />}
      {showBulkMove && (
        <BulkMoveModal count={selected.size} onMove={handleBulkMove} onClose={() => setShowBulkMove(false)} />
      )}

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Channels</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {channels.length.toLocaleString()} total ·{' '}
            <span className="text-green-400">all 302 redirect</span>
            {tamilCount > 0 && <span className="text-orange-400"> · {tamilCount} 🎬 Tamil</span>}
            {multiCount > 0  && <span className="text-blue-400"> · {multiCount} 🔀 multi</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={batchCheck} disabled={batchChecking}
            className="flex items-center gap-2 bg-green-700/30 hover:bg-green-700/50 border border-green-600/30 text-green-400 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
            {batchChecking ? <Loader className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            {batchChecking ? 'Checking…' : `Health (${paged.length})`}
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Add Channel
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ──────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 flex-wrap bg-blue-900/30 border border-blue-500/30 rounded-xl px-4 py-3">
          <span className="text-blue-300 text-sm font-medium">{selected.size} selected</span>
          <div className="flex gap-2 flex-wrap ml-auto">
            <button onClick={() => handleBulkToggle(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 border border-green-500/30 text-green-400 rounded-lg text-xs font-medium hover:bg-green-600/30">
              <RefreshCw className="w-3 h-3" /> Enable
            </button>
            <button onClick={() => handleBulkToggle(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 border border-gray-600 text-gray-300 rounded-lg text-xs font-medium hover:bg-gray-600">
              <RefreshCw className="w-3 h-3" /> Disable
            </button>
            <button onClick={() => setShowBulkMove(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 border border-purple-500/30 text-purple-400 rounded-lg text-xs font-medium hover:bg-purple-600/30">
              <MoveRight className="w-3 h-3" /> Move to Group
            </button>
            <button onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 border border-red-500/30 text-red-400 rounded-lg text-xs font-medium hover:bg-red-600/30">
              <Trash2 className="w-3 h-3" /> Delete ({selected.size})
            </button>
            <button onClick={clearSelection}
              className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-white text-xs">
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or group…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors" />
        </div>

        <select value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setPage(1); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 min-w-36">
          <option value="">All Groups ({channels.length})</option>
          {groupNames.map(g => (
            <option key={g} value={g}>
              {g} ({channels.filter(ch => ch.group === g).length})
            </option>
          ))}
        </select>

        <div className="flex gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
          {([
            ['all',   'All'],
            ['tamil', '🎬 Tamil'],
            ['multi', '🔀 Multi'],
          ] as const).map(([f, label]) => (
            <button key={f} onClick={() => { setRouteFilter(f); setPage(1); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${routeFilter === f ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>

        <button onClick={() => { setShowTamilOnly(!showTamilOnly); setPage(1); }}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${showTamilOnly
            ? 'bg-orange-500 border-orange-400 text-white'
            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-orange-500 hover:text-orange-400'}`}>
          <Heart className={`w-3.5 h-3.5 ${showTamilOnly ? 'fill-white' : ''}`} />
          Tamil {tamilCount > 0 && `(${tamilCount})`}
        </button>

        {(search || groupFilter || routeFilter !== 'all' || showTamilOnly) && (
          <button onClick={() => { setSearch(''); setGroupFilter(''); setRouteFilter('all'); setShowTamilOnly(false); setPage(1); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors">
            <Filter className="w-3.5 h-3.5" /> Clear
          </button>
        )}
      </div>

      {/* ── Channel list ─────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Filter className="w-14 h-14 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium text-gray-400 mb-2">No channels found</p>
          <p className="text-sm mb-6">Try adjusting filters or add a channel manually</p>
          <button onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Channel
          </button>
        </div>
      ) : (
        <>
          {/* Select all row */}
          <div className="flex items-center gap-3 px-3 py-2 bg-gray-800/50 border border-gray-700/50 rounded-lg text-xs text-gray-400">
            <button onClick={toggleSelectAll} className="flex items-center gap-2 hover:text-white transition-colors">
              {allPageSelected
                ? <CheckSquare className="w-4 h-4 text-blue-400" />
                : <Square className="w-4 h-4" />}
              {allPageSelected ? 'Deselect page' : `Select page (${paged.length})`}
            </button>
            <span className="text-gray-600">·</span>
            <span>{filtered.length.toLocaleString()} channels shown</span>
            <span className="text-gray-600">·</span>
            <span className="flex items-center gap-1"><Globe className="w-3 h-3 text-green-400" /> all 302 redirect</span>
          </div>

          <div className="space-y-1.5">
            {paged.map(ch => (
              <div key={ch.id}
                className={`bg-gray-800 border rounded-xl transition-all ${
                  selected.has(ch.id)  ? 'border-blue-500/60 bg-blue-950/20'
                  : ch.multiSource     ? 'border-blue-700/30 hover:border-blue-600/50'
                  : !ch.isActive       ? 'border-gray-700/40 opacity-60'
                  : 'border-gray-700 hover:border-gray-600'
                }`}>
                <div className="flex items-center gap-3 p-3">
                  {/* Checkbox */}
                  <button onClick={() => toggleSelect(ch.id)} className="shrink-0 text-gray-500 hover:text-blue-400 transition-colors">
                    {selected.has(ch.id)
                      ? <CheckSquare className="w-4 h-4 text-blue-400" />
                      : <Square className="w-4 h-4" />}
                  </button>

                  {/* Logo */}
                  <div className="w-9 h-9 rounded-lg overflow-hidden bg-gray-700 flex items-center justify-center shrink-0">
                    {ch.logo
                      ? <img src={ch.logo} alt="" className="w-full h-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="text-gray-500 text-xs font-bold">TV</span>}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium text-sm truncate ${ch.isActive ? 'text-white' : 'text-gray-500'}`}>
                        {ch.name}
                      </span>
                      {ch.isTamil && (
                        <span className="text-xs bg-orange-500/10 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded-full">🎬</span>
                      )}
                      {ch.multiSource && (
                        <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                          <GitMerge className="w-2.5 h-2.5" /> {(ch.combinedLinks || []).length}
                        </span>
                      )}
                      <RouteBadge ch={ch} />
                      <HealthBadge ch={ch} />
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-gray-500 text-xs">{ch.group}</span>
                      <span className="text-gray-700">·</span>
                      <span className="text-gray-600 text-xs font-mono truncate max-w-48">{ch.url}</span>
                      {sources.find(s => s.id === ch.sourceId) && (
                        <>
                          <span className="text-gray-700">·</span>
                          <span className="text-gray-600 text-xs">{sources.find(s => s.id === ch.sourceId)?.name}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Health check */}
                    <button onClick={() => checkHealth(ch)} disabled={!!checking[ch.id]}
                      title="Check stream health"
                      className="p-1.5 text-gray-400 hover:text-green-400 transition-colors rounded-lg hover:bg-gray-700 disabled:opacity-50">
                      {checking[ch.id] ? <Loader className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                    </button>

                    {/* Copy 302 URL */}
                    <button onClick={() => copyUrl(`${base}/redirect/${ch.id}`, '📋 Redirect URL copied!')}
                      title="Copy 302 redirect URL"
                      className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Copy className="w-4 h-4" />
                    </button>

                    {/* Multi-source expand */}
                    {ch.multiSource && (
                      <button onClick={() => setExpanded(expanded === ch.id ? null : ch.id)}
                        title="View all source links"
                        className="flex items-center gap-0.5 p-1.5 text-blue-400 hover:text-blue-300 transition-colors rounded-lg hover:bg-gray-700">
                        <GitMerge className="w-4 h-4" />
                        {expanded === ch.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                    )}

                    {/* Enable toggle */}
                    <button onClick={() => toggleChannel(ch.id)} title={ch.isActive ? 'Disable' : 'Enable'}
                      className={`w-8 h-4 rounded-full transition-colors relative ${ch.isActive ? 'bg-blue-600' : 'bg-gray-600'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${ch.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>

                    {/* Edit */}
                    <button onClick={() => setEditCh(ch)} title="Edit channel"
                      className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Edit2 className="w-4 h-4" />
                    </button>

                    {/* Delete */}
                    <button onClick={() => handleDelete(ch)} title="Delete channel"
                      className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Multi-source panel */}
                {expanded === ch.id && ch.multiSource && (
                  <MultiSourcePanel ch={ch} onClose={() => setExpanded(null)} />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Pagination ──────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-gray-500 text-sm">
            {filtered.length.toLocaleString()} channels · Page {page}/{totalPages}
          </p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg text-sm disabled:opacity-40 hover:bg-gray-700">
              ← Prev
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pg = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
              return (
                <button key={pg} onClick={() => setPage(pg)}
                  className={`w-9 py-1.5 rounded-lg text-sm font-medium transition-colors ${pg === page ? 'bg-blue-600 text-white' : 'bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700'}`}>
                  {pg}
                </button>
              );
            })}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg text-sm disabled:opacity-40 hover:bg-gray-700">
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
