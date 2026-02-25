/**
 * JASH ADDON — Selection Models Tab
 *
 * A Selection Model is a named list of channel patterns.
 * When applied to a source, only matching channels survive.
 * Matching is LIBERAL — "Sun TV" matches "Sun TV HD", "SunTV 4K", "SUN TV USA" etc.
 *
 * Sections:
 *  1. Built-in Models (read-only, but can be applied)
 *  2. Custom Models (create, edit, delete)
 *  3. Live Preview — test a pattern list against your loaded streams
 */

import { useState, useMemo, useCallback } from 'react';
import { SelectionModel } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { channelMatches, previewModelMatch, filterStreamsByModel } from '../utils/channelMatcher';

interface Props { store: AppStore; }

const genId = () => `model_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const DEFAULT_TAMIL_CHANNELS = `Sun TV
Star Vijay
Zee Tamil
Colors Tamil
Jaya TV
Kalaignar TV
Raj TV
Polimer TV
Mega TV
Makkal TV
Puthuyugam TV
Vendhar TV
Thanthi TV
KTV
J Movies
Puthiya Thalaimurai
News7 Tamil
Polimer News
Thanthi One
Seithigal TV
Isai Aruvi
Sirippoli TV
StarSports Tamil
Sony Ten`;

export const SelectionModelsTab: React.FC<Props> = ({ store }) => {
  const { streams, sources, selectionModels, saveSelectionModel, deleteSelectionModel, applyModelToSource, notify } = store;

  // ── Edit form state ────────────────────────────────────────────────────────
  const [editModel,    setEditModel]    = useState<SelectionModel | null>(null);
  const [editName,     setEditName]     = useState('');
  const [editChannels, setEditChannels] = useState('');
  const [editGroup,    setEditGroup]    = useState('');
  const [editSingle,   setEditSingle]   = useState(true);
  const [showForm,     setShowForm]     = useState(false);

  // ── Preview state ──────────────────────────────────────────────────────────
  const [previewModelId, setPreviewModelId] = useState<string | null>(null);
  const [testName,       setTestName]       = useState('');

  // ── Apply state ────────────────────────────────────────────────────────────
  const [applyModelId,  setApplyModelId]  = useState('');
  const [applySourceId, setApplySourceId] = useState('');
  const [applying,      setApplying]      = useState(false);

  // ── Delete confirm ────────────────────────────────────────────────────────
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Built-in and custom models
  const builtInModels = useMemo(() => selectionModels.filter(m => m.isBuiltIn), [selectionModels]);
  const customModels  = useMemo(() => selectionModels.filter(m => !m.isBuiltIn), [selectionModels]);

  // Preview for selected model
  const previewModel = useMemo(() =>
    selectionModels.find(m => m.id === previewModelId) || null,
    [selectionModels, previewModelId]
  );

  const previewResults = useMemo(() => {
    if (!previewModel || !streams.length) return [];
    return previewModelMatch(streams, previewModel.channels);
  }, [previewModel, streams]);

  const previewMatched = useMemo(() => {
    if (!previewModel || !streams.length) return 0;
    return filterStreamsByModel(streams, previewModel.channels).matched.length;
  }, [previewModel, streams]);

  // Single channel test
  const singleTestMatches = useMemo(() => {
    if (!testName.trim() || !previewModel) return null;
    return previewModel.channels.filter(p => channelMatches(testName.trim(), p.trim()));
  }, [testName, previewModel]);

  // ── Open edit form ─────────────────────────────────────────────────────────
  const openNew = useCallback(() => {
    setEditModel(null);
    setEditName('');
    setEditChannels(DEFAULT_TAMIL_CHANNELS);
    setEditGroup('Custom Channels');
    setEditSingle(true);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((model: SelectionModel) => {
    setEditModel(model);
    setEditName(model.name);
    setEditChannels(model.channels.join('\n'));
    setEditGroup(model.defaultGroupName);
    setEditSingle(model.singleGroup);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(() => {
    const name = editName.trim();
    if (!name) { notify('Enter a model name', 'error'); return; }
    const channels = editChannels
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (!channels.length) { notify('Add at least one channel', 'error'); return; }

    const model: SelectionModel = {
      id              : editModel?.id || genId(),
      name,
      channels,
      singleGroup     : editSingle,
      defaultGroupName: editGroup.trim() || name,
      isBuiltIn       : false,
      createdAt       : editModel?.createdAt || Date.now(),
      updatedAt       : Date.now(),
    };
    saveSelectionModel(model);
    setShowForm(false);
  }, [editModel, editName, editChannels, editGroup, editSingle, saveSelectionModel, notify]);

  const handleDelete = useCallback((id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    deleteSelectionModel(id);
  }, [deleteConfirm, deleteSelectionModel]);

  const handleApply = useCallback(async () => {
    if (!applySourceId) { notify('Select a source', 'error'); return; }
    setApplying(true);
    await applyModelToSource(applySourceId, applyModelId || null);
    setApplying(false);
  }, [applySourceId, applyModelId, applyModelToSource, notify]);

  // Sources that have models applied
  const sourcesWithModels = useMemo(() =>
    sources.filter(s => s.selectionModelId),
    [sources]
  );

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-rose-900/50 to-pink-900/50 border border-rose-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            🎯
          </div>
          <div>
            <h2 className="text-white font-bold text-xl">Selection Models</h2>
            <p className="text-rose-300/80 text-sm">
              Filter sources to keep only specific channels — with liberal fuzzy matching
            </p>
          </div>
        </div>
        <div className="bg-rose-950/50 border border-rose-700/30 rounded-xl p-4 text-xs text-rose-200/80 space-y-1.5">
          <div className="font-semibold text-rose-300 mb-2">🎯 How Selection Models work:</div>
          <div>1️⃣ Create a model with a list of channel names (e.g. "Sun TV", "Star Vijay")</div>
          <div>2️⃣ Apply the model to any source from the <strong>Sources</strong> tab or below</div>
          <div>3️⃣ Only matching channels are kept — all others are removed from that source</div>
          <div>4️⃣ <strong>Liberal matching:</strong> "Sun TV" → matches "Sun TV HD", "SunTV 4K", "SUN TV USA", "[HD] Sun TV"</div>
          <div>5️⃣ All matched channels can be grouped under one custom group name</div>
        </div>
      </div>

      {/* ── Apply Model to Source ────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>⚡</span> Apply Model to Source
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-gray-400 text-xs mb-1.5 block">Select Source</label>
            <select
              value={applySourceId}
              onChange={e => setApplySourceId(e.target.value)}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600"
            >
              <option value="">Choose a source…</option>
              {sources.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.streamCount} streams)
                  {s.selectionModelId ? ' 🎯' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-gray-400 text-xs mb-1.5 block">Select Model</label>
            <select
              value={applyModelId}
              onChange={e => setApplyModelId(e.target.value)}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600"
            >
              <option value="">— No model (keep all streams) —</option>
              {selectionModels.map(m => (
                <option key={m.id} value={m.id}>
                  {m.isBuiltIn ? '📦 ' : '✏️ '}{m.name} ({m.channels.length} patterns)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Info about selected combo */}
        {applySourceId && applyModelId && (() => {
          const src   = sources.find(s => s.id === applySourceId);
          const model = selectionModels.find(m => m.id === applyModelId);
          if (!src || !model) return null;
          const srcStreams = streams.filter(s => s.sourceId === applySourceId);
          const { matched } = filterStreamsByModel(srcStreams, model.channels);
          return (
            <div className="bg-rose-900/20 border border-rose-700/30 rounded-xl p-4 space-y-2">
              <div className="text-rose-300 font-medium text-sm">📊 Preview:</div>
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <div>
                  <div className="text-white font-bold text-lg">{srcStreams.length}</div>
                  <div className="text-gray-400">Total streams</div>
                </div>
                <div>
                  <div className="text-emerald-400 font-bold text-lg">{matched.length}</div>
                  <div className="text-gray-400">Will be kept</div>
                </div>
                <div>
                  <div className="text-red-400 font-bold text-lg">{srcStreams.length - matched.length}</div>
                  <div className="text-gray-400">Will be removed</div>
                </div>
              </div>
              {model.singleGroup && (
                <div className="text-xs text-rose-200/70">
                  All kept channels → grouped under <strong className="text-white">"{model.defaultGroupName}"</strong>
                </div>
              )}
            </div>
          );
        })()}

        <div className="bg-amber-900/20 border border-amber-700/30 rounded-lg px-4 py-2.5 text-xs text-amber-200/70 flex items-start gap-2">
          <span className="text-amber-400 text-base flex-shrink-0">⚠️</span>
          <span>
            Applying a model <strong>permanently removes non-matching streams</strong> from that source in your library.
            The original M3U URL/file is not deleted — you can refresh the source to restore all streams,
            then re-apply a different model.
          </span>
        </div>

        <button
          onClick={handleApply}
          disabled={!applySourceId || applying}
          className={cn(
            'flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg',
            applying
              ? 'bg-rose-800 text-rose-300 cursor-wait animate-pulse'
              : applySourceId
                ? 'bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white active:scale-95'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          )}
        >
          <span className={applying ? 'animate-spin inline-block' : ''}>🎯</span>
          {applying ? 'Applying…' : applyModelId ? 'Apply Model to Source' : 'Remove Model (Restore All)'}
        </button>
      </div>

      {/* ── Active Model Assignments ──────────────────────────────────────────── */}
      {sourcesWithModels.length > 0 && (
        <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 space-y-2">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <span>🎯</span> Active Model Assignments ({sourcesWithModels.length})
          </h3>
          {sourcesWithModels.map(src => {
            const model = selectionModels.find(m => m.id === src.selectionModelId);
            return (
              <div key={src.id} className="flex items-center gap-3 bg-gray-700/40 border border-gray-600/40 rounded-lg px-4 py-2.5">
                <span className="text-rose-400 text-lg flex-shrink-0">🎯</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-medium">{src.name}</span>
                    <span className="text-gray-500 text-xs">→</span>
                    <span className="text-rose-300 text-xs">{model?.name || 'Unknown model'}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {src.streamCount} kept
                    {src.rawStreamCount ? ` / ${src.rawStreamCount} total` : ''}
                  </div>
                </div>
                <button
                  onClick={() => applyModelToSource(src.id, null)}
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors flex-shrink-0 px-2 py-1 rounded hover:bg-red-900/20"
                  title="Remove model assignment"
                >
                  ✕ Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Built-in Models ──────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>📦</span> Built-in Models ({builtInModels.length})
          <span className="text-xs text-gray-500 font-normal">— read-only, always available</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {builtInModels.map(model => {
            const matchCount = streams.length
              ? filterStreamsByModel(streams, model.channels).matched.length
              : 0;
            return (
              <div key={model.id} className="bg-gray-800 rounded-xl p-4 border border-gray-700 hover:border-rose-700/40 transition-all space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-white font-semibold">{model.name}</div>
                    <div className="text-gray-500 text-xs mt-0.5">
                      {model.channels.length} patterns · {model.singleGroup ? `group: "${model.defaultGroupName}"` : 'original groups'}
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400 border border-gray-600 flex-shrink-0">
                    Built-in
                  </span>
                </div>

                {streams.length > 0 && (
                  <div className="text-xs text-emerald-400">
                    ✅ Matches {matchCount} of {streams.length} loaded streams
                  </div>
                )}

                <div className="flex flex-wrap gap-1">
                  {model.channels.slice(0, 6).map(c => (
                    <span key={c} className="text-xs px-2 py-0.5 rounded-full bg-rose-900/30 text-rose-300 border border-rose-700/30">
                      {c}
                    </span>
                  ))}
                  {model.channels.length > 6 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-500">
                      +{model.channels.length - 6} more
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => setPreviewModelId(prev => prev === model.id ? null : model.id)}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-xs font-medium transition-colors border',
                      previewModelId === model.id
                        ? 'bg-rose-600 border-rose-500 text-white'
                        : 'bg-gray-700 border-gray-600 text-gray-300 hover:text-white hover:bg-gray-600'
                    )}
                  >
                    {previewModelId === model.id ? '✓ Previewing' : '👁️ Preview'}
                  </button>
                  <button
                    onClick={() => openEdit({ ...model, isBuiltIn: false, id: genId(), name: `${model.name} (Copy)`, createdAt: Date.now(), updatedAt: Date.now() })}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-indigo-700/50 hover:bg-indigo-700 border border-indigo-600/50 text-indigo-300 hover:text-white transition-colors"
                    title="Clone and edit this model"
                  >
                    📋 Clone
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Custom Models ────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <span>✏️</span> Custom Models ({customModels.length})
          </h3>
          <button
            onClick={openNew}
            className="flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            + Create Model
          </button>
        </div>

        {customModels.length === 0 && !showForm && (
          <div className="text-center py-10 border border-dashed border-gray-700 rounded-xl text-gray-500">
            <div className="text-4xl mb-3">🎯</div>
            <div className="text-gray-400 font-medium">No custom models yet</div>
            <div className="text-sm mt-1">Create a model to filter sources to specific channels</div>
            <button onClick={openNew} className="mt-4 px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-sm font-medium transition-colors">
              + Create Your First Model
            </button>
          </div>
        )}

        {customModels.map(model => {
          const matchCount = streams.length
            ? filterStreamsByModel(streams, model.channels).matched.length
            : 0;
          return (
            <div key={model.id} className="bg-gray-800 rounded-xl p-4 border border-gray-700 hover:border-rose-700/40 transition-all space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold">{model.name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      {model.channels.length} patterns
                    </span>
                    {model.singleGroup && (
                      <span className="text-xs text-gray-500">→ group: "{model.defaultGroupName}"</span>
                    )}
                  </div>
                  {streams.length > 0 && (
                    <div className="text-xs text-emerald-400 mt-1">
                      ✅ Matches {matchCount} of {streams.length} loaded streams
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => setPreviewModelId(prev => prev === model.id ? null : model.id)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      previewModelId === model.id
                        ? 'bg-rose-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:text-white hover:bg-gray-600'
                    )}
                  >
                    {previewModelId === model.id ? '✓' : '👁️'}
                  </button>
                  <button
                    onClick={() => openEdit(model)}
                    className="p-1.5 rounded-lg bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white transition-colors"
                  >✏️</button>
                  <button
                    onClick={() => handleDelete(model.id)}
                    className={cn(
                      'p-1.5 rounded-lg text-xs transition-colors',
                      deleteConfirm === model.id
                        ? 'bg-red-600 text-white animate-pulse'
                        : 'bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white'
                    )}
                  >
                    {deleteConfirm === model.id ? '⚠️' : '🗑️'}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                {model.channels.slice(0, 8).map(c => (
                  <span key={c} className="text-xs px-2 py-0.5 rounded-full bg-rose-900/30 text-rose-300 border border-rose-700/30">
                    {c}
                  </span>
                ))}
                {model.channels.length > 8 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-500">
                    +{model.channels.length - 8} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Create / Edit Form ────────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div
            className="bg-gray-800 rounded-2xl border border-gray-600 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-6 space-y-4">
              <h3 className="text-white font-bold text-xl flex items-center gap-2">
                {editModel ? '✏️ Edit' : '➕ Create'} Selection Model
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-gray-400 text-xs mb-1.5 block font-medium">Model Name *</label>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    placeholder="e.g. Tamil Channels, Sports Pack…"
                    className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600"
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1.5 block font-medium">Default Group Name</label>
                  <input
                    value={editGroup}
                    onChange={e => setEditGroup(e.target.value)}
                    placeholder="e.g. Tamil, Sports, News…"
                    className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600"
                  />
                </div>
              </div>

              {/* Single group toggle */}
              <div className="flex items-center justify-between bg-gray-700/40 border border-gray-600/50 rounded-xl px-4 py-3">
                <div>
                  <div className="text-white text-sm font-medium">Combine into Single Group</div>
                  <div className="text-gray-500 text-xs">
                    {editSingle
                      ? `All matched channels → one group: "${editGroup || 'Default'}"`
                      : 'Keep original group names from M3U source'}
                  </div>
                </div>
                <button
                  onClick={() => setEditSingle(v => !v)}
                  className={cn('w-10 h-6 rounded-full transition-all relative flex-shrink-0 ml-4', editSingle ? 'bg-rose-500' : 'bg-gray-600')}
                >
                  <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', editSingle ? 'left-4' : 'left-0.5')} />
                </button>
              </div>

              {/* Channel list */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-gray-400 text-xs font-medium">
                    Channel Patterns * — one per line
                  </label>
                  <span className="text-gray-600 text-xs">
                    {editChannels.split('\n').filter(l => l.trim()).length} patterns
                  </span>
                </div>
                <textarea
                  value={editChannels}
                  onChange={e => setEditChannels(e.target.value)}
                  rows={14}
                  placeholder={`Sun TV\nStar Vijay\nZee Tamil\n…`}
                  className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600 resize-none leading-relaxed"
                />
                <p className="text-gray-600 text-xs mt-1">
                  Liberal matching: "Sun TV" also matches "Sun TV HD", "SunTV 4K", "SUN TV USA" etc.
                </p>
              </div>

              {/* Live match count */}
              {streams.length > 0 && editChannels.trim() && (() => {
                const patterns = editChannels.split('\n').map(l => l.trim()).filter(Boolean);
                const { matched } = filterStreamsByModel(streams, patterns);
                return (
                  <div className={cn(
                    'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm',
                    matched.length > 0
                      ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                      : 'bg-gray-700/40 border border-gray-600/40 text-gray-400'
                  )}>
                    <span>{matched.length > 0 ? '✅' : 'ℹ️'}</span>
                    <span>
                      {matched.length > 0
                        ? `${matched.length} of ${streams.length} loaded streams would be kept`
                        : 'No streams match yet (add sources first to see matches)'}
                    </span>
                  </div>
                );
              })()}

              <div className="flex gap-3">
                <button
                  onClick={handleSave}
                  className="flex-1 bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white py-3 rounded-xl font-semibold text-sm transition-all shadow-lg"
                >
                  {editModel ? '✓ Update Model' : '✓ Create Model'}
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-xl text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Preview Panel ─────────────────────────────────────────────────────── */}
      {previewModel && (
        <div className="bg-gray-800 rounded-xl p-5 border border-rose-700/30 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span>👁️</span> Preview: {previewModel.name}
            </h3>
            <button
              onClick={() => setPreviewModelId(null)}
              className="text-gray-500 hover:text-white text-sm transition-colors"
            >✕ Close</button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-gray-700/50 rounded-xl p-3">
              <div className="text-blue-400 font-bold text-xl">{streams.length}</div>
              <div className="text-gray-500 text-xs">Total streams</div>
            </div>
            <div className="bg-emerald-900/30 border border-emerald-700/30 rounded-xl p-3">
              <div className="text-emerald-400 font-bold text-xl">{previewMatched}</div>
              <div className="text-gray-500 text-xs">Would be kept</div>
            </div>
            <div className="bg-red-900/20 border border-red-700/20 rounded-xl p-3">
              <div className="text-red-400 font-bold text-xl">{streams.length - previewMatched}</div>
              <div className="text-gray-500 text-xs">Would be removed</div>
            </div>
          </div>

          {/* Single channel test */}
          <div className="space-y-2">
            <label className="text-gray-400 text-xs font-medium block">
              🧪 Test a channel name — does it match this model?
            </label>
            <input
              value={testName}
              onChange={e => setTestName(e.target.value)}
              placeholder="e.g. Sun TV HD, Star Vijay 4K…"
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 border border-gray-600"
            />
            {testName.trim() && (
              <div className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm',
                singleTestMatches && singleTestMatches.length > 0
                  ? 'bg-emerald-900/30 border border-emerald-700/30 text-emerald-300'
                  : 'bg-red-900/20 border border-red-700/20 text-red-300'
              )}>
                <span>{singleTestMatches && singleTestMatches.length > 0 ? '✅ MATCH' : '❌ NO MATCH'}</span>
                {singleTestMatches && singleTestMatches.length > 0 && (
                  <span className="text-xs text-emerald-200/70">
                    matched by pattern: "{singleTestMatches[0]}"
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Per-pattern breakdown */}
          <div className="space-y-2">
            <h4 className="text-gray-400 text-xs font-medium">Pattern Breakdown</h4>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {previewResults.map(r => (
                <div key={r.pattern} className="flex items-center gap-3 bg-gray-700/30 rounded-lg px-3 py-2">
                  <span className={cn(
                    'text-xs font-bold flex-shrink-0 w-8 text-right',
                    r.matchCount > 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {r.matchCount}
                  </span>
                  <span className="text-white text-sm font-medium flex-shrink-0 min-w-[140px]">{r.pattern}</span>
                  <div className="flex flex-wrap gap-1 min-w-0">
                    {r.examples.slice(0, 4).map(ex => (
                      <span key={ex} className="text-xs text-gray-400 bg-gray-700 px-1.5 py-0.5 rounded truncate max-w-[150px]">
                        {ex}
                      </span>
                    ))}
                    {r.examples.length === 0 && (
                      <span className="text-xs text-red-400/60 italic">no streams matched</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
