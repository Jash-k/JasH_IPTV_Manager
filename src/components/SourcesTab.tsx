import { useState, useRef } from 'react';
import { Source } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props {
  store: AppStore;
}

type AddMode = 'url' | 'file' | 'cloud' | 'single' | 'manual' | null;

const genId = () => `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export const SourcesTab: React.FC<Props> = ({ store }) => {
  const { sources, streams, selectionModels, addSource, refreshSource, deleteSource, toggleSource, applyModelToSource, combineSourceChannels, setActiveTab, notify } = store;
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [urlInput, setUrlInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [singleUrl, setSingleUrl] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualGroup, setManualGroup] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [applyingModel, setApplyingModel] = useState<string | null>(null);
  const [combining, setCombining] = useState<string | null>(null);
  const [combineGroupName, setCombineGroupName] = useState('⭐ Best Streams');
  const [showCombineBar, setShowCombineBar] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAddUrl = async () => {
    if (!urlInput.trim()) return notify('Please enter a URL', 'error');
    const source: Source = {
      id: genId(),
      name: nameInput || urlInput.split('/').pop() || 'New Source',
      type: 'url',
      url: urlInput.trim(),
      enabled: true,
      priority: sources.length,
      streamCount: 0,
      status: 'loading',
    };
    setLoading(source.id);
    setAddMode(null);
    setUrlInput(''); setNameInput('');
    await addSource(source);
    setLoading(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      const source: Source = {
        id: genId(),
        name: file.name.replace('.m3u', '').replace('.m3u8', ''),
        type: 'file',
        enabled: true,
        priority: sources.length,
        streamCount: 0,
        status: 'loading',
        content,
      };
      setLoading(source.id);
      setAddMode(null);
      await addSource(source, content);
      setLoading(null);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleAddSingle = async () => {
    if (!singleUrl.trim()) return notify('Please enter a stream URL', 'error');
    const source: Source = {
      id: genId(),
      name: nameInput || 'Single Stream',
      type: 'single',
      url: singleUrl.trim(),
      enabled: true,
      priority: sources.length,
      streamCount: 1,
      status: 'loading',
    };
    setLoading(source.id);
    setAddMode(null);
    setSingleUrl(''); setNameInput('');
    await addSource(source);
    setLoading(null);
  };

  const handleAddManual = async () => {
    if (!manualUrl.trim() || !manualName.trim()) return notify('Name and URL required', 'error');
    const content = `#EXTM3U\n#EXTINF:-1 group-title="${manualGroup || 'Manual'}",${manualName}\n${manualUrl}`;
    const source: Source = {
      id: genId(),
      name: manualName,
      type: 'manual',
      enabled: true,
      priority: sources.length,
      streamCount: 1,
      status: 'loading',
      content,
    };
    setLoading(source.id);
    setAddMode(null);
    setManualName(''); setManualUrl(''); setManualGroup('');
    await addSource(source, content);
    setLoading(null);
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    await deleteSource(id);
  };

  const typeColors: Record<string, string> = {
    url: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    file: 'bg-green-500/20 text-green-300 border-green-500/30',
    cloud: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    single: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    manual: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  };

  return (
    <div className="space-y-6">
      {/* Add Buttons */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { mode: 'url' as AddMode, icon: '🔗', label: 'Add M3U URL', color: 'from-blue-600 to-blue-700' },
          { mode: 'file' as AddMode, icon: '📁', label: 'Upload File', color: 'from-green-600 to-green-700' },
          { mode: 'single' as AddMode, icon: '📺', label: 'Single Stream', color: 'from-orange-600 to-orange-700' },
          { mode: 'manual' as AddMode, icon: '✏️', label: 'Manual Entry', color: 'from-pink-600 to-pink-700' },
        ].map(b => (
          <button
            key={b.mode}
            onClick={() => { setAddMode(addMode === b.mode ? null : b.mode); }}
            className={cn(
              'flex items-center gap-2 px-4 py-3 rounded-xl text-white font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-white/30',
              `bg-gradient-to-r ${b.color} hover:opacity-90 active:scale-95 shadow-lg`,
              addMode === b.mode && 'ring-2 ring-white/40'
            )}
          >
            <span className="text-lg">{b.icon}</span>
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      {/* Add Forms */}
      {addMode === 'url' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">🔗 Add M3U URL</h3>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)}
            placeholder="Source name (optional)" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600" />
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)}
            placeholder="https://example.com/playlist.m3u" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600" />
          <div className="flex gap-3">
            <button onClick={handleAddUrl} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add Source
            </button>
            <button onClick={() => setAddMode(null)} className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {addMode === 'file' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">📁 Upload M3U File</h3>
          <input ref={fileRef} type="file" accept=".m3u,.m3u8,.txt" onChange={handleFileUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-500 hover:border-green-500 text-gray-300 hover:text-white rounded-xl py-8 transition-all text-center">
            <div className="text-3xl mb-2">📁</div>
            <div className="font-medium">Click to choose M3U file</div>
            <div className="text-sm text-gray-500 mt-1">Supports .m3u, .m3u8, .txt</div>
          </button>
          <button onClick={() => setAddMode(null)} className="w-full bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
            Cancel
          </button>
        </div>
      )}

      {addMode === 'single' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">📺 Single .m3u8 Stream</h3>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)}
            placeholder="Stream name" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 border border-gray-600" />
          <input value={singleUrl} onChange={e => setSingleUrl(e.target.value)}
            placeholder="https://example.com/stream.m3u8" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 border border-gray-600" />
          <div className="flex gap-3">
            <button onClick={handleAddSingle} className="flex-1 bg-orange-600 hover:bg-orange-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add Stream
            </button>
            <button onClick={() => setAddMode(null)} className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {addMode === 'manual' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">✏️ Manual Stream Entry</h3>
          <input value={manualName} onChange={e => setManualName(e.target.value)}
            placeholder="Channel name *" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <input value={manualUrl} onChange={e => setManualUrl(e.target.value)}
            placeholder="Stream URL *" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <input value={manualGroup} onChange={e => setManualGroup(e.target.value)}
            placeholder="Group (optional)" className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <div className="flex gap-3">
            <button onClick={handleAddManual} className="flex-1 bg-pink-600 hover:bg-pink-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add Channel
            </button>
            <button onClick={() => setAddMode(null)} className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Combine Controls ─────────────────────────────────────────────── */}
      {sources.length >= 2 && (
        <div className="bg-gradient-to-r from-yellow-900/30 to-amber-900/30 border border-yellow-700/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⭐</span>
              <div>
                <div className="text-white font-semibold text-sm">Auto-Combine Channels</div>
                <div className="text-yellow-300/70 text-xs">
                  Find channels that appear in multiple sources and combine them into one catalog entry
                </div>
              </div>
            </div>
            <button
              onClick={() => setShowCombineBar(v => !v)}
              className={cn(
                'px-4 py-2 rounded-xl text-sm font-semibold transition-all flex-shrink-0',
                showCombineBar
                  ? 'bg-yellow-600 text-white'
                  : 'bg-yellow-700/60 hover:bg-yellow-700 text-yellow-200 border border-yellow-600/50'
              )}
            >
              {showCombineBar ? '▲ Hide' : '⭐ Combine Options'}
            </button>
          </div>

          {showCombineBar && (
            <div className="space-y-3 border-t border-yellow-700/30 pt-3">
              <div className="flex gap-3 items-end flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="text-yellow-300/70 text-xs mb-1 block">Combined Group Name</label>
                  <input
                    value={combineGroupName}
                    onChange={e => setCombineGroupName(e.target.value)}
                    placeholder="⭐ Best Streams"
                    className="w-full bg-gray-800 border border-yellow-700/40 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500"
                  />
                </div>
                <button
                  onClick={async () => {
                    setCombining('all');
                    await combineSourceChannels(null, combineGroupName || '⭐ Best Streams');
                    setCombining(null);
                  }}
                  disabled={combining === 'all'}
                  className={cn(
                    'flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-lg flex-shrink-0',
                    combining === 'all'
                      ? 'bg-yellow-800 text-yellow-300 cursor-wait animate-pulse'
                      : 'bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-500 hover:to-amber-500 text-white active:scale-95'
                  )}
                >
                  <span className={combining === 'all' ? 'animate-spin inline-block' : ''}>⭐</span>
                  {combining === 'all' ? 'Combining…' : 'Combine All Sources'}
                </button>
              </div>

              <div className="bg-yellow-900/20 border border-yellow-700/20 rounded-lg px-4 py-2.5 text-xs text-yellow-200/70 space-y-1">
                <div>• Channels with the same name (e.g. "Sun TV") found in ≥ 2 sources are combined into one entry</div>
                <div>• Quality variants (Sun TV HD, Sun TV 4K) from the same source are handled by the backend automatically</div>
                <div>• Combined channels appear in the <strong className="text-yellow-300">Combine</strong> tab — sync to backend to activate in Stremio</div>
                <div>• <strong className="text-yellow-300">Language words are preserved</strong> — Zee Tamil ≠ Zee Marathi (safe to combine Tamil M3U sources)</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sources List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Active Sources ({sources.length})</h3>
        </div>

        {sources.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <div className="text-5xl mb-4">📡</div>
            <div className="text-lg font-medium text-gray-400">No sources added yet</div>
            <div className="text-sm mt-2">Add an M3U URL or upload a file to get started</div>
          </div>
        )}

        {sources.map(src => (
          <div key={src.id} className={cn(
            'bg-gray-800 rounded-xl p-4 border transition-all',
            src.enabled ? 'border-gray-700' : 'border-gray-700/30 opacity-60'
          )}>
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-white font-medium truncate">{src.name}</span>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border', typeColors[src.type])}>
                    {src.type}
                  </span>
                  {src.status === 'loading' || loading === src.id ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 animate-pulse">
                      Loading...
                    </span>
                  ) : src.status === 'error' ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30">
                      Error
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {src.streamCount.toLocaleString()} streams
                    </span>
                  )}
                </div>
                {src.url && <div className="text-gray-500 text-xs truncate">{src.url}</div>}
                {src.error && <div className="text-red-400 text-xs mt-1">{src.error}</div>}
                {src.lastUpdated && <div className="text-gray-600 text-xs mt-1">Updated: {new Date(src.lastUpdated).toLocaleString()}</div>}
                {/* Selection Model badge + quick-change */}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {src.selectionModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                      🎯 {selectionModels.find(m => m.id === src.selectionModelId)?.name || 'Model'}
                      {src.rawStreamCount && (
                        <span className="text-rose-400/60">({src.streamCount}/{src.rawStreamCount})</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-600">No filter model</span>
                  )}
                  <select
                    value={src.selectionModelId || ''}
                    onChange={async e => {
                      const modelId = e.target.value || null;
                      setApplyingModel(src.id);
                      await applyModelToSource(src.id, modelId);
                      setApplyingModel(null);
                    }}
                    disabled={applyingModel === src.id}
                    className="text-xs bg-gray-700 text-gray-300 rounded-lg px-2 py-1 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    title="Apply selection model to this source"
                  >
                    <option value="">— Apply Model —</option>
                    {selectionModels.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.isBuiltIn ? '📦 ' : '✏️ '}{m.name}
                      </option>
                    ))}
                  </select>
                  {applyingModel === src.id && (
                    <span className="text-xs text-rose-300 animate-pulse">Applying…</span>
                  )}
                  <button
                    onClick={() => setActiveTab('models')}
                    className="text-xs text-gray-600 hover:text-rose-400 transition-colors"
                    title="Manage selection models"
                  >
                    🎯 Manage Models
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Per-source Combine button — only show when there are ≥2 sources */}
                {sources.length >= 2 && src.streamCount > 0 && (
                  <button
                    onClick={async () => {
                      setCombining(src.id);
                      await combineSourceChannels(src.id, combineGroupName || '⭐ Best Streams');
                      setCombining(null);
                    }}
                    disabled={combining === src.id}
                    className={cn(
                      'px-2.5 py-2 rounded-lg text-xs font-semibold transition-all border',
                      combining === src.id
                        ? 'bg-yellow-800 border-yellow-700 text-yellow-300 cursor-wait animate-pulse'
                        : 'bg-yellow-700/30 hover:bg-yellow-700/60 border-yellow-600/40 text-yellow-300 hover:text-yellow-100'
                    )}
                    title={`Find channels from "${src.name}" that exist in other sources and combine them`}
                  >
                    {combining === src.id ? '⏳' : '⭐'} Combine
                  </button>
                )}
                {/* Toggle */}
                <button onClick={() => toggleSource(src.id)}
                  className={cn('w-10 h-6 rounded-full transition-colors relative', src.enabled ? 'bg-purple-600' : 'bg-gray-600')}
                  title={src.enabled ? 'Disable' : 'Enable'}>
                  <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow', src.enabled ? 'left-4' : 'left-0.5')} />
                </button>
                {/* Refresh */}
                {(src.type === 'url' || src.type === 'file') && (
                  <button onClick={() => refreshSource(src.id)}
                    className="p-2 rounded-lg bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white transition-colors" title="Refresh">
                    🔄
                  </button>
                )}
                {/* Delete */}
                <button onClick={() => handleDelete(src.id)}
                  className={cn('p-2 rounded-lg transition-colors text-sm',
                    deleteConfirm === src.id
                      ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                      : 'bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white'
                  )} title={deleteConfirm === src.id ? 'Click again to confirm' : 'Delete'}>
                  {deleteConfirm === src.id ? '⚠️ Confirm' : '🗑️'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
