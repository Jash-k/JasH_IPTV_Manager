import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Channel } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Eye, EyeOff,
  Search, Shield, Play, Copy, Check, Star, Filter,
  Globe, Key, ChevronLeft, ChevronRight, Server,
  Activity, Wifi, WifiOff, Loader, ArrowUpRight,
} from 'lucide-react';
import toast from 'react-hot-toast';

const STREAM_TYPE_COLORS: Record<string, string> = {
  hls:    'bg-green-900/40 text-green-400 border-green-800/30',
  dash:   'bg-blue-900/40  text-blue-400  border-blue-800/30',
  direct: 'bg-gray-700    text-gray-400  border-gray-600',
};

const emptyForm = {
  name: '', url: '', group: 'Uncategorized', logo: '',
  tvgId: '', tvgName: '', language: '', country: '',
  isDrm: false, drmKeyId: '', drmKey: '', licenseType: 'clearkey',
  licenseKey: '', userAgent: '', referer: '', isActive: true,
};

type HealthState = { ok: boolean; status: number; latency: number; error?: string };

export default function ChannelsTab() {
  const {
    channels, groups, showTamilOnly, searchQuery, selectedGroup,
    setShowTamilOnly, setSearchQuery, setSelectedGroup, serverUrl,
    addChannel, updateChannel, deleteChannel, toggleChannel,
    getFilteredChannels,
  } = useStore();

  const [showAdd,  setShowAdd]  = useState(false);
  const [editId,   setEditId]   = useState<string | null>(null);
  const [copied,   setCopied]   = useState<string | null>(null);
  const [page,     setPage]     = useState(1);
  const [form,     setForm]     = useState(emptyForm);
  const [healthMap,   setHealthMap]   = useState<Record<string, HealthState>>({});
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());

  const PAGE_SIZE  = 50;
  const filtered   = getFilteredChannels();
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const tamilCount = channels.filter(c => c.isTamil).length;
  const drmCount   = channels.filter(c => c.isDrm || !!c.licenseType).length;

  const resetForm = () => { setForm(emptyForm); setEditId(null); setShowAdd(false); };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.url.trim()) { toast.error('Name and URL required'); return; }
    const channelData: Partial<Channel> = {
      name:        form.name,
      url:         form.url,
      group:       form.group,
      logo:        form.logo   || undefined,
      tvgId:       form.tvgId  || undefined,
      tvgName:     form.tvgName || undefined,
      language:    form.language || undefined,
      country:     form.country  || undefined,
      isDrm:       form.isDrm,
      drmKeyId:    form.isDrm ? form.drmKeyId   : undefined,
      drmKey:      form.isDrm ? form.drmKey      : undefined,
      licenseType: form.isDrm ? form.licenseType : undefined,
      licenseKey:  form.isDrm ? form.licenseKey  : undefined,
      userAgent:   form.userAgent || undefined,
      referer:     form.referer   || undefined,
      isActive:    form.isActive,
    };
    if (editId) {
      updateChannel(editId, channelData);
      toast.success('✅ Channel updated & synced');
    } else {
      addChannel({ ...(channelData as Omit<Channel, 'id'>), order: channels.length, sourceId: 'manual' });
      toast.success('✅ Channel added & synced');
    }
    resetForm();
  };

  const startEdit = (ch: Channel) => {
    setForm({
      name: ch.name, url: ch.url, group: ch.group, logo: ch.logo || '',
      tvgId: ch.tvgId || '', tvgName: ch.tvgName || '',
      language: ch.language || '', country: ch.country || '',
      isDrm: ch.isDrm || false, drmKeyId: ch.drmKeyId || '',
      drmKey: ch.drmKey || '', licenseType: ch.licenseType || 'clearkey',
      licenseKey: ch.licenseKey || '', userAgent: ch.userAgent || '',
      referer: ch.referer || '', isActive: ch.isActive,
    });
    setEditId(ch.id);
    setShowAdd(true);
  };

  // ── Smart URL resolver (mirrors server routing logic exactly) ──────────────
  const resolveStreamUrl = (ch: Channel): { url: string; label: string; isDrm: boolean } => {
    const base     = serverUrl || window.location.origin;
    const hasDRM   = !!(ch.isDrm || ch.licenseType || ch.licenseKey);
    const urlLower = (ch.url || '').toLowerCase();

    if (hasDRM) {
      if (urlLower.includes('.mpd') || urlLower.includes('/dash/') || urlLower.includes('manifest.mpd'))
        return { url: `${base}/live/${ch.id}.mpd`, label: 'DRM DASH', isDrm: true };
      if (urlLower.includes('.m3u8') || urlLower.includes('/hls/'))
        return { url: `${base}/live/${ch.id}.m3u8`, label: 'DRM HLS', isDrm: true };
      return { url: `${base}/live/${ch.id}.ts`, label: 'DRM TS', isDrm: true };
    }

    // Direct → 302 redirect endpoint
    return { url: `${base}/proxy/redirect/${ch.id}`, label: '302 Direct', isDrm: false };
  };

  const copyProxyUrl = (ch: Channel) => {
    const { url } = resolveStreamUrl(ch);
    navigator.clipboard.writeText(url);
    setCopied(ch.id);
    setTimeout(() => setCopied(null), 2000);
    toast.success(ch.isDrm ? '🔐 DRM proxy URL copied!' : '✅ Redirect URL copied!');
  };

  // ── Per-channel health check ──────────────────────────────────────────────
  const checkHealth = async (ch: Channel) => {
    const base = serverUrl || window.location.origin;
    setCheckingIds(s => new Set(s).add(ch.id));
    try {
      const resp = await fetch(`${base}/api/health/${ch.id}`, { signal: AbortSignal.timeout(12000) });
      if (resp.ok) {
        const data = await resp.json() as HealthState;
        setHealthMap(m => ({ ...m, [ch.id]: data }));
        toast.success(data.ok
          ? `✅ ${ch.name} — Live (${data.latency}ms)`
          : `❌ ${ch.name} — Error ${data.status}`);
      } else {
        setHealthMap(m => ({ ...m, [ch.id]: { ok: false, status: resp.status, latency: 0, error: `HTTP ${resp.status}` } }));
      }
    } catch (e) {
      setHealthMap(m => ({ ...m, [ch.id]: { ok: false, status: 0, latency: 0, error: 'timeout / unreachable' } }));
      toast.error('Health check failed — is server running?');
    } finally {
      setCheckingIds(s => { const n = new Set(s); n.delete(ch.id); return n; });
    }
  };

  // Batch health check for visible page
  const checkPageHealth = async () => {
    const base = serverUrl || window.location.origin;
    const ids  = paginated.map(c => c.id);
    ids.forEach(id => setCheckingIds(s => new Set(s).add(id)));
    try {
      const resp = await fetch(`${base}/api/health/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) {
        const data = await resp.json() as { results: Record<string, HealthState> };
        setHealthMap(m => ({ ...m, ...data.results }));
        const ok = Object.values(data.results).filter((r) => r.ok).length;
        toast.success(`🏥 Health: ${ok}/${ids.length} channels live`);
      }
    } catch {
      toast.error('Batch health check failed');
    } finally {
      ids.forEach(id => setCheckingIds(s => { const n = new Set(s); n.delete(id); return n; }));
    }
  };

  const formFields = [
    { label: 'Channel Name *', key: 'name',      placeholder: 'Sun TV' },
    { label: 'Stream URL *',   key: 'url',       placeholder: 'http://stream.url/live.m3u8' },
    { label: 'Logo URL',       key: 'logo',      placeholder: 'https://logo.url/img.png' },
    { label: 'EPG ID',         key: 'tvgId',     placeholder: 'suntv.in' },
    { label: 'TVG Name',       key: 'tvgName',   placeholder: 'Sun TV' },
    { label: 'Language',       key: 'language',  placeholder: 'Tamil' },
    { label: 'Country',        key: 'country',   placeholder: 'IN' },
    { label: 'User-Agent',     key: 'userAgent', placeholder: 'Mozilla/5.0...' },
    { label: 'Referer',        key: 'referer',   placeholder: 'https://...' },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Channels</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {filtered.length} shown · {channels.length} total · {tamilCount} 🎬 Tamil · {drmCount} 🔐 DRM
          </p>
        </div>
        <div className="flex gap-2">
          {paginated.length > 0 && (
            <button
              onClick={checkPageHealth}
              className="flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Activity className="w-4 h-4" /> Check Health
            </button>
          )}
          <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Add Channel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="Search channels, groups, EPG IDs..." />
        </div>

        <select value={selectedGroup || ''} onChange={e => { setSelectedGroup(e.target.value || null); setPage(1); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
          <option value="">All Groups</option>
          {groups.map(g => (
            <option key={g.id} value={g.name}>{g.isTamil ? '🎬 ' : ''}{g.name} ({g.channelCount || 0})</option>
          ))}
        </select>

        {/* 🎬 Tamil Filter Button */}
        <button
          onClick={() => { setShowTamilOnly(!showTamilOnly); setPage(1); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all border ${
            showTamilOnly
              ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30 scale-105'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-orange-400 hover:border-orange-600'
          }`}
        >
          <Star className={`w-4 h-4 ${showTamilOnly ? 'fill-white' : ''}`} />
          🎬 Tamil
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${showTamilOnly ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
            {tamilCount}
          </span>
        </button>

        <button onClick={() => { setSelectedGroup(null); setSearchQuery(''); setShowTamilOnly(false); setPage(1); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors">
          <Filter className="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      {/* Tamil banner */}
      {showTamilOnly && (
        <div className="flex items-center gap-3 px-4 py-3 bg-orange-500/10 border border-orange-500/30 rounded-xl">
          <Star className="w-5 h-5 text-orange-400 fill-orange-400 shrink-0" />
          <div>
            <p className="text-orange-300 font-medium text-sm">Tamil Channels Filter Active</p>
            <p className="text-orange-500 text-xs">
              Showing {filtered.length} Tamil channels — Sun TV, Star Vijay, Zee Tamil, Polimer, Kalaignar, Colors Tamil, Jaya, Raj TV & more
            </p>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold">{editId ? 'Edit Channel' : 'Add Channel'}</h3>
            <button onClick={resetForm} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {formFields.map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="text-gray-400 text-sm mb-1 block">{label}</label>
                <input
                  value={(form as Record<string, unknown>)[key] as string}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                  placeholder={placeholder}
                />
              </div>
            ))}
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Group</label>
              <select value={form.group} onChange={e => setForm(f => ({ ...f, group: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                <option value="Uncategorized">Uncategorized</option>
                {groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
              </select>
            </div>
          </div>

          {/* DRM Section */}
          <div className="space-y-3 p-4 bg-gray-900/60 border border-gray-700/60 rounded-lg">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isDrm} onChange={e => setForm(f => ({ ...f, isDrm: e.target.checked }))} className="w-4 h-4 accent-purple-500" />
              <span className="text-gray-300 text-sm flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-purple-400" /> DRM Protected Stream
              </span>
            </label>
            {form.isDrm && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="text-gray-400 text-sm mb-1 block flex items-center gap-1"><Key className="w-3 h-3" /> License Type</label>
                  <select value={form.licenseType} onChange={e => setForm(f => ({ ...f, licenseType: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500">
                    <option value="clearkey">ClearKey</option>
                    <option value="widevine">Widevine</option>
                    <option value="playready">PlayReady</option>
                    <option value="fairplay">FairPlay</option>
                  </select>
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-1 block">License URL / kid:key</label>
                  <input value={form.licenseKey} onChange={e => setForm(f => ({ ...f, licenseKey: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                    placeholder="https://license.url or kid:key" />
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-1 block">Key ID (KID)</label>
                  <input value={form.drmKeyId} onChange={e => setForm(f => ({ ...f, drmKeyId: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                    placeholder="Key ID (hex)" />
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-1 block">Decryption Key</label>
                  <input value={form.drmKey} onChange={e => setForm(f => ({ ...f, drmKey: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                    placeholder="Key (hex)" />
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={resetForm} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
            <button onClick={handleSubmit}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Save className="w-4 h-4" /> {editId ? 'Update' : 'Add Channel'}
            </button>
          </div>
        </div>
      )}

      {/* Channels Table */}
      {paginated.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Play className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-lg text-gray-400">{channels.length === 0 ? 'No channels loaded' : 'No channels match your filter'}</p>
          <p className="text-sm mt-1">{channels.length === 0 ? 'Add a source in the Sources tab' : 'Try adjusting search or filters'}</p>
        </div>
      ) : (
        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-900 border-b border-gray-700">
                <tr>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium w-10">#</th>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium">Channel</th>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium hidden md:table-cell">Group</th>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium hidden lg:table-cell">Type</th>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium hidden xl:table-cell">Routing</th>
                  <th className="text-left text-gray-400 px-4 py-3 font-medium hidden xl:table-cell">Health</th>
                  <th className="text-right text-gray-400 px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/40">
                {paginated.map((ch, idx) => {
                  const resolved  = resolveStreamUrl(ch);
                  const health    = healthMap[ch.id];
                  const checking  = checkingIds.has(ch.id);

                  return (
                    <tr key={ch.id} className={`hover:bg-gray-700/30 transition-colors ${!ch.isActive ? 'opacity-40' : ''}`}>
                      <td className="px-4 py-3 text-gray-600 text-xs">{(page - 1) * PAGE_SIZE + idx + 1}</td>

                      {/* Channel name + badges */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {ch.logo ? (
                            <img src={ch.logo} alt="" className="w-9 h-6 object-contain rounded bg-gray-700 p-0.5"
                              onError={e => (e.currentTarget.style.display = 'none')} />
                          ) : (
                            <div className="w-9 h-6 bg-gray-700 rounded flex items-center justify-center">
                              <Globe className="w-3 h-3 text-gray-500" />
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-white font-medium text-sm">{ch.name}</span>
                              {ch.isDrm && <span title="DRM Protected"><Shield className="w-3 h-3 text-purple-400 shrink-0" /></span>}
                              {ch.isTamil && (
                                <span className="text-xs bg-orange-500/20 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                                  <Star className="w-2.5 h-2.5 fill-orange-400" /> Tamil
                                </span>
                              )}
                            </div>
                            {ch.tvgId && <span className="text-gray-600 text-xs font-mono">{ch.tvgId}</span>}
                          </div>
                        </div>
                      </td>

                      {/* Group */}
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs bg-gray-700/60 text-gray-300 px-2 py-1 rounded-full border border-gray-600/50">{ch.group}</span>
                      </td>

                      {/* Stream type */}
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {ch.streamType && (
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-mono uppercase ${STREAM_TYPE_COLORS[ch.streamType] || ''}`}>
                            {ch.streamType}
                          </span>
                        )}
                      </td>

                      {/* Routing — shows DRM vs Direct */}
                      <td className="px-4 py-3 hidden xl:table-cell max-w-[200px]">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-mono ${
                            resolved.isDrm
                              ? 'bg-purple-900/40 text-purple-400 border-purple-800/30'
                              : 'bg-green-900/30 text-green-400 border-green-800/30'
                          }`}>
                            {resolved.isDrm ? '🔐 ' : '🔁 '}{resolved.label}
                          </span>
                          <button onClick={() => copyProxyUrl(ch)} className="text-gray-600 hover:text-white transition-colors shrink-0" title="Copy stream URL">
                            {copied === ch.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                          </button>
                          <a href={resolved.url} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-blue-400 transition-colors shrink-0" title="Open URL">
                            <ArrowUpRight className="w-3 h-3" />
                          </a>
                        </div>
                      </td>

                      {/* Health status */}
                      <td className="px-4 py-3 hidden xl:table-cell">
                        {checking ? (
                          <span className="flex items-center gap-1 text-xs text-yellow-400">
                            <Loader className="w-3 h-3 animate-spin" /> Checking
                          </span>
                        ) : health ? (
                          <span className={`flex items-center gap-1 text-xs ${health.ok ? 'text-green-400' : 'text-red-400'}`}>
                            {health.ok
                              ? <><Wifi className="w-3 h-3" /> {health.latency}ms</>
                              : <><WifiOff className="w-3 h-3" /> {health.error || `HTTP ${health.status}`}</>
                            }
                          </span>
                        ) : (
                          <button
                            onClick={() => checkHealth(ch)}
                            className="flex items-center gap-1 text-xs text-gray-600 hover:text-green-400 transition-colors"
                            title="Check health"
                          >
                            <Activity className="w-3 h-3" /> Check
                          </button>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          {/* Health check button (mobile) */}
                          <button
                            onClick={() => checkHealth(ch)}
                            disabled={checking}
                            className="p-1.5 text-gray-400 hover:text-green-400 transition-colors rounded hover:bg-gray-700 xl:hidden"
                            title="Check health"
                          >
                            {checking
                              ? <Loader className="w-3.5 h-3.5 animate-spin text-yellow-400" />
                              : <Activity className="w-3.5 h-3.5" />
                            }
                          </button>
                          <button onClick={() => toggleChannel(ch.id)}
                            className="p-1.5 text-gray-400 hover:text-white transition-colors rounded hover:bg-gray-700"
                            title={ch.isActive ? 'Disable' : 'Enable'}>
                            {ch.isActive ? <Eye className="w-3.5 h-3.5 text-green-400" /> : <EyeOff className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => startEdit(ch)} className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded hover:bg-gray-700">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => { deleteChannel(ch.id); toast.success('Channel deleted'); }}
                            className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded hover:bg-gray-700">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => copyProxyUrl(ch)} className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors rounded hover:bg-gray-700 xl:hidden" title="Copy URL">
                            {copied === ch.id ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Server className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700 bg-gray-900/50">
              <span className="text-gray-400 text-sm">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="p-1.5 bg-gray-700 text-white rounded disabled:opacity-30 hover:bg-gray-600 transition-colors">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-gray-400 text-sm px-2">{page} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-1.5 bg-gray-700 text-white rounded disabled:opacity-30 hover:bg-gray-600 transition-colors">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
