import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { Source } from '../types';
import {
  Plus, Trash2, RefreshCw, Upload, Link, CheckCircle, XCircle,
  Clock, Edit2, Save, X, FileJson, FileText, Globe, Timer,
  AlertCircle, Zap, Star, Filter
} from 'lucide-react';
import toast from 'react-hot-toast';
import { detectFormat, isTamilChannel } from '../utils/parser';

const SOURCE_TYPE_ICONS: Record<string, React.ReactNode> = {
  m3u: <FileText className="w-4 h-4 text-green-400" />,
  json: <FileJson className="w-4 h-4 text-yellow-400" />,
  php: <Globe className="w-4 h-4 text-blue-400" />,
  url: <Link className="w-4 h-4 text-purple-400" />,
  file: <Upload className="w-4 h-4 text-pink-400" />,
};

const EXAMPLE_URLS = [
  { label: '🇮🇳 India Channels (iptv-org)', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/in.m3u', type: 'm3u' as const },
  { label: '🎬 Sun TV (Tamil)', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/in_sun.m3u', type: 'm3u' as const },
  { label: '🌐 World IPTV', url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/index.m3u', type: 'm3u' as const },
];

type FormState = {
  name: string; url: string; type: Source['type'];
  autoRefresh: boolean; refreshInterval: number;
};

export default function SourcesTab() {
  const {
    sources, channels, addSource, deleteSource, loadSource, updateSource,
    tamilSourceFilter, setTamilSourceFilter,
  } = useStore();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ name: '', url: '', type: 'url', autoRefresh: false, refreshInterval: 30 });
  const [inputMode, setInputMode] = useState<'url' | 'file'>('url');
  const [detectedFormat, setDetectedFormat] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const intervalRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Auto-refresh intervals
  useEffect(() => {
    sources.forEach(src => {
      if (src.autoRefresh && src.refreshInterval > 0 && src.url) {
        if (!intervalRefs.current[src.id]) {
          intervalRefs.current[src.id] = setInterval(() => {
            loadSource(src.id);
          }, src.refreshInterval * 60 * 1000);
        }
      } else {
        if (intervalRefs.current[src.id]) {
          clearInterval(intervalRefs.current[src.id]);
          delete intervalRefs.current[src.id];
        }
      }
    });
    return () => { Object.values(intervalRefs.current).forEach(clearInterval); };
  }, [sources, loadSource]);

  const detectTypeFromUrl = (url: string): Source['type'] => {
    const u = url.toLowerCase();
    if (u.includes('.m3u') || u.includes('.m3u8')) return 'm3u';
    if (u.includes('.json')) return 'json';
    if (u.includes('.php')) return 'php';
    return 'url';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      const ext = file.name.split('.').pop()?.toLowerCase() || 'url';
      const detectedType: Source['type'] = ext === 'm3u' || ext === 'm3u8' ? 'm3u'
        : ext === 'json' ? 'json' : ext === 'php' ? 'php' : 'file';
      const fmt = detectFormat(content);
      setDetectedFormat(fmt);
      addSource({ name: form.name || file.name, type: detectedType, content, autoRefresh: false, refreshInterval: 30 });
      toast.success(`✅ Loaded ${file.name} — ${fmt.toUpperCase()} format detected`);
      setShowAdd(false);
      resetForm();
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error('Name required'); return; }
    if (inputMode === 'url' && !form.url.trim()) { toast.error('URL required'); return; }
    if (editId) {
      updateSource(editId, { name: form.name, url: form.url, type: form.type, autoRefresh: form.autoRefresh, refreshInterval: form.refreshInterval });
      toast.success('Source updated');
      setEditId(null);
    } else {
      addSource({ name: form.name, url: form.url, type: form.type, autoRefresh: form.autoRefresh, refreshInterval: form.refreshInterval });
      toast.success('🚀 Source added — fetching & parsing...');
    }
    resetForm();
  };

  const startEdit = (src: Source) => {
    setForm({ name: src.name, url: src.url || '', type: src.type, autoRefresh: src.autoRefresh, refreshInterval: src.refreshInterval });
    setEditId(src.id);
    setShowAdd(true);
    setInputMode('url');
  };

  const resetForm = () => {
    setForm({ name: '', url: '', type: 'url', autoRefresh: false, refreshInterval: 30 });
    setDetectedFormat('');
    setEditId(null);
    setShowAdd(false);
  };

  // Compute source-level tamil stats
  const sourceStats = sources.map(src => {
    const srcChannels = channels.filter(ch => ch.sourceId === src.id);
    const tamilCount = srcChannels.filter(ch => ch.isTamil || isTamilChannel(ch)).length;
    return { ...src, tamilCount, totalCount: srcChannels.length };
  });

  const displayedSources = tamilSourceFilter
    ? sourceStats.filter(s => s.tamilCount > 0)
    : sourceStats;

  const totalTamil = channels.filter(ch => ch.isTamil).length;
  const totalChannels = channels.length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Playlist Sources</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {sources.length} sources · {totalChannels.toLocaleString()} channels · {totalTamil.toLocaleString()} Tamil
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditId(null); setDetectedFormat(''); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-blue-600/20"
        >
          <Plus className="w-4 h-4" /> Add Source
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setTamilSourceFilter(!tamilSourceFilter)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all border ${
            tamilSourceFilter
              ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:border-orange-600 hover:text-orange-400'
          }`}
        >
          <Star className={`w-4 h-4 ${tamilSourceFilter ? 'fill-white' : ''}`} />
          🎬 Tamil Sources Only
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${tamilSourceFilter ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
            {sources.filter(s => (s.tamilCount || 0) > 0).length}
          </span>
        </button>

        {tamilSourceFilter && (
          <button
            onClick={() => setTamilSourceFilter(false)}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors"
          >
            <Filter className="w-3.5 h-3.5" /> Clear Filter
          </button>
        )}
      </div>

      {/* Info Banner */}
      <div className="bg-gray-800/60 border border-gray-700/60 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Zap className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-white text-sm font-medium mb-1">Auto-Detection Parser</p>
            <p className="text-gray-400 text-xs leading-relaxed">
              Supports <span className="text-green-400 font-mono">.m3u / .m3u8</span> (KODIPROP, EXTVLCOPT, EXTHTTP),{' '}
              <span className="text-yellow-400 font-mono">.json</span> (JioTV, nested, hybrid),{' '}
              <span className="text-blue-400 font-mono">.php</span> APIs, GitHub raw, Pastebin, direct URLs.
              Tamil channels are auto-detected and tagged. DRM keys auto-extracted.
              Sources auto-sync to server on every change.
            </p>
          </div>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold">{editId ? 'Edit Source' : 'New Source'}</h3>
            <button onClick={resetForm} className="text-gray-400 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
          </div>

          {!editId && (
            <div className="flex gap-2 bg-gray-900 rounded-lg p-1 w-fit">
              <button onClick={() => setInputMode('url')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${inputMode === 'url' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                <Link className="w-3 h-3" /> URL / Link
              </button>
              <button onClick={() => setInputMode('file')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${inputMode === 'file' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                <Upload className="w-3 h-3" /> Upload File
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Source Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="My IPTV Source"
              />
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Format Override</label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as Source['type'] }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="url">Auto Detect</option>
                <option value="m3u">M3U / M3U8</option>
                <option value="json">JSON (JioTV, Generic)</option>
                <option value="php">PHP API</option>
              </select>
            </div>
          </div>

          {inputMode === 'url' ? (
            <div>
              <label className="text-gray-400 text-sm mb-1 block">URL *</label>
              <input
                value={form.url}
                onChange={e => { const url = e.target.value; setForm(f => ({ ...f, url, type: detectTypeFromUrl(url) })); }}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="https://raw.githubusercontent.com/... or http://server.com/playlist.m3u"
              />
              <p className="text-gray-500 text-xs mt-1.5 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                GitHub raw, Pastebin, direct M3U/JSON/PHP URLs. CORS proxy applied automatically.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {EXAMPLE_URLS.map(ex => (
                  <button key={ex.url}
                    onClick={() => setForm(f => ({ ...f, url: ex.url, name: f.name || ex.label, type: ex.type }))}
                    className="text-xs bg-gray-700 hover:bg-gray-600 text-blue-400 px-2 py-1 rounded-md transition-colors"
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Upload File</label>
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-lg p-8 text-center cursor-pointer transition-colors group"
              >
                <Upload className="w-10 h-10 text-gray-500 group-hover:text-blue-400 mx-auto mb-3 transition-colors" />
                <p className="text-gray-400 text-sm">Click to upload playlist file</p>
                <p className="text-gray-600 text-xs mt-1">.m3u · .m3u8 · .json · .php · .txt</p>
                <input ref={fileRef} type="file" className="hidden" accept=".m3u,.m3u8,.json,.php,.txt" onChange={handleFileUpload} />
              </div>
              {detectedFormat && (
                <p className="text-green-400 text-xs mt-2 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> Detected: {detectedFormat.toUpperCase()}
                </p>
              )}
            </div>
          )}

          {/* Auto Refresh */}
          <div className="flex items-center gap-4 flex-wrap p-3 bg-gray-900/50 rounded-lg border border-gray-700/50">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.autoRefresh}
                onChange={e => setForm(f => ({ ...f, autoRefresh: e.target.checked }))}
                className="w-4 h-4 accent-blue-500" />
              <span className="text-gray-300 text-sm flex items-center gap-1">
                <Timer className="w-3.5 h-3.5 text-blue-400" /> Auto Refresh
              </span>
            </label>
            {form.autoRefresh && (
              <div className="flex items-center gap-2">
                <span className="text-gray-500 text-sm">Every</span>
                <input type="number" min="1" max="1440" value={form.refreshInterval}
                  onChange={e => setForm(f => ({ ...f, refreshInterval: +e.target.value }))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 text-center" />
                <span className="text-gray-500 text-sm">minutes</span>
              </div>
            )}
          </div>

          {inputMode === 'url' && (
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={resetForm} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
              <button onClick={handleSubmit}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
                <Save className="w-4 h-4" /> {editId ? 'Update' : 'Add Source'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Source List */}
      {displayedSources.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Globe className="w-14 h-14 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium text-gray-400 mb-2">
            {tamilSourceFilter ? 'No Tamil sources found' : 'No sources added yet'}
          </p>
          <p className="text-sm">{tamilSourceFilter ? 'Add sources that contain Tamil channels' : 'Add a playlist URL or upload a file to get started'}</p>
          {!tamilSourceFilter && (
            <button onClick={() => setShowAdd(true)}
              className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> Add Your First Source
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {displayedSources.map(src => (
            <div key={src.id}
              className={`bg-gray-800 border rounded-xl p-4 transition-all ${src.status === 'error' ? 'border-red-800/50' : 'border-gray-700'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="mt-0.5 p-2 bg-gray-700/50 rounded-lg">
                    {SOURCE_TYPE_ICONS[src.type] || <Globe className="w-4 h-4 text-gray-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-white font-medium">{src.name}</h3>
                      <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full uppercase font-mono">{src.type}</span>
                      {src.autoRefresh && (
                        <span className="text-xs bg-blue-900/50 text-blue-400 border border-blue-800/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Timer className="w-3 h-3" /> {src.refreshInterval}min
                        </span>
                      )}
                      {(src.tamilCount || 0) > 0 && (
                        <span className="text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Star className="w-3 h-3 fill-orange-400" /> {src.tamilCount} Tamil
                        </span>
                      )}
                    </div>
                    {src.url && <p className="text-gray-500 text-xs mt-1 truncate font-mono">{src.url}</p>}
                    {src.content && !src.url && (
                      <p className="text-gray-500 text-xs mt-1 italic">Local file · {(src.content.length / 1024).toFixed(1)} KB</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      {src.status === 'loading' && (
                        <span className="flex items-center gap-1.5 text-yellow-400 text-xs">
                          <RefreshCw className="w-3 h-3 animate-spin" /> Fetching & parsing...
                        </span>
                      )}
                      {src.status === 'success' && (
                        <span className="flex items-center gap-1.5 text-green-400 text-xs">
                          <CheckCircle className="w-3 h-3" /> {(src.channelCount || 0).toLocaleString()} channels loaded
                          {(src.tamilCount || 0) > 0 && (
                            <span className="text-orange-400 ml-1">· {src.tamilCount} 🎬 Tamil</span>
                          )}
                        </span>
                      )}
                      {src.status === 'error' && (
                        <span className="flex items-center gap-1.5 text-red-400 text-xs">
                          <XCircle className="w-3 h-3" /> {src.errorMessage}
                        </span>
                      )}
                      {src.status === 'idle' && <span className="text-gray-600 text-xs">Not loaded yet</span>}
                      {src.lastRefreshed && (
                        <span className="flex items-center gap-1 text-gray-600 text-xs">
                          <Clock className="w-3 h-3" /> {new Date(src.lastRefreshed).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    {src.status === 'loading' && (
                      <div className="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full animate-pulse w-2/3" />
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {src.url && (
                    <button
                      onClick={() => { loadSource(src.id); toast.success('🔄 Refreshing source...'); }}
                      disabled={src.status === 'loading'}
                      title="Refresh"
                      className="p-2 text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-50 rounded-lg hover:bg-gray-700"
                    >
                      <RefreshCw className={`w-4 h-4 ${src.status === 'loading' ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                  <button onClick={() => startEdit(src)} title="Edit"
                    className="p-2 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => { deleteSource(src.id); toast.success('Source removed'); }} title="Delete"
                    className="p-2 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
