import { useState } from 'react';
import { useStore } from '../store/useStore';
import { PlaylistConfig } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Copy, Check,
  List, Download, Globe, Star, Eye, Heart,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ── Form state ────────────────────────────────────────────────────────────────
interface FormState {
  name: string;
  tamilOnly: boolean;
  includeGroups: string[];
}

// ── Copy button with feedback ─────────────────────────────────────────────────
function CopyBtn({ text, label = 'Copied!' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success(label);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={copy}
      className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors rounded-lg hover:bg-gray-700">
      {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

// ── Playlist card ─────────────────────────────────────────────────────────────
function PlaylistCard({
  playlist,
  onEdit,
  onDelete,
}: {
  playlist: PlaylistConfig;
  onEdit: (p: PlaylistConfig) => void;
  onDelete: (id: string) => void;
}) {
  const { getPlaylistM3U, channels, serverUrl } = useStore();
  const base   = serverUrl || window.location.origin;
  const liveUrl = `${base}/api/playlist/${playlist.id}.m3u`;

  const includedChannels = channels.filter(ch => {
    if (!ch.isActive) return false;
    if (playlist.tamilOnly && !ch.isTamil) return false;
    if (playlist.includeGroups.length && !playlist.includeGroups.includes(ch.group)) return false;
    if (playlist.excludeGroups.includes(ch.group)) return false;
    return true;
  });

  const downloadM3U = () => {
    const content = getPlaylistM3U(playlist.id);
    const blob = new Blob([content], { type: 'application/x-mpegurl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${playlist.name.replace(/\s+/g, '_')}.m3u`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success('Playlist downloaded!');
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 hover:border-gray-600 transition-all space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center shrink-0">
            <List className="w-5 h-5 text-purple-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-white font-semibold truncate">{playlist.name}</h3>
              {playlist.tamilOnly && (
                <span className="flex items-center gap-1 text-xs bg-orange-500/15 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full">
                  <Heart className="w-3 h-3 fill-orange-400" /> Tamil Only
                </span>
              )}
            </div>
            <p className="text-gray-500 text-xs mt-0.5">
              {includedChannels.length.toLocaleString()} channels
              {playlist.includeGroups.length > 0 && ` · ${playlist.includeGroups.length} groups`}
              {playlist.tamilOnly && ' · 🎬 Tamil filter ON'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onEdit(playlist)}
            className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
            <Edit2 className="w-4 h-4" />
          </button>
          <button onClick={() => onDelete(playlist.id)}
            className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Groups pills */}
      {playlist.includeGroups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {playlist.includeGroups.slice(0, 6).map(g => (
            <span key={g} className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full">{g}</span>
          ))}
          {playlist.includeGroups.length > 6 && (
            <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
              +{playlist.includeGroups.length - 6} more
            </span>
          )}
        </div>
      )}

      {/* Live server URL */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-3">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-green-400" />
            <span className="text-xs text-gray-400 font-medium">Live Playlist URL</span>
          </div>
          <CopyBtn text={liveUrl} label="📋 Playlist URL copied!" />
        </div>
        <p className="text-green-400 text-xs font-mono truncate">{liveUrl}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={downloadM3U}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white rounded-lg text-xs font-medium transition-colors">
          <Download className="w-3.5 h-3.5" /> Download M3U
        </button>
        <button onClick={() => { navigator.clipboard.writeText(liveUrl); toast.success('URL copied!'); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-400 rounded-lg text-xs font-medium transition-colors">
          <Copy className="w-3.5 h-3.5" /> Copy URL
        </button>
        <a href={liveUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 rounded-lg text-xs font-medium transition-colors">
          <Eye className="w-3.5 h-3.5" /> Preview
        </a>
      </div>
    </div>
  );
}

// ── Add/Edit form modal ───────────────────────────────────────────────────────
function PlaylistForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: PlaylistConfig;
  onSave: (f: FormState) => void;
  onClose: () => void;
}) {
  const { groups } = useStore();
  const [form, setForm] = useState<FormState>({
    name:          initial?.name || '',
    tamilOnly:     initial?.tamilOnly || false,
    includeGroups: initial?.includeGroups || [],
  });
  const [groupSearch, setGroupSearch] = useState('');

  const toggleGroup = (name: string) => {
    setForm(f => ({
      ...f,
      includeGroups: f.includeGroups.includes(name)
        ? f.includeGroups.filter(g => g !== name)
        : [...f.includeGroups, name],
    }));
  };

  const selectTamilGroups = () => {
    const tamilGroupNames = groups.filter(g => g.isTamil).map(g => g.name);
    setForm(f => ({ ...f, includeGroups: tamilGroupNames, tamilOnly: true }));
  };

  const filteredGroups = groups.filter(g =>
    !groupSearch || g.name.toLowerCase().includes(groupSearch.toLowerCase())
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-xl max-h-[90vh] flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold text-lg">
            {initial ? 'Edit Playlist' : 'Create Playlist'}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Name */}
        <div>
          <label className="text-gray-400 text-sm mb-1.5 block">Playlist Name *</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="My Tamil HD Channels"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        {/* Tamil only toggle */}
        <div className="flex items-center justify-between p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <div className="flex items-center gap-2">
            <Heart className={`w-4 h-4 ${form.tamilOnly ? 'text-orange-400 fill-orange-400' : 'text-gray-500'}`} />
            <div>
              <p className="text-sm text-white font-medium">Tamil Only Filter</p>
              <p className="text-xs text-gray-400">Only include Tamil-tagged channels</p>
            </div>
          </div>
          <button
            onClick={() => setForm(f => ({ ...f, tamilOnly: !f.tamilOnly }))}
            className={`w-10 h-5 rounded-full transition-colors relative ${form.tamilOnly ? 'bg-orange-500' : 'bg-gray-600'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${form.tamilOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {/* Group selector */}
        <div className="flex-1 overflow-hidden flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-gray-400 text-sm">
              Filter Groups
              {form.includeGroups.length > 0 && (
                <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">
                  {form.includeGroups.length} selected
                </span>
              )}
            </label>
            <div className="flex gap-2">
              <button onClick={selectTamilGroups}
                className="text-xs text-orange-400 hover:text-orange-300 transition-colors flex items-center gap-1">
                <Star className="w-3 h-3" /> Select Tamil
              </button>
              <button onClick={() => setForm(f => ({ ...f, includeGroups: groups.map(g => g.name) }))}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                All
              </button>
              <button onClick={() => setForm(f => ({ ...f, includeGroups: [] }))}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                None
              </button>
            </div>
          </div>

          <input
            value={groupSearch}
            onChange={e => setGroupSearch(e.target.value)}
            placeholder="Search groups..."
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500 transition-colors"
          />

          <p className="text-xs text-gray-500">
            {form.includeGroups.length === 0 ? 'No groups selected = all channels included' : `${form.includeGroups.length} groups selected`}
          </p>

          <div className="overflow-y-auto flex-1 max-h-48 space-y-1 pr-1">
            {filteredGroups.map(g => {
              const selected = form.includeGroups.includes(g.name);
              return (
                <button
                  key={g.id}
                  onClick={() => toggleGroup(g.name)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                    selected
                      ? 'bg-blue-600/20 border border-blue-500/40 text-white'
                      : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    selected ? 'bg-blue-600 border-blue-500' : 'border-gray-600'
                  }`}>
                    {selected && <Check className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <span className="flex-1 truncate">{g.name}</span>
                  {g.isTamil && <Star className="w-3 h-3 text-orange-400 fill-orange-400 shrink-0" />}
                  <span className="text-xs text-gray-600">{g.channelCount || 0}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">
            Cancel
          </button>
          <button
            onClick={() => {
              if (!form.name.trim()) { toast.error('Name is required'); return; }
              onSave(form);
            }}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <Save className="w-4 h-4" /> {initial ? 'Update' : 'Create'} Playlist
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PlaylistsTab() {
  const { playlists, channels, createPlaylist, updatePlaylist, deletePlaylist } = useStore();

  const [showForm, setShowForm] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistConfig | null>(null);

  const handleCreate = (form: FormState) => {
    createPlaylist(form.name, form.includeGroups, form.tamilOnly);
    toast.success('✅ Playlist created!');
    setShowForm(false);
  };

  const handleEdit = (form: FormState) => {
    if (!editingPlaylist) return;
    updatePlaylist(editingPlaylist.id, {
      name: form.name,
      tamilOnly: form.tamilOnly,
      includeGroups: form.includeGroups,
    });
    toast.success('✅ Playlist updated!');
    setEditingPlaylist(null);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this playlist?')) return;
    deletePlaylist(id);
    toast.success('Playlist deleted');
  };

  const tamilCount = channels.filter(c => c.isTamil).length;

  return (
    <div className="space-y-5">
      {/* Form modals */}
      {showForm && (
        <PlaylistForm onSave={handleCreate} onClose={() => setShowForm(false)} />
      )}
      {editingPlaylist && (
        <PlaylistForm
          initial={editingPlaylist}
          onSave={handleEdit}
          onClose={() => setEditingPlaylist(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Playlists</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {playlists.length} playlists · {channels.length.toLocaleString()} total channels
            {tamilCount > 0 && <span className="text-orange-400"> · {tamilCount} Tamil</span>}
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New Playlist
        </button>
      </div>

      {/* Empty state */}
      {playlists.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <List className="w-14 h-14 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium text-gray-400 mb-2">No playlists yet</p>
          <p className="text-sm mb-6">Create a playlist to get a shareable M3U URL</p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Create First Playlist
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {playlists.map(p => (
            <PlaylistCard
              key={p.id}
              playlist={p}
              onEdit={pl => setEditingPlaylist(pl)}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
