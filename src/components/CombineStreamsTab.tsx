/**
 * JASH ADDON — Combine Streams Tab
 *
 * Lets you select any streams and combine them into one catalog entry
 * with a custom name. The combined channel appears in Stremio as a
 * single entry but shows multiple quality/stream options.
 *
 * Features:
 *  • Multi-select streams from any group
 *  • Auto-name (uses common channel name) or manual name entry
 *  • Custom group for the combined channel
 *  • Custom logo URL
 *  • Enable/disable individual combined channels
 *  • Sort alphabetically toggle
 */

import { useState, useMemo, useCallback } from 'react';
import { CombinedChannel } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

const genId = () => `comb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

export const CombineStreamsTab: React.FC<Props> = ({ store }) => {
  const {
    streams, combinedChannels,
    addCombinedChannel, deleteCombinedChannel, toggleCombinedChannel,
    settings, saveSettings, notify,
  } = store;

  // ── New combine form state ─────────────────────────────────────────────────
  const [selected,      setSelected]      = useState<Set<string>>(new Set());
  const [combName,      setCombName]      = useState('');
  const [combGroup,     setCombGroup]     = useState('');
  const [combLogo,      setCombLogo]      = useState('');
  const [autoName,      setAutoName]      = useState(true);
  const [showForm,      setShowForm]      = useState(false);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [search,        setSearch]        = useState('');
  const [filterGroup,   setFilterGroup]   = useState('');
  const [editChannel,   setEditChannel]   = useState<CombinedChannel | null>(null);

  const groupNames = useMemo(() => [...new Set(streams.map(s => s.group))].sort(), [streams]);

  const filtered = useMemo(() => {
    return streams.filter(s => {
      if (!s.enabled) return false;
      if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterGroup && s.group !== filterGroup) return false;
      return true;
    });
  }, [streams, search, filterGroup]);

  // Auto-detect name from selected streams
  const autoDetectedName = useMemo(() => {
    if (selected.size === 0) return '';
    const sel   = streams.filter(s => selected.has(s.id));
    const names = [...new Set(sel.map(s => s.name.trim()))];
    if (names.length === 1) return names[0];
    // Find common prefix
    const first = names[0];
    let prefix  = '';
    for (let i = 0; i < first.length; i++) {
      if (names.every(n => n[i] === first[i])) prefix += first[i];
      else break;
    }
    return prefix.trim() || names[0];
  }, [selected, streams]);

  const effectiveName = autoName ? autoDetectedName : combName;

  // ── Selection ─────────────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filtered.map(s => s.id)));
  }, [filtered]);

  const clearSelect = useCallback(() => setSelected(new Set()), []);

  // ── Create combined channel ───────────────────────────────────────────────
  const handleCreate = useCallback(() => {
    if (selected.size < 1) {
      notify('Select at least 1 stream to combine', 'error');
      return;
    }
    const name = effectiveName.trim();
    if (!name) {
      notify('Enter a channel name', 'error');
      return;
    }

    const sel     = streams.filter(s => selected.has(s.id));
    const channel: CombinedChannel = {
      id        : genId(),
      name,
      group     : combGroup.trim() || sel[0]?.group || 'Combined',
      logo      : combLogo.trim() || sel.find(s => s.logo)?.logo || '',
      streamUrls: sel.map(s => s.url),
      enabled   : true,
      createdAt : Date.now(),
    };

    addCombinedChannel(channel);
    setSelected(new Set());
    setCombName('');
    setCombGroup('');
    setCombLogo('');
    setShowForm(false);
    notify(`✅ Created "${name}" with ${sel.length} stream${sel.length > 1 ? 's' : ''}`, 'success');
  }, [selected, streams, effectiveName, combGroup, combLogo, addCombinedChannel, notify]);

  // ── Edit save ─────────────────────────────────────────────────────────────
  const handleEditSave = useCallback(() => {
    if (!editChannel) return;
    addCombinedChannel(editChannel);
    setEditChannel(null);
    notify('Combined channel updated', 'success');
  }, [editChannel, addCombinedChannel, notify]);

  // ── Remove a stream URL from editChannel ──────────────────────────────────
  const removeStreamFromEdit = useCallback((url: string) => {
    if (!editChannel) return;
    setEditChannel({
      ...editChannel,
      streamUrls: editChannel.streamUrls.filter(u => u !== url),
    });
  }, [editChannel]);

  // ── Status badge colors ────────────────────────────────────────────────────
  const streamForUrl = useCallback((url: string) => {
    return streams.find(s => s.url === url);
  }, [streams]);

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-indigo-900/50 to-blue-900/50 border border-indigo-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            🔗
          </div>
          <div>
            <h2 className="text-white font-bold text-xl">Combine Streams</h2>
            <p className="text-indigo-300/80 text-sm">
              Merge multiple streams into one Stremio catalog entry — great for multi-quality or backup streams
            </p>
          </div>
        </div>

        {/* Info box */}
        <div className="bg-indigo-950/50 border border-indigo-700/30 rounded-xl p-4 text-xs text-indigo-200/80 space-y-1">
          <div className="font-semibold text-indigo-300 mb-1">How combining works:</div>
          <div>1️⃣ Select any streams from your library (different groups/sources allowed)</div>
          <div>2️⃣ Give the combined channel a name (auto-detected or custom)</div>
          <div>3️⃣ It appears in Stremio as <strong>one catalog entry</strong> with all streams listed</div>
          <div>4️⃣ Viewer selects which stream to play from the stream picker</div>
          <div>5️⃣ Sync to backend → appears in <strong>⭐ Combined Channels</strong> catalog in Stremio</div>
        </div>
      </div>

      {/* ── Sort Alphabetically toggle ──────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex items-center justify-between">
        <div>
          <div className="text-white font-medium flex items-center gap-2">
            🔤 Sort Streams Alphabetically in Stremio
            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              {settings.sortAlphabetically ? 'ON' : 'OFF'}
            </span>
          </div>
          <div className="text-gray-500 text-sm mt-0.5">
            {settings.sortAlphabetically
              ? 'Channels sorted A→Z by Group Title then Channel Name'
              : 'Channels follow your manual drag-and-drop order'}
          </div>
        </div>
        <button
          onClick={() => saveSettings({ ...settings, sortAlphabetically: !settings.sortAlphabetically })}
          className={cn(
            'w-12 h-7 rounded-full transition-all relative flex-shrink-0 ml-4',
            settings.sortAlphabetically ? 'bg-emerald-500' : 'bg-gray-600'
          )}
        >
          <span className={cn(
            'absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all',
            settings.sortAlphabetically ? 'left-6' : 'left-1'
          )} />
        </button>
      </div>

      {/* ── Existing combined channels ─────────────────────────────────────── */}
      {combinedChannels.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span>⭐</span> Combined Channels ({combinedChannels.length})
            </h3>
            <span className="text-xs text-gray-500">Sync to backend to activate in Stremio</span>
          </div>

          {combinedChannels.map(ch => (
            <div
              key={ch.id}
              className={cn(
                'bg-gray-800 rounded-xl p-4 border transition-all',
                ch.enabled ? 'border-indigo-700/40' : 'border-gray-700/30 opacity-60'
              )}
            >
              <div className="flex items-start gap-3">
                {/* Logo */}
                <div className="w-10 h-10 flex-shrink-0 rounded-lg overflow-hidden bg-gray-700 flex items-center justify-center">
                  {ch.logo
                    ? <img src={ch.logo} alt="" className="w-full h-full object-contain"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    : <span className="text-xl">📺</span>
                  }
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold">{ch.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {ch.streamUrls.length} stream{ch.streamUrls.length > 1 ? 's' : ''}
                    </span>
                    <span className="text-xs text-purple-400">{ch.group}</span>
                    {!ch.enabled && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-500">disabled</span>
                    )}
                  </div>

                  {/* Stream URLs preview */}
                  <div className="mt-2 space-y-1">
                    {ch.streamUrls.slice(0, 3).map((url, i) => {
                      const s = streamForUrl(url);
                      return (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className={cn(
                            'w-1.5 h-1.5 rounded-full flex-shrink-0',
                            s?.status === 'alive' ? 'bg-emerald-400' :
                            s?.status === 'dead'  ? 'bg-red-400'     : 'bg-gray-500'
                          )} />
                          <span className="text-gray-500 truncate font-mono">{url.slice(0, 70)}{url.length > 70 ? '…' : ''}</span>
                        </div>
                      );
                    })}
                    {ch.streamUrls.length > 3 && (
                      <div className="text-xs text-gray-600">
                        +{ch.streamUrls.length - 3} more streams
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Enable toggle */}
                  <button
                    onClick={() => toggleCombinedChannel(ch.id)}
                    className={cn('w-10 h-6 rounded-full transition-colors relative', ch.enabled ? 'bg-indigo-600' : 'bg-gray-600')}
                    title={ch.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', ch.enabled ? 'left-4' : 'left-0.5')} />
                  </button>
                  {/* Edit */}
                  <button
                    onClick={() => setEditChannel({ ...ch })}
                    className="p-2 rounded-lg bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white transition-colors"
                    title="Edit"
                  >✏️</button>
                  {/* Delete */}
                  <button
                    onClick={() => deleteCombinedChannel(ch.id)}
                    className="p-2 rounded-lg bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white transition-colors"
                    title="Delete"
                  >🗑️</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create New Combined Channel ────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
        <button
          onClick={() => setShowForm(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-white font-semibold hover:bg-gray-750 transition-colors"
        >
          <span className="flex items-center gap-2">
            <span className="text-xl">➕</span>
            Create New Combined Channel
          </span>
          <span className="text-gray-400">{showForm ? '▲' : '▼'}</span>
        </button>

        {showForm && (
          <div className="border-t border-gray-700 p-5 space-y-5">

            {/* Step 1 — Channel details */}
            <div className="space-y-3">
              <h4 className="text-indigo-300 font-medium text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">1</span>
                Channel Details
              </h4>

              {/* Auto-name toggle */}
              <div className="flex items-center justify-between bg-gray-700/40 border border-gray-600/50 rounded-xl px-4 py-3">
                <div>
                  <div className="text-white text-sm font-medium">Auto-detect name</div>
                  <div className="text-gray-500 text-xs">
                    {autoName
                      ? `Will use: "${autoDetectedName || 'select streams below'}" `
                      : 'Enter name manually'}
                  </div>
                </div>
                <button
                  onClick={() => setAutoName(v => !v)}
                  className={cn('w-10 h-6 rounded-full transition-all relative', autoName ? 'bg-indigo-500' : 'bg-gray-600')}
                >
                  <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', autoName ? 'left-4' : 'left-0.5')} />
                </button>
              </div>

              {!autoName && (
                <input
                  value={combName}
                  onChange={e => setCombName(e.target.value)}
                  placeholder="Channel name (e.g. CNN HD)"
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                />
              )}

              {autoName && autoDetectedName && (
                <div className="flex items-center gap-2 bg-indigo-900/20 border border-indigo-700/30 rounded-lg px-4 py-2.5">
                  <span className="text-xs text-indigo-400">Auto name:</span>
                  <span className="text-white font-medium">{autoDetectedName}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Group (optional)</label>
                  <input
                    value={combGroup}
                    onChange={e => setCombGroup(e.target.value)}
                    list="combine-group-list"
                    placeholder="Group name in Stremio"
                    className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                  />
                  <datalist id="combine-group-list">
                    {groupNames.map(g => <option key={g} value={g} />)}
                  </datalist>
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Logo URL (optional)</label>
                  <input
                    value={combLogo}
                    onChange={e => setCombLogo(e.target.value)}
                    placeholder="https://example.com/logo.png"
                    className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                  />
                </div>
              </div>
            </div>

            {/* Step 2 — Select streams */}
            <div className="space-y-3">
              <h4 className="text-indigo-300 font-medium text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">2</span>
                Select Streams to Combine
                <span className="ml-auto text-xs text-gray-400">
                  {selected.size} selected
                </span>
              </h4>

              {/* Stream search/filter */}
              <div className="flex gap-2">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="🔍 Search streams..."
                  className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                />
                <select
                  value={filterGroup}
                  onChange={e => setFilterGroup(e.target.value)}
                  className="bg-gray-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                >
                  <option value="">All Groups</option>
                  {groupNames.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>

              {/* Select all / clear */}
              <div className="flex items-center gap-3">
                <button
                  onClick={selectAll}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Select All ({filtered.length})
                </button>
                <span className="text-gray-700 text-xs">|</span>
                <button
                  onClick={clearSelect}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear Selection
                </button>
              </div>

              {/* Stream list */}
              <div className="space-y-1 max-h-64 overflow-y-auto border border-gray-700 rounded-xl p-2 bg-gray-900/40">
                {filtered.length === 0 && (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No streams match your filter
                  </div>
                )}
                {filtered.slice(0, 200).map(stream => (
                  <div
                    key={stream.id}
                    onClick={() => toggleSelect(stream.id)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer transition-all border',
                      selected.has(stream.id)
                        ? 'bg-indigo-900/30 border-indigo-600/50'
                        : 'border-transparent hover:bg-gray-800/60 hover:border-gray-700/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(stream.id)}
                      onChange={() => toggleSelect(stream.id)}
                      onClick={e => e.stopPropagation()}
                      className="w-4 h-4 accent-indigo-500 flex-shrink-0"
                    />
                    <span className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      stream.status === 'alive' ? 'bg-emerald-400' :
                      stream.status === 'dead'  ? 'bg-red-400' : 'bg-gray-500'
                    )} />
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm truncate font-medium">{stream.name}</div>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span className="text-purple-400 truncate max-w-[100px]">{stream.group}</span>
                        <span>·</span>
                        <span className="truncate font-mono">{stream.url.slice(0, 50)}{stream.url.length > 50 ? '…' : ''}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {filtered.length > 200 && (
                  <div className="text-center text-xs text-gray-600 py-2">
                    Showing 200 of {filtered.length} — use filters to narrow down
                  </div>
                )}
              </div>
            </div>

            {/* Selected preview */}
            {selected.size > 0 && (
              <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-xl p-4 space-y-2">
                <div className="text-indigo-300 text-sm font-medium">
                  ✅ {selected.size} stream{selected.size > 1 ? 's' : ''} selected for combination
                </div>
                <div className="space-y-1">
                  {streams.filter(s => selected.has(s.id)).slice(0, 5).map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-xs text-indigo-200/70">
                      <span className="text-indigo-400">→</span>
                      <span className="font-medium text-white truncate">{s.name}</span>
                      <span className="text-indigo-400/60">{s.group}</span>
                    </div>
                  ))}
                  {selected.size > 5 && (
                    <div className="text-xs text-indigo-300/50">+{selected.size - 5} more streams</div>
                  )}
                </div>
                <div className="text-xs text-indigo-300/60 flex items-center gap-1">
                  <span>📺</span>
                  <span>
                    Combined name will be: <strong className="text-white">{effectiveName || '(enter name above)'}</strong>
                  </span>
                </div>
              </div>
            )}

            {/* Create button */}
            <div className="flex gap-3">
              <button
                onClick={handleCreate}
                disabled={selected.size === 0 || !effectiveName.trim()}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl font-semibold text-base transition-all shadow-lg',
                  selected.size > 0 && effectiveName.trim()
                    ? 'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white active:scale-[0.98]'
                    : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                )}
              >
                <span>🔗</span>
                <span>
                  Create Combined Channel
                  {selected.size > 0 && ` (${selected.size} streams)`}
                </span>
              </button>
              <button
                onClick={() => { setShowForm(false); clearSelect(); }}
                className="px-5 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Empty state ────────────────────────────────────────────────────── */}
      {combinedChannels.length === 0 && !showForm && (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-700 rounded-2xl">
          <div className="text-5xl mb-4">🔗</div>
          <div className="text-lg font-medium text-gray-400">No combined channels yet</div>
          <div className="text-sm mt-2 max-w-md mx-auto text-gray-600">
            Select streams from your library and combine them into one Stremio catalog entry.
            Perfect for multi-quality channels or combining backup streams.
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            ➕ Create Your First Combined Channel
          </button>
        </div>
      )}

      {/* ── Sync reminder ─────────────────────────────────────────────────── */}
      {combinedChannels.length > 0 && (
        <div className="bg-violet-900/20 border border-violet-700/30 rounded-xl p-4 flex items-center gap-3">
          <span className="text-violet-400 text-xl">💡</span>
          <div className="text-violet-200/80 text-sm">
            <strong>Remember to sync!</strong> Go to the <strong>Backend</strong> tab and click
            <strong> Sync Streams</strong> to push combined channels to the server.
            They appear in Stremio under the <strong>⭐ Combined Channels</strong> catalog.
          </div>
        </div>
      )}

      {/* ── Edit Modal ────────────────────────────────────────────────────── */}
      {editChannel && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setEditChannel(null)}
        >
          <div
            className="bg-gray-800 rounded-2xl p-6 border border-gray-600 w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-white font-bold text-lg">✏️ Edit Combined Channel</h3>

            <div className="space-y-3">
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Channel Name</label>
                <input
                  value={editChannel.name}
                  onChange={e => setEditChannel({ ...editChannel, name: e.target.value })}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Group</label>
                <input
                  value={editChannel.group}
                  onChange={e => setEditChannel({ ...editChannel, group: e.target.value })}
                  list="edit-comb-group-list"
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                />
                <datalist id="edit-comb-group-list">
                  {groupNames.map(g => <option key={g} value={g} />)}
                </datalist>
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1 block">Logo URL</label>
                <input
                  value={editChannel.logo || ''}
                  onChange={e => setEditChannel({ ...editChannel, logo: e.target.value })}
                  placeholder="https://..."
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-600"
                />
              </div>

              {/* Stream URLs */}
              <div>
                <label className="text-gray-400 text-xs mb-2 block">
                  Stream URLs ({editChannel.streamUrls.length})
                </label>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {editChannel.streamUrls.map((url, i) => (
                    <div key={i} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2">
                      <span className="text-gray-500 text-xs w-5 flex-shrink-0">#{i + 1}</span>
                      <span className="text-gray-300 text-xs font-mono flex-1 truncate">{url}</span>
                      <button
                        onClick={() => removeStreamFromEdit(url)}
                        disabled={editChannel.streamUrls.length <= 1}
                        className="text-red-400 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs flex-shrink-0 px-1"
                        title="Remove this stream"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center gap-3">
                <label className="text-gray-400 text-sm">Enabled</label>
                <button
                  onClick={() => setEditChannel({ ...editChannel, enabled: !editChannel.enabled })}
                  className={cn('w-10 h-6 rounded-full transition-colors relative', editChannel.enabled ? 'bg-indigo-600' : 'bg-gray-600')}
                >
                  <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', editChannel.enabled ? 'left-4' : 'left-0.5')} />
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleEditSave}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-xl font-medium text-sm transition-colors"
              >
                ✓ Save Changes
              </button>
              <button
                onClick={() => setEditChannel(null)}
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
