import React, { useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { Source } from '../types';
import {
  Plus, Trash2, RefreshCw, Upload, Link, CheckCircle, XCircle,
  Clock, Edit2, Save, X, FileJson, FileText, Globe, Timer,
  AlertCircle, Zap, Heart, Activity,
  ExternalLink, Copy, Check, Wifi, WifiOff, Loader,
  ShieldOff, GitMerge, FolderHeart, UserMinus,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { detectFormat } from '../utils/universalParser';

const SOURCE_TYPE_ICONS: Record<string, React.ReactNode> = {
  m3u:  <FileText className="w-4 h-4 text-green-400" />,
  json: <FileJson className="w-4 h-4 text-yellow-400" />,
  php:  <Globe    className="w-4 h-4 text-blue-400" />,
  url:  <Link     className="w-4 h-4 text-purple-400" />,
  file: <Upload   className="w-4 h-4 text-pink-400" />,
};

const EXAMPLE_URLS = [
  { label: '🇮🇳 India IPTV',  url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/in.m3u', type: 'm3u' as const },
  { label: '🌐 World IPTV',   url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/index.m3u',     type: 'm3u' as const },
];

type FormState = {
  name: string; url: string; type: Source['type'];
  autoRefresh: boolean; refreshInterval: number;
};

// ── Per-source Tamil filter button ────────────────────────────────────────────
function TamilBtn({
  sourceId, tamilCount, isActive, onToggle,
}: {
  sourceId: string;
  tamilCount: number;
  isActive?: boolean;
  onToggle: (id: string, val: boolean) => void;
}) {
  if (tamilCount === 0) return null;
  return (
    <button
      onClick={e => { e.stopPropagation(); onToggle(sourceId, !isActive); }}
      title={isActive ? 'Tamil filter ON — click to show all' : `Show only ${tamilCount} Tamil channels`}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold
        transition-all border select-none ${
        isActive
          ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/40 scale-105 ring-2 ring-orange-400/40'
          : 'bg-orange-500/10 border-orange-500/40 text-orange-400 hover:bg-orange-500/20 hover:border-orange-400 hover:scale-105'
      }`}
    >
      <Heart className={`w-3.5 h-3.5 ${isActive ? 'fill-white' : 'fill-orange-400'}`} />
      {isActive
        ? <span>🎬 Tamil <span className="bg-white/20 px-1 rounded">{tamilCount}</span></span>
        : <span>🎬 Tamil ({tamilCount})</span>
      }
    </button>
  );
}

// ── Health badge ──────────────────────────────────────────────────────────────
function HealthBadge({ status }: { status?: string }) {
  if (!status || status === 'unknown') return null;
  if (status === 'ok')       return <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded-full"><Wifi className="w-3 h-3" /> Live</span>;
  if (status === 'error')    return <span className="flex items-center gap-1 text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full"><WifiOff className="w-3 h-3" /> Error</span>;
  if (status === 'checking') return <span className="flex items-center gap-1 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full"><Loader className="w-3 h-3 animate-spin" /> Checking</span>;
  return null;
}

export default function SourcesTab() {
  const {
    sources, channels, addSource, deleteSource, loadSource, updateSource,
    tamilSourceFilter, setTamilSourceFilter, serverUrl, removeNonTamilFromSource,
  } = useStore();

  const [showAdd, setShowAdd]         = useState(false);
  const [editId, setEditId]           = useState<string | null>(null);
  const [form, setForm]               = useState<FormState>({ name: '', url: '', type: 'url', autoRefresh: false, refreshInterval: 30 });
  const [inputMode, setInputMode]     = useState<'url' | 'file'>('url');
  const [detectedFmt, setDetectedFmt] = useState('');
  const [copied, setCopied]           = useState<string | null>(null);
  const [healthChecking, setHealthChecking] = useState<Record<string, boolean>>({});

  const fileRef      = useRef<HTMLInputElement>(null);
  // Auto-refresh is handled globally in App.tsx

  const detectTypeFromUrl = (url: string): Source['type'] => {
    const u = url.toLowerCase();
    if (u.includes('.m3u') || u.includes('.m3u8')) return 'm3u';
    if (u.includes('.json'))  return 'json';
    if (u.includes('.php'))   return 'php';
    return 'url';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const content = ev.target?.result as string;
      const ext = file.name.split('.').pop()?.toLowerCase() || 'url';
      const detectedType: Source['type'] = ext === 'm3u' || ext === 'm3u8' ? 'm3u'
        : ext === 'json' ? 'json' : ext === 'php' ? 'php' : 'file';
      const fmt = detectFormat(content);
      setDetectedFmt(fmt);
      addSource({ name: form.name || file.name, type: detectedType, content, autoRefresh: false, refreshInterval: 30 });
      toast.success(`✅ ${file.name} — ${fmt.toUpperCase()} detected. DRM streams will be stripped.`);
      setShowAdd(false); resetForm();
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error('Name required'); return; }
    if (inputMode === 'url' && !form.url.trim()) { toast.error('URL required'); return; }
    if (editId) {
      updateSource(editId, { name: form.name, url: form.url, type: form.type, autoRefresh: form.autoRefresh, refreshInterval: form.refreshInterval });
      toast.success('Source updated'); setEditId(null);
    } else {
      addSource({ name: form.name, url: form.url, type: form.type, autoRefresh: form.autoRefresh, refreshInterval: form.refreshInterval });
      toast.success('🚀 Fetching & parsing... DRM streams auto-removed.');
    }
    resetForm();
  };

  const startEdit = (src: Source) => {
    setForm({ name: src.name, url: src.url || '', type: src.type, autoRefresh: src.autoRefresh, refreshInterval: src.refreshInterval });
    setEditId(src.id); setShowAdd(true); setInputMode('url');
  };

  const resetForm = () => {
    setForm({ name: '', url: '', type: 'url', autoRefresh: false, refreshInterval: 30 });
    setDetectedFmt(''); setEditId(null); setShowAdd(false);
  };

  const toggleTamilFilter = (sourceId: string, val: boolean) => {
    updateSource(sourceId, { tamilFilter: val });
    toast.success(val ? '🎬 Tamil filter ON for this source' : '🎬 Showing all channels', { duration: 1500 });
  };

  const copyUrl = (key: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
    toast.success('📋 Copied!');
  };

  const checkSourceHealth = async (srcId: string) => {
    const srcChannels = channels.filter(ch => ch.sourceId === srcId).slice(0, 10);
    if (!srcChannels.length) { toast.error('No channels to check'); return; }
    setHealthChecking(h => ({ ...h, [srcId]: true }));
    updateSource(srcId, { healthStatus: 'checking' });
    try {
      const base = serverUrl || window.location.origin;
      const resp = await fetch(`${base}/api/health/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: srcChannels.map(c => c.id) }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) {
        const data = await resp.json() as { results: Record<string, { ok: boolean }> };
        const okCount = Object.values(data.results || {}).filter(r => r.ok).length;
        updateSource(srcId, { healthStatus: okCount > 0 ? 'ok' : 'error' });
        toast.success(`🏥 ${okCount}/${srcChannels.length} channels live`);
      } else {
        updateSource(srcId, { healthStatus: 'error' });
        toast.error('Health check failed');
      }
    } catch {
      updateSource(srcId, { healthStatus: 'error' });
      toast.error('Health check error — is server running?');
    } finally {
      setHealthChecking(h => { const n = { ...h }; delete n[srcId]; return n; });
    }
  };

  // Enrich sources with stats
  const enriched = sources.map(src => {
    const srcChs   = channels.filter(ch => ch.sourceId === src.id);
    const tamilCnt = srcChs.filter(ch => ch.isTamil).length;
    const multiCnt = srcChs.filter(ch => ch.multiSource).length;
    return { ...src, tamilCount: tamilCnt, totalCount: srcChs.length, multiCount: multiCnt };
  });

  const displayed = tamilSourceFilter
    ? enriched.filter(s => s.tamilCount > 0)
    : enriched;

  const totalTamil    = channels.filter(ch => ch.isTamil).length;
  const totalChannels = channels.length;
  const base          = serverUrl || window.location.origin;
  const tamilSrcCount = enriched.filter(s => s.tamilCount > 0).length;

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Playlist Sources</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {sources.length} sources · {totalChannels.toLocaleString()} channels
            {totalTamil > 0 && <span className="text-orange-400"> · {totalTamil.toLocaleString()} 🎬 Tamil</span>}
            <span className="text-green-400"> · Direct 302 only</span>
            <span className="text-red-400"> · DRM auto-stripped</span>
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditId(null); setDetectedFmt(''); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-blue-600/20"
        >
          <Plus className="w-4 h-4" /> Add Source
        </button>
      </div>

      {/* ── Info banner ── */}
      <div className="bg-gray-800/60 border border-gray-700/60 rounded-xl p-4 flex items-start gap-3">
        <ShieldOff className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="text-white text-sm font-medium">
            🔁 Direct 302 Redirect — No Proxy — DRM Auto-Stripped
          </p>
          <p className="text-gray-400 text-xs leading-relaxed">
            All streams served as pure <span className="text-green-300 font-semibold">302 redirects</span> to original URLs — zero server overhead.
            DRM-protected streams (Widevine, ClearKey, PlayReady) are{' '}
            <span className="text-red-300 font-semibold">automatically removed</span> when sources are imported.
            Supports <span className="text-green-400 font-mono">.m3u/.m3u8</span>,{' '}
            <span className="text-yellow-400 font-mono">.json</span> (JioTV, generic),{' '}
            <span className="text-blue-400 font-mono">.php/API</span>, GitHub raw, Pastebin.
            Tamil channels auto-detected from name/group.
          </p>
        </div>
      </div>

      {/* ── Global Tamil sources filter ── */}
      {tamilSrcCount > 0 && (
        <div className="flex items-center gap-3 flex-wrap bg-orange-500/5 border border-orange-500/20 rounded-xl px-4 py-3">
          <Heart className="w-4 h-4 text-orange-400 fill-orange-400 shrink-0" />
          <span className="text-orange-300 text-sm font-medium">
            {tamilSrcCount} sources contain Tamil channels
          </span>
          <button
            onClick={() => setTamilSourceFilter(!tamilSourceFilter)}
            className={`ml-auto flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-semibold transition-all border ${
              tamilSourceFilter
                ? 'bg-orange-500 border-orange-400 text-white'
                : 'bg-gray-800 border-gray-600 text-gray-300 hover:border-orange-500 hover:text-orange-400'
            }`}
          >
            {tamilSourceFilter ? '✓ Tamil Sources Only' : 'Show Tamil Sources Only'}
          </button>
          {tamilSourceFilter && (
            <button
              onClick={() => setTamilSourceFilter(false)}
              className="text-gray-500 hover:text-white text-xs transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* ── Add/Edit form ── */}
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
              <input value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="My IPTV Source" />
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Format</label>
              <select value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as Source['type'] }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
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
              <input value={form.url}
                onChange={e => { const url = e.target.value; setForm(f => ({ ...f, url, type: detectTypeFromUrl(url) })); }}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="https://raw.githubusercontent.com/... or http://server.com/playlist.m3u" />
              <p className="text-gray-500 text-xs mt-1.5 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> GitHub raw, Pastebin, direct M3U/JSON/PHP URLs. CORS handled server-side.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {EXAMPLE_URLS.map(ex => (
                  <button key={ex.url}
                    onClick={() => setForm(f => ({ ...f, url: ex.url, name: f.name || ex.label, type: ex.type }))}
                    className="text-xs bg-gray-700 hover:bg-gray-600 text-blue-400 px-2 py-1 rounded-md transition-colors">
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
                className="border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-lg p-8 text-center cursor-pointer transition-colors group">
                <Upload className="w-10 h-10 text-gray-500 group-hover:text-blue-400 mx-auto mb-3 transition-colors" />
                <p className="text-gray-400 text-sm">Click to upload playlist file</p>
                <p className="text-gray-600 text-xs mt-1">.m3u · .m3u8 · .json · .php · .txt</p>
                <input ref={fileRef} type="file" className="hidden" accept=".m3u,.m3u8,.json,.php,.txt" onChange={handleFileUpload} />
              </div>
              {detectedFmt && (
                <p className="text-green-400 text-xs mt-2 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" /> Detected: {detectedFmt.toUpperCase()}
                </p>
              )}
            </div>
          )}

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

      {/* ── Source list ── */}
      {displayed.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Globe className="w-14 h-14 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium text-gray-400 mb-2">
            {tamilSourceFilter ? 'No Tamil sources found' : 'No sources added yet'}
          </p>
          <p className="text-sm">{tamilSourceFilter ? 'Add sources with Tamil channels' : 'Add a playlist URL or upload a file'}</p>
          {!tamilSourceFilter && (
            <button onClick={() => setShowAdd(true)}
              className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> Add Your First Source
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {displayed.map(src => (
            <div key={src.id}
              className={`bg-gray-800 border rounded-xl transition-all ${
                src.status === 'error'  ? 'border-red-800/50' :
                src.tamilFilter         ? 'border-orange-500/60 shadow-lg shadow-orange-500/10' :
                                         'border-gray-700 hover:border-gray-600'
              }`}>

              <div className="flex items-start justify-between gap-3 p-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {/* Icon */}
                  <div className="mt-0.5 p-2 bg-gray-700/50 rounded-lg shrink-0">
                    {SOURCE_TYPE_ICONS[src.type] || <Globe className="w-4 h-4 text-gray-400" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Name + badges row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-white font-medium">{src.name}</h3>
                      <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full uppercase font-mono">{src.type}</span>
                      {src.autoRefresh && (
                        <span className="text-xs bg-blue-900/50 text-blue-400 border border-blue-800/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Timer className="w-3 h-3" /> {src.refreshInterval}m
                        </span>
                      )}
                      <HealthBadge status={src.healthStatus} />
                    </div>

                    {src.url && <p className="text-gray-500 text-xs mt-1 truncate font-mono">{src.url}</p>}
                    {src.content && !src.url && (
                      <p className="text-gray-500 text-xs mt-1 italic">Local file · {(src.content.length / 1024).toFixed(1)} KB</p>
                    )}

                    {/* Status */}
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      {src.status === 'loading' && (
                        <span className="flex items-center gap-1.5 text-yellow-400 text-xs">
                          <RefreshCw className="w-3 h-3 animate-spin" /> Fetching & parsing...
                        </span>
                      )}
                      {src.status === 'success' && (
                        <span className="flex items-center gap-1.5 text-green-400 text-xs">
                          <CheckCircle className="w-3 h-3" /> {(src.totalCount || 0).toLocaleString()} direct channels
                          {(src.tamilCount || 0) > 0 && (
                            <span className="text-orange-400 ml-1">· {src.tamilCount} 🎬 Tamil</span>
                          )}
                          {(src.multiCount || 0) > 0 && (
                            <span className="text-blue-400 ml-1">· {src.multiCount} 🔀 multi</span>
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

                    {/* DRM strip notice */}
                    {src.status === 'success' && src.errorMessage && src.errorMessage.includes('DRM') && (
                      <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-lg w-fit">
                        <ShieldOff className="w-3 h-3 shrink-0" /> {src.errorMessage}
                      </div>
                    )}

                    {/* ── Controls row — visible after load ── */}
                    {src.status === 'success' && (src.totalCount || 0) > 0 && (
                      <div className="mt-3 flex items-center gap-2 flex-wrap">

                        {/* 🎬 TAMIL FILTER — prominent per-source button */}
                        <TamilBtn
                          sourceId={src.id}
                          tamilCount={src.tamilCount || 0}
                          isActive={src.tamilFilter}
                          onToggle={toggleTamilFilter}
                        />

                        {/* Multi-source indicator */}
                        {(src.multiCount || 0) > 0 && (
                          <span className="flex items-center gap-1 text-xs bg-blue-500/10 border border-blue-500/20 text-blue-400 px-2 py-1 rounded-lg">
                            <GitMerge className="w-3 h-3" /> {src.multiCount} multi-source
                          </span>
                        )}

                        {/* Playlist URL */}
                        <button
                          onClick={() => copyUrl(src.id, `${base}/api/playlist/source/${src.id}.m3u`)}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-colors"
                        >
                          {copied === src.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                          Playlist URL
                        </button>

                        {/* Tamil playlist URL */}
                        {(src.tamilCount || 0) > 0 && (
                          <button
                            onClick={() => copyUrl(src.id + '_t', `${base}/api/playlist/source/${src.id}/tamil.m3u`)}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-orange-500/10 border border-orange-500/20 text-orange-400 hover:bg-orange-500/20 transition-colors"
                          >
                            {copied === src.id + '_t' ? <Check className="w-3 h-3 text-green-400" /> : <ExternalLink className="w-3 h-3" />}
                            Tamil URL
                          </button>
                        )}

                        {/* Health check */}
                        <button
                          onClick={() => checkSourceHealth(src.id)}
                          disabled={healthChecking[src.id]}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-50"
                        >
                          {healthChecking[src.id] ? <Loader className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
                          {healthChecking[src.id] ? 'Checking...' : 'Check Health'}
                        </button>
                      </div>
                    )}

                    {/* Tamil filter active banner + Remove Others */}
                    {src.tamilFilter && src.status === 'success' && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/30 rounded-lg px-3 py-2">
                          <FolderHeart className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-orange-300 text-xs font-semibold block">
                              📁 {src.name} — Tamil folder active
                            </span>
                            <span className="text-orange-400/70 text-xs">
                              {src.tamilCount} Tamil channels shown in playlist · {(src.totalCount || 0) - (src.tamilCount || 0)} other channels hidden
                            </span>
                          </div>
                          <button
                            onClick={() => toggleTamilFilter(src.id, false)}
                            className="text-orange-400/60 hover:text-orange-400 transition-colors shrink-0"
                            title="Turn off Tamil filter"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {/* Remove Others button */}
                        {((src.totalCount || 0) - (src.tamilCount || 0)) > 0 && (
                          <button
                            onClick={() => {
                              const nonTamilCount = (src.totalCount || 0) - (src.tamilCount || 0);
                              if (!confirm(`Remove ${nonTamilCount} non-Tamil channels from "${src.name}"?\n\nOnly ${src.tamilCount} Tamil channels will remain.\nEmpty groups will be auto-deleted.`)) return;
                              const removed = removeNonTamilFromSource(src.id);
                              toast.success(`🗑️ Removed ${removed} non-Tamil channels. Empty groups deleted.`);
                              updateSource(src.id, { channelCount: src.tamilCount });
                            }}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-400 rounded-lg text-xs font-semibold transition-all"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                            Remove {(src.totalCount || 0) - (src.tamilCount || 0)} Non-Tamil Channels from this source
                            <span className="bg-red-500/20 px-1.5 py-0.5 rounded text-red-300">
                              Keep only {src.tamilCount} Tamil channels
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  {/* Zap = quick Tamil toggle shortcut (visible if has Tamil channels) */}
                  {(src.tamilCount || 0) > 0 && (
                    <button
                      onClick={() => toggleTamilFilter(src.id, !src.tamilFilter)}
                      title={src.tamilFilter ? 'Tamil filter ON' : 'Enable Tamil filter'}
                      className={`p-2 rounded-lg transition-colors ${
                        src.tamilFilter
                          ? 'text-orange-400 bg-orange-500/10 hover:bg-orange-500/20'
                          : 'text-gray-500 hover:text-orange-400 hover:bg-gray-700'
                      }`}
                    >
                      <Zap className="w-4 h-4" />
                    </button>
                  )}
                  {src.url && (
                    <button
                      onClick={() => { loadSource(src.id); toast.success('🔄 Refreshing...'); }}
                      disabled={src.status === 'loading'}
                      title="Refresh source"
                      className="p-2 text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-50 rounded-lg hover:bg-gray-700"
                    >
                      <RefreshCw className={`w-4 h-4 ${src.status === 'loading' ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                  <button onClick={() => startEdit(src)} title="Edit"
                    className="p-2 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => { deleteSource(src.id); toast.success('Source removed'); }}
                    title="Delete"
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
