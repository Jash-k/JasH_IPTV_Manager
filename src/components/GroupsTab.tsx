import { useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { Group } from '../types';
import {
  Plus, Trash2, Edit2, Save, X, Eye, EyeOff,
  Layers, Star, Search, Filter, MoveRight,
  CheckSquare, Square, Tv2, ChevronDown, ChevronUp,
  Copy, Check,
} from 'lucide-react';
import toast from 'react-hot-toast';

// ── Form state ────────────────────────────────────────────────────────────────
interface GroupForm { name: string; logo: string }

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 text-gray-500 hover:text-blue-400 transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Merge groups modal ────────────────────────────────────────────────────────
function MergeModal({
  sourceGroup,
  onMerge,
  onClose,
}: {
  sourceGroup: Group;
  onMerge: (targetName: string) => void;
  onClose: () => void;
}) {
  const { groups } = useStore();
  const [target, setTarget] = useState('');
  const others = groups.filter(g => g.id !== sourceGroup.id);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Merge "{sourceGroup.name}"</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-gray-400 text-sm">
          Move all {sourceGroup.channelCount || 0} channels into another group, then delete this group.
        </p>
        <div>
          <label className="text-gray-400 text-sm mb-1.5 block">Target Group</label>
          <select value={target} onChange={e => setTarget(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
            <option value="">Select target…</option>
            {others.map(g => (
              <option key={g.id} value={g.name}>{g.name} ({g.channelCount || 0} channels)</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
          <button onClick={() => { if (!target) { toast.error('Select target group'); return; } onMerge(target); }}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <MoveRight className="w-4 h-4" /> Merge
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Channel mini-list inside a group card ─────────────────────────────────────
function GroupChannelList({ groupName }: { groupName: string }) {
  const { channels, deleteChannel, updateChannel, setSelectedGroup, setActiveTab } = useStore();
  const [search, setSearch] = useState('');
  const chans = useMemo(() =>
    channels.filter(ch => ch.group === groupName &&
      (!search || ch.name.toLowerCase().includes(search.toLowerCase())))
  , [channels, groupName, search]);

  return (
    <div className="mt-3 border-t border-gray-700 pt-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search channels…"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500" />
        </div>
        <button onClick={() => { setSelectedGroup(groupName); setActiveTab('channels'); }}
          className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600/20 border border-blue-500/30 text-blue-400 rounded-lg text-xs hover:bg-blue-600/30">
          <Tv2 className="w-3 h-3" /> View All
        </button>
      </div>

      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
        {chans.length === 0 && (
          <p className="text-center text-gray-600 text-xs py-4">No channels found</p>
        )}
        {chans.slice(0, 30).map(ch => (
          <div key={ch.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-gray-900/60 hover:bg-gray-900 transition-colors group">
            {ch.logo
              ? <img src={ch.logo} alt="" className="w-5 h-5 rounded object-contain bg-gray-800" onError={e => (e.currentTarget.style.display='none')} />
              : <div className="w-5 h-5 rounded bg-gray-700 flex items-center justify-center"><Tv2 className="w-3 h-3 text-gray-500" /></div>}
            <span className="flex-1 text-xs text-gray-300 truncate">{ch.name}</span>
            {ch.isTamil && <span className="text-orange-400 text-xs">🎬</span>}
            <CopyBtn text={ch.url} />
            <button onClick={() => { updateChannel(ch.id, { isActive: !ch.isActive }); }}
              className={`w-6 h-3 rounded-full transition-colors relative shrink-0 ${ch.isActive ? 'bg-blue-600' : 'bg-gray-600'}`}>
              <div className={`absolute top-0.5 w-2 h-2 bg-white rounded-full transition-transform ${ch.isActive ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </button>
            <button onClick={() => { deleteChannel(ch.id); toast.success('Channel removed'); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-red-400 hover:text-red-300 transition-all">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        {chans.length > 30 && (
          <p className="text-center text-gray-600 text-xs py-2">…and {chans.length - 30} more. Click "View All" →</p>
        )}
      </div>
    </div>
  );
}

// ── Group card ────────────────────────────────────────────────────────────────
function GroupCard({
  g,
  onEdit,
  onDelete,
  onMerge,
}: {
  g: Group;
  onEdit: (g: Group) => void;
  onDelete: (g: Group) => void;
  onMerge: (g: Group) => void;
}) {
  const { toggleGroup, channels, setSelectedGroup, setActiveTab, setShowTamilOnly } = useStore();
  const [expanded, setExpanded] = useState(false);

  const chCount = channels.filter(ch => ch.group === g.name).length;
  const tamilCount = channels.filter(ch => ch.group === g.name && ch.isTamil).length;
  const activeCount = channels.filter(ch => ch.group === g.name && ch.isActive).length;

  return (
    <div className={`bg-gray-800 border rounded-xl transition-all ${
      !g.isActive ? 'opacity-55 border-gray-700/50'
      : g.isTamil ? 'border-orange-700/40 hover:border-orange-600/60'
      : 'border-gray-700 hover:border-gray-600'
    }`}>
      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            {g.logo ? (
              <img src={g.logo} alt="" className="w-9 h-9 rounded-lg object-contain bg-gray-700 p-1"
                onError={e => (e.currentTarget.style.display = 'none')} />
            ) : (
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${g.isTamil ? 'bg-orange-500/20' : 'bg-gray-700'}`}>
                <Layers className={`w-4 h-4 ${g.isTamil ? 'text-orange-400' : 'text-gray-400'}`} />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-white font-semibold text-sm truncate">{g.name}</h3>
                {g.isTamil && <Star className="w-3.5 h-3.5 text-orange-400 fill-orange-400 shrink-0" />}
                {!g.isActive && <span className="text-xs bg-gray-700 text-gray-500 px-1.5 py-0.5 rounded-full">Hidden</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-gray-500 text-xs">{chCount} channels</span>
                {tamilCount > 0 && <span className="text-orange-500 text-xs">· {tamilCount} Tamil</span>}
                {chCount > 0 && <span className="text-gray-600 text-xs">· {activeCount} active</span>}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => toggleGroup(g.id)} title={g.isActive ? 'Hide group' : 'Show group'}
              className={`p-1.5 rounded-lg transition-colors hover:bg-gray-700 ${g.isActive ? 'text-green-400 hover:text-green-300' : 'text-gray-500 hover:text-green-400'}`}>
              {g.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => onEdit(g)} title="Edit group"
              className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onMerge(g)} title="Merge into another group"
              className="p-1.5 text-gray-400 hover:text-purple-400 transition-colors rounded-lg hover:bg-gray-700">
              <MoveRight className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onDelete(g)} title="Delete group"
              className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden mb-3">
          <div className={`h-full rounded-full transition-all ${g.isTamil ? 'bg-orange-500' : 'bg-blue-500'}`}
            style={{ width: `${Math.min(100, (activeCount / Math.max(1, chCount)) * 100)}%` }} />
        </div>

        {/* Quick action buttons */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => { setSelectedGroup(g.name); setActiveTab('channels'); }}
            className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-lg transition-colors font-medium ${
              g.isTamil
                ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/20'
                : 'bg-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-white border border-gray-600/30'
            }`}>
            <Tv2 className="w-3 h-3" /> View Channels
          </button>
          {g.isTamil && (
            <button onClick={() => { setShowTamilOnly(true); setSelectedGroup(g.name); setActiveTab('channels'); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg text-xs hover:bg-orange-500/20">
              <Star className="w-3 h-3 fill-orange-400" /> Tamil
            </button>
          )}
          <button onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-700/50 border border-gray-600/30 text-gray-400 hover:text-white rounded-lg text-xs transition-colors">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Collapse' : 'Channels'}
          </button>
        </div>

        {/* Inline channel list */}
        {expanded && <GroupChannelList groupName={g.name} />}
      </div>
    </div>
  );
}

// ── Add/Edit Form ─────────────────────────────────────────────────────────────
function GroupFormPanel({
  editGroup,
  onSave,
  onClose,
}: {
  editGroup: Group | null;
  onSave: (f: GroupForm) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<GroupForm>({
    name: editGroup?.name || '',
    logo: editGroup?.logo || '',
  });

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4 shadow-xl">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold">{editGroup ? '✏️ Edit Group' : '➕ Add Group'}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
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
            placeholder="https://…" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
        <button onClick={() => {
          if (!form.name.trim()) { toast.error('Group name is required'); return; }
          onSave(form);
        }}
          className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
          <Save className="w-4 h-4" /> {editGroup ? 'Update' : 'Add'} Group
        </button>
      </div>
    </div>
  );
}

// ── Bulk group actions bar ────────────────────────────────────────────────────
function BulkGroupBar({
  selected,
  onToggleAll,
  onDeleteAll,
  onClear,
}: {
  selected: Set<string>;
  onToggleAll: (active: boolean) => void;
  onDeleteAll: () => void;
  onClear: () => void;
}) {
  if (selected.size === 0) return null;
  return (
    <div className="flex items-center gap-3 flex-wrap bg-yellow-900/20 border border-yellow-500/30 rounded-xl px-4 py-3">
      <span className="text-yellow-300 text-sm font-medium">{selected.size} groups selected</span>
      <div className="flex gap-2 flex-wrap ml-auto">
        <button onClick={() => onToggleAll(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 border border-green-500/30 text-green-400 rounded-lg text-xs font-medium">
          <Eye className="w-3 h-3" /> Show All
        </button>
        <button onClick={() => onToggleAll(false)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 border border-gray-600 text-gray-300 rounded-lg text-xs font-medium">
          <EyeOff className="w-3 h-3" /> Hide All
        </button>
        <button onClick={onDeleteAll}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 border border-red-500/30 text-red-400 rounded-lg text-xs font-medium">
          <Trash2 className="w-3 h-3" /> Delete ({selected.size})
        </button>
        <button onClick={onClear} className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-white text-xs">
          <X className="w-3 h-3" /> Clear
        </button>
      </div>
    </div>
  );
}

// ── Main GroupsTab ────────────────────────────────────────────────────────────
export default function GroupsTab() {
  const {
    groups, channels,
    addGroup, updateGroup, deleteGroup, toggleGroup,
    setActiveTab, setShowTamilOnly,
  } = useStore();

  const [showForm,     setShowForm]     = useState(false);
  const [editGroup,    setEditGroup]    = useState<Group | null>(null);
  const [mergeGroup,   setMergeGroup]   = useState<Group | null>(null);
  const [search,       setSearch]       = useState('');
  const [filterTamil,  setFilterTamil]  = useState(false);
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [sortBy,       setSortBy]       = useState<'name' | 'count' | 'tamil'>('count');

  const filteredGroups = useMemo(() => {
    let gs = [...groups];
    if (filterTamil) gs = gs.filter(g => g.isTamil);
    if (search)      gs = gs.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
    if (sortBy === 'count') gs.sort((a, b) => (b.channelCount || 0) - (a.channelCount || 0));
    if (sortBy === 'name')  gs.sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === 'tamil') gs.sort((a, b) => (b.isTamil ? 1 : 0) - (a.isTamil ? 1 : 0));
    return gs;
  }, [groups, filterTamil, search, sortBy]);

  const tamilGroups  = groups.filter(g => g.isTamil).length;
  const totalChannels= channels.length;
  const activeGroups = groups.filter(g => g.isActive).length;

  // ── Selection ─────────────────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const allSelected = filteredGroups.length > 0 && filteredGroups.every(g => selected.has(g.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(prev => { const n = new Set(prev); filteredGroups.forEach(g => n.delete(g.id)); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); filteredGroups.forEach(g => n.add(g.id)); return n; });
    }
  };

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleSave = (form: GroupForm) => {
    if (editGroup) {
      updateGroup(editGroup.id, { name: form.name, logo: form.logo || undefined });
      toast.success('✅ Group updated');
      setEditGroup(null);
    } else {
      addGroup({ name: form.name, logo: form.logo || undefined, isActive: true, order: groups.length });
      toast.success('✅ Group added');
    }
    setShowForm(false);
  };

  const handleDelete = (g: Group) => {
    const count = channels.filter(ch => ch.group === g.name).length;
    const msg   = count > 0
      ? `Delete "${g.name}" and move ${count} channels to Uncategorized?`
      : `Delete empty group "${g.name}"?`;
    if (!confirm(msg)) return;
    deleteGroup(g.id);
    toast.success(`🗑️ "${g.name}" deleted`);
  };

  const handleMerge = (targetName: string) => {
    if (!mergeGroup) return;
    const chans = channels.filter(ch => ch.group === mergeGroup.name);
    chans.forEach(ch => {
      useStore.getState().updateChannel(ch.id, { group: targetName });
    });
    deleteGroup(mergeGroup.id);
    toast.success(`✅ Merged "${mergeGroup.name}" → "${targetName}" (${chans.length} channels moved)`);
    setMergeGroup(null);
  };

  const handleBulkToggle = (active: boolean) => {
    selected.forEach(id => {
      const g = groups.find(gr => gr.id === id);
      if (g && g.isActive !== active) toggleGroup(id);
    });
    toast.success(`${active ? 'Showed' : 'Hidden'} ${selected.size} groups`);
    setSelected(new Set());
  };

  const handleBulkDelete = () => {
    const selGroups = groups.filter(g => selected.has(g.id));
    const totalChs  = selGroups.reduce((sum, g) => sum + (g.channelCount || 0), 0);
    if (!confirm(`Delete ${selected.size} groups${totalChs > 0 ? ` and move ${totalChs} channels to Uncategorized` : ''}?`)) return;
    selGroups.forEach(g => deleteGroup(g.id));
    toast.success(`🗑️ ${selected.size} groups deleted`);
    setSelected(new Set());
  };

  return (
    <div className="space-y-5">
      {/* Merge modal */}
      {mergeGroup && (
        <MergeModal sourceGroup={mergeGroup} onMerge={handleMerge} onClose={() => setMergeGroup(null)} />
      )}

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Groups</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {groups.length} groups · {activeGroups} active · {totalChannels.toLocaleString()} channels
            {tamilGroups > 0 && <span className="text-orange-400"> · {tamilGroups} Tamil</span>}
          </p>
        </div>
        <button onClick={() => { setShowForm(true); setEditGroup(null); }}
          className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          <Plus className="w-4 h-4" /> Add Group
        </button>
      </div>

      {/* ── Stats row ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Groups',   value: groups.length,          color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/20' },
          { label: 'Active Groups',  value: activeGroups,           color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
          { label: 'Tamil Groups',   value: tamilGroups,            color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
          { label: 'Total Channels', value: totalChannels,          color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
        ].map(s => (
          <div key={s.label} className={`${s.bg} border rounded-xl p-3 text-center`}>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value.toLocaleString()}</p>
            <p className="text-gray-500 text-xs mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── Add/Edit form ────────────────────────────────────────────── */}
      {(showForm || editGroup) && (
        <GroupFormPanel
          editGroup={editGroup}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditGroup(null); }}
        />
      )}

      {/* ── Bulk action bar ──────────────────────────────────────────── */}
      <BulkGroupBar
        selected={selected}
        onToggleAll={handleBulkToggle}
        onDeleteAll={handleBulkDelete}
        onClear={() => setSelected(new Set())}
      />

      {/* ── Filters + sort ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="Search groups…" />
        </div>

        {/* Tamil filter */}
        <button onClick={() => setFilterTamil(!filterTamil)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all border ${
            filterTamil
              ? 'bg-orange-500 border-orange-400 text-white shadow-lg shadow-orange-500/30'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:border-orange-600 hover:text-orange-400'
          }`}>
          <Star className={`w-4 h-4 ${filterTamil ? 'fill-white' : ''}`} />
          🎬 Tamil
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${filterTamil ? 'bg-orange-400 text-orange-900' : 'bg-gray-700 text-gray-400'}`}>
            {tamilGroups}
          </span>
        </button>

        {/* Sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
          <option value="count">Sort: Most Channels</option>
          <option value="name">Sort: Name A-Z</option>
          <option value="tamil">Sort: Tamil First</option>
        </select>

        {/* View Tamil channels */}
        <button onClick={() => { setShowTamilOnly(true); setActiveTab('channels'); }}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-medium transition-colors">
          <Star className="w-4 h-4 fill-white" /> All Tamil Channels
        </button>

        {/* Clear filters */}
        {(filterTamil || search) && (
          <button onClick={() => { setFilterTamil(false); setSearch(''); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm">
            <Filter className="w-3.5 h-3.5" /> Clear
          </button>
        )}
      </div>

      {/* ── Select-all row ───────────────────────────────────────────── */}
      {filteredGroups.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-gray-800/50 border border-gray-700/50 rounded-lg text-xs text-gray-400">
          <button onClick={toggleSelectAll} className="flex items-center gap-2 hover:text-white transition-colors">
            {allSelected
              ? <CheckSquare className="w-4 h-4 text-yellow-400" />
              : <Square className="w-4 h-4" />}
            {allSelected ? 'Deselect all' : `Select all (${filteredGroups.length})`}
          </button>
          <span className="text-gray-600">·</span>
          <span>{filteredGroups.length} groups shown</span>
        </div>
      )}

      {/* ── Groups grid ──────────────────────────────────────────────── */}
      {filteredGroups.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Layers className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-gray-400 font-medium text-lg">
            {filterTamil ? 'No Tamil groups found' : 'No groups yet'}
          </p>
          <p className="text-sm mt-1">
            {filterTamil
              ? 'Load Tamil sources to auto-create Tamil groups'
              : 'Groups are created automatically when you import channels'}
          </p>
          {!filterTamil && (
            <button onClick={() => { setShowForm(true); setEditGroup(null); }}
              className="mt-4 inline-flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> Add Group Manually
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredGroups.map(g => (
            <div key={g.id} className="relative">
              {/* Selection checkbox */}
              <button onClick={() => toggleSelect(g.id)}
                className="absolute top-3 left-3 z-10 text-gray-500 hover:text-yellow-400 transition-colors">
                {selected.has(g.id)
                  ? <CheckSquare className="w-4 h-4 text-yellow-400" />
                  : <Square className="w-4 h-4" />}
              </button>
              <div className="pl-7">
                <GroupCard
                  g={g}
                  onEdit={g => { setEditGroup(g); setShowForm(false); }}
                  onDelete={handleDelete}
                  onMerge={setMergeGroup}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
