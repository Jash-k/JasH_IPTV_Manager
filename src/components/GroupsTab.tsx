import { useState, useMemo } from 'react';
import { Group } from '../types';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

interface Props { store: AppStore; }

const GROUP_COLORS = [
  '#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1'
];

export const GroupsTab: React.FC<Props> = ({ store }) => {
  const { groups, streams, createGroup, deleteGroup, renameGroup } = store;
  const [newGroupName, setNewGroupName] = useState('');
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const groupStats = useMemo(() => {
    return groups.map(g => ({
      ...g,
      total: streams.filter(s => s.group === g.name).length,
      enabled: streams.filter(s => s.group === g.name && s.enabled).length,
      alive: streams.filter(s => s.group === g.name && s.status === 'alive').length,
      dead: streams.filter(s => s.group === g.name && s.status === 'dead').length,
    }));
  }, [groups, streams]);

  const filtered = useMemo(() =>
    groupStats.filter(g => !search || g.name.toLowerCase().includes(search.toLowerCase())),
    [groupStats, search]
  );

  const handleCreate = async () => {
    if (!newGroupName.trim()) return;
    await createGroup(newGroupName.trim());
    setNewGroupName('');
  };

  const handleRename = async () => {
    if (!editGroup || !editName.trim()) return;
    await renameGroup(editGroup.id, editName.trim());
    setEditGroup(null);
    setEditName('');
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) { setDeleteConfirm(id); return; }
    setDeleteConfirm(null);
    await deleteGroup(id);
  };

  return (
    <div className="space-y-5">
      {/* Create Group */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
        <h3 className="text-white font-semibold mb-3">📂 Create New Group</h3>
        <div className="flex gap-3">
          <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="Group name..." className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600" />
          <button onClick={handleCreate}
            className="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-medium text-sm transition-colors">
            + Create
          </button>
        </div>
      </div>

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)}
        placeholder="🔍 Search groups..."
        className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-700" />

      {/* Stats Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Groups', value: groups.length, icon: '📂', color: 'text-purple-400' },
          { label: 'Total Streams', value: streams.length.toLocaleString(), icon: '📺', color: 'text-blue-400' },
          { label: 'Alive Streams', value: streams.filter(s => s.status === 'alive').length.toLocaleString(), icon: '✅', color: 'text-emerald-400' },
          { label: 'Dead Streams', value: streams.filter(s => s.status === 'dead').length.toLocaleString(), icon: '❌', color: 'text-red-400' },
        ].map(stat => (
          <div key={stat.label} className="bg-gray-800 rounded-xl p-4 border border-gray-700 text-center">
            <div className="text-2xl mb-1">{stat.icon}</div>
            <div className={cn('text-2xl font-bold', stat.color)}>{stat.value}</div>
            <div className="text-gray-500 text-xs mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Groups List */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.length === 0 && (
          <div className="col-span-full text-center py-12 text-gray-500">
            <div className="text-5xl mb-4">📂</div>
            <div className="text-lg font-medium text-gray-400">No groups found</div>
            <div className="text-sm mt-2">Groups are created automatically from your M3U sources</div>
          </div>
        )}

        {filtered.map((group, idx) => {
          const color = GROUP_COLORS[idx % GROUP_COLORS.length];
          const pct = group.total > 0 ? Math.round((group.alive / group.total) * 100) : 0;
          return (
            <div key={group.id} className="bg-gray-800 rounded-xl p-4 border border-gray-700 hover:border-gray-600 transition-all">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-white font-medium truncate">{group.name}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  <button onClick={() => { setEditGroup(groups.find(g => g.id === group.id) || null); setEditName(group.name); }}
                    className="p-1.5 rounded-lg bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white transition-colors text-xs">
                    ✏️
                  </button>
                  <button onClick={() => handleDelete(group.id)}
                    className={cn('p-1.5 rounded-lg transition-colors text-xs',
                      deleteConfirm === group.id ? 'bg-red-600 text-white animate-pulse' : 'bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white'
                    )}>
                    {deleteConfirm === group.id ? '⚠️' : '🗑️'}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{group.total.toLocaleString()} streams</span>
                  {group.total > 0 && group.alive > 0 && (
                    <span className="text-emerald-400">{pct}% alive</span>
                  )}
                </div>

                {group.alive > 0 || group.dead > 0 ? (
                  <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                ) : null}

                <div className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500">{group.enabled.toLocaleString()} enabled</span>
                  {group.alive > 0 && <span className="text-emerald-400">✅ {group.alive}</span>}
                  {group.dead > 0 && <span className="text-red-400">❌ {group.dead}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit Modal */}
      {editGroup && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setEditGroup(null)}>
          <div className="bg-gray-800 rounded-2xl p-6 border border-gray-600 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-bold text-lg">✏️ Rename Group</h3>
            <input value={editName} onChange={e => setEditName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRename()}
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 border border-gray-600" />
            <div className="flex gap-3">
              <button onClick={handleRename} className="flex-1 bg-purple-600 hover:bg-purple-500 text-white py-3 rounded-xl font-medium text-sm transition-colors">
                ✓ Rename
              </button>
              <button onClick={() => setEditGroup(null)} className="px-5 bg-gray-700 hover:bg-gray-600 text-white py-3 rounded-xl text-sm transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
