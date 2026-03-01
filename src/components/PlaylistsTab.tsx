import { useState } from 'react';
import { useStore } from '../store/useStore';
import {
  Plus, Trash2, Edit2, Save, X, Copy, Check,
  Download, ExternalLink, List, Star, Server
} from 'lucide-react';
import toast from 'react-hot-toast';

export default function PlaylistsTab() {
  const {
    playlists, groups, channels, serverUrl,
    createPlaylist, updatePlaylist, deletePlaylist, getPlaylistM3U, exportDB,
  } = useStore();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', includeGroups: [] as string[], excludeGroups: [] as string[], tamilOnly: false,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const toggleGroupSel = (groupName: string, list: 'include' | 'exclude') => {
    const key = list === 'include' ? 'includeGroups' : 'excludeGroups';
    const other = list === 'include' ? 'excludeGroups' : 'includeGroups';
    setForm(f => {
      const updated = f[key].includes(groupName) ? f[key].filter(g => g !== groupName) : [...f[key], groupName];
      return { ...f, [key]: updated, [other]: f[other].filter(g => g !== groupName) };
    });
  };

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error('Playlist name required'); return; }
    if (editId) {
      updatePlaylist(editId, { name: form.name, includeGroups: form.includeGroups, excludeGroups: form.excludeGroups, tamilOnly: form.tamilOnly });
      toast.success('Playlist updated');
      setEditId(null);
    } else {
      createPlaylist(form.name, form.includeGroups, form.tamilOnly);
      toast.success('✅ Playlist created & synced to server!');
    }
    setForm({ name: '', includeGroups: [], excludeGroups: [], tamilOnly: false });
    setShowAdd(false);
  };

  const copyUrl = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('URL copied!');
  };

  const downloadM3U = (id: string, name: string) => {
    const content = getPlaylistM3U(id);
    const blob = new Blob([content], { type: 'application/x-mpegurl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/\s+/g, '_')}.m3u`;
    a.click();
    toast.success('Playlist downloaded!');
  };

  const handleExportDB = () => {
    const content = exportDB();
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'iptv-manager-db.json';
    a.click();
    toast.success('Database exported!');
  };

  const getPlaylistChannelCount = (pl: { includeGroups: string[]; excludeGroups: string[]; tamilOnly?: boolean }) => {
    return channels.filter(ch => {
      if (!ch.isActive) return false;
      if (pl.tamilOnly && !ch.isTamil) return false;
      if (pl.includeGroups.length && !pl.includeGroups.includes(ch.group)) return false;
      if (pl.excludeGroups.includes(ch.group)) return false;
      return true;
    }).length;
  };

  const tamilChannelCount = channels.filter(c => c.isTamil && c.isActive).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Generated Playlists</h2>
          <p className="text-gray-500 text-sm mt-0.5">{playlists.length} playlists · auto-synced to server</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleExportDB}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Download className="w-4 h-4" /> Export DB
          </button>
          <button
            onClick={() => { setShowAdd(true); setEditId(null); setForm({ name: '', includeGroups: [], excludeGroups: [], tamilOnly: false }); }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> New Playlist
          </button>
        </div>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-950/40 border border-blue-800/40 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Server className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-blue-300 font-medium text-sm mb-1">Live Server-Side Playlist URLs</p>
            <p className="text-blue-400 text-xs leading-relaxed">
              Each playlist URL (<code className="font-mono bg-blue-900/30 px-1 rounded">/api/playlist/&#123;id&#125;.m3u</code>) is served live by the backend.
              When you add/update sources, the playlist URL auto-updates — no need to re-share.
              Stream URLs in the M3U point to the server proxy, hiding original URLs.
              {tamilChannelCount > 0 && ` You have ${tamilChannelCount} Tamil channels available for Tamil-only playlists.`}
            </p>
          </div>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold">{editId ? 'Edit Playlist' : 'New Playlist'}</h3>
            <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>

          <div>
            <label className="text-gray-400 text-sm mb-1 block">Playlist Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              placeholder="My Tamil IPTV Playlist" />
          </div>

          {/* Tamil Only Toggle */}
          <div className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
            form.tamilOnly ? 'bg-orange-500/10 border-orange-500/40' : 'bg-gray-900/50 border-gray-700/50'
          }`} onClick={() => setForm(f => ({ ...f, tamilOnly: !f.tamilOnly }))}>
            <div className={`w-10 h-5 rounded-full transition-all relative ${form.tamilOnly ? 'bg-orange-500' : 'bg-gray-600'}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow ${form.tamilOnly ? 'left-5' : 'left-0.5'}`} />
            </div>
            <div>
              <p className="text-white text-sm font-medium flex items-center gap-2">
                <Star className={`w-4 h-4 ${form.tamilOnly ? 'text-orange-400 fill-orange-400' : 'text-gray-400'}`} />
                🎬 Tamil Channels Only
              </p>
              <p className="text-gray-500 text-xs">
                {form.tamilOnly
                  ? `Will include only ${tamilChannelCount} Tamil channels (Sun TV, Vijay, Zee Tamil, Polimer, etc.)`
                  : 'Toggle to create a Tamil-only playlist'}
              </p>
            </div>
          </div>

          {!form.tamilOnly && (
            <>
              <div>
                <label className="text-gray-400 text-sm mb-2 block">
                  Include Groups <span className="text-gray-600">(empty = all active groups)</span>
                </label>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                  {groups.map(g => (
                    <button key={g.id} onClick={() => toggleGroupSel(g.name, 'include')}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1 ${
                        form.includeGroups.includes(g.name) ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}>
                      {form.includeGroups.includes(g.name) ? '✓ ' : ''}{g.name}
                      {g.isTamil && <Star className="w-3 h-3 text-orange-400 fill-orange-400" />}
                      <span className="text-xs opacity-60">({g.channelCount})</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-gray-400 text-sm mb-2 block">Exclude Groups</label>
                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                  {groups.map(g => (
                    <button key={g.id} onClick={() => toggleGroupSel(g.name, 'exclude')}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                        form.excludeGroups.includes(g.name) ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}>
                      {form.excludeGroups.includes(g.name) ? '✗ ' : ''}{g.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
            <button onClick={handleSubmit}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Save className="w-4 h-4" /> {editId ? 'Update' : 'Create Playlist'}
            </button>
          </div>
        </div>
      )}

      {/* Playlist List */}
      {playlists.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <List className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-gray-400 font-medium">No playlists yet</p>
          <p className="text-sm mt-1">Create one to get a shareable URL for any IPTV player</p>
          <button onClick={() => setShowAdd(true)}
            className="mt-4 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Create First Playlist
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {playlists.map(pl => {
            const channelCount = getPlaylistChannelCount(pl);
            const serverPlaylistUrl = `${serverUrl}/api/playlist/${pl.id}.m3u`;
            return (
              <div key={pl.id} className="bg-gray-800 border border-gray-700 rounded-xl p-5 hover:border-gray-600 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="text-white font-semibold text-lg">{pl.name}</h3>
                      {pl.tamilOnly && (
                        <span className="flex items-center gap-1 text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full">
                          <Star className="w-3 h-3 fill-orange-400" /> Tamil Only
                        </span>
                      )}
                    </div>
                    <p className="text-gray-400 text-sm mb-3">
                      <span className="text-green-400 font-medium">{channelCount}</span> channels active
                    </p>

                    {pl.includeGroups.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {pl.includeGroups.map(g => (
                          <span key={g} className="text-xs bg-green-900/40 text-green-400 border border-green-800/30 px-2 py-0.5 rounded-full">✓ {g}</span>
                        ))}
                      </div>
                    )}
                    {pl.excludeGroups.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {pl.excludeGroups.map(g => (
                          <span key={g} className="text-xs bg-red-900/40 text-red-400 border border-red-800/30 px-2 py-0.5 rounded-full">✗ {g}</span>
                        ))}
                      </div>
                    )}

                    {/* Playlist URL */}
                    <div className="p-3 bg-gray-900 rounded-xl border border-gray-700 hover:border-blue-700 transition-colors">
                      <p className="text-gray-500 text-xs mb-1.5 flex items-center gap-1">
                        <Server className="w-3 h-3" /> Playlist URL — add to VLC, Kodi, TiviMate, GSE IPTV
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="text-green-400 text-xs flex-1 truncate font-mono">{serverPlaylistUrl}</code>
                        <button onClick={() => copyUrl(serverPlaylistUrl, pl.id)} className="shrink-0 text-gray-400 hover:text-white p-1.5 hover:bg-gray-700 rounded-lg transition-colors">
                          {copied === pl.id ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <p className="text-gray-600 text-xs mt-2">
                      Created {new Date(pl.createdAt).toLocaleDateString()} · Updated {new Date(pl.updatedAt).toLocaleDateString()}
                    </p>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => setPreview(getPlaylistM3U(pl.id))} title="Preview M3U"
                      className="p-2 text-gray-400 hover:text-blue-400 transition-colors rounded-lg hover:bg-gray-700">
                      <ExternalLink className="w-4 h-4" />
                    </button>
                    <button onClick={() => downloadM3U(pl.id, pl.name)} title="Download .m3u"
                      className="p-2 text-gray-400 hover:text-green-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Download className="w-4 h-4" />
                    </button>
                    <button onClick={() => {
                      setForm({ name: pl.name, includeGroups: pl.includeGroups, excludeGroups: pl.excludeGroups, tamilOnly: pl.tamilOnly || false });
                      setEditId(pl.id); setShowAdd(true);
                    }} className="p-2 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => { deletePlaylist(pl.id); toast.success('Playlist deleted'); }}
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

      {/* M3U Preview Modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-white font-semibold">M3U Preview</h3>
              <div className="flex gap-2">
                <button onClick={() => { navigator.clipboard.writeText(preview); toast.success('Copied!'); }}
                  className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm">
                  <Copy className="w-3 h-3" /> Copy All
                </button>
                <button onClick={() => setPreview(null)} className="text-gray-400 hover:text-white p-1 hover:bg-gray-700 rounded-lg">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <pre className="p-4 text-green-400 text-xs font-mono overflow-auto flex-1 leading-relaxed">{preview}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
