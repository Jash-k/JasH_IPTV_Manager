import { useState } from 'react';
import { useStore } from '../store/useStore';
import { DrmProxy } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Shield, Copy, Check,
  Key, Eye, EyeOff, AlertTriangle, Zap, Globe
} from 'lucide-react';
import toast from 'react-hot-toast';

const emptyForm = {
  channelId: '', channelName: '', keyId: '', key: '',
  licenseUrl: '', licenseType: 'clearkey', isActive: true, notes: '',
};

export default function DrmTab() {
  const { drmProxies, channels, addDrmProxy, updateDrmProxy, deleteDrmProxy, serverUrl } = useStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [copied, setCopied] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Copied!');
  };

  const toggleShowKey = (id: string) => setShowKeys(s => ({ ...s, [id]: !s[id] }));

  const handleSubmit = () => {
    if (!form.keyId && !form.licenseUrl) { toast.error('Key ID or License URL required'); return; }
    if (editId) {
      updateDrmProxy(editId, { ...form });
      toast.success('DRM proxy updated');
      setEditId(null);
    } else {
      const ch = channels.find(c => c.id === form.channelId);
      addDrmProxy({ ...form, channelName: ch?.name || form.channelName });
      toast.success('✅ DRM proxy created');
    }
    setForm(emptyForm);
    setShowAdd(false);
  };

  const startEdit = (d: DrmProxy) => {
    setForm({ channelId: d.channelId, channelName: d.channelName || '', keyId: d.keyId, key: d.key, licenseUrl: d.licenseUrl || '', licenseType: d.licenseType || 'clearkey', isActive: d.isActive, notes: d.notes || '' });
    setEditId(d.id);
    setShowAdd(true);
  };

  const drmChannels = channels.filter(c => c.isDrm);
  const activeProxies = drmProxies.filter(d => d.isActive);

  const licenseTypeColor = (t?: string) => {
    if (t === 'clearkey') return 'bg-green-900/40 text-green-400 border-green-800/30';
    if (t === 'widevine') return 'bg-purple-900/40 text-purple-400 border-purple-800/30';
    if (t === 'playready') return 'bg-blue-900/40 text-blue-400 border-blue-800/30';
    return 'bg-gray-700 text-gray-400 border-gray-600';
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">DRM Proxy Manager</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {drmProxies.length} proxies · {activeProxies.length} active · {drmChannels.length} DRM channels detected
          </p>
        </div>
        <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> Add DRM Proxy
        </button>
      </div>

      {/* How it works */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { icon: <Key className="w-5 h-5 text-green-400" />, title: 'ClearKey', desc: 'kid:key pairs stored server-side. License endpoint: /proxy/drm-license/{id}. Compatible with DASH.js, Shaka, ExoPlayer.', color: 'border-green-800/30 bg-green-950/20' },
          { icon: <Shield className="w-5 h-5 text-purple-400" />, title: 'Widevine', desc: 'License URL forwarded through server. EME binary license requests proxied with correct headers.', color: 'border-purple-800/30 bg-purple-950/20' },
          { icon: <Globe className="w-5 h-5 text-blue-400" />, title: 'Stream Proxy', desc: 'DRM streams served via /proxy/drm/{channelId}. Original URL + key never exposed to client.', color: 'border-blue-800/30 bg-blue-950/20' },
        ].map(item => (
          <div key={item.title} className={`p-4 rounded-xl border ${item.color}`}>
            <div className="flex items-center gap-2 mb-2">{item.icon}<span className="text-white font-medium text-sm">{item.title}</span></div>
            <p className="text-gray-400 text-xs leading-relaxed">{item.desc}</p>
          </div>
        ))}
      </div>

      {/* Auto-detected DRM channels */}
      {drmChannels.length > 0 && (
        <div className="bg-yellow-950/20 border border-yellow-800/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <p className="text-yellow-300 font-medium text-sm">Auto-Detected DRM Channels ({drmChannels.length})</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {drmChannels.slice(0, 12).map(ch => (
              <div key={ch.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/20 border border-yellow-800/20 rounded-lg text-xs">
                <Shield className="w-3 h-3 text-yellow-400" />
                <span className="text-yellow-300">{ch.name}</span>
                {ch.licenseType && <span className="text-yellow-600 font-mono">({ch.licenseType})</span>}
              </div>
            ))}
            {drmChannels.length > 12 && (
              <span className="text-yellow-600 text-xs px-2 py-1.5">+{drmChannels.length - 12} more</span>
            )}
          </div>
          <p className="text-yellow-700 text-xs mt-2">
            DRM proxies are auto-created when sources are loaded. Add missing keys manually below.
          </p>
        </div>
      )}

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-purple-400" />
              {editId ? 'Edit DRM Proxy' : 'New DRM Proxy'}
            </h3>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Link to Channel</label>
              <select value={form.channelId}
                onChange={e => { const ch = channels.find(c => c.id === e.target.value); setForm(f => ({ ...f, channelId: e.target.value, channelName: ch?.name || '' })); }}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500">
                <option value="">Select channel (optional)</option>
                {channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name} [{ch.group}]</option>)}
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block">License Type</label>
              <select value={form.licenseType} onChange={e => setForm(f => ({ ...f, licenseType: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500">
                <option value="clearkey">ClearKey (MPEG-DASH)</option>
                <option value="widevine">Widevine</option>
                <option value="playready">PlayReady</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block flex items-center gap-1"><Key className="w-3 h-3" /> Key ID (KID)</label>
              <input value={form.keyId} onChange={e => setForm(f => ({ ...f, keyId: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                placeholder="hex key id or kid" />
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block flex items-center gap-1"><Key className="w-3 h-3" /> Decryption Key</label>
              <input value={form.key} onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                placeholder="hex key" />
            </div>
            <div className="md:col-span-2">
              <label className="text-gray-400 text-sm mb-1 block">License URL (for Widevine / kid:key string for ClearKey)</label>
              <input value={form.licenseUrl} onChange={e => setForm(f => ({ ...f, licenseUrl: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                placeholder="https://license.example.com/widevine  or  kid1:key1,kid2:key2" />
            </div>
            <div className="md:col-span-2">
              <label className="text-gray-400 text-sm mb-1 block">Notes</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                placeholder="Optional notes (source, expiry, etc.)" />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-purple-500" />
            <span className="text-gray-300 text-sm">Active</span>
          </label>

          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
            <button onClick={handleSubmit}
              className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Save className="w-4 h-4" /> {editId ? 'Update' : 'Create Proxy'}
            </button>
          </div>
        </div>
      )}

      {/* Proxy List */}
      {drmProxies.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Shield className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-gray-400 font-medium">No DRM proxies yet</p>
          <p className="text-sm mt-1">DRM proxies are auto-created when DRM channels are loaded from sources.<br />You can also add them manually.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {drmProxies.map(d => {
            const ch = channels.find(c => c.id === d.channelId);
            const proxyUrl = `${serverUrl}/proxy/drm/${d.channelId || d.id}`;
            const licenseUrl = `${serverUrl}/proxy/drm-license/${d.id}`;
            return (
              <div key={d.id} className={`bg-gray-800 border rounded-xl p-4 transition-all ${!d.isActive ? 'opacity-50 border-gray-700/50' : 'border-gray-700'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <Shield className={`w-4 h-4 ${d.isActive ? 'text-purple-400' : 'text-gray-500'}`} />
                      <span className="text-white font-medium">{d.channelName || ch?.name || 'Unnamed'}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-mono ${licenseTypeColor(d.licenseType)}`}>
                        {d.licenseType || 'clearkey'}
                      </span>
                      {!d.isActive && <span className="text-xs text-gray-500">disabled</span>}
                    </div>

                    <div className="space-y-1.5">
                      {d.keyId && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 text-xs w-14 shrink-0">KID:</span>
                          <code className="text-yellow-400 text-xs font-mono flex-1 truncate">
                            {showKeys[`kid_${d.id}`] ? d.keyId : '••••••••••••••••'}
                          </code>
                          <button onClick={() => toggleShowKey(`kid_${d.id}`)} className="text-gray-600 hover:text-white shrink-0">
                            {showKeys[`kid_${d.id}`] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          </button>
                          {showKeys[`kid_${d.id}`] && (
                            <button onClick={() => copy(d.keyId, `kid_${d.id}`)} className="text-gray-600 hover:text-white shrink-0">
                              {copied === `kid_${d.id}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                            </button>
                          )}
                        </div>
                      )}
                      {d.key && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 text-xs w-14 shrink-0">Key:</span>
                          <code className="text-green-400 text-xs font-mono flex-1 truncate">
                            {showKeys[`key_${d.id}`] ? d.key : '••••••••••••••••'}
                          </code>
                          <button onClick={() => toggleShowKey(`key_${d.id}`)} className="text-gray-600 hover:text-white shrink-0">
                            {showKeys[`key_${d.id}`] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          </button>
                        </div>
                      )}
                      {d.licenseUrl && (
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 text-xs w-14 shrink-0">Lic:</span>
                          <code className="text-blue-400 text-xs font-mono flex-1 truncate">{d.licenseUrl}</code>
                        </div>
                      )}
                    </div>

                    {/* Proxy URLs */}
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center gap-2 p-2 bg-gray-900 rounded-lg">
                        <span className="text-gray-600 text-xs w-20 shrink-0">Stream URL:</span>
                        <code className="text-purple-400 text-xs flex-1 truncate font-mono">{proxyUrl}</code>
                        <button onClick={() => copy(proxyUrl, `proxy_${d.id}`)} className="text-gray-600 hover:text-white shrink-0">
                          {copied === `proxy_${d.id}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      {d.licenseType === 'clearkey' && (
                        <div className="flex items-center gap-2 p-2 bg-gray-900 rounded-lg">
                          <span className="text-gray-600 text-xs w-20 shrink-0">License:</span>
                          <code className="text-yellow-400 text-xs flex-1 truncate font-mono">{licenseUrl}</code>
                          <button onClick={() => copy(licenseUrl, `lic_${d.id}`)} className="text-gray-600 hover:text-white shrink-0">
                            {copied === `lic_${d.id}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      )}
                    </div>

                    {d.notes && <p className="text-gray-600 text-xs mt-2 italic">{d.notes}</p>}
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => updateDrmProxy(d.id, { isActive: !d.isActive })}
                      className={`p-2 transition-colors rounded-lg hover:bg-gray-700 ${d.isActive ? 'text-green-400 hover:text-gray-400' : 'text-gray-500 hover:text-green-400'}`}>
                      {d.isActive ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button onClick={() => startEdit(d)} className="p-2 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => { deleteDrmProxy(d.id); toast.success('DRM proxy deleted'); }}
                      className="p-2 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
