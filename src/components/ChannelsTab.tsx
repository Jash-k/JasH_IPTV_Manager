import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Channel } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Eye, EyeOff,
  Search, Shield, Play, Copy, Check, Star, Filter,
  Globe, Key, ChevronLeft, ChevronRight, Server
} from 'lucide-react';
import toast from 'react-hot-toast';

const STREAM_TYPE_COLORS: Record<string, string> = {
  hls: 'bg-green-900/40 text-green-400 border-green-800/30',
  dash: 'bg-blue-900/40 text-blue-400 border-blue-800/30',
  direct: 'bg-gray-700 text-gray-400 border-gray-600',
};

const emptyForm = {
  name: '', url: '', group: 'Uncategorized', logo: '',
  tvgId: '', tvgName: '', language: '', country: '',
  isDrm: false, drmKeyId: '', drmKey: '', licenseType: 'clearkey',
  licenseKey: '', userAgent: '', referer: '', isActive: true,
};

export default function ChannelsTab() {
  const {
    channels, groups, showTamilOnly, searchQuery, selectedGroup,
    setShowTamilOnly, setSearchQuery, setSelectedGroup, serverUrl,
    addChannel, updateChannel, deleteChannel, toggleChannel,
    getFilteredChannels,
  } = useStore();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [form, setForm] = useState(emptyForm);

  const filtered = getFilteredChannels();
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const tamilCount = channels.filter(c => c.isTamil).length;
  const drmCount = channels.filter(c => c.isDrm).length;

  const resetForm = () => { setForm(emptyForm); setEditId(null); setShowAdd(false); };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.url.trim()) { toast.error('Name and URL required'); return; }
    const channelData: Partial<Channel> = {
      name: form.name, url: form.url, group: form.group, logo: form.logo || undefined,
      tvgId: form.tvgId || undefined, tvgName: form.tvgName || undefined,
      language: form.language || undefined, country: form.country || undefined,
      isDrm: form.isDrm,
      drmKeyId: form.isDrm ? form.drmKeyId : undefined,
      drmKey: form.isDrm ? form.drmKey : undefined,
      licenseType: form.isDrm ? form.licenseType : undefined,
      licenseKey: form.isDrm ? form.licenseKey : undefined,
      userAgent: form.userAgent || undefined,
      referer: form.referer || undefined,
      isActive: form.isActive,
    };
    if (editId) {
      updateChannel(editId, channelData);
      toast.success('Channel updated & synced');
    } else {
      addChannel({ ...(channelData as Omit<Channel, 'id'>), order: channels.length, sourceId: 'manual' });
      toast.success('Channel added & synced');
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

  const copyProxyUrl = (ch: Channel, id: string) => {
    const url = ch.isDrm ? `${serverUrl}/proxy/drm/${ch.id}` : `${serverUrl}/proxy/redirect/${ch.id}`;
    navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Proxy URL copied!');
  };

  const formFields = [
    { label: 'Channel Name *', key: 'name', placeholder: 'Sun TV' },
    { label: 'Stream URL *', key: 'url', placeholder: 'http://stream.url/live.m3u8' },
    { label: 'Logo URL', key: 'logo', placeholder: 'https://logo.url/img.png' },
    { label: 'EPG ID (tvg-id)', key: 'tvgId', placeholder: 'suntv.in' },
    { label: 'TVG Name', key: 'tvgName', placeholder: 'Sun TV' },
    { label: 'Language', key: 'language', placeholder: 'Tamil' },
    { label: 'Country', key: 'country', placeholder: 'IN' },
    { label: 'User-Agent', key: 'userAgent', placeholder: 'Mozilla/5.0...' },
    { label: 'Referer', key: 'referer', placeholder: 'https://...' },
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
        <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> Add Channel
        </button>
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

        {/* Tamil Filter Button */}
        <button
          onClick={() => { setShowTamilOnly(!showTamilOnly); setPage(1); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all border ${
            showTamilOnly
              ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30 scale-105'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-orange-400 hover:border-orange-600'
          }`}
        >
          <Star className={`w-4 h-4 ${showTamilOnly ? 'fill-white' : ''}`} />
          🎬 Tamil Filter
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${showTamilOnly ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
            {tamilCount}
          </span>
        </button>

        <button onClick={() => { setSelectedGroup(null); setSearchQuery(''); setShowTamilOnly(false); setPage(1); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors">
          <Filter className="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      {/* Tamil Banner */}
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
                  </select>
                </div>
                <div>
                  <label className="text-gray-400 text-sm mb-1 block">License URL / kid:key String</label>
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
          <p className="text-sm mt-1">{channels.length === 0 ? 'Add a source in the Sources tab to import channels' : 'Try adjusting search or filters'}</p>
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
                  <th className="text-left text-gray-400 px-4 py-3 font-medium hidden xl:table-cell">Proxy URL</th>
                  <th className="text-right text-gray-400 px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/40">
                {paginated.map((ch, idx) => (
                  <tr key={ch.id} className={`hover:bg-gray-700/30 transition-colors ${!ch.isActive ? 'opacity-40' : ''}`}>
                    <td className="px-4 py-3 text-gray-600 text-xs">{(page - 1) * PAGE_SIZE + idx + 1}</td>
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
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-xs bg-gray-700/60 text-gray-300 px-2 py-1 rounded-full border border-gray-600/50">{ch.group}</span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {ch.streamType && (
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-mono uppercase ${STREAM_TYPE_COLORS[ch.streamType] || ''}`}>
                          {ch.streamType}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell max-w-xs">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <Server className="w-3 h-3 text-gray-600 shrink-0" />
                          <span className="text-gray-500 text-xs truncate font-mono">
                            {ch.isDrm ? `/proxy/drm/${ch.id.slice(0, 8)}...` : `/proxy/redirect/${ch.id.slice(0, 8)}...`}
                          </span>
                        </div>
                        <button onClick={() => copyProxyUrl(ch, ch.id)} className="shrink-0 text-gray-600 hover:text-white transition-colors">
                          {copied === ch.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5">
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
