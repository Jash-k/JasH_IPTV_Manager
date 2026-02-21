import { useState, useMemo, useCallback, useRef } from 'react';
import { Stream } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

const PAGE_SIZE = 100;

export const StreamsTab: React.FC<Props> = ({ store }) => {
  const {
    streams, sources, updateStream, deleteStream,
    bulkDeleteStreams, bulkMoveStreams, bulkToggleStreams,
    reorderStreams, notify,
  } = store;

  const [search,       setSearch]       = useState('');
  const [filterGroup,  setFilterGroup]  = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [editStream,   setEditStream]   = useState<Stream | null>(null);
  const [page,         setPage]         = useState(1);
  const [bulkGroup,    setBulkGroup]    = useState('');
  const [showBulkMove, setShowBulkMove] = useState(false);
  const [dragMode,     setDragMode]     = useState(false);

  // ── Drag state ────────────────────────────────────────────────────────────
  const dragFromIdx = useRef<number | null>(null);
  const [dragOver,   setDragOver]  = useState<number | null>(null);
  const [dragActive, setDragActive] = useState<number | null>(null);

  // ── Working list: ALL streams sorted by order (the ground truth) ─────────
  // We operate on `streams` (full list, sorted by order) for all reorder ops.
  // Filtering only affects what is displayed.
  const filtered = useMemo(() => {
    return streams.filter(s => {
      if (search && !s.name.toLowerCase().includes(search.toLowerCase()) &&
          !s.url.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterGroup  && s.group    !== filterGroup)  return false;
      if (filterSource && s.sourceId !== filterSource) return false;
      if (filterStatus === 'alive'    && s.status !== 'alive')    return false;
      if (filterStatus === 'dead'     && s.status !== 'dead')     return false;
      if (filterStatus === 'enabled'  && !s.enabled)              return false;
      if (filterStatus === 'disabled' && s.enabled)               return false;
      return true;
    });
  }, [streams, search, filterGroup, filterSource, filterStatus]);

  const paginated  = useMemo(() => filtered.slice(0, page * PAGE_SIZE), [filtered, page]);
  const groupNames = useMemo(() => [...new Set(streams.map(s => s.group))].sort(), [streams]);

  // Detect duplicate names (multi-quality channels)
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    streams.forEach(s => {
      const k = `${s.group}||${s.name}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));
  }, [streams]);

  // ── Selection ─────────────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(s => s.id)));
  }, [selected.size, filtered]);

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    if (!selected.size) return;
    await bulkDeleteStreams([...selected]);
    setSelected(new Set());
  };

  const handleBulkMove = async () => {
    if (!selected.size || !bulkGroup.trim()) return;
    await bulkMoveStreams([...selected], bulkGroup);
    setSelected(new Set());
    setShowBulkMove(false);
    setBulkGroup('');
  };

  const handleBulkEnable = async (enabled: boolean) => {
    if (!selected.size) return;
    await bulkToggleStreams([...selected], enabled);
    setSelected(new Set());
  };

  // ── Drag-and-drop reorder ─────────────────────────────────────────────────
  // We reorder within the `filtered` list (which respects current filters).
  // After reorder we build a new global order: filtered items in new order,
  // then all non-filtered items preserving their relative positions.

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragFromIdx.current = index;
    setDragActive(index);
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(index);
  };

  const handleDrop = useCallback(async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const fromIndex = dragFromIdx.current;

    if (fromIndex === null || fromIndex === dropIndex) {
      setDragActive(null);
      setDragOver(null);
      dragFromIdx.current = null;
      return;
    }

    // Reorder the filtered display list
    const newFiltered = [...filtered];
    const [moved] = newFiltered.splice(fromIndex, 1);
    newFiltered.splice(dropIndex, 0, moved);

    // Build new global order:
    // • Filtered items in their new order
    // • Non-filtered items retain their existing relative order (appended)
    const filteredIdSet = new Set(filtered.map(s => s.id));
    const nonFiltered   = streams.filter(s => !filteredIdSet.has(s.id));
    const newOrderedIds = [
      ...newFiltered.map(s => s.id),
      ...nonFiltered.map(s => s.id),
    ];

    await reorderStreams(newOrderedIds);
    notify('Stream order saved ✓', 'success');

    dragFromIdx.current = null;
    setDragActive(null);
    setDragOver(null);
  }, [filtered, streams, reorderStreams, notify]);

  const handleDragEnd = () => {
    dragFromIdx.current = null;
    setDragActive(null);
    setDragOver(null);
  };

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusBadge = (s: Stream) => {
    const map: Record<string, string> = {
      alive   : 'text-emerald-400',
      dead    : 'text-red-400',
      checking: 'text-yellow-400 animate-pulse',
      unknown : 'text-gray-600',
    };
    const dot = s.status === 'alive' ? '●' : s.status === 'dead' ? '●' : s.status === 'checking' ? '◌' : '○';
    return <span className={cn('text-xs flex-shrink-0', map[s.status || 'unknown'])}>{dot}</span>;
  };

  return (
    <div className="space-y-4">

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="🔍 Search streams..."
            className="bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
          />
          <select
            value={filterGroup}
            onChange={e => { setFilterGroup(e.target.value); setPage(1); }}
            className="bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
          >
            <option value="">All Groups</option>
            {groupNames.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select
            value={filterSource}
            onChange={e => { setFilterSource(e.target.value); setPage(1); }}
            className="bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
          >
            <option value="">All Sources</option>
            {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
            className="bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
          >
            <option value="">All Status</option>
            <option value="alive">✅ Alive</option>
            <option value="dead">❌ Dead</option>
            <option value="enabled">▶ Enabled</option>
            <option value="disabled">⏸ Disabled</option>
          </select>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm text-gray-400">
            Showing {paginated.length.toLocaleString()} of {filtered.length.toLocaleString()} streams
            {duplicateNames.size > 0 && (
              <span className="ml-2 text-blue-400 text-xs">
                · {duplicateNames.size} multi-quality channel{duplicateNames.size > 1 ? 's' : ''}
              </span>
            )}
          </span>
          <div className="flex items-center gap-3">
            {/* Reorder toggle */}
            <button
              onClick={() => { setDragMode(v => !v); setSelected(new Set()); }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                dragMode
                  ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                  : 'bg-gray-700 border-gray-600 text-gray-400 hover:text-white'
              )}
              title="Toggle drag-and-drop reordering"
            >
              ↕ {dragMode ? 'Reorder ON' : 'Reorder'}
            </button>
            {!dragMode && (
              <button
                onClick={toggleAll}
                className="text-purple-400 hover:text-purple-300 transition-colors text-sm"
              >
                {selected.size === filtered.length && filtered.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>
        </div>

        {dragMode && (
          <div className="bg-orange-900/20 border border-orange-700/30 rounded-lg px-4 py-2.5 text-xs text-orange-300 flex items-center gap-2">
            <span>↕️</span>
            <span>
              Drag the <strong>⠿</strong> handle to reorder · Order is saved to DB and preserved in M3U export &amp; Stremio catalog
              {(search || filterGroup || filterSource || filterStatus) && (
                <span className="text-orange-400 ml-1">· Reorder applies within current filter</span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* ── Bulk Actions ──────────────────────────────────────────────────── */}
      {selected.size > 0 && !dragMode && (
        <div className="bg-purple-900/40 border border-purple-700/50 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <span className="text-purple-300 font-medium">{selected.size} selected</span>
          <button onClick={() => handleBulkEnable(true)}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-sm transition-colors">
            ▶ Enable
          </button>
          <button onClick={() => handleBulkEnable(false)}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors">
            ⏸ Disable
          </button>
          <button onClick={() => setShowBulkMove(!showBulkMove)}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded-lg text-sm transition-colors">
            📂 Move to Group
          </button>
          <button onClick={handleBulkDelete}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded-lg text-sm transition-colors">
            🗑️ Delete Selected
          </button>
          <button onClick={() => setSelected(new Set())}
            className="ml-auto text-gray-400 hover:text-white transition-colors text-sm">
            ✕ Clear
          </button>
        </div>
      )}

      {showBulkMove && (
        <div className="bg-gray-800 rounded-xl p-4 border border-blue-700/50 flex gap-3">
          <input
            value={bulkGroup}
            onChange={e => setBulkGroup(e.target.value)}
            placeholder="Group name or new group..."
            list="group-list"
            className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600"
          />
          <datalist id="group-list">{groupNames.map(g => <option key={g} value={g} />)}</datalist>
          <button onClick={handleBulkMove}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors">
            Move
          </button>
          <button onClick={() => setShowBulkMove(false)}
            className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm transition-colors">
            Cancel
          </button>
        </div>
      )}

      {/* ── Stream List ───────────────────────────────────────────────────── */}
      <div className="space-y-1">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <div className="text-5xl mb-4">📺</div>
            <div className="text-lg font-medium text-gray-400">No streams found</div>
            <div className="text-sm mt-2">Add sources or adjust filters</div>
          </div>
        )}

        {paginated.map((stream, index) => {
          const isDupeKey     = `${stream.group}||${stream.name}`;
          const isMultiQuality = duplicateNames.has(isDupeKey);
          const isDragging    = dragActive === index;
          const isDropTarget  = dragOver === index && dragActive !== index;

          return (
            <div
              key={stream.id}
              draggable={dragMode}
              onDragStart={dragMode ? e => handleDragStart(e, index) : undefined}
              onDragOver={dragMode  ? e => handleDragOver(e, index)  : undefined}
              onDrop={dragMode      ? e => handleDrop(e, index)      : undefined}
              onDragEnd={dragMode   ? handleDragEnd                  : undefined}
              className={cn(
                'flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5 border transition-all select-none',
                selected.has(stream.id) ? 'border-purple-600/70 bg-purple-900/20' : 'border-gray-700/50 hover:border-gray-600/70',
                !stream.enabled && 'opacity-50',
                dragMode && !isDragging && 'cursor-default',
                isDragging && 'opacity-30 scale-[0.97] border-dashed border-gray-500',
                isDropTarget && 'border-orange-400/70 bg-orange-900/10 scale-[1.005] shadow-lg shadow-orange-500/10',
              )}
            >
              {/* Drag handle OR checkbox */}
              {dragMode ? (
                <span
                  className="text-gray-500 hover:text-orange-300 cursor-grab active:cursor-grabbing flex-shrink-0 select-none text-xl leading-none px-1"
                  onMouseDown={e => e.currentTarget.parentElement?.setAttribute('draggable', 'true')}
                >
                  ⠿
                </span>
              ) : (
                <input
                  type="checkbox"
                  checked={selected.has(stream.id)}
                  onChange={() => toggleSelect(stream.id)}
                  className="w-4 h-4 accent-purple-500 flex-shrink-0 cursor-pointer"
                />
              )}

              {/* Logo */}
              <div className="w-7 h-7 flex-shrink-0">
                {stream.logo ? (
                  <img
                    src={stream.logo}
                    alt=""
                    className="w-7 h-7 rounded object-contain bg-gray-700"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="w-7 h-7 rounded bg-gray-700 flex items-center justify-center text-xs text-gray-500">
                    📺
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {statusBadge(stream)}
                  <span className="text-white text-sm font-medium truncate">{stream.name}</span>
                  {isMultiQuality && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 flex-shrink-0">
                      Multi-Q
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-purple-400 truncate max-w-[120px]">{stream.group}</span>
                  <span className="text-gray-700 text-xs">•</span>
                  <span className="text-xs text-gray-600 truncate">
                    {stream.url.slice(0, 55)}{stream.url.length > 55 ? '…' : ''}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {stream.responseTime && (
                  <span className="text-xs text-gray-600 hidden sm:block">{stream.responseTime}ms</span>
                )}
                {dragMode && (
                  <span className="text-gray-700 text-xs hidden sm:block">#{index + 1}</span>
                )}
                {!dragMode && (
                  <>
                    <button
                      onClick={() => setEditStream({ ...stream })}
                      className="p-1.5 rounded-lg bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white transition-colors text-sm"
                      title="Edit stream"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => deleteStream(stream.id)}
                      className="p-1.5 rounded-lg bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white transition-colors text-sm"
                      title="Delete stream"
                    >
                      🗑️
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {paginated.length < filtered.length && (
          <div className="text-center pt-4">
            <button
              onClick={() => setPage(p => p + 1)}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm transition-colors"
            >
              Load More ({(filtered.length - paginated.length).toLocaleString()} remaining)
            </button>
          </div>
        )}
      </div>

      {/* ── Multi-quality info ────────────────────────────────────────────── */}
      {duplicateNames.size > 0 && (
        <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4 space-y-2">
          <h4 className="text-blue-300 font-medium text-sm flex items-center gap-2">
            🎬 Multi-Quality Channels Detected
          </h4>
          <p className="text-blue-200/70 text-xs leading-relaxed">
            <strong>{duplicateNames.size}</strong> channel{duplicateNames.size > 1 ? 's have' : ' has'} multiple
            entries with the same name in the same group. In Stremio these appear as <strong>one channel entry</strong>
            with multiple quality options on the stream selection screen.
            The backend HLS extractor handles each quality variant separately.
            Toggle <strong>Combine Multi-Quality</strong> in Settings to control this.
          </p>
        </div>
      )}

      {/* ── Edit Modal ────────────────────────────────────────────────────── */}
      {editStream && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setEditStream(null)}
        >
          <div
            className="bg-gray-800 rounded-2xl p-6 border border-gray-600 w-full max-w-lg space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-white font-bold text-lg">✏️ Edit Stream</h3>
            <div className="space-y-3">
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Channel Name</label>
                <input
                  value={editStream.name}
                  onChange={e => setEditStream({ ...editStream, name: e.target.value })}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Stream URL</label>
                <input
                  value={editStream.url}
                  onChange={e => setEditStream({ ...editStream, url: e.target.value })}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Logo URL</label>
                <input
                  value={editStream.logo || ''}
                  onChange={e => setEditStream({ ...editStream, logo: e.target.value })}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
                  placeholder="https://..."
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Group</label>
                <input
                  value={editStream.group}
                  onChange={e => setEditStream({ ...editStream, group: e.target.value })}
                  list="edit-group-list"
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600"
                />
                <datalist id="edit-group-list">
                  {groupNames.map(g => <option key={g} value={g} />)}
                </datalist>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-gray-400 text-sm">Enabled</label>
                <button
                  onClick={() => setEditStream({ ...editStream, enabled: !editStream.enabled })}
                  className={cn('w-10 h-6 rounded-full transition-colors relative', editStream.enabled ? 'bg-purple-600' : 'bg-gray-600')}
                >
                  <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow', editStream.enabled ? 'left-4' : 'left-0.5')} />
                </button>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={async () => { await updateStream(editStream); setEditStream(null); }}
                className="flex-1 bg-purple-600 hover:bg-purple-500 text-white py-3 rounded-xl font-medium text-sm transition-colors"
              >
                ✓ Save Changes
              </button>
              <button
                onClick={() => setEditStream(null)}
                className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-xl text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
