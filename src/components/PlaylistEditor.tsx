import { useState, useMemo, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { Channel } from '../types';
import {
  Search, X, Plus, Minus, Star,
  GripVertical, Copy, Check, Download,
  Filter, ChevronUp, ChevronDown, RefreshCw,
  Shield, Tv2, List, Save, ArrowLeft, ArrowRight,
  Eye, EyeOff, ChevronRight,
} from 'lucide-react';
import toast from 'react-hot-toast';

/* ─── Safe string coercer ──────────────────────────────────────────────────── */
const ss = (v: unknown) => (typeof v === 'string' ? v : String(v ?? '')).toLowerCase();

/* ─── Single Channel Row Component ────────────────────────────────────────── */
function ChannelRow({
  ch, side, onAdd, onRemove, onPin, onBlock,
  isPinned, isBlocked, isDragging,
  onDragStart, onDragOver, onDrop,
}: {
  ch: Channel;
  side: 'left' | 'right';
  onAdd?: () => void;
  onRemove?: () => void;
  onPin?: () => void;
  onBlock?: () => void;
  isPinned?: boolean;
  isBlocked?: boolean;
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
}) {
  return (
    <div
      draggable={side === 'right'}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-all group select-none ${
        isDragging
          ? 'opacity-40 scale-95 border-blue-500 bg-blue-950/30'
          : isBlocked
          ? 'bg-red-950/20 border-red-900/40'
          : isPinned
          ? 'bg-green-950/20 border-green-800/40'
          : side === 'right'
          ? 'bg-gray-800/80 border-gray-700/60 hover:border-gray-600'
          : 'bg-gray-900/80 border-gray-800/60 hover:border-gray-700'
      }`}
    >
      {/* Drag handle */}
      {side === 'right' && (
        <GripVertical className="w-3 h-3 text-gray-700 group-hover:text-gray-500 shrink-0 cursor-grab" />
      )}

      {/* Logo */}
      {ch.logo ? (
        <img src={ch.logo} alt="" className="w-5 h-5 rounded object-contain bg-gray-800 shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div className="w-5 h-5 rounded bg-gray-700 flex items-center justify-center shrink-0">
          <Tv2 className="w-2.5 h-2.5 text-gray-500" />
        </div>
      )}

      {/* Name + group */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate leading-tight ${
          isBlocked ? 'text-red-400 line-through opacity-60'
          : isPinned ? 'text-green-300'
          : 'text-white'
        }`}>{ch.name}</p>
        <p className="text-gray-600 text-[10px] truncate leading-tight">{ch.group}</p>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-0.5 shrink-0">
        {ch.isTamil && <span className="text-[9px] bg-orange-500/20 text-orange-400 px-1 py-0.5 rounded font-bold border border-orange-500/20">TM</span>}
        {ch.isDrm   && <Shield className="w-2.5 h-2.5 text-purple-400" />}
        {isPinned   && <span className="text-[9px] bg-green-500/20 text-green-400 px-1 py-0.5 rounded font-bold border border-green-500/20">PIN</span>}
        {isBlocked  && <span className="text-[9px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded font-bold border border-red-500/20">BLK</span>}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {side === 'left' ? (
          <>
            <button onClick={onAdd} title="Add to playlist"
              className="p-1 rounded hover:bg-green-500/20 text-gray-600 hover:text-green-400 transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button onClick={onBlock} title={isBlocked ? 'Unblock' : 'Block'}
              className={`p-1 rounded transition-colors ${isBlocked ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400 hover:bg-red-500/10'}`}>
              <Minus className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <>
            <button onClick={onPin} title={isPinned ? 'Unpin' : 'Pin (always include)'}
              className={`p-1 rounded transition-colors ${isPinned ? 'text-green-400 bg-green-500/10' : 'text-gray-600 hover:text-green-400 hover:bg-green-500/10'}`}>
              <Star className={`w-3.5 h-3.5 ${isPinned ? 'fill-green-400' : ''}`} />
            </button>
            <button onClick={onRemove} title="Remove from playlist"
              className="p-1 rounded hover:bg-red-500/20 text-gray-600 hover:text-red-400 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Main Playlist Editor ─────────────────────────────────────────────────── */
export default function PlaylistEditor() {
  const {
    channels, groups, playlists, serverUrl,
    editingPlaylistId, setEditingPlaylistId,
    updatePlaylist, getPlaylistM3U, setActiveTab,
  } = useStore();

  const playlist = playlists.find(p => p.id === editingPlaylistId);

  /* ── Local UI state ── */
  const [leftSearch,    setLeftSearch]    = useState('');
  const [rightSearch,   setRightSearch]   = useState('');
  const [leftGroup,     setLeftGroup]     = useState('__all__');
  const [leftTamilOnly, setLeftTamilOnly] = useState(false);
  const [leftDrmOnly,   setLeftDrmOnly]   = useState(false);
  const [sortMode,      setSortMode]      = useState<'order' | 'name' | 'group'>('order');
  const [dragId,        setDragId]        = useState<string | null>(null);
  const [dragOverId,    setDragOverId]    = useState<string | null>(null);
  const [rightOrder,    setRightOrder]    = useState<string[]>([]);
  const [copied,        setCopied]        = useState(false);
  const [showPreview,   setShowPreview]   = useState(false);

  /* ── Derived sets ── */
  const pinnedSet  = useMemo(() => new Set(playlist?.pinnedChannels  || []), [playlist]);
  const blockedSet = useMemo(() => new Set(playlist?.blockedChannels || []), [playlist]);

  /* ── Channels IN this playlist (right panel) ── */
  const inPlaylist = useMemo<Channel[]>(() => {
    if (!playlist) return [];
    return channels.filter(ch => {
      if (blockedSet.has(ch.id)) return false;
      if (pinnedSet.has(ch.id))  return true;   // always show pinned
      if (!ch.isActive) return false;
      if (playlist.tamilOnly && !ch.isTamil) return false;
      if (playlist.includeGroups.length && !playlist.includeGroups.includes(ch.group)) return false;
      if (playlist.excludeGroups.includes(ch.group)) return false;
      return true;
    });
  }, [playlist, channels, pinnedSet, blockedSet]);

  /* ── Channels NOT in playlist (left panel) ── */
  const available = useMemo<Channel[]>(() => {
    const inIds = new Set(inPlaylist.map(c => c.id));
    return channels.filter(c => !inIds.has(c.id));
  }, [channels, inPlaylist]);

  /* ── Left panel filter ── */
  const leftFiltered = useMemo(() => {
    let list = [...available];
    if (leftTamilOnly) list = list.filter(c => c.isTamil);
    if (leftDrmOnly)   list = list.filter(c => c.isDrm);
    if (leftGroup !== '__all__') list = list.filter(c => c.group === leftGroup);
    if (leftSearch) {
      const q = leftSearch.toLowerCase();
      list = list.filter(c => ss(c.name).includes(q) || ss(c.group).includes(q));
    }
    return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [available, leftTamilOnly, leftDrmOnly, leftGroup, leftSearch]);

  /* ── Right panel filter + sort ── */
  const rightFiltered = useMemo(() => {
    let list = [...inPlaylist];
    if (rightSearch) {
      const q = rightSearch.toLowerCase();
      list = list.filter(c => ss(c.name).includes(q) || ss(c.group).includes(q));
    }
    if (sortMode === 'name') {
      list.sort((a, b) => ss(a.name).localeCompare(ss(b.name)));
    } else if (sortMode === 'group') {
      list.sort((a, b) => ss(a.group).localeCompare(ss(b.group)));
    } else {
      // custom order: pinned first, then by rightOrder or channel.order
      list.sort((a, b) => {
        const ap = pinnedSet.has(a.id) ? 0 : 1;
        const bp = pinnedSet.has(b.id) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        const ai = rightOrder.indexOf(a.id);
        const bi = rightOrder.indexOf(b.id);
        if (ai !== -1 && bi !== -1) return ai - bi;
        return (a.order ?? 0) - (b.order ?? 0);
      });
    }
    return list;
  }, [inPlaylist, rightSearch, sortMode, pinnedSet, rightOrder]);

  /* ── Counts ── */
  const tamilLeft  = leftFiltered.filter(c => c.isTamil).length;
  const tamilRight = inPlaylist.filter(c => c.isTamil).length;

  /* ── Save helper ── */
  const save = useCallback((updates: { pinnedChannels?: string[]; blockedChannels?: string[] }) => {
    if (!playlist) return;
    updatePlaylist(playlist.id, updates);
  }, [playlist, updatePlaylist]);

  /* ── Add channel to playlist ── */
  const addChannel = useCallback((ch: Channel) => {
    const pinned  = [...new Set([...(playlist?.pinnedChannels  || []), ch.id])];
    const blocked = (playlist?.blockedChannels || []).filter(id => id !== ch.id);
    save({ pinnedChannels: pinned, blockedChannels: blocked });
    toast.success(`➕ Added: ${ch.name}`);
  }, [playlist, save]);

  /* ── Remove channel from playlist ── */
  const removeChannel = useCallback((ch: Channel) => {
    const pinned  = (playlist?.pinnedChannels  || []).filter(id => id !== ch.id);
    const blocked = [...new Set([...(playlist?.blockedChannels || []), ch.id])];
    save({ pinnedChannels: pinned, blockedChannels: blocked });
    toast.success(`➖ Removed: ${ch.name}`);
  }, [playlist, save]);

  /* ── Toggle pin ── */
  const togglePin = useCallback((ch: Channel) => {
    const pinned = playlist?.pinnedChannels || [];
    if (pinned.includes(ch.id)) {
      save({ pinnedChannels: pinned.filter(id => id !== ch.id) });
      toast.success(`📌 Unpinned: ${ch.name}`);
    } else {
      save({ pinnedChannels: [...pinned, ch.id] });
      toast.success(`📌 Pinned: ${ch.name}`);
    }
  }, [playlist, save]);

  /* ── Toggle block ── */
  const toggleBlock = useCallback((ch: Channel) => {
    const blocked = playlist?.blockedChannels || [];
    if (blocked.includes(ch.id)) {
      save({ blockedChannels: blocked.filter(id => id !== ch.id) });
      toast.success(`✅ Unblocked: ${ch.name}`);
    } else {
      save({ blockedChannels: [...blocked, ch.id] });
      toast.success(`🚫 Blocked: ${ch.name}`);
    }
  }, [playlist, save]);

  /* ── Add all visible ── */
  const addAllVisible = () => {
    const ids     = leftFiltered.map(c => c.id);
    const pinned  = [...new Set([...(playlist?.pinnedChannels  || []), ...ids])];
    const blocked = (playlist?.blockedChannels || []).filter(id => !ids.includes(id));
    save({ pinnedChannels: pinned, blockedChannels: blocked });
    toast.success(`➕ Added ${ids.length} channels`);
  };

  /* ── Remove all visible ── */
  const removeAllVisible = () => {
    const ids     = new Set(rightFiltered.map(c => c.id));
    const pinned  = (playlist?.pinnedChannels  || []).filter(id => !ids.has(id));
    const blocked = [...new Set([...(playlist?.blockedChannels || []), ...rightFiltered.map(c => c.id)])];
    save({ pinnedChannels: pinned, blockedChannels: blocked });
    toast.success(`➖ Removed ${ids.size} channels`);
  };

  /* ── Clear blocked ── */
  const clearBlocked = () => {
    save({ blockedChannels: [] });
    toast.success('♻️ All blocked channels cleared');
  };

  /* ── Reset playlist (remove all manual pins) ── */
  const resetPlaylist = () => {
    save({ pinnedChannels: [], blockedChannels: [] });
    toast.success('🔄 Playlist reset to group/filter defaults');
  };

  /* ── Drag & drop reorder ── */
  const handleDragStart = (id: string) => setDragId(id);
  const handleDragOver  = (e: React.DragEvent, id: string) => { e.preventDefault(); setDragOverId(id); };
  const handleDrop      = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids     = rightFiltered.map(c => c.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx   = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...ids];
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, dragId);
    setRightOrder(reordered);
    setDragId(null);
    setDragOverId(null);
    toast.success('🔀 Reordered');
  };

  /* ── Copy playlist URL ── */
  const copyUrl = () => {
    if (!playlist) return;
    const url = `${serverUrl}/api/playlist/${playlist.id}.m3u`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('📋 Playlist URL copied!');
  };

  /* ── Download M3U ── */
  const downloadM3U = () => {
    if (!playlist) return;
    const content = getPlaylistM3U(playlist.id);
    const blob = new Blob([content], { type: 'application/x-mpegurl' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${playlist.name.replace(/\s+/g, '_')}.m3u`;
    a.click();
    toast.success('⬇️ Downloading M3U...');
  };

  /* ── No playlist selected ── */
  if (!playlist) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-gray-500 gap-6">
        <div className="w-20 h-20 rounded-2xl bg-gray-800 flex items-center justify-center">
          <List className="w-10 h-10 opacity-30" />
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-gray-300 mb-1">No Playlist Selected</p>
          <p className="text-sm text-gray-500">Go to the Playlists tab and click <strong className="text-pink-400">Edit Channels</strong> on any playlist.</p>
        </div>
        <button
          onClick={() => { setActiveTab('playlists'); setEditingPlaylistId(null); }}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Go to Playlists
        </button>
      </div>
    );
  }

  const playlistUrl = `${serverUrl}/api/playlist/${playlist.id}.m3u`;
  const m3uContent  = getPlaylistM3U(playlist.id);

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { setActiveTab('playlists'); setEditingPlaylistId(null); }}
              className="flex items-center gap-1 text-gray-500 hover:text-white transition-colors text-sm"
            >
              <ArrowLeft className="w-4 h-4" /> Playlists
            </button>
            <ChevronRight className="w-3 h-3 text-gray-700" />
            <h2 className="text-xl font-bold text-white">{playlist.name}</h2>
            {playlist.tamilOnly && (
              <span className="text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                <Star className="w-3 h-3 fill-orange-400" /> Tamil Only
              </span>
            )}
          </div>
          <p className="text-gray-500 text-sm mt-1 ml-6">
            <span className="text-green-400 font-bold">{inPlaylist.length}</span> channels in playlist
            {tamilRight > 0 && <> · <span className="text-orange-400">{tamilRight} Tamil</span></>}
            {pinnedSet.size > 0  && <> · <span className="text-green-600">{pinnedSet.size} pinned</span></>}
            {blockedSet.size > 0 && <> · <span className="text-red-600">{blockedSet.size} blocked</span></>}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={clearBlocked}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-900/30 hover:bg-red-900/50 border border-red-800/30 text-red-400 rounded-lg text-xs font-medium transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Clear Blocked ({blockedSet.size})
          </button>
          <button onClick={resetPlaylist}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 rounded-lg text-xs font-medium transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Reset All
          </button>
          <button onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-lg text-xs font-medium transition-colors">
            {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPreview ? 'Hide' : 'Preview'} M3U
          </button>
          <button onClick={downloadM3U}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-lg text-xs font-medium transition-colors">
            <Download className="w-3.5 h-3.5" /> Download
          </button>
          <button onClick={copyUrl}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        </div>
      </div>

      {/* ── Playlist URL Bar ── */}
      <div className="flex items-center gap-3 bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5">
        <span className="text-gray-500 text-xs shrink-0">📡 Playlist URL:</span>
        <code className="text-green-400 text-xs font-mono flex-1 truncate">{playlistUrl}</code>
        <button onClick={copyUrl} className="shrink-0 p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors">
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <span className="text-gray-600 text-[10px] shrink-0 font-medium">
          {inPlaylist.length} channels · Auto-saves
        </span>
      </div>

      {/* ── M3U Preview ── */}
      {showPreview && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-900">
            <span className="text-gray-400 text-xs font-medium flex items-center gap-2">
              <Eye className="w-3.5 h-3.5" />
              M3U Preview — {inPlaylist.length} entries
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => { navigator.clipboard.writeText(m3uContent); toast.success('Copied!'); }}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors">
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button onClick={() => setShowPreview(false)} className="text-gray-600 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <pre className="p-4 text-green-400 text-[10px] font-mono overflow-auto max-h-48 leading-relaxed">
            {m3uContent || '# Empty playlist — add channels from the left panel'}
          </pre>
        </div>
      )}

      {/* ── Help Banner ── */}
      <div className="bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3">
        <div className="flex items-center gap-6 flex-wrap text-[11px] text-gray-500">
          <span className="font-semibold text-gray-400">How to use:</span>
          <span className="flex items-center gap-1.5"><Plus className="w-3 h-3 text-green-500" /> <strong className="text-gray-400">Add</strong> — move channel to playlist</span>
          <span className="flex items-center gap-1.5"><Minus className="w-3 h-3 text-red-500" /> <strong className="text-gray-400">Block</strong> — prevent from appearing</span>
          <span className="flex items-center gap-1.5"><Star className="w-3 h-3 text-green-400 fill-green-400" /> <strong className="text-gray-400">Pin</strong> — always include regardless of group filters</span>
          <span className="flex items-center gap-1.5"><GripVertical className="w-3 h-3 text-gray-500" /> <strong className="text-gray-400">Drag</strong> — reorder channels in right panel</span>
          <span className="ml-auto flex items-center gap-1 text-green-700"><Save className="w-3 h-3" /> All changes auto-saved</span>
        </div>
      </div>

      {/* ── Main 2-Panel Editor ── */}
      <div className="grid grid-cols-[1fr,auto,1fr] gap-3" style={{ minHeight: '500px', maxHeight: 'calc(100vh - 420px)' }}>

        {/* ─── LEFT PANEL: Available Channels ─── */}
        <div className="flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Left Header */}
          <div className="p-3 border-b border-gray-800 space-y-2 shrink-0 bg-gray-900">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white text-sm font-semibold">
                  Available Channels
                  <span className="ml-2 text-gray-500 font-normal text-xs">({leftFiltered.length})</span>
                </p>
                <p className="text-gray-600 text-[10px]">Not in this playlist yet</p>
              </div>
              <button onClick={addAllVisible}
                className="flex items-center gap-1 text-xs bg-green-600/20 hover:bg-green-600 text-green-400 hover:text-white border border-green-700/30 hover:border-green-600 px-2.5 py-1.5 rounded-lg transition-all font-medium">
                <ArrowRight className="w-3 h-3" /> Add All ({leftFiltered.length})
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
              <input value={leftSearch} onChange={e => setLeftSearch(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-8 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500 placeholder-gray-600"
                placeholder="Search available channels..." />
              {leftSearch && (
                <button onClick={() => setLeftSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
              <select value={leftGroup} onChange={e => setLeftGroup(e.target.value)}
                className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                <option value="__all__">All Groups ({available.length})</option>
                {groups.map(g => {
                  const cnt = available.filter(c => c.group === g.name).length;
                  if (cnt === 0) return null;
                  return <option key={g.id} value={g.name}>{g.name} ({cnt})</option>;
                })}
              </select>
              <button onClick={() => setLeftTamilOnly(v => !v)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                  leftTamilOnly ? 'bg-orange-500 border-orange-400 text-white' : 'bg-orange-500/10 border-orange-500/20 text-orange-400 hover:bg-orange-500/20'
                }`}>
                <Star className={`w-3 h-3 ${leftTamilOnly ? 'fill-white' : 'fill-orange-400'}`} />
                TM {tamilLeft > 0 && `(${tamilLeft})`}
              </button>
              <button onClick={() => setLeftDrmOnly(v => !v)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                  leftDrmOnly ? 'bg-purple-600 border-purple-500 text-white' : 'bg-purple-500/10 border-purple-500/20 text-purple-400 hover:bg-purple-500/20'
                }`}>
                <Shield className="w-3 h-3" /> DRM
              </button>
            </div>
          </div>

          {/* Left Channel List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {leftFiltered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-gray-700 text-xs gap-2">
                <Filter className="w-8 h-8 opacity-30" />
                {channels.length === 0 ? 'No channels loaded. Add a source first.' :
                 leftSearch || leftGroup !== '__all__' || leftTamilOnly || leftDrmOnly
                   ? 'No channels match your filters'
                   : 'All channels are already in this playlist! 🎉'}
              </div>
            ) : (
              leftFiltered.map(ch => (
                <ChannelRow key={ch.id} ch={ch} side="left"
                  isBlocked={blockedSet.has(ch.id)}
                  onAdd={() => addChannel(ch)}
                  onBlock={() => toggleBlock(ch)}
                />
              ))
            )}
          </div>

          {/* Left footer count */}
          <div className="px-3 py-2 border-t border-gray-800 bg-gray-900/50">
            <p className="text-gray-700 text-[10px] text-center">
              {leftFiltered.length} available · {blockedSet.size} blocked
            </p>
          </div>
        </div>

        {/* ─── Center Arrow Controls ─── */}
        <div className="flex flex-col items-center justify-center gap-2 py-4 shrink-0">
          <button onClick={addAllVisible} title="Add all visible to playlist"
            className="p-2.5 rounded-xl bg-green-600/20 hover:bg-green-600 border border-green-700/30 hover:border-green-600 text-green-400 hover:text-white transition-all shadow"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <div className="w-px flex-1 bg-gray-800" />
          <button onClick={removeAllVisible} title="Remove all visible from playlist"
            className="p-2.5 rounded-xl bg-red-600/20 hover:bg-red-600 border border-red-700/30 hover:border-red-600 text-red-400 hover:text-white transition-all shadow"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>

        {/* ─── RIGHT PANEL: In Playlist ─── */}
        <div className="flex flex-col bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          {/* Right Header */}
          <div className="p-3 border-b border-gray-700 space-y-2 shrink-0 bg-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white text-sm font-semibold">
                  In Playlist
                  <span className="ml-2 text-gray-400 font-normal text-xs">({rightFiltered.length})</span>
                  {tamilRight > 0 && <span className="ml-2 text-orange-400 text-xs">· {tamilRight} 🎬</span>}
                </p>
                <p className="text-gray-500 text-[10px]">Drag to reorder · Star to pin</p>
              </div>
              <button onClick={removeAllVisible}
                className="flex items-center gap-1 text-xs bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-700/30 hover:border-red-600 px-2.5 py-1.5 rounded-lg transition-all font-medium">
                <ArrowLeft className="w-3 h-3" /> Remove All
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input value={rightSearch} onChange={e => setRightSearch(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg pl-8 pr-8 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500 placeholder-gray-500"
                placeholder="Search in playlist..." />
              {rightSearch && (
                <button onClick={() => setRightSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Sort */}
            <div className="flex items-center gap-1.5">
              <span className="text-gray-600 text-[10px] shrink-0">Sort by:</span>
              {(['order', 'name', 'group'] as const).map(mode => (
                <button key={mode} onClick={() => setSortMode(mode)}
                  className={`flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-medium transition-colors capitalize ${
                    sortMode === mode ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}>
                  {mode === 'order' ? <GripVertical className="w-2.5 h-2.5" />
                   : mode === 'name' ? <ChevronUp className="w-2.5 h-2.5" />
                   : <ChevronDown className="w-2.5 h-2.5" />}
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Right Channel List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1" onDragOver={e => e.preventDefault()}>
            {rightFiltered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-gray-700 text-xs gap-2">
                <List className="w-8 h-8 opacity-30" />
                {rightSearch ? 'No channels match search' : (
                  <div className="text-center">
                    <p>Playlist is empty</p>
                    <p className="text-gray-600 mt-1">Add channels from the left panel using the <Plus className="w-3 h-3 inline text-green-500" /> button</p>
                  </div>
                )}
              </div>
            ) : (
              rightFiltered.map(ch => (
                <ChannelRow
                  key={ch.id} ch={ch} side="right"
                  isPinned={pinnedSet.has(ch.id)}
                  isDragging={dragId === ch.id || dragOverId === ch.id}
                  onDragStart={() => handleDragStart(ch.id)}
                  onDragOver={e => handleDragOver(e, ch.id)}
                  onDrop={() => handleDrop(ch.id)}
                  onPin={() => togglePin(ch)}
                  onRemove={() => removeChannel(ch)}
                />
              ))
            )}
          </div>

          {/* Right footer */}
          <div className="px-3 py-2 border-t border-gray-700 bg-gray-800/80">
            <p className="text-gray-600 text-[10px] text-center">
              {inPlaylist.length} total · {pinnedSet.size} pinned · {blockedSet.size} blocked
            </p>
          </div>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 flex-wrap text-[10px] text-gray-600 border-t border-gray-800 pt-3">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded bg-green-950 border border-green-800" /> Pinned — always in playlist</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded bg-red-950 border border-red-900" /> Blocked — never in playlist</span>
        <span className="flex items-center gap-1.5"><span className="text-[9px] bg-orange-500/20 text-orange-400 px-1 rounded font-bold border border-orange-500/20">TM</span> Tamil</span>
        <span className="flex items-center gap-1.5"><Shield className="w-2.5 h-2.5 text-purple-400" /> DRM protected</span>
        <span className="flex items-center gap-1.5 ml-auto text-gray-700"><Save className="w-3 h-3" /> All changes auto-saved & synced to server</span>
      </div>
    </div>
  );
}
