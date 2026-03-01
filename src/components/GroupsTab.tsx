import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Group } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Eye, EyeOff,
  Layers, Star, Search, Filter
} from 'lucide-react';
import toast from 'react-hot-toast';

export default function GroupsTab() {
  const { groups, channels, addGroup, updateGroup, deleteGroup, toggleGroup, setSelectedGroup, setActiveTab, setShowTamilOnly } = useStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', logo: '' });
  const [search, setSearch] = useState('');
  const [filterTamil, setFilterTamil] = useState(false);

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error('Group name required'); return; }
    if (editId) {
      updateGroup(editId, { name: form.name, logo: form.logo || undefined });
      toast.success('Group updated');
      setEditId(null);
    } else {
      addGroup({ name: form.name, logo: form.logo || undefined, isActive: true, order: groups.length });
      toast.success('Group added');
    }
    setForm({ name: '', logo: '' });
    setShowAdd(false);
  };

  const startEdit = (g: Group) => {
    setForm({ name: g.name, logo: g.logo || '' });
    setEditId(g.id);
    setShowAdd(true);
  };

  const handleViewChannels = (groupName: string) => {
    setSelectedGroup(groupName);
    setActiveTab('channels');
    toast.success(`Viewing channels in: ${groupName}`);
  };

  const handleViewTamilChannels = () => {
    setShowTamilOnly(true);
    setActiveTab('channels');
    toast.success('Viewing Tamil channels');
  };

  const filteredGroups = groups.filter(g => {
    if (filterTamil && !g.isTamil) return false;
    if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const totalChannels = channels.length;
  const tamilGroups = groups.filter(g => g.isTamil).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Groups</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {groups.length} groups · {totalChannels.toLocaleString()} channels · {tamilGroups} Tamil groups
          </p>
        </div>
        <button onClick={() => { setShowAdd(true); setEditId(null); setForm({ name: '', logo: '' }); }}
          className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> Add Group
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="Search groups..." />
        </div>
        <button
          onClick={() => setFilterTamil(!filterTamil)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all border ${
            filterTamil
              ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:border-orange-600 hover:text-orange-400'
          }`}
        >
          <Star className={`w-4 h-4 ${filterTamil ? 'fill-white' : ''}`} />
          🎬 Tamil Groups
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${filterTamil ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
            {tamilGroups}
          </span>
        </button>
        {(filterTamil || search) && (
          <button onClick={() => { setFilterTamil(false); setSearch(''); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors">
            <Filter className="w-3.5 h-3.5" /> Clear
          </button>
        )}
        {/* Quick Tamil view */}
        <button onClick={handleViewTamilChannels}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-medium transition-colors">
          <Star className="w-4 h-4 fill-white" /> View All Tamil Channels
        </button>
      </div>

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold">{editId ? 'Edit Group' : 'Add Group'}</h3>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Group Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="Tamil Entertainment" />
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block">Logo URL (optional)</label>
              <input value={form.logo} onChange={e => setForm(f => ({ ...f, logo: e.target.value }))}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="https://..." />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowAdd(false); setEditId(null); }} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
            <button onClick={handleSubmit}
              className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Save className="w-4 h-4" /> {editId ? 'Update' : 'Add Group'}
            </button>
          </div>
        </div>
      )}

      {/* Groups Grid */}
      {filteredGroups.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Layers className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-gray-400 font-medium">{filterTamil ? 'No Tamil groups found' : 'No groups yet'}</p>
          <p className="text-sm mt-1">{filterTamil ? 'Load Tamil sources to see Tamil groups' : 'Groups are auto-created when channels are imported'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredGroups.map(g => (
            <div key={g.id}
              className={`bg-gray-800 border rounded-xl p-4 transition-all hover:border-gray-600 ${
                !g.isActive ? 'opacity-50 border-gray-700/50' : g.isTamil ? 'border-orange-800/40' : 'border-gray-700'
              }`}>
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {g.logo ? (
                    <img src={g.logo} alt="" className="w-8 h-8 rounded-lg object-contain bg-gray-700 p-1"
                      onError={e => (e.currentTarget.style.display = 'none')} />
                  ) : (
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${g.isTamil ? 'bg-orange-500/20' : 'bg-gray-700'}`}>
                      <Layers className={`w-4 h-4 ${g.isTamil ? 'text-orange-400' : 'text-gray-400'}`} />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-white font-medium text-sm truncate">{g.name}</h3>
                      {g.isTamil && <Star className="w-3.5 h-3.5 text-orange-400 fill-orange-400 shrink-0" />}
                    </div>
                    <p className="text-gray-500 text-xs">
                      {g.channelCount || 0} channels
                      {g.isTamil && <span className="text-orange-500 ml-1">· Tamil</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button onClick={() => toggleGroup(g.id)}
                    className={`p-1.5 rounded-lg transition-colors hover:bg-gray-700 ${g.isActive ? 'text-green-400' : 'text-gray-500 hover:text-green-400'}`}
                    title={g.isActive ? 'Disable group' : 'Enable group'}>
                    {g.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => startEdit(g)} className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => { deleteGroup(g.id); toast.success('Group deleted'); }}
                    className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mb-3">
                <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${g.isTamil ? 'bg-orange-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(100, ((g.channelCount || 0) / Math.max(1, channels.length)) * 100 * 10)}%` }}
                  />
                </div>
              </div>

              <button onClick={() => handleViewChannels(g.name)}
                className={`w-full text-xs py-1.5 rounded-lg transition-colors font-medium ${
                  g.isTamil
                    ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/20'
                    : 'bg-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-white border border-gray-600/30'
                }`}>
                View {g.channelCount || 0} Channels →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
