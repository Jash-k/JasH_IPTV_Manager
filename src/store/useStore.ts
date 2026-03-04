/**
 * IPTV Manager Store — Overlay/Delta Architecture + Supabase Persistence
 *
 * KEY PRINCIPLE: Never modify source data directly.
 * User modifications (deletions, renames, group removes) are stored as rules
 * and re-applied every time a source refreshes.
 *
 * Persistence layers:
 *   1. Supabase  (cloud DB — survives everything, no quota limit)
 *   2. Server /api/db (Render disk db.json — fallback)
 *   3. sessionStorage (in-tab session — last resort)
 *
 * On startup : Load Supabase → merge with server → display
 * On change  : Debounced 2s → save to Supabase + server
 */

import { create }    from 'zustand';
import { Channel, Group, Source, PlaylistConfig, TabType } from '../types';
import { parseAny, generateM3U, fetchSourceContent }       from '../utils/parser';
import { isTamilChannel }                                  from '../utils/universalParser';
import { saveToSupabase, loadFromSupabase, SUPABASE_ENABLED } from '../lib/supabase';
import {
  ModificationStore, EMPTY_MODS,
  applyModifications,
  makeRemovedRule, makeNonTamilRules,
  makeGroupRemoveRule, makeGroupRenameRule,
  GroupRule, ChannelOverride,
} from '../utils/modifications';
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

// ─── Session cache ────────────────────────────────────────────────────────────
function saveSession(data: object) {
  try { sessionStorage.setItem('iptv_session_v2', JSON.stringify(data)); } catch { /* ignore */ }
}
function loadSession(): Partial<AppState> | null {
  try {
    const raw = sessionStorage.getItem('iptv_session_v2');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ─── Debounced save ───────────────────────────────────────────────────────────
let saveTimer  : ReturnType<typeof setTimeout> | null = null;
let syncTimer  : ReturnType<typeof setTimeout> | null = null;

function debouncedSave(state: AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const payload = {
      channels     : state.channels,
      sources      : state.sources,
      groups       : state.groups,
      playlists    : state.playlists,
      modifications: state.modifications,
      serverUrl    : state.serverUrl,
      apiKey       : state.apiKey,
      savedAt      : Date.now(),
    };

    // 1. Session storage (instant)
    saveSession(payload);

    // 2. Supabase (cloud)
    if (SUPABASE_ENABLED) {
      await saveToSupabase(payload).catch(() => {});
    }

    // 3. Server (Render disk) — extra 5s delay
    const url = state.serverUrl || DEFAULT_SERVER;
    if (url && !url.includes('localhost:517') && !url.includes('127.0.0.1')) {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        fetch(`${url}/api/sync`, {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': state.apiKey || 'iptv-secret' },
          body   : JSON.stringify(payload),
          signal : AbortSignal.timeout(15000),
        }).catch(() => {});
      }, 5000);
    }
  }, 2000);
}

// ─── Merge helpers ────────────────────────────────────────────────────────────
function mergeById<T extends { id: string }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  (remote || []).forEach(item => map.set(item.id, item));
  (local  || []).forEach(item => { if (!map.has(item.id)) map.set(item.id, item); });
  return Array.from(map.values());
}

function mergeMods(local: ModificationStore, remote: ModificationStore): ModificationStore {
  // Merge by key uniqueness
  const removedMap = new Map<string, typeof local.removedChannels[0]>();
  [...(remote.removedChannels || []), ...(local.removedChannels || [])].forEach(r => {
    removedMap.set(`${r.matchType}:${r.channelKey}:${r.sourceId || '*'}`, r);
  });
  const overridesMap = new Map<string, ChannelOverride>();
  [...(remote.channelOverrides || []), ...(local.channelOverrides || [])].forEach(o => {
    overridesMap.set(`${o.matchType}:${o.channelKey}:${o.sourceId || '*'}`, o);
  });
  const groupRulesMap = new Map<string, GroupRule>();
  [...(remote.groupRules || []), ...(local.groupRules || [])].forEach(g => {
    groupRulesMap.set(g.id, g);
  });
  return {
    removedChannels  : Array.from(removedMap.values()),
    channelOverrides : Array.from(overridesMap.values()),
    groupRules       : Array.from(groupRulesMap.values()),
    customChannels   : mergeById(local.customChannels || [], remote.customChannels || []) as typeof local.customChannels,
  };
}

// ─── Store types ──────────────────────────────────────────────────────────────
export interface AppState {
  channels      : Channel[];
  groups        : Group[];
  sources       : Source[];
  playlists     : PlaylistConfig[];
  modifications : ModificationStore;
  activeTab     : TabType;
  selectedGroup : string | null;
  showTamilOnly : boolean;
  tamilSourceFilter: boolean;
  searchQuery   : string;
  serverUrl     : string;
  apiKey        : string;
  lastSyncTime  : number;
  hydrated      : boolean;
  supabaseOk    : boolean;

  // Settings
  setActiveTab         : (tab: TabType)         => void;
  setSelectedGroup     : (group: string | null) => void;
  setShowTamilOnly     : (v: boolean)           => void;
  setTamilSourceFilter : (v: boolean)           => void;
  setSearchQuery       : (q: string)            => void;
  setServerUrl         : (url: string)          => void;
  setApiKey            : (key: string)          => void;
  setHydrated          : (v: boolean)           => void;

  // Queries
  getFilteredChannels    : () => Channel[];
  getSourceChannels      : (sourceId: string, tamilOnly?: boolean) => Channel[];
  getMultiSourceChannels : () => Array<{ name: string; channels: Channel[] }>;

  // Sources
  addSource    : (source: Omit<Source, 'id' | 'status'>) => void;
  updateSource : (id: string, updates: Partial<Source>)  => void;
  deleteSource : (id: string)                            => void;
  loadSource   : (id: string)                            => Promise<void>;

  // Channels CRUD
  addChannel         : (channel: Omit<Channel, 'id'>)          => void;
  updateChannel      : (id: string, updates: Partial<Channel>) => void;
  deleteChannel      : (id: string)                            => void;
  toggleChannel      : (id: string)                            => void;
  reorderChannels    : (fromIdx: number, toIdx: number)        => void;
  moveChannelToGroup : (channelId: string, groupName: string)  => void;

  // Groups CRUD
  addGroup    : (group: Omit<Group, 'id'>)            => void;
  updateGroup : (id: string, updates: Partial<Group>) => void;
  deleteGroup : (id: string)                          => void;
  toggleGroup : (id: string)                          => void;

  // Playlists
  createPlaylist : (name: string, includeGroups: string[], tamilOnly?: boolean) => PlaylistConfig;
  updatePlaylist : (id: string, updates: Partial<PlaylistConfig>)                => void;
  deletePlaylist : (id: string)                                                  => void;
  getPlaylistM3U : (id: string)                                                  => string;

  // Modification rules (overlay/delta)
  addRemovedRule   : (rule: ModificationStore['removedChannels'][0])  => void;
  addOverrideRule  : (rule: ChannelOverride)                          => void;
  addGroupRule     : (rule: GroupRule)                                => void;
  removeGroupRule  : (id: string)                                     => void;
  clearModsForSource : (sourceId: string)                             => void;

  // Helpers
  pruneEmptyGroups         : () => void;
  removeNonTamilFromSource : (sourceId: string) => number;
  syncGroups               : () => void;
  tagMultiSourceChannels   : () => void;
  exportDB                 : () => string;

  // Persistence
  syncDB          : () => void;
  syncToServer    : () => Promise<void>;
  loadFromServer  : (url?: string) => Promise<void>;
  initFromStorage : () => Promise<void>;
}

// ─── Store ────────────────────────────────────────────────────────────────────
export const useStore = create<AppState>()((set, get) => ({
  channels      : [],
  groups        : [],
  sources       : [],
  playlists     : [],
  modifications : { ...EMPTY_MODS },
  activeTab     : 'sources' as TabType,
  selectedGroup : null,
  showTamilOnly : false,
  tamilSourceFilter: false,
  searchQuery   : '',
  serverUrl     : DEFAULT_SERVER,
  apiKey        : 'iptv-secret',
  lastSyncTime  : 0,
  hydrated      : false,
  supabaseOk    : SUPABASE_ENABLED,

  // ── Settings ────────────────────────────────────────────────────────────────
  setActiveTab         : tab   => set({ activeTab: tab }),
  setSelectedGroup     : group => set({ selectedGroup: group }),
  setShowTamilOnly     : v     => set({ showTamilOnly: v }),
  setTamilSourceFilter : v     => set({ tamilSourceFilter: v }),
  setSearchQuery       : q     => set({ searchQuery: q }),
  setServerUrl         : url   => { set({ serverUrl: url }); get().syncDB(); },
  setApiKey            : key   => { set({ apiKey: key });    get().syncDB(); },
  setHydrated          : v     => set({ hydrated: v }),

  // ── Queries ─────────────────────────────────────────────────────────────────
  getSourceChannels: (sourceId, tamilOnly = false) =>
    get().channels.filter(ch =>
      ch.sourceId === sourceId && (tamilOnly ? !!ch.isTamil : true)
    ),

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

  // ── Filtered channel view ────────────────────────────────────────────────────
  getFilteredChannels: () => {
    const { channels, groups, selectedGroup, showTamilOnly, searchQuery } = get();
    const sv = (v: unknown) =>
      (typeof v === 'string' ? v : String(v ?? '')).toLowerCase();

    let filtered = [...channels];
    if (selectedGroup)  filtered = filtered.filter(ch => ch.group === selectedGroup);
    if (showTamilOnly)  filtered = filtered.filter(ch => !!ch.isTamil);
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
    const activeGroupNames = new Set(groups.filter(g => g.isActive).map(g => g.name));
    filtered = filtered.filter(
      ch => activeGroupNames.has(ch.group) || !groups.find(g => g.name === ch.group)
    );
    return filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },

  // ── Sources ──────────────────────────────────────────────────────────────────
  addSource: source => {
    const newSource: Source = { ...source, id: uuidv4(), status: 'idle' };
    set(s => ({ sources: [...s.sources, newSource] }));
    get().loadSource(newSource.id);
  },

  updateSource: (id, updates) => {
    set(s => ({
      sources: s.sources.map(src => src.id === id ? { ...src, ...updates } : src),
    }));
  },

  deleteSource: id => {
    set(s => ({
      sources  : s.sources.filter(src => src.id !== id),
      channels : s.channels.filter(ch  => ch.sourceId !== id),
    }));
    // Clear modification rules for this source
    get().clearModsForSource(id);
    get().pruneEmptyGroups();
    get().syncDB();
  },

  /**
   * loadSource — CORE of the overlay architecture
   *
   * Flow:
   *   1. Fetch + parse raw channels from source URL/content
   *   2. Strip DRM channels
   *   3. Apply tamilFilter (source-level)
   *   4. Apply ALL modification rules (removedChannels, overrides, groupRules)
   *   5. Merge result into store (replace this source, keep others)
   *   6. Persist
   */
  loadSource: async id => {
    const source = get().sources.find(s => s.id === id);
    if (!source) return;

    get().updateSource(id, { status: 'loading' });

    try {
      let content = '';
      if (source.content)  content = source.content;
      else if (source.url) content = await fetchSourceContent(source.url);
      else throw new Error('No URL or content provided');

      // ── Parse raw ───────────────────────────────────────────────────────────
      const parsed = parseAny(content, id) as Array<Channel & Record<string, unknown>>;
      const directRaw  = parsed.filter(ch => !hasDRM(ch));
      const drmCount   = parsed.length - directRaw.length;

      // ── Map to Channel objects ───────────────────────────────────────────────
      let rawChannels: Channel[] = directRaw.map((ch, idx) => ({
        id         : ch.id || uuidv4(),
        name       : String(ch.name  || 'Unknown'),
        url        : ch.url    || '',
        rawUrl     : ch.rawUrl || ch.url || '',
        logo       : ch.logo,
        group      : String(ch.group || 'General'),
        tvgId      : ch.tvgId,
        tvgName    : ch.tvgName,
        language   : ch.language,
        country    : ch.country,
        isActive   : true,
        enabled    : true,
        order      : ch.order ?? idx,
        sourceId   : id,
        tags       : ch.tags,
        streamType : ch.streamType,
        userAgent  : ch.userAgent,
        referer    : ch.referer,
        cookie     : ch.cookie,
        httpHeaders: ch.httpHeaders,
        isTamil    : isTamilChannel(
          String(ch.name     || ''),
          String(ch.group    || ''),
          String(ch.language || ''),
        ),
      }));

      // ── Apply source-level Tamil filter ─────────────────────────────────────
      if (source.tamilFilter) {
        rawChannels = rawChannels.filter(ch => ch.isTamil);
      }

      // ── Apply modifications overlay ──────────────────────────────────────────
      // This is the KEY step — re-applies ALL persistent rules on fresh data
      const mods     = get().modifications;
      const filtered = applyModifications(rawChannels, mods, id);

      const tamilCount = filtered.filter(ch => ch.isTamil).length;

      // ── Merge into store (replace this source only) ─────────────────────────
      set(s => ({
        channels: [
          ...s.channels.filter(ch => ch.sourceId !== id),  // keep other sources
          ...filtered,                                       // add fresh filtered channels
        ],
      }));

      get().updateSource(id, {
        status       : 'success',
        lastRefreshed: new Date().toISOString(),
        channelCount : filtered.length,
        tamilCount,
        removedCount : rawChannels.length - filtered.length,
        errorMessage : drmCount > 0
          ? `✅ ${filtered.length} channels. ${drmCount} DRM removed.`
          : undefined,
      });

      get().syncGroups();
      get().tagMultiSourceChannels();
      get().syncDB();

    } catch (err) {
      get().updateSource(id, {
        status      : 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  },

  // ── Tag multi-source channels ────────────────────────────────────────────────
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
          url       : c.rawUrl || c.url,
          status    : 'unknown' as const,
        })),
      };
    });
    set({ channels: updated });
  },

  // ── Channels CRUD ────────────────────────────────────────────────────────────
  addChannel: channel => {
    const newCh: Channel = {
      ...channel,
      id      : uuidv4(),
      group   : channel.group || 'General',
      isCustom: channel.sourceId === 'custom' || !channel.sourceId ? true : undefined,
      isTamil : isTamilChannel(
        String(channel.name     || ''),
        String(channel.group    || ''),
        String(channel.language || ''),
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
            String(updated.language || ''),
          ),
        };
      }),
    }));

    // If name/group changed, add an override rule so it persists after source refresh
    const ch = get().channels.find(c => c.id === id);
    if (ch && ch.sourceId && ch.sourceId !== 'custom') {
      if (updates.name || updates.group || updates.logo || updates.url) {
        get().addOverrideRule({
          channelKey    : ch.name.toLowerCase().trim(),
          matchType     : 'exact_name',
          sourceId      : ch.sourceId,
          overrideName  : updates.name,
          overrideGroup : updates.group,
          overrideLogo  : updates.logo,
          overrideUrl   : updates.url,
        });
      }
    }

    get().syncGroups();
    get().pruneEmptyGroups();
    get().syncDB();
  },

  /**
   * deleteChannel — stores a persistent removal rule so it survives refreshes
   */
  deleteChannel: id => {
    const ch = get().channels.find(c => c.id === id);
    if (ch && ch.sourceId && ch.sourceId !== 'custom') {
      // Add persistent removal rules (by name + by URL)
      const rules = makeRemovedRule(ch, 'manual_delete', ch.sourceId);
      set(s => ({
        modifications: {
          ...s.modifications,
          removedChannels: [
            ...s.modifications.removedChannels,
            ...rules.filter(r =>
              !s.modifications.removedChannels.find(
                x => x.channelKey === r.channelKey && x.matchType === r.matchType
              )
            ),
          ],
        },
      }));
    }
    set(s => ({ channels: s.channels.filter(c => c.id !== id) }));
    get().pruneEmptyGroups();
    get().syncDB();
  },

  /**
   * removeNonTamilFromSource — removes all non-Tamil channels AND
   * stores persistent rules so they never come back on refresh
   */
  removeNonTamilFromSource: sourceId => {
    const { channels, modifications } = get();
    const toRemove = channels.filter(ch => ch.sourceId === sourceId && !ch.isTamil);

    // Create removal rules for all non-Tamil channels
    const rules = makeNonTamilRules(channels, sourceId);
    const existing = new Set(
      modifications.removedChannels.map(r => `${r.matchType}:${r.channelKey}:${r.sourceId || '*'}`)
    );
    const newRules = rules.filter(
      r => !existing.has(`${r.matchType}:${r.channelKey}:${r.sourceId || '*'}`)
    );

    set(s => ({
      channels: s.channels.filter(ch => !(ch.sourceId === sourceId && !ch.isTamil)),
      modifications: {
        ...s.modifications,
        removedChannels: [...s.modifications.removedChannels, ...newRules],
      },
    }));

    get().updateSource(sourceId, { removedOthers: true });
    get().pruneEmptyGroups();
    get().syncDB();
    return toRemove.length;
  },

  // ── Modification rules ────────────────────────────────────────────────────────
  addRemovedRule: rule => {
    set(s => ({
      modifications: {
        ...s.modifications,
        removedChannels: [
          ...s.modifications.removedChannels.filter(
            r => !(r.channelKey === rule.channelKey && r.matchType === rule.matchType && r.sourceId === rule.sourceId)
          ),
          rule,
        ],
      },
    }));
    get().syncDB();
  },

  addOverrideRule: rule => {
    set(s => ({
      modifications: {
        ...s.modifications,
        channelOverrides: [
          ...s.modifications.channelOverrides.filter(
            o => !(o.channelKey === rule.channelKey && o.matchType === rule.matchType && o.sourceId === rule.sourceId)
          ),
          rule,
        ],
      },
    }));
    get().syncDB();
  },

  addGroupRule: rule => {
    set(s => ({
      modifications: {
        ...s.modifications,
        groupRules: [
          ...s.modifications.groupRules.filter(r => r.id !== rule.id),
          rule,
        ],
      },
    }));
    get().syncDB();
  },

  removeGroupRule: id => {
    set(s => ({
      modifications: {
        ...s.modifications,
        groupRules: s.modifications.groupRules.filter(r => r.id !== id),
      },
    }));
    get().syncDB();
  },

  clearModsForSource: sourceId => {
    set(s => ({
      modifications: {
        ...s.modifications,
        removedChannels : s.modifications.removedChannels.filter(r => r.sourceId !== sourceId),
        channelOverrides: s.modifications.channelOverrides.filter(o => o.sourceId !== sourceId),
        groupRules      : s.modifications.groupRules.filter(r => r.sourceId !== sourceId),
      },
    }));
  },

  // ── Auto-delete empty groups ───────────────────────────────────────────────────
  pruneEmptyGroups: () => {
    const { channels, groups } = get();
    const usedGroups = new Set(channels.map(ch => ss(ch.group) || 'General').filter(Boolean));
    const pruned = groups.filter(g => usedGroups.has(g.name));
    if (pruned.length !== groups.length) set({ groups: pruned });
  },

  toggleChannel: id => {
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

  // ── Groups CRUD ───────────────────────────────────────────────────────────────
  addGroup: group => {
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
      // Update channels to use new group name
      set(s => ({
        channels: s.channels.map(ch =>
          ch.group === old.name ? { ...ch, group: updates.name! } : ch
        ),
      }));
      // Add a group rename rule so it persists after source refresh
      const ruleId = uuidv4();
      get().addGroupRule(makeGroupRenameRule(old.name, updates.name, ruleId));
    }
    get().syncDB();
  },

  /**
   * deleteGroup — permanently removes group AND all its channels.
   * Adds a group remove rule so refreshed sources never re-create it.
   */
  deleteGroup: id => {
    const grp = get().groups.find(g => g.id === id);
    if (!grp) return;

    set(s => ({
      groups  : s.groups.filter(g => g.id !== id),
      channels: s.channels.filter(ch => ch.group !== grp.name),
    }));

    // Persistent rule: never show this group again after source refresh
    const ruleId = uuidv4();
    get().addGroupRule(makeGroupRemoveRule(grp.name, ruleId));
    get().syncDB();
  },

  toggleGroup: id => {
    set(s => ({
      groups: s.groups.map(g =>
        g.id === id ? { ...g, isActive: !g.isActive } : g
      ),
    }));
    get().syncDB();
  },

  // ── Auto-sync groups from channel data ────────────────────────────────────────
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
        isTamil     :
          g.isTamil ||
          g.name.toLowerCase().includes('tamil') ||
          s.channels.filter(ch => ss(ch.group) === g.name).some(ch => ch.isTamil),
      })),
    }));

    get().pruneEmptyGroups();
  },

  // ── Playlists ─────────────────────────────────────────────────────────────────
  createPlaylist: (name, includeGroups, tamilOnly = false) => {
    const id   = uuidv4();
    const base = (get().serverUrl || DEFAULT_SERVER) + '/api/playlist';
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
        p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p
      ),
    }));
    get().syncDB();
  },

  deletePlaylist: id => {
    set(s => ({ playlists: s.playlists.filter(p => p.id !== id) }));
    get().syncDB();
  },

  getPlaylistM3U: id => {
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
      if (playlist.includeGroups.length > 0 &&
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

  // ── Export ───────────────────────────────────────────────────────────────────
  exportDB: () => {
    const { channels, playlists, sources, groups, modifications } = get();
    return JSON.stringify({ channels, playlists, sources, groups, modifications }, null, 2);
  },

  // ── Persistence ───────────────────────────────────────────────────────────────
  syncDB: () => { debouncedSave(get()); },

  syncToServer: async () => {
    const { channels, playlists, sources, groups, modifications, serverUrl, apiKey } = get();
    const url  = serverUrl || DEFAULT_SERVER;
    const resp = await fetch(`${url}/api/sync`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey || 'iptv-secret' },
      body   : JSON.stringify({ channels, playlists, sources, groups, modifications }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`Server sync failed: ${(err as { error: string }).error || resp.status}`);
    }
    set({ lastSyncTime: Date.now() });
    if (SUPABASE_ENABLED) {
      await saveToSupabase({
        channels, sources, groups, playlists, modifications,
        serverUrl, apiKey, savedAt: Date.now(),
      }).catch(() => {});
    }
  },

  /**
   * initFromStorage — app startup
   * Priority: Supabase → sessionStorage → server
   */
  initFromStorage: async () => {
    // 1. Try Supabase (cloud, most reliable)
    if (SUPABASE_ENABLED) {
      try {
        const sb = await loadFromSupabase();
        if (sb && Array.isArray(sb.channels) && sb.channels.length > 0) {
          set({
            channels     : sb.channels   as Channel[],
            sources      : sb.sources    as Source[],
            groups       : sb.groups     as Group[],
            playlists    : sb.playlists  as PlaylistConfig[],
            modifications: (sb as { modifications?: ModificationStore }).modifications || { ...EMPTY_MODS },
            serverUrl    : (sb.serverUrl as string) || DEFAULT_SERVER,
            apiKey       : (sb.apiKey   as string) || 'iptv-secret',
            hydrated     : true,
          });
          console.log(`[Store] ✅ Supabase: ${sb.channels.length} channels`);
          // Merge with server in background
          void get().loadFromServer((sb.serverUrl as string) || DEFAULT_SERVER);
          return;
        }
      } catch (e) {
        console.warn('[Store] Supabase load failed:', e);
      }
    }

    // 2. Try sessionStorage (instant, in-tab)
    const session = loadSession();
    if (session && Array.isArray(session.channels) && session.channels.length > 0) {
      set({
        channels     : session.channels,
        sources      : session.sources   || [],
        groups       : session.groups    || [],
        playlists    : session.playlists || [],
        modifications: session.modifications || { ...EMPTY_MODS },
        serverUrl    : session.serverUrl  || DEFAULT_SERVER,
        apiKey       : session.apiKey     || 'iptv-secret',
        hydrated     : true,
      });
      console.log(`[Store] ✅ Session: ${session.channels.length} channels`);
    }

    // 3. Always try server (may have newer data)
    await get().loadFromServer(get().serverUrl || DEFAULT_SERVER);
  },

  /**
   * loadFromServer — fetch /api/db and merge with local state
   */
  loadFromServer: async (overrideUrl?: string) => {
    const url = overrideUrl || get().serverUrl || DEFAULT_SERVER;
    if (!url || url.includes('localhost:517') || url.includes('127.0.0.1')) {
      set({ hydrated: true });
      return;
    }

    try {
      const resp = await fetch(`${url}/api/db`, {
        headers: { 'X-Api-Key': get().apiKey || 'iptv-secret' },
        signal : AbortSignal.timeout(12000),
      });
      if (!resp.ok) { set({ hydrated: true }); return; }

      const serverData = await resp.json() as {
        channels     ?: unknown[];
        sources      ?: unknown[];
        groups       ?: unknown[];
        playlists    ?: unknown[];
        modifications?: ModificationStore;
      };

      const local = get();

      const mergedChannels   = mergeById(local.channels,  (serverData.channels  || []) as Channel[]);
      const mergedSources    = mergeById(local.sources,   (serverData.sources   || []) as Source[]);
      const mergedGroups     = mergeById(local.groups,    (serverData.groups    || []) as Group[]);
      const mergedPlaylists  = mergeById(local.playlists, (serverData.playlists || []) as PlaylistConfig[]);
      const mergedMods       = mergeMods(
        local.modifications,
        serverData.modifications || { ...EMPTY_MODS }
      );

      set({
        channels     : mergedChannels,
        sources      : mergedSources,
        groups       : mergedGroups,
        playlists    : mergedPlaylists,
        modifications: mergedMods,
        hydrated     : true,
      });

      console.log(`[Store] ✅ Server merge: ${mergedChannels.length} channels`);

      // Push merged data back to server + Supabase
      const pushPayload = {
        channels     : mergedChannels,
        sources      : mergedSources,
        groups       : mergedGroups,
        playlists    : mergedPlaylists,
        modifications: mergedMods,
      };

      fetch(`${url}/api/sync`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': get().apiKey || 'iptv-secret' },
        body   : JSON.stringify(pushPayload),
      }).catch(() => {});

      if (SUPABASE_ENABLED) {
        saveToSupabase({
          ...pushPayload,
          serverUrl: get().serverUrl,
          apiKey   : get().apiKey,
          savedAt  : Date.now(),
        }).catch(() => {});
      }

    } catch {
      set({ hydrated: true });
    }
  },
}));
