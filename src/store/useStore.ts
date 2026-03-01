import { create } from 'zustand';
import { Channel, Group, Source, PlaylistConfig, DrmProxy, TabType } from '../types';
import { parseAny, generateM3U, isTamilChannel, fetchSourceContent } from '../utils/parser';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
const PLAYLIST_BASE = `${BASE_URL}/api/playlist`;

// ── Server sync helpers ────────────────────────────────────────────────────────
async function syncToServer(data: object): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* server may not be running in dev */ }
}

interface AppState {
  channels: Channel[];
  groups: Group[];
  sources: Source[];
  playlists: PlaylistConfig[];
  drmProxies: DrmProxy[];
  activeTab: TabType;
  selectedGroup: string | null;
  showTamilOnly: boolean;
  tamilSourceFilter: boolean;
  searchQuery: string;
  serverUrl: string;

  setActiveTab: (tab: TabType) => void;
  setSelectedGroup: (group: string | null) => void;
  setShowTamilOnly: (v: boolean) => void;
  setTamilSourceFilter: (v: boolean) => void;
  setSearchQuery: (q: string) => void;

  addSource: (source: Omit<Source, 'id' | 'status'>) => void;
  updateSource: (id: string, updates: Partial<Source>) => void;
  deleteSource: (id: string) => void;
  loadSource: (id: string) => Promise<void>;

  addChannel: (channel: Omit<Channel, 'id'>) => void;
  updateChannel: (id: string, updates: Partial<Channel>) => void;
  deleteChannel: (id: string) => void;
  toggleChannel: (id: string) => void;
  reorderChannels: (fromIdx: number, toIdx: number) => void;
  moveChannelToGroup: (channelId: string, groupName: string) => void;

  addGroup: (group: Omit<Group, 'id'>) => void;
  updateGroup: (id: string, updates: Partial<Group>) => void;
  deleteGroup: (id: string) => void;
  toggleGroup: (id: string) => void;

  createPlaylist: (name: string, includeGroups: string[], tamilOnly?: boolean) => PlaylistConfig;
  updatePlaylist: (id: string, updates: Partial<PlaylistConfig>) => void;
  deletePlaylist: (id: string) => void;
  getPlaylistM3U: (id: string) => string;

  addDrmProxy: (proxy: Omit<DrmProxy, 'id' | 'proxyUrl'>) => void;
  updateDrmProxy: (id: string, updates: Partial<DrmProxy>) => void;
  deleteDrmProxy: (id: string) => void;

  syncGroups: () => void;
  getFilteredChannels: () => Channel[];
  exportDB: () => string;
  syncDB: () => Promise<void>;
  setServerUrl: (url: string) => void;
  syncToServer: () => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  channels: [],
  groups: [],
  sources: [],
  playlists: [],
  drmProxies: [],
  activeTab: 'sources',
  selectedGroup: null,
  showTamilOnly: false,
  tamilSourceFilter: false,
  searchQuery: '',
  serverUrl: BASE_URL,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedGroup: (group) => set({ selectedGroup: group }),
  setShowTamilOnly: (v) => set({ showTamilOnly: v }),
  setTamilSourceFilter: (v) => set({ tamilSourceFilter: v }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  addSource: (source) => {
    const newSource: Source = { ...source, id: uuidv4(), status: 'idle' };
    set(s => ({ sources: [...s.sources, newSource] }));
    get().loadSource(newSource.id);
  },

  updateSource: (id, updates) => {
    set(s => ({ sources: s.sources.map(src => src.id === id ? { ...src, ...updates } : src) }));
  },

  deleteSource: (id) => {
    set(s => ({
      sources: s.sources.filter(src => src.id !== id),
      channels: s.channels.filter(ch => ch.sourceId !== id),
      drmProxies: s.drmProxies.filter(d => !s.channels.filter(ch => ch.sourceId === id).map(ch => ch.id).includes(d.channelId)),
    }));
    get().syncGroups();
    get().syncDB();
  },

  loadSource: async (id) => {
    const source = get().sources.find(s => s.id === id);
    if (!source) return;
    get().updateSource(id, { status: 'loading' });
    try {
      let content = '';
      if (source.content) content = source.content;
      else if (source.url) content = await fetchSourceContent(source.url);
      else throw new Error('No URL or content provided');

      const newChannels = parseAny(content, id);

      // Tag tamil channels
      const taggedChannels = newChannels.map(ch => ({
        ...ch,
        isTamil: isTamilChannel(ch),
      }));

      const tamilCount = taggedChannels.filter(ch => ch.isTamil).length;

      // Auto-create DRM proxies for DRM channels
      const drmChannels = taggedChannels.filter(c => c.isDrm && (c.drmKeyId || c.licenseKey));
      const existingProxyChannelIds = new Set(get().drmProxies.map(d => d.channelId));
      const newProxies: DrmProxy[] = drmChannels
        .filter(c => !existingProxyChannelIds.has(c.id))
        .map(c => ({
          id: uuidv4(),
          channelId: c.id,
          channelName: c.name,
          keyId: c.drmKeyId || '',
          key: c.drmKey || '',
          licenseType: c.licenseType || 'clearkey',
          licenseUrl: c.licenseKey || '',
          proxyUrl: `${BASE_URL}/proxy/drm/${c.id}`,
          isActive: true,
          notes: `Auto-created from source: ${source.name}`,
        }));

      set(s => ({
        channels: [
          ...s.channels.filter(ch => ch.sourceId !== id),
          ...taggedChannels,
        ],
        drmProxies: [...s.drmProxies, ...newProxies],
      }));

      get().updateSource(id, {
        status: 'success',
        lastRefreshed: new Date().toISOString(),
        channelCount: taggedChannels.length,
        tamilCount,
      });
      get().syncGroups();
      get().syncDB();
    } catch (err) {
      get().updateSource(id, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  },

  addChannel: (channel) => {
    const newCh: Channel = { ...channel, id: uuidv4(), isTamil: isTamilChannel(channel as Channel) };
    set(s => ({ channels: [...s.channels, newCh] }));
    get().syncGroups();
    get().syncDB();
  },

  updateChannel: (id, updates) => {
    set(s => ({
      channels: s.channels.map(ch => {
        if (ch.id !== id) return ch;
        const updated = { ...ch, ...updates };
        return { ...updated, isTamil: isTamilChannel(updated) };
      }),
    }));
    get().syncGroups();
    get().syncDB();
  },

  deleteChannel: (id) => {
    set(s => ({
      channels: s.channels.filter(ch => ch.id !== id),
      drmProxies: s.drmProxies.filter(d => d.channelId !== id),
    }));
    get().syncGroups();
    get().syncDB();
  },

  toggleChannel: (id) => {
    set(s => ({ channels: s.channels.map(ch => ch.id === id ? { ...ch, isActive: !ch.isActive } : ch) }));
    get().syncDB();
  },

  reorderChannels: (fromIdx, toIdx) => {
    set(s => {
      const chs = [...s.channels];
      const [moved] = chs.splice(fromIdx, 1);
      chs.splice(toIdx, 0, moved);
      return { channels: chs.map((c, i) => ({ ...c, order: i })) };
    });
    get().syncDB();
  },

  moveChannelToGroup: (channelId, groupName) => {
    set(s => ({ channels: s.channels.map(ch => ch.id === channelId ? { ...ch, group: groupName } : ch) }));
    get().syncGroups();
    get().syncDB();
  },

  addGroup: (group) => {
    const newGroup: Group = { ...group, id: uuidv4() };
    set(s => ({ groups: [...s.groups, newGroup] }));
    get().syncDB();
  },

  updateGroup: (id, updates) => {
    const old = get().groups.find(g => g.id === id);
    set(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, ...updates } : g) }));
    if (old && updates.name && old.name !== updates.name) {
      set(s => ({ channels: s.channels.map(ch => ch.group === old.name ? { ...ch, group: updates.name! } : ch) }));
    }
    get().syncDB();
  },

  deleteGroup: (id) => {
    const group = get().groups.find(g => g.id === id);
    set(s => ({ groups: s.groups.filter(g => g.id !== id) }));
    if (group) {
      set(s => ({ channels: s.channels.map(ch => ch.group === group.name ? { ...ch, group: 'Uncategorized' } : ch) }));
    }
    get().syncDB();
  },

  toggleGroup: (id) => {
    set(s => ({ groups: s.groups.map(g => g.id === id ? { ...g, isActive: !g.isActive } : g) }));
    get().syncDB();
  },

  syncGroups: () => {
    const { channels, groups } = get();
    const ss = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));
    const groupNames = [...new Set(channels.map(ch => ss(ch.group) || 'Uncategorized'))];
    const existingNames = new Set(groups.map(g => g.name));
    const newGroups: Group[] = [];
    groupNames.forEach(name => {
      if (!existingNames.has(name)) {
        const groupChannels = channels.filter(ch => ss(ch.group) === name);
        const isTamil = groupChannels.some(ch => ch.isTamil) || name.toLowerCase().includes('tamil');
        newGroups.push({
          id: uuidv4(), name, isActive: true,
          order: groups.length + newGroups.length, isTamil,
        });
      }
    });
    if (newGroups.length) set(s => ({ groups: [...s.groups, ...newGroups] }));
    set(s => ({
      groups: s.groups.map(g => ({
        ...g,
        channelCount: s.channels.filter(ch => ss(ch.group) === g.name).length,
        isTamil: g.isTamil || g.name.toLowerCase().includes('tamil') ||
          s.channels.filter(ch => ss(ch.group) === g.name).some(ch => ch.isTamil),
      })),
    }));
  },

  createPlaylist: (name, includeGroups, tamilOnly = false) => {
    const id = uuidv4();
    const playlist: PlaylistConfig = {
      id, name,
      generatedUrl: `${PLAYLIST_BASE}/${id}.m3u`,
      includeGroups,
      excludeGroups: [],
      tamilOnly,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    set(s => ({ playlists: [...s.playlists, playlist] }));
    get().syncDB();
    return playlist;
  },

  updatePlaylist: (id, updates) => {
    set(s => ({
      playlists: s.playlists.map(p => p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p),
    }));
    get().syncDB();
  },

  deletePlaylist: (id) => {
    set(s => ({ playlists: s.playlists.filter(p => p.id !== id) }));
    get().syncDB();
  },

  getPlaylistM3U: (id) => {
    const { playlists, channels } = get();
    const playlist = playlists.find(p => p.id === id);
    if (!playlist) return '';
    const filtered = channels.filter(ch => {
      if (!ch.isActive) return false;
      if (playlist.tamilOnly && !ch.isTamil) return false;
      if (playlist.includeGroups.length && !playlist.includeGroups.includes(ch.group)) return false;
      if (playlist.excludeGroups.includes(ch.group)) return false;
      return true;
    });
    return generateM3U(filtered, BASE_URL);
  },

  addDrmProxy: (proxy) => {
    const id = uuidv4();
    const newProxy: DrmProxy = { ...proxy, id, proxyUrl: `${BASE_URL}/proxy/drm/${id}` };
    set(s => ({ drmProxies: [...s.drmProxies, newProxy] }));
    get().syncDB();
  },

  updateDrmProxy: (id, updates) => {
    set(s => ({ drmProxies: s.drmProxies.map(d => d.id === id ? { ...d, ...updates } : d) }));
    get().syncDB();
  },

  deleteDrmProxy: (id) => {
    set(s => ({ drmProxies: s.drmProxies.filter(d => d.id !== id) }));
    get().syncDB();
  },

  getFilteredChannels: () => {
    const { channels, groups, selectedGroup, showTamilOnly, searchQuery } = get();
    const s = (v: unknown) => (typeof v === 'string' ? v : String(v ?? '')).toLowerCase();
    let filtered = [...channels];
    if (selectedGroup) filtered = filtered.filter(ch => ch.group === selectedGroup);
    if (showTamilOnly) filtered = filtered.filter(ch => ch.isTamil);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(ch =>
        s(ch.name).includes(q) ||
        s(ch.group).includes(q) ||
        s(ch.tvgId).includes(q) ||
        s(ch.language).includes(q) ||
        s(ch.tvgName).includes(q)
      );
    }
    const activeGroupNames = new Set(groups.filter(g => g.isActive).map(g => g.name));
    filtered = filtered.filter(ch => activeGroupNames.has(ch.group) || !groups.find(g => g.name === ch.group));
    return filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },

  exportDB: () => {
    const { channels, playlists, drmProxies, sources, groups } = get();
    return JSON.stringify({ channels, playlists, drmProxies, sources, groups }, null, 2);
  },

  syncDB: async () => {
    const { channels, playlists, drmProxies, sources, groups } = get();
    await syncToServer({ channels, playlists, drmProxies, sources, groups });
  },

  setServerUrl: (url: string) => {
    set({ serverUrl: url });
  },

  syncToServer: async () => {
    const { channels, playlists, drmProxies, sources, groups, serverUrl } = get();
    const url = serverUrl || BASE_URL;
    const resp = await fetch(`${url}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels, playlists, drmProxies, sources, groups }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}: ${resp.statusText}`);
  },
}));
