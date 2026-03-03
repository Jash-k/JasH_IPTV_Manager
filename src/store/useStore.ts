import { create } from 'zustand';
import { Channel, Group, Source, PlaylistConfig, DrmProxy, TabType, CombinedLink } from '../types';
import { parseAny, generateM3U, isTamilChannel } from '../utils/parser';
import { fetchUrl as fetchSourceContent } from '../utils/fetcher';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:10000';
const PLAYLIST_BASE = `${BASE_URL}/api/playlist`;

async function syncToServer(data: object): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* server may not be running in dev */ }
}

interface BestLinkResult {
  channelName: string;
  totalLinks: number;
  liveLinks: number;
  best: { id: string; url: string; latency: number; isDrm: boolean } | null;
  all: Array<{ id: string; url: string; ok: boolean; latency: number; isDrm: boolean }>;
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
  editingPlaylistId: string | null;

  setEditingPlaylistId: (id: string | null) => void;
  setActiveTab: (tab: TabType) => void;
  setSelectedGroup: (group: string | null) => void;
  setShowTamilOnly: (v: boolean) => void;
  setTamilSourceFilter: (v: boolean) => void;
  setSearchQuery: (q: string) => void;
  setServerUrl: (url: string) => void;

  getSourceChannels: (sourceId: string, tamilOnly?: boolean) => Channel[];
  getFilteredChannels: () => Channel[];
  getMultiSourceChannels: () => Array<{ name: string; channels: Channel[] }>;

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
  exportDB: () => string;
  syncDB: () => Promise<void>;
  syncToServer: () => Promise<void>;

  // Best link — query server for fastest live link among same-named channels
  getBestLink: (channelName: string) => Promise<BestLinkResult | null>;
  // Tag multi-source channels (same name, multiple sources)
  tagMultiSourceChannels: () => void;
  // Check combined link statuses for a specific channel name
  checkCombinedLinks: (channelName: string) => Promise<CombinedLink[]>;
}

function normName(n: string) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
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
  editingPlaylistId: null,

  setEditingPlaylistId: (id) => set({ editingPlaylistId: id }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedGroup: (group) => set({ selectedGroup: group }),
  setShowTamilOnly: (v) => set({ showTamilOnly: v }),
  setTamilSourceFilter: (v) => set({ tamilSourceFilter: v }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setServerUrl: (url) => set({ serverUrl: url }),

  getSourceChannels: (sourceId, tamilOnly = false) => {
    return get().channels.filter(ch => ch.sourceId === sourceId && (tamilOnly ? ch.isTamil : true));
  },

  // Returns groups of channels with the same name from different sources
  getMultiSourceChannels: () => {
    const { channels, sources } = get();
    const byName: Record<string, Channel[]> = {};
    channels.forEach(ch => {
      const key = normName(ch.name);
      if (!byName[key]) byName[key] = [];
      byName[key].push(ch);
    });
    return Object.entries(byName)
      .filter(([, chs]) => chs.length > 1 && new Set(chs.map(c => c.sourceId)).size > 1)
      .map(([, chs]) => ({
        name: chs[0].name,
        channels: chs.map(ch => ({
          ...ch,
          combinedLinks: chs.map(c => ({
            channelId: c.id,
            sourceId:  c.sourceId,
            sourceName: sources.find(s => s.id === c.sourceId)?.name || c.sourceId,
            url:       c.url,
            isDrm:     !!(c.isDrm || c.licenseType),
            status:    'unknown' as const,
          })),
          multiSource: true,
        })),
      }));
  },

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

      const parsed = parseAny(content, id);

      // ── STRIP DRM channels immediately on import ──────────────────────────
      const isDRM = (ch: Channel) => !!(
        ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId || ch.isDrm
      );

      const directChannels = parsed.filter(ch => !isDRM(ch));
      const drmCount       = parsed.length - directChannels.length;

      // Tag Tamil
      const taggedChannels = directChannels.map(ch => ({
        ...ch,
        isTamil: isTamilChannel(ch),
        enabled: true,
        isActive: true,
      }));

      const tamilCount = taggedChannels.filter(ch => ch.isTamil).length;

      set(s => ({
        channels: [...s.channels.filter(ch => ch.sourceId !== id), ...taggedChannels],
      }));

      get().updateSource(id, {
        status: 'success',
        lastRefreshed: new Date().toISOString(),
        channelCount: taggedChannels.length,
        tamilCount,
        errorMessage: drmCount > 0
          ? `✅ ${taggedChannels.length} direct channels loaded. ${drmCount} DRM streams removed.`
          : undefined,
      });
      get().syncGroups();
      get().tagMultiSourceChannels();
      get().syncDB();
    } catch (err) {
      get().updateSource(id, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  },

  // Tag channels that appear in multiple sources
  tagMultiSourceChannels: () => {
    const { channels, sources } = get();
    const byName: Record<string, Channel[]> = {};
    channels.forEach(ch => {
      const key = normName(ch.name);
      if (!byName[key]) byName[key] = [];
      byName[key].push(ch);
    });
    const updated = channels.map(ch => {
      const key = normName(ch.name);
      const siblings = byName[key] || [];
      const hasMultiple = siblings.length > 1 && new Set(siblings.map(c => c.sourceId)).size > 1;
      if (!hasMultiple) return { ...ch, multiSource: false, combinedLinks: undefined };
      return {
        ...ch,
        multiSource: true,
        combinedLinks: siblings.map(c => ({
          channelId:  c.id,
          sourceId:   c.sourceId,
          sourceName: sources.find(s => s.id === c.sourceId)?.name || c.sourceId,
          url:        c.url,
          isDrm:      !!(c.isDrm || c.licenseType),
          status:     'unknown' as const,
        })),
      };
    });
    set({ channels: updated });
  },

  addChannel: (channel) => {
    const newCh: Channel = { ...channel, id: uuidv4(), isTamil: isTamilChannel(channel as Channel) };
    set(s => ({ channels: [...s.channels, newCh] }));
    get().syncGroups();
    get().tagMultiSourceChannels();
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
        const gc = channels.filter(ch => ss(ch.group) === name);
        newGroups.push({ id: uuidv4(), name, isActive: true, order: groups.length + newGroups.length, isTamil: gc.some(ch => ch.isTamil) || name.toLowerCase().includes('tamil') });
      }
    });
    if (newGroups.length) set(s => ({ groups: [...s.groups, ...newGroups] }));
    set(s => ({
      groups: s.groups.map(g => ({
        ...g,
        channelCount: s.channels.filter(ch => ss(ch.group) === g.name).length,
        isTamil: g.isTamil || g.name.toLowerCase().includes('tamil') || s.channels.filter(ch => ss(ch.group) === g.name).some(ch => ch.isTamil),
      })),
    }));
  },

  createPlaylist: (name, includeGroups, tamilOnly = false) => {
    const id = uuidv4();
    const playlist: PlaylistConfig = {
      id, name,
      generatedUrl: `${PLAYLIST_BASE}/${id}.m3u`,
      includeGroups, excludeGroups: [], tamilOnly,
      pinnedChannels: [], blockedChannels: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    set(s => ({ playlists: [...s.playlists, playlist] }));
    get().syncDB();
    return playlist;
  },

  updatePlaylist: (id, updates) => {
    set(s => ({ playlists: s.playlists.map(p => p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p) }));
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
    const pinned  = new Set(playlist.pinnedChannels || []);
    const blocked = new Set(playlist.blockedChannels || []);
    const filtered = channels.filter(ch => {
      if (blocked.has(ch.id)) return false;
      if (pinned.has(ch.id)) return true;
      if (!ch.isActive) return false;
      if (playlist.tamilOnly && !ch.isTamil) return false;
      if (playlist.includeGroups.length && !playlist.includeGroups.includes(ch.group)) return false;
      if (playlist.excludeGroups.includes(ch.group)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const ap = pinned.has(a.id) ? 0 : 1;
      const bp = pinned.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.order ?? 0) - (b.order ?? 0);
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
      filtered = filtered.filter(ch => s(ch.name).includes(q) || s(ch.group).includes(q) || s(ch.tvgId).includes(q) || s(ch.language).includes(q) || s(ch.tvgName).includes(q));
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

  // Query server for best live link among same-named channels
  getBestLink: async (channelName: string) => {
    const { serverUrl } = get();
    const base = serverUrl || BASE_URL;
    try {
      const resp = await fetch(`${base}/api/bestlink/${encodeURIComponent(channelName)}`, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return null;
      return await resp.json() as BestLinkResult;
    } catch { return null; }
  },

  // Check all combined links for a channel name — returns sorted by latency
  checkCombinedLinks: async (channelName: string) => {
    const { channels, sources, serverUrl } = get();
    const base = serverUrl || BASE_URL;
    const key  = normName(channelName);
    const matching = channels.filter(ch => normName(ch.name) === key);
    if (matching.length === 0) return [];

    try {
      const resp = await fetch(`${base}/api/health/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: matching.map(ch => ch.id) }),
        signal: AbortSignal.timeout(20000),
      });
      const data = resp.ok ? await resp.json() : { results: {} };

      const links: CombinedLink[] = matching.map(ch => {
        const result = data.results?.[ch.id];
        return {
          channelId:  ch.id,
          sourceId:   ch.sourceId,
          sourceName: sources.find(s => s.id === ch.sourceId)?.name || ch.sourceId,
          url:        ch.url,
          isDrm:      !!(ch.isDrm || ch.licenseType),
          latency:    result?.latency ?? 9999,
          status:     result?.ok ? 'live' : 'dead',
        };
      });

      // Update channel health in store
      set(s => ({
        channels: s.channels.map(ch => {
          const r = data.results?.[ch.id];
          if (!r) return ch;
          return { ...ch, healthStatus: r.ok ? 'ok' : 'error', healthLatency: r.latency };
        }),
      }));

      return links.sort((a, b) => (a.latency ?? 9999) - (b.latency ?? 9999));
    } catch {
      return matching.map(ch => ({
        channelId:  ch.id,
        sourceId:   ch.sourceId,
        sourceName: sources.find(s => s.id === ch.sourceId)?.name || ch.sourceId,
        url:        ch.url,
        isDrm:      !!(ch.isDrm || ch.licenseType),
        status:     'unknown' as const,
      }));
    }
  },
}));
