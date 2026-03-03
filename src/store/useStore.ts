import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Channel, Group, Source, PlaylistConfig, TabType } from '../types';
import { parseAny, generateM3U, fetchSourceContent } from '../utils/parser';
import { isTamilChannel } from '../utils/universalParser';
import { v4 as uuidv4 } from 'uuid';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_SERVER = typeof window !== 'undefined' ? window.location.origin : '';
const ss = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

function hasDRM(ch: Record<string, unknown>): boolean {
  return !!(ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId || ch.isDrm);
}

function normName(n: string) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

// ─── Auto-sync debounce ────────────────────────────────────────────────────────
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncToServer(serverUrl: string, data: object) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const url = serverUrl || DEFAULT_SERVER;
    if (!url || url.includes('localhost') || url.includes('127.0.0.1')) return;
    fetch(`${url}/api/sync`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'iptv-secret' },
      body   : JSON.stringify(data),
      signal : AbortSignal.timeout(15000),
    }).catch(() => { /* silent — server may be offline */ });
  }, 2000); // 2s debounce
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface AppState {
  channels          : Channel[];
  groups            : Group[];
  sources           : Source[];
  playlists         : PlaylistConfig[];
  activeTab         : TabType;
  selectedGroup     : string | null;
  showTamilOnly     : boolean;
  tamilSourceFilter : boolean;
  searchQuery       : string;
  serverUrl         : string;
  apiKey            : string;
  lastSyncTime      : number;
  hydrated          : boolean;

  setActiveTab         : (tab: TabType)         => void;
  setSelectedGroup     : (group: string | null) => void;
  setShowTamilOnly     : (v: boolean)           => void;
  setTamilSourceFilter : (v: boolean)           => void;
  setSearchQuery       : (q: string)            => void;
  setServerUrl         : (url: string)          => void;
  setApiKey            : (key: string)          => void;
  setHydrated          : (v: boolean)           => void;

  getSourceChannels      : (sourceId: string, tamilOnly?: boolean) => Channel[];
  getFilteredChannels    : () => Channel[];
  getMultiSourceChannels : () => Array<{ name: string; channels: Channel[] }>;

  addSource    : (source: Omit<Source, 'id' | 'status'>) => void;
  updateSource : (id: string, updates: Partial<Source>)  => void;
  deleteSource : (id: string)                            => void;
  loadSource   : (id: string)                            => Promise<void>;

  addChannel         : (channel: Omit<Channel, 'id'>)          => void;
  updateChannel      : (id: string, updates: Partial<Channel>) => void;
  deleteChannel      : (id: string)                            => void;
  toggleChannel      : (id: string)                            => void;
  reorderChannels    : (fromIdx: number, toIdx: number)        => void;
  moveChannelToGroup : (channelId: string, groupName: string)  => void;

  addGroup    : (group: Omit<Group, 'id'>)                => void;
  updateGroup : (id: string, updates: Partial<Group>)     => void;
  deleteGroup : (id: string)                              => void;
  toggleGroup : (id: string)                              => void;

  createPlaylist : (name: string, includeGroups: string[], tamilOnly?: boolean) => PlaylistConfig;
  updatePlaylist : (id: string, updates: Partial<PlaylistConfig>)                => void;
  deletePlaylist : (id: string)                                                  => void;
  getPlaylistM3U : (id: string)                                                  => string;

  pruneEmptyGroups         : () => void;
  removeNonTamilFromSource : (sourceId: string) => number;
  syncGroups               : () => void;
  tagMultiSourceChannels   : () => void;
  exportDB                 : () => string;

  // Server sync
  syncToServer   : () => Promise<void>;
  syncDB         : () => void;
  loadFromServer : (serverUrl?: string) => Promise<void>;
}

// ─── Store ─────────────────────────────────────────────────────────────────────
export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      channels          : [],
      groups            : [],
      sources           : [],
      playlists         : [],
      activeTab         : 'sources' as TabType,
      selectedGroup     : null,
      showTamilOnly     : false,
      tamilSourceFilter : false,
      searchQuery       : '',
      serverUrl         : DEFAULT_SERVER,
      apiKey            : 'iptv-secret',
      lastSyncTime      : 0,
      hydrated          : false,

      setActiveTab         : (tab)   => set({ activeTab: tab }),
      setSelectedGroup     : (group) => set({ selectedGroup: group }),
      setShowTamilOnly     : (v)     => set({ showTamilOnly: v }),
      setTamilSourceFilter : (v)     => set({ tamilSourceFilter: v }),
      setSearchQuery       : (q)     => set({ searchQuery: q }),
      setServerUrl         : (url)   => set({ serverUrl: url }),
      setApiKey            : (key)   => set({ apiKey: key }),
      setHydrated          : (v)     => set({ hydrated: v }),

      // ── Source channel helpers ─────────────────────────────────────────────
      getSourceChannels: (sourceId, tamilOnly = false) =>
        get().channels.filter(ch =>
          ch.sourceId === sourceId && (tamilOnly ? ch.isTamil : true)
        ),

      // ── Multi-source grouping ──────────────────────────────────────────────
      getMultiSourceChannels: () => {
        const { channels } = get();
        const byName: Record<string, Channel[]> = {};
        channels.forEach(ch => {
          const key = normName(ch.name);
          if (!byName[key]) byName[key] = [];
          byName[key].push(ch);
        });
        return Object.entries(byName)
          .filter(([, chs]) => chs.length > 1 && new Set(chs.map(c => c.sourceId)).size > 1)
          .map(([, chs]) => ({ name: chs[0].name, channels: chs }));
      },

      // ── Sources ────────────────────────────────────────────────────────────
      addSource: (source) => {
        const newSource: Source = { ...source, id: uuidv4(), status: 'idle' };
        set(s => ({ sources: [...s.sources, newSource] }));
        get().loadSource(newSource.id);
      },

      updateSource: (id, updates) => {
        set(s => ({
          sources: s.sources.map(src => src.id === id ? { ...src, ...updates } : src),
        }));
      },

      deleteSource: (id) => {
        set(s => ({
          sources  : s.sources.filter(src => src.id !== id),
          channels : s.channels.filter(ch  => ch.sourceId !== id),
        }));
        get().pruneEmptyGroups();
        get().syncDB();
      },

      loadSource: async (id) => {
        const state  = get();
        const source = state.sources.find(s => s.id === id);
        if (!source) return;

        get().updateSource(id, { status: 'loading' });

        try {
          let content = '';
          if (source.content)  content = source.content;
          else if (source.url) content = await fetchSourceContent(source.url);
          else throw new Error('No URL or content provided');

          const parsed = parseAny(content, id) as Array<Channel & Record<string, unknown>>;
          const directChannels = parsed.filter(ch => !hasDRM(ch));
          const drmCount       = parsed.length - directChannels.length;

          const taggedChannels: Channel[] = directChannels.map(ch => ({
            id          : ch.id,
            name        : ch.name,
            url         : ch.url,
            rawUrl      : ch.rawUrl,
            logo        : ch.logo,
            group       : ch.group || 'General',
            tvgId       : ch.tvgId,
            tvgName     : ch.tvgName,
            language    : ch.language,
            country     : ch.country,
            isActive    : true,
            enabled     : true,
            order       : ch.order ?? 0,
            sourceId    : id,
            tags        : ch.tags,
            streamType  : ch.streamType,
            userAgent   : ch.userAgent,
            referer     : ch.referer,
            cookie      : ch.cookie,
            httpHeaders : ch.httpHeaders,
            isTamil     : isTamilChannel(
              String(ch.name     || ''),
              String(ch.group    || ''),
              String(ch.language || '')
            ),
            healthStatus : 'unknown' as const,
          }));

          const tamilCount = taggedChannels.filter(ch => ch.isTamil).length;

          // ── MERGE: keep channels from OTHER sources, replace THIS source's channels ──
          set(s => ({
            channels: [
              ...s.channels.filter(ch => ch.sourceId !== id), // keep all other sources
              ...taggedChannels,                               // add/replace this source
            ],
          }));

          get().updateSource(id, {
            status        : 'success',
            lastRefreshed : new Date().toISOString(),
            channelCount  : taggedChannels.length,
            tamilCount,
            errorMessage  : drmCount > 0
              ? `✅ ${taggedChannels.length} direct channels. ${drmCount} DRM removed.`
              : undefined,
          });

          get().syncGroups();
          get().tagMultiSourceChannels();
          get().syncDB(); // auto-save to server after source load
        } catch (err) {
          get().updateSource(id, {
            status      : 'error',
            errorMessage: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      },

      // ── Tag multi-source channels ──────────────────────────────────────────
      tagMultiSourceChannels: () => {
        const { channels, sources } = get();
        const byName: Record<string, Channel[]> = {};
        channels.forEach(ch => {
          const key = normName(ch.name);
          if (!byName[key]) byName[key] = [];
          byName[key].push(ch);
        });
        const updated = channels.map(ch => {
          const key      = normName(ch.name);
          const siblings = byName[key] || [];
          const hasMulti = siblings.length > 1 &&
            new Set(siblings.map(c => c.sourceId)).size > 1;
          if (!hasMulti) return { ...ch, multiSource: false, combinedLinks: undefined };
          return {
            ...ch,
            multiSource  : true,
            combinedLinks: siblings.map(c => ({
              channelId : c.id,
              sourceId  : c.sourceId,
              sourceName: sources.find(s => s.id === c.sourceId)?.name || c.sourceId,
              url       : c.url,
              status    : 'unknown' as const,
            })),
          };
        });
        set({ channels: updated });
      },

      // ── Channels CRUD ──────────────────────────────────────────────────────
      addChannel: (channel) => {
        const newCh: Channel = {
          ...channel,
          id     : uuidv4(),
          group  : channel.group || 'General',
          isTamil: isTamilChannel(
            String(channel.name     || ''),
            String(channel.group    || ''),
            String(channel.language || '')
          ),
        };
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
            return {
              ...updated,
              group  : updated.group || 'General',
              isTamil: isTamilChannel(
                String(updated.name     || ''),
                String(updated.group    || ''),
                String(updated.language || '')
              ),
            };
          }),
        }));
        get().syncGroups();
        get().pruneEmptyGroups();
        get().syncDB();
      },

      deleteChannel: (id) => {
        const ch = get().channels.find(c => c.id === id);
        if (ch?.sourceId) {
          // Remember blocked channel in source so refresh won't re-add it
          const src = get().sources.find(s => s.id === ch.sourceId);
          if (src) {
            get().updateSource(ch.sourceId, {
              blockedChannelIds  : [...(src.blockedChannelIds   || []), id],
              blockedChannelNames: [...(src.blockedChannelNames || []),
                ch.name.toLowerCase()],
            });
          }
        }
        set(s => ({ channels: s.channels.filter(c => c.id !== id) }));
        get().pruneEmptyGroups();
        get().syncDB();
      },

      removeNonTamilFromSource: (sourceId) => {
        const { channels } = get();
        const toRemove = channels.filter(ch => ch.sourceId === sourceId && !ch.isTamil);
        const removedNames = toRemove.map(ch => ch.name.toLowerCase());
        const removedIds   = toRemove.map(ch => ch.id);

        // Remember in source so refresh won't re-add them
        const src = get().sources.find(s => s.id === sourceId);
        if (src) {
          get().updateSource(sourceId, {
            removedOthers      : true,
            blockedChannelIds  : [...(src.blockedChannelIds   || []), ...removedIds],
            blockedChannelNames: [...(src.blockedChannelNames || []), ...removedNames],
          });
        }

        set(s => ({
          channels: s.channels.filter(
            ch => !(ch.sourceId === sourceId && !ch.isTamil)
          ),
        }));
        get().pruneEmptyGroups();
        get().syncDB();
        return toRemove.length;
      },

      // ── Auto-delete empty groups — NO uncategorized fallback ──────────────
      pruneEmptyGroups: () => {
        const { channels, groups } = get();
        const usedGroups = new Set(
          channels.map(ch => ss(ch.group) || 'General').filter(Boolean)
        );
        const pruned = groups.filter(g => usedGroups.has(g.name));
        if (pruned.length !== groups.length) set({ groups: pruned });
      },

      toggleChannel: (id) => {
        set(s => ({
          channels: s.channels.map(ch =>
            ch.id === id ? { ...ch, isActive: !ch.isActive } : ch
          ),
        }));
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
        set(s => ({
          channels: s.channels.map(ch =>
            ch.id === channelId ? { ...ch, group: groupName } : ch
          ),
        }));
        get().syncGroups();
        get().pruneEmptyGroups();
        get().syncDB();
      },

      // ── Groups CRUD ────────────────────────────────────────────────────────
      addGroup: (group) => {
        const newGroup: Group = { ...group, id: uuidv4() };
        set(s => ({ groups: [...s.groups, newGroup] }));
        get().syncDB();
      },

      updateGroup: (id, updates) => {
        const old = get().groups.find(g => g.id === id);
        set(s => ({
          groups: s.groups.map(g => g.id === id ? { ...g, ...updates } : g),
        }));
        if (old && updates.name && old.name !== updates.name) {
          set(s => ({
            channels: s.channels.map(ch =>
              ch.group === old.name ? { ...ch, group: updates.name! } : ch
            ),
          }));
        }
        get().syncDB();
      },

      // Delete group AND all its channels — no fallback
      deleteGroup: (id) => {
        const grp = get().groups.find(g => g.id === id);
        if (!grp) return;
        set(s => ({
          groups  : s.groups.filter(g => g.id !== id),
          channels: s.channels.filter(ch => ch.group !== grp.name),
        }));
        get().syncDB();
      },

      toggleGroup: (id) => {
        set(s => ({
          groups: s.groups.map(g =>
            g.id === id ? { ...g, isActive: !g.isActive } : g
          ),
        }));
        get().syncDB();
      },

      // ── Auto-sync groups from channel data ─────────────────────────────────
      syncGroups: () => {
        const { channels, groups } = get();
        const groupNames    = [...new Set(channels.map(ch => ss(ch.group) || 'General').filter(Boolean))];
        const existingNames = new Set(groups.map(g => g.name));
        const newGroups: Group[] = [];

        groupNames.forEach(name => {
          if (!existingNames.has(name)) {
            const gc = channels.filter(ch => ss(ch.group) === name);
            newGroups.push({
              id      : uuidv4(),
              name,
              isActive: true,
              order   : groups.length + newGroups.length,
              isTamil : gc.some(ch => ch.isTamil) || name.toLowerCase().includes('tamil'),
            });
          }
        });

        if (newGroups.length) set(s => ({ groups: [...s.groups, ...newGroups] }));

        set(s => ({
          groups: s.groups.map(g => ({
            ...g,
            channelCount: s.channels.filter(ch => ss(ch.group) === g.name).length,
            isTamil:
              g.isTamil ||
              g.name.toLowerCase().includes('tamil') ||
              s.channels.filter(ch => ss(ch.group) === g.name).some(ch => ch.isTamil),
          })),
        }));

        get().pruneEmptyGroups();
      },

      // ── Playlists ──────────────────────────────────────────────────────────
      createPlaylist: (name, includeGroups, tamilOnly = false) => {
        const id       = uuidv4();
        const { serverUrl } = get();
        const base     = (serverUrl || DEFAULT_SERVER) + '/api/playlist';
        const playlist: PlaylistConfig = {
          id,
          name,
          generatedUrl   : `${base}/${id}.m3u`,
          includeGroups,
          excludeGroups  : [],
          tamilOnly,
          pinnedChannels : [],
          blockedChannels: [],
          createdAt      : new Date().toISOString(),
          updatedAt      : new Date().toISOString(),
        };
        set(s => ({ playlists: [...s.playlists, playlist] }));
        get().syncDB();
        return playlist;
      },

      updatePlaylist: (id, updates) => {
        set(s => ({
          playlists: s.playlists.map(p =>
            p.id === id
              ? { ...p, ...updates, updatedAt: new Date().toISOString() }
              : p
          ),
        }));
        get().syncDB();
      },

      deletePlaylist: (id) => {
        set(s => ({ playlists: s.playlists.filter(p => p.id !== id) }));
        get().syncDB();
      },

      getPlaylistM3U: (id) => {
        const { playlists, channels, serverUrl } = get();
        const playlist = playlists.find(p => p.id === id);
        if (!playlist) return '';
        const pinned  = new Set(playlist.pinnedChannels  || []);
        const blocked = new Set(playlist.blockedChannels || []);
        const filtered = channels.filter(ch => {
          if (blocked.has(ch.id)) return false;
          if (pinned.has(ch.id))  return true;
          if (!ch.isActive)       return false;
          if (playlist.tamilOnly && !ch.isTamil)                              return false;
          if (playlist.includeGroups.length &&
              !playlist.includeGroups.includes(ch.group))                     return false;
          if (playlist.excludeGroups.includes(ch.group))                      return false;
          return true;
        });
        filtered.sort((a, b) => {
          const ap = pinned.has(a.id) ? 0 : 1;
          const bp = pinned.has(b.id) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return (a.order ?? 0) - (b.order ?? 0);
        });
        return generateM3U(filtered, serverUrl || DEFAULT_SERVER);
      },

      // ── Filtered channel view ──────────────────────────────────────────────
      getFilteredChannels: () => {
        const { channels, groups, selectedGroup, showTamilOnly, searchQuery } = get();
        const sv = (v: unknown) =>
          (typeof v === 'string' ? v : String(v ?? '')).toLowerCase();
        let filtered = [...channels];
        if (selectedGroup) filtered = filtered.filter(ch => ch.group === selectedGroup);
        if (showTamilOnly) filtered = filtered.filter(ch => ch.isTamil);
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filtered = filtered.filter(ch =>
            sv(ch.name).includes(q)     ||
            sv(ch.group).includes(q)    ||
            sv(ch.tvgId).includes(q)    ||
            sv(ch.language).includes(q) ||
            sv(ch.tvgName).includes(q)
          );
        }
        const activeGroupNames = new Set(
          groups.filter(g => g.isActive).map(g => g.name)
        );
        filtered = filtered.filter(
          ch => activeGroupNames.has(ch.group) || !groups.find(g => g.name === ch.group)
        );
        return filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      },

      // ── DB export ──────────────────────────────────────────────────────────
      exportDB: () => {
        const { channels, playlists, sources, groups } = get();
        return JSON.stringify({ channels, playlists, sources, groups }, null, 2);
      },

      // ── Auto-sync to server (debounced 2s) ────────────────────────────────
      syncDB: () => {
        const { channels, playlists, sources, groups, serverUrl } = get();
        const url = serverUrl || DEFAULT_SERVER;
        scheduleSyncToServer(url, { channels, playlists, sources, groups });
      },

      // ── Manual sync to server (immediate) ─────────────────────────────────
      syncToServer: async () => {
        const { channels, playlists, sources, groups, serverUrl, apiKey } = get();
        const url = serverUrl || DEFAULT_SERVER;
        const resp = await fetch(`${url}/api/sync`, {
          method : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key'   : apiKey || 'iptv-secret',
          },
          body: JSON.stringify({ channels, playlists, sources, groups }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }));
          throw new Error(`Server sync failed: ${err.error || resp.status}`);
        }
        set({ lastSyncTime: Date.now() });
      },

      // ── Load from server on startup + MERGE ───────────────────────────────
      loadFromServer: async (overrideUrl?: string) => {
        const url = overrideUrl || get().serverUrl || DEFAULT_SERVER;
        if (!url || url.includes('localhost') || url.includes('127.0.0.1')) {
          set({ hydrated: true });
          return;
        }

        try {
          const resp = await fetch(`${url}/api/db`, {
            headers: { 'X-Api-Key': get().apiKey || 'iptv-secret' },
            signal : AbortSignal.timeout(10000),
          });

          if (!resp.ok) {
            set({ hydrated: true });
            return;
          }

          const serverData = await resp.json();
          const local      = get();

          // ── SMART MERGE: never lose data from either side ──────────────────
          const mergeById = <T extends { id: string }>(
            local: T[],
            remote: T[]
          ): T[] => {
            const map = new Map<string, T>();
            // remote first (server is source of truth)
            (remote || []).forEach(item => map.set(item.id, item));
            // local items not in remote — add them (locally-added since last sync)
            (local || []).forEach(item => {
              if (!map.has(item.id)) map.set(item.id, item);
            });
            return Array.from(map.values());
          };

          const mergedChannels  = mergeById(local.channels,  serverData.channels  || []);
          const mergedSources   = mergeById(local.sources,   serverData.sources   || []);
          const mergedGroups    = mergeById(local.groups,     serverData.groups    || []);
          const mergedPlaylists = mergeById(local.playlists, serverData.playlists || []);

          set({
            channels  : mergedChannels,
            sources   : mergedSources,
            groups    : mergedGroups,
            playlists : mergedPlaylists,
            hydrated  : true,
          });

          // Push merged result back to server so both sides stay in sync
          const { apiKey } = get();
          fetch(`${url}/api/sync`, {
            method : 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key'   : apiKey || 'iptv-secret',
            },
            body: JSON.stringify({
              channels : mergedChannels,
              sources  : mergedSources,
              groups   : mergedGroups,
              playlists: mergedPlaylists,
            }),
          }).catch(() => {});

        } catch {
          // Server offline — use localStorage data (already in state via persist)
          set({ hydrated: true });
        }
      },
    }),
    {
      name   : 'iptv-manager-v2',          // localStorage key
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({            // only persist data, not functions/ui state
        channels     : state.channels,
        sources      : state.sources,
        groups       : state.groups,
        playlists    : state.playlists,
        serverUrl    : state.serverUrl,
        apiKey       : state.apiKey,
        lastSyncTime : state.lastSyncTime,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    }
  )
);
