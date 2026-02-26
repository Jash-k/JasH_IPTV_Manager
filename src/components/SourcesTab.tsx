import { useState, useRef } from 'react';
import { Source } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

type AddMode = 'url' | 'json' | 'file' | 'manual' | null;

const genId = () => `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const AUTO_REFRESH_OPTIONS = [
  { label: 'Off',       value: 0    },
  { label: '15 min',    value: 15   },
  { label: '30 min',    value: 30   },
  { label: '1 hour',    value: 60   },
  { label: '2 hours',   value: 120  },
  { label: '4 hours',   value: 240  },
  { label: '6 hours',   value: 360  },
  { label: '12 hours',  value: 720  },
  { label: '24 hours',  value: 1440 },
];

function formatNextRefresh(nextAutoRefresh?: number): string {
  if (!nextAutoRefresh) return '';
  const diff = nextAutoRefresh - Date.now();
  if (diff <= 0) return 'Refreshing soon…';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
}

function formatLastRefresh(ts?: number): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export const SourcesTab: React.FC<Props> = ({ store }) => {
  const {
    sources, selectionModels,
    addSource, refreshSource, deleteSource, toggleSource,
    applyModelToSource, setAutoRefresh, setActiveTab, notify,
  } = store;

  const [addMode,       setAddMode]       = useState<AddMode>(null);
  const [urlInput,      setUrlInput]      = useState('');
  const [nameInput,     setNameInput]     = useState('');
  const [manualName,    setManualName]    = useState('');
  const [manualUrl,     setManualUrl]     = useState('');
  const [manualGroup,   setManualGroup]   = useState('');
  const [addRefresh,    setAddRefresh]    = useState(0);   // auto-refresh interval for new URL/JSON sources
  const [loading,       setLoading]       = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [applyingModel, setApplyingModel] = useState<string | null>(null);
  const [refreshing,    setRefreshing]    = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Add URL / JSON Source ─────────────────────────────────────────────────
  const handleAddUrl = async (type: 'url' | 'json') => {
    if (!urlInput.trim()) return notify('Please enter a URL', 'error');
    const source: Source = {
      id                 : genId(),
      name               : nameInput || urlInput.split('/').pop()?.split('?')[0] || 'New Source',
      type,
      url                : urlInput.trim(),
      enabled            : true,
      priority           : sources.length,
      streamCount        : 0,
      status             : 'loading',
      autoRefreshInterval: addRefresh,
      nextAutoRefresh    : addRefresh > 0 ? Date.now() + addRefresh * 60 * 1000 : undefined,
    };
    setLoading(source.id);
    setAddMode(null);
    setUrlInput(''); setNameInput(''); setAddRefresh(0);
    await addSource(source);
    setLoading(null);
  };

  // ── File Upload ───────────────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      const isJson  = file.name.endsWith('.json') || content.trimStart().startsWith('[') || content.trimStart().startsWith('{');
      const source: Source = {
        id         : genId(),
        name       : file.name.replace(/\.(m3u8?|json|txt)$/i, ''),
        type       : isJson ? 'json' : 'file',
        enabled    : true,
        priority   : sources.length,
        streamCount: 0,
        status     : 'loading',
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

  // ── Manual Entry ──────────────────────────────────────────────────────────
  const handleAddManual = async () => {
    if (!manualUrl.trim() || !manualName.trim()) return notify('Name and URL required', 'error');
    const content = `#EXTM3U\n#EXTINF:-1 group-title="${manualGroup || 'Manual'}",${manualName}\n${manualUrl}`;
    const source: Source = {
      id         : genId(),
      name       : manualName,
      type       : 'manual',
      enabled    : true,
      priority   : sources.length,
      streamCount: 1,
      status     : 'loading',
      content,
    };
    setLoading(source.id);
    setAddMode(null);
    setManualName(''); setManualUrl(''); setManualGroup('');
    await addSource(source, content);
    setLoading(null);
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    await deleteSource(id);
  };

  // ── Manual Refresh ────────────────────────────────────────────────────────
  const handleRefresh = async (id: string) => {
    setRefreshing(id);
    await refreshSource(id);
    setRefreshing(null);
  };

  // ── Type badge colors ─────────────────────────────────────────────────────
  const typeColors: Record<string, string> = {
    url   : 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    json  : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    file  : 'bg-green-500/20 text-green-300 border-green-500/30',
    cloud : 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    manual: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  };

  const typeIcons: Record<string, string> = {
    url   : '🔗',
    json  : '{}',
    file  : '📁',
    cloud : '☁️',
    manual: '✏️',
  };

  const canRefresh = (src: Source) =>
    (src.type === 'url' || src.type === 'json') && !!src.url;

  return (
    <div className="space-y-6">

      {/* ── Add Buttons ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { mode: 'url'    as AddMode, icon: '🔗', label: 'M3U URL',    color: 'from-blue-600 to-blue-700'   },
          { mode: 'json'   as AddMode, icon: '{}', label: 'JSON URL',   color: 'from-yellow-600 to-yellow-700' },
          { mode: 'file'   as AddMode, icon: '📁', label: 'Upload File', color: 'from-green-600 to-green-700'  },
          { mode: 'manual' as AddMode, icon: '✏️', label: 'Manual',     color: 'from-pink-600 to-pink-700'    },
        ].map(b => (
          <button
            key={b.mode}
            onClick={() => setAddMode(addMode === b.mode ? null : b.mode)}
            className={cn(
              'flex items-center gap-2 px-4 py-3 rounded-xl text-white font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-white/30',
              `bg-gradient-to-r ${b.color} hover:opacity-90 active:scale-95 shadow-lg`,
              addMode === b.mode && 'ring-2 ring-white/40'
            )}
          >
            <span className="text-base font-bold">{b.icon}</span>
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      {/* ── M3U URL Form ────────────────────────────────────────────────────── */}
      {addMode === 'url' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3 animate-fadeIn">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">🔗 Add M3U URL</h3>
          <p className="text-gray-400 text-xs">
            Supports M3U playlists from raw.github, pastebin, any public URL.<br/>
            Auto-detected format: M3U or JSON.
          </p>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)}
            placeholder="Source name (optional)"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600" />
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)}
            placeholder="https://raw.githubusercontent.com/.../playlist.m3u"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600" />
          <div>
            <label className="text-gray-400 text-xs mb-1 block">🔄 Auto-Refresh Interval</label>
            <select value={addRefresh} onChange={e => setAddRefresh(Number(e.target.value))}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500">
              {AUTO_REFRESH_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <button onClick={() => handleAddUrl('url')} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add M3U Source
            </button>
            <button onClick={() => { setAddMode(null); setUrlInput(''); setNameInput(''); setAddRefresh(0); }}
              className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── JSON URL Form ───────────────────────────────────────────────────── */}
      {addMode === 'json' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-yellow-700/40 space-y-3 animate-fadeIn">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">
            <span className="text-yellow-400 font-mono font-bold">{'{}'}</span> Add JSON Source
          </h3>
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-3 text-xs text-yellow-200/80 space-y-1">
            <div className="font-semibold text-yellow-300 mb-2">Supported JSON formats:</div>
            <div className="font-mono bg-gray-900/60 rounded p-2 text-xs overflow-x-auto whitespace-pre">{`[
  {
    "name": "Star Plus",
    "link": "https://…/index.mpd",
    "logo": "https://…/logo.jpg",
    "cookie": "__hdnea__=st=…",
    "drmLicense": "kid:key",
    "drmScheme": "clearkey"
  }
]`}</div>
            <div className="mt-2 text-gray-400">Also supports: <code className="bg-gray-800 px-1 rounded">url</code>, <code className="bg-gray-800 px-1 rounded">stream</code>, <code className="bg-gray-800 px-1 rounded">category</code>, <code className="bg-gray-800 px-1 rounded">icon</code> and many more field names.</div>
          </div>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)}
            placeholder="Source name (optional)"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 border border-gray-600" />
          <input value={urlInput} onChange={e => setUrlInput(e.target.value)}
            placeholder="https://raw.githubusercontent.com/.../channels.json"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500 border border-gray-600" />
          <div>
            <label className="text-gray-400 text-xs mb-1 block">🔄 Auto-Refresh Interval</label>
            <select value={addRefresh} onChange={e => setAddRefresh(Number(e.target.value))}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm border border-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-500">
              {AUTO_REFRESH_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <button onClick={() => handleAddUrl('json')}
              className="flex-1 bg-yellow-600 hover:bg-yellow-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add JSON Source
            </button>
            <button onClick={() => { setAddMode(null); setUrlInput(''); setNameInput(''); setAddRefresh(0); }}
              className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── File Upload Form ─────────────────────────────────────────────────── */}
      {addMode === 'file' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3 animate-fadeIn">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">📁 Upload File</h3>
          <p className="text-gray-400 text-xs">Supports .m3u, .m3u8, .json, .txt — format auto-detected.</p>
          <input ref={fileRef} type="file" accept=".m3u,.m3u8,.json,.txt" onChange={handleFileUpload} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-500 hover:border-green-500 text-gray-300 hover:text-white rounded-xl py-8 transition-all text-center">
            <div className="text-3xl mb-2">📁</div>
            <div className="font-medium">Click to choose file</div>
            <div className="text-sm text-gray-500 mt-1">Supports .m3u, .m3u8, .json, .txt</div>
          </button>
          <button onClick={() => setAddMode(null)}
            className="w-full bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
            Cancel
          </button>
        </div>
      )}

      {/* ── Manual Entry Form ────────────────────────────────────────────────── */}
      {addMode === 'manual' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3 animate-fadeIn">
          <h3 className="text-white font-semibold text-lg flex items-center gap-2">✏️ Manual Stream Entry</h3>
          <input value={manualName} onChange={e => setManualName(e.target.value)}
            placeholder="Channel name *"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <input value={manualUrl} onChange={e => setManualUrl(e.target.value)}
            placeholder="Stream URL * (http://…)"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <input value={manualGroup} onChange={e => setManualGroup(e.target.value)}
            placeholder="Group (optional)"
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500 border border-gray-600" />
          <div className="flex gap-3">
            <button onClick={handleAddManual}
              className="flex-1 bg-pink-600 hover:bg-pink-500 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              ✓ Add Channel
            </button>
            <button onClick={() => setAddMode(null)}
              className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-lg font-medium text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Sources List ──────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">
            Active Sources
            <span className="ml-2 text-gray-400 text-sm font-normal">({sources.length})</span>
          </h3>
          {sources.some(s => s.autoRefreshInterval && s.autoRefreshInterval > 0) && (
            <span className="text-xs text-emerald-400 flex items-center gap-1 animate-pulse">
              <span className="w-2 h-2 bg-emerald-400 rounded-full inline-block" />
              Auto-refresh active
            </span>
          )}
        </div>

        {sources.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <div className="text-5xl mb-4">📡</div>
            <div className="text-lg font-medium text-gray-400">No sources added yet</div>
            <div className="text-sm mt-2">Add an M3U URL, JSON URL, or upload a file to get started</div>
          </div>
        )}

        {sources.map(src => (
          <div key={src.id} className={cn(
            'bg-gray-800 rounded-xl border transition-all',
            src.enabled ? 'border-gray-700' : 'border-gray-700/30 opacity-60'
          )}>
            {/* ── Source Header ───────────────────────────────────────────── */}
            <div className="flex items-start gap-3 p-4">
              <div className="flex-1 min-w-0">

                {/* Name + type badge + status */}
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-white font-medium truncate max-w-[200px]">{src.name}</span>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border font-mono font-semibold', typeColors[src.type])}>
                    {typeIcons[src.type]} {src.type.toUpperCase()}
                  </span>
                  {/* Status pill */}
                  {src.status === 'loading' || loading === src.id ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 animate-pulse">
                      ⏳ Loading…
                    </span>
                  ) : src.status === 'error' ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30" title={src.error}>
                      ❌ Error
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      ✓ {src.streamCount.toLocaleString()} streams
                    </span>
                  )}
                  {/* DRM / JSON badge */}
                  {src.type === 'json' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                      Auto-DRM
                    </span>
                  )}
                </div>

                {/* URL */}
                {src.url && (
                  <div className="text-gray-500 text-xs truncate max-w-[420px]" title={src.url}>{src.url}</div>
                )}

                {/* Error message */}
                {src.error && (
                  <div className="text-red-400 text-xs mt-1 truncate">{src.error}</div>
                )}

                {/* Timestamps */}
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-600 flex-wrap">
                  {src.lastUpdated && (
                    <span>Updated: {new Date(src.lastUpdated).toLocaleString()}</span>
                  )}
                  {src.rawStreamCount && (
                    <span className="text-rose-400/70">
                      Filtered: {src.streamCount}/{src.rawStreamCount} kept
                    </span>
                  )}
                </div>

                {/* Auto-refresh status line */}
                {src.autoRefreshInterval && src.autoRefreshInterval > 0 ? (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse flex-shrink-0" />
                    <span className="text-xs text-emerald-400">
                      Auto-refresh every {AUTO_REFRESH_OPTIONS.find(o => o.value === src.autoRefreshInterval)?.label || `${src.autoRefreshInterval}m`}
                      {src.nextAutoRefresh && (
                        <span className="text-gray-500 ml-2">· next {formatNextRefresh(src.nextAutoRefresh)}</span>
                      )}
                      {src.lastAutoRefresh && (
                        <span className="text-gray-600 ml-2">· last {formatLastRefresh(src.lastAutoRefresh)}</span>
                      )}
                    </span>
                  </div>
                ) : null}

                {/* Selection Model row */}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {src.selectionModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                      🎯 {selectionModels.find(m => m.id === src.selectionModelId)?.name || 'Model'}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-600">No filter</span>
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
                    title="Apply channel filter model"
                  >
                    <option value="">— Filter Model —</option>
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
                    title="Manage filter models"
                  >
                    🎯 Models
                  </button>
                </div>
              </div>

              {/* ── Action Buttons ─────────────────────────────────────────── */}
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">

                {/* Enable/Disable toggle */}
                <button
                  onClick={() => toggleSource(src.id)}
                  className={cn(
                    'w-11 h-6 rounded-full transition-colors relative flex-shrink-0',
                    src.enabled ? 'bg-purple-600' : 'bg-gray-600'
                  )}
                  title={src.enabled ? 'Disable source' : 'Enable source'}
                >
                  <span className={cn(
                    'absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow',
                    src.enabled ? 'left-5' : 'left-0.5'
                  )} />
                </button>

                {/* Refresh button — only for URL/JSON sources */}
                {canRefresh(src) && (
                  <button
                    onClick={() => handleRefresh(src.id)}
                    disabled={refreshing === src.id}
                    className={cn(
                      'p-2 rounded-lg transition-colors text-sm',
                      refreshing === src.id
                        ? 'bg-blue-800 text-blue-200 cursor-wait animate-pulse'
                        : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white'
                    )}
                    title="Refresh source now"
                  >
                    {refreshing === src.id ? '⏳' : '🔄'}
                  </button>
                )}

                {/* Delete button */}
                <button
                  onClick={() => handleDelete(src.id)}
                  className={cn(
                    'px-3 py-2 rounded-lg transition-colors text-sm font-medium',
                    deleteConfirm === src.id
                      ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                      : 'bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white'
                  )}
                  title={deleteConfirm === src.id ? 'Click again to confirm delete' : 'Delete source'}
                >
                  {deleteConfirm === src.id ? '⚠️ Sure?' : '🗑️'}
                </button>
              </div>
            </div>

            {/* ── Auto-Refresh Control Row (for URL/JSON sources) ──────────── */}
            {canRefresh(src) && (
              <div className="border-t border-gray-700/50 px-4 py-2.5 flex items-center gap-3 bg-gray-800/50 rounded-b-xl">
                <span className="text-xs text-gray-500 flex-shrink-0">🔄 Auto-Refresh:</span>
                <select
                  value={src.autoRefreshInterval || 0}
                  onChange={e => setAutoRefresh(src.id, Number(e.target.value))}
                  className="text-xs bg-gray-700 text-gray-300 rounded-lg px-3 py-1.5 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 flex-shrink-0"
                >
                  {AUTO_REFRESH_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {src.autoRefreshInterval && src.autoRefreshInterval > 0 ? (
                  <span className="text-xs text-emerald-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                    Active — next: {formatNextRefresh(src.nextAutoRefresh)}
                  </span>
                ) : (
                  <span className="text-xs text-gray-600">Disabled — refresh manually with 🔄</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
