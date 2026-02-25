import { useState, useEffect, useCallback } from 'react';
import { AppConfig, Source, Stream, Group, Settings, Tab, CombinedChannel, SelectionModel } from '../types';
import { sourcesDB, streamsDB, groupsDB, settingsDB, getDefaultSettings, exportConfig, importConfig } from '../utils/db';
import { parseM3U, fetchM3U } from '../utils/m3uParser';
import { downloadM3UFile, generateM3U, generateM3UBlobUrl } from '../utils/m3uExporter';
import { filterStreamsByModel, BUILT_IN_MODELS, groupStreamsByChannel } from '../utils/channelMatcher';

const MODELS_KEY = 'jash_selection_models';

function loadModelsFromStorage(): SelectionModel[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    const custom: SelectionModel[] = raw ? JSON.parse(raw) : [];
    const builtIns: SelectionModel[] = BUILT_IN_MODELS.map(m => ({
      ...m,
      channels : [...m.channels] as string[],
      createdAt: 0,
      updatedAt: 0,
    }));
    return [...builtIns, ...custom.filter(m => !m.isBuiltIn)];
  } catch {
    return BUILT_IN_MODELS.map(m => ({ ...m, channels: [...m.channels] as string[], createdAt: 0, updatedAt: 0 }));
  }
}

function saveModelsToStorage(models: SelectionModel[]): void {
  const custom = models.filter(m => !m.isBuiltIn);
  localStorage.setItem(MODELS_KEY, JSON.stringify(custom));
}

export function useAppStore() {
  const [sources,          setSources]          = useState<Source[]>([]);
  const [streams,          setStreams]           = useState<Stream[]>([]);
  const [groups,           setGroups]            = useState<Group[]>([]);
  const [settings,         setSettings]          = useState<Settings>(getDefaultSettings());
  const [combinedChannels, setCombinedChannels]  = useState<CombinedChannel[]>([]);
  const [selectionModels,  setSelectionModels]   = useState<SelectionModel[]>(() => loadModelsFromStorage());
  const [activeTab,        setActiveTab]         = useState<Tab>('sources');
  const [loading,          setLoading]           = useState(true);
  const [notification,     setNotification]      = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  const notify = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, st, g, se] = await Promise.all([
        sourcesDB.getAll(),
        streamsDB.getAll(),
        groupsDB.getAll(),
        settingsDB.get(),
      ]);
      setSources(s.sort((a, b) => a.priority - b.priority));
      // Preserve stored order (order field)
      setStreams(st.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      setGroups(g);
      setSettings(se);
    } catch (_e) {
      notify('Failed to load data from database', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const rebuildGroups = useCallback(async (allStreams: Stream[]) => {
    const groupMap = new Map<string, Group>();
    const existing = await groupsDB.getAll();
    existing.forEach(g => groupMap.set(g.name, g));

    allStreams.forEach(s => {
      const name = s.group || 'Uncategorized';
      if (!groupMap.has(name)) {
        groupMap.set(name, {
          id        : `grp_${name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`,
          name,
          streamCount: 0,
          enabled   : true,
          sourceIds : [],
        });
      }
      const g = groupMap.get(name)!;
      g.streamCount = allStreams.filter(st => st.group === name && st.enabled).length;
      if (!g.sourceIds.includes(s.sourceId)) g.sourceIds.push(s.sourceId);
    });

    await groupsDB.clear();
    const arr = Array.from(groupMap.values());
    await Promise.all(arr.map(g => groupsDB.put(g)));
    setGroups(arr);
  }, []);

  // ─── Sources ──────────────────────────────────────────────────────────────

  const addSource = useCallback(async (source: Source, content?: string) => {
    source.status = 'loading';
    await sourcesDB.put(source);
    setSources(prev => [...prev.filter(s => s.id !== source.id), source].sort((a, b) => a.priority - b.priority));

    try {
      let m3uContent = content || '';

      if (!content && source.type === 'url' && source.url) {
        m3uContent = await fetchM3U(source.url, settings.corsProxy);
      } else if (!content && source.type === 'single' && source.url) {
        m3uContent = `#EXTM3U\n#EXTINF:-1 group-title="${source.name}",${source.name}\n${source.url}`;
      }

      const existing  = await streamsDB.getAll();
      const nextOrder = existing.length;
      const parsed    = parseM3U(m3uContent, source.id).map((s, i) => ({ ...s, order: nextOrder + i }));

      source.streamCount = parsed.length;
      source.status      = 'active';
      source.lastUpdated = Date.now();
      source.content     = m3uContent;

      await sourcesDB.put(source);
      await streamsDB.bulkPut(parsed);

      const allStreams = await streamsDB.getAll();
      setStreams(allStreams.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      await rebuildGroups(allStreams);
      setSources(prev => prev.map(s => s.id === source.id ? source : s));
      notify(`Added: ${source.name} (${parsed.length} streams)`, 'success');
    } catch (e) {
      source.status = 'error';
      source.error  = (e as Error).message;
      await sourcesDB.put(source);
      setSources(prev => prev.map(s => s.id === source.id ? source : s));
      notify(`Error: ${(e as Error).message}`, 'error');
    }
  }, [settings.corsProxy, rebuildGroups, notify]);

  const refreshSource = useCallback(async (sourceId: string) => {
    const source = sources.find(s => s.id === sourceId);
    if (!source) return;

    setSources(prev => prev.map(s => s.id === sourceId ? { ...s, status: 'loading' } : s));

    try {
      let m3uContent = '';
      if (source.type === 'url' && source.url) {
        m3uContent = await fetchM3U(source.url, settings.corsProxy);
      } else if (source.content) {
        m3uContent = source.content;
      }

      // Get existing order base
      const existing  = await streamsDB.getAll();
      const srcStreams = existing.filter(s => s.sourceId === sourceId);
      const baseOrder = srcStreams.length ? Math.min(...srcStreams.map(s => s.order ?? 0)) : existing.length;

      await streamsDB.deleteBySource(sourceId);
      const parsed = parseM3U(m3uContent, sourceId).map((s, i) => ({ ...s, order: baseOrder + i }));
      await streamsDB.bulkPut(parsed);

      source.streamCount = parsed.length;
      source.status      = 'active';
      source.lastUpdated = Date.now();
      source.content     = m3uContent;
      await sourcesDB.put(source);

      const allStreams = await streamsDB.getAll();
      setStreams(allStreams.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      await rebuildGroups(allStreams);
      setSources(prev => prev.map(s => s.id === sourceId ? source : s));
      notify(`Refreshed: ${source.name} (${parsed.length} streams)`, 'success');
    } catch (e) {
      source.status = 'error';
      source.error  = (e as Error).message;
      await sourcesDB.put(source);
      setSources(prev => prev.map(s => s.id === sourceId ? source : s));
      notify(`Refresh failed: ${(e as Error).message}`, 'error');
    }
  }, [sources, settings.corsProxy, rebuildGroups, notify]);

  const deleteSource = useCallback(async (sourceId: string) => {
    await streamsDB.deleteBySource(sourceId);
    await sourcesDB.delete(sourceId);
    const allStreams = await streamsDB.getAll();
    setStreams(allStreams.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    setSources(prev => prev.filter(s => s.id !== sourceId));
    await rebuildGroups(allStreams);
    notify('Source deleted', 'success');
  }, [rebuildGroups, notify]);

  const toggleSource = useCallback(async (sourceId: string) => {
    const src = sources.find(s => s.id === sourceId);
    if (!src) return;
    const updated = { ...src, enabled: !src.enabled };
    await sourcesDB.put(updated);
    setSources(prev => prev.map(s => s.id === sourceId ? updated : s));
  }, [sources]);

  // ─── Streams ──────────────────────────────────────────────────────────────

  const updateStream = useCallback(async (stream: Stream) => {
    await streamsDB.put(stream);
    setStreams(prev => prev.map(s => s.id === stream.id ? stream : s));
    const allStreams = await streamsDB.getAll();
    await rebuildGroups(allStreams);
  }, [rebuildGroups]);

  const deleteStream = useCallback(async (streamId: string) => {
    await streamsDB.delete(streamId);
    setStreams(prev => prev.filter(s => s.id !== streamId));
    const allStreams = await streamsDB.getAll();
    await rebuildGroups(allStreams);
    notify('Stream deleted', 'success');
  }, [rebuildGroups, notify]);

  const bulkDeleteStreams = useCallback(async (ids: string[]) => {
    await streamsDB.bulkDelete(ids);
    setStreams(prev => prev.filter(s => !ids.includes(s.id)));
    const allStreams = await streamsDB.getAll();
    await rebuildGroups(allStreams);
    notify(`Deleted ${ids.length} streams`, 'success');
  }, [rebuildGroups, notify]);

  const bulkMoveStreams = useCallback(async (ids: string[], group: string) => {
    const toUpdate = streams.filter(s => ids.includes(s.id)).map(s => ({ ...s, group }));
    await streamsDB.bulkPut(toUpdate);
    setStreams(prev => prev.map(s => ids.includes(s.id) ? { ...s, group } : s));
    const allStreams = await streamsDB.getAll();
    await rebuildGroups(allStreams);
    notify(`Moved ${ids.length} streams to ${group}`, 'success');
  }, [streams, rebuildGroups, notify]);

  const bulkToggleStreams = useCallback(async (ids: string[], enabled: boolean) => {
    const toUpdate = streams.filter(s => ids.includes(s.id)).map(s => ({ ...s, enabled }));
    await streamsDB.bulkPut(toUpdate);
    setStreams(prev => prev.map(s => ids.includes(s.id) ? { ...s, enabled } : s));
    notify(`${enabled ? 'Enabled' : 'Disabled'} ${ids.length} streams`, 'success');
  }, [streams, notify]);

  const updateStreamStatus = useCallback(async (streamId: string, status: Stream['status'], responseTime?: number) => {
    const stream = streams.find(s => s.id === streamId);
    if (!stream) return;
    const updated = { ...stream, status, responseTime, lastChecked: Date.now() };
    await streamsDB.put(updated);
    setStreams(prev => prev.map(s => s.id === streamId ? updated : s));
  }, [streams]);

  /**
   * Reorder streams by providing a new ordered array of stream IDs.
   * Persists the `order` field to IndexedDB and updates React state.
   */
  const reorderStreams = useCallback(async (orderedIds: string[]) => {
    const idToOrder = new Map(orderedIds.map((id, i) => [id, i]));
    const updated   = streams.map(s => ({ ...s, order: idToOrder.has(s.id) ? idToOrder.get(s.id)! : (s.order ?? 0) }));
    await streamsDB.bulkPut(updated);
    const sorted = [...updated].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    setStreams(sorted);
  }, [streams]);

  // ─── Groups ───────────────────────────────────────────────────────────────

  const createGroup = useCallback(async (name: string) => {
    const group: Group = { id: `grp_${Date.now()}`, name, streamCount: 0, enabled: true, sourceIds: [] };
    await groupsDB.put(group);
    setGroups(prev => [...prev, group]);
    notify(`Group "${name}" created`, 'success');
  }, [notify]);

  const deleteGroup = useCallback(async (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const affected = streams.filter(s => s.group === group.name).map(s => ({ ...s, group: 'Uncategorized' }));
    await streamsDB.bulkPut(affected);
    await groupsDB.delete(groupId);
    setStreams(prev => prev.map(s => s.group === group.name ? { ...s, group: 'Uncategorized' } : s));
    setGroups(prev => prev.filter(g => g.id !== groupId));
    notify('Group deleted, streams moved to Uncategorized', 'success');
  }, [groups, streams, notify]);

  const renameGroup = useCallback(async (groupId: string, newName: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const oldName     = group.name;
    const updatedGroup = { ...group, name: newName };
    await groupsDB.put(updatedGroup);
    const affected = streams.filter(s => s.group === oldName).map(s => ({ ...s, group: newName }));
    await streamsDB.bulkPut(affected);
    setGroups(prev  => prev.map(g => g.id === groupId ? updatedGroup : g));
    setStreams(prev => prev.map(s => s.group === oldName ? { ...s, group: newName } : s));
    notify(`Group renamed to "${newName}"`, 'success');
  }, [groups, streams, notify]);

  // ─── Settings ─────────────────────────────────────────────────────────────

  const saveSettings = useCallback(async (s: Settings) => {
    await settingsDB.put(s);
    setSettings(s);
    notify('Settings saved', 'success');
  }, [notify]);

  // ─── Config export / import ───────────────────────────────────────────────

  const exportConfigData = useCallback(async () => {
    const config = await exportConfig();
    const blob   = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = 'jash-addon-config.json'; a.click();
    URL.revokeObjectURL(url);
    notify('Configuration exported', 'success');
  }, [notify]);

  const importConfigData = useCallback(async (config: AppConfig) => {
    await importConfig(config);
    await loadAll();
    notify('Configuration imported successfully', 'success');
  }, [loadAll, notify]);

  // ─── M3U Export ───────────────────────────────────────────────────────────

  const downloadM3U = useCallback((options: {
    includeDisabled?: boolean;
    filterGroup?: string;
    filename?: string;
    playlistName?: string;
  } = {}) => {
    if (!streams.length) { notify('No streams to export', 'error'); return; }
    const filename = options.filename || `jash-playlist-${new Date().toISOString().slice(0, 10)}.m3u`;
    // Export in current order (order field), not sorted by group
    downloadM3UFile(streams, filename, {
      includeDisabled: options.includeDisabled,
      filterGroup    : options.filterGroup,
      playlistName   : options.playlistName || 'Jash IPTV',
      sortByGroup    : false,   // preserve manual order
    });
    const count = streams.filter(s =>
      (options.includeDisabled || s.enabled) &&
      (!options.filterGroup || s.group === options.filterGroup)
    ).length;
    notify(`Downloaded ${count.toLocaleString()} streams as M3U`, 'success');
  }, [streams, notify]);

  const getM3UContent = useCallback((options: {
    includeDisabled?: boolean;
    filterGroup?: string;
    playlistName?: string;
    sortByGroup?: boolean;
  } = {}): string => {
    return generateM3U(streams, {
      includeDisabled: options.includeDisabled,
      filterGroup    : options.filterGroup,
      playlistName   : options.playlistName || 'Jash IPTV',
      sortByGroup    : options.sortByGroup ?? false,
    });
  }, [streams]);

  const getM3UBlobUrl = useCallback((options: {
    includeDisabled?: boolean;
    filterGroup?: string;
  } = {}): string => {
    return generateM3UBlobUrl(streams, { ...options, sortByGroup: false });
  }, [streams]);

  // ─── Combined Channels ────────────────────────────────────────────────────

  const loadCombinedChannels = useCallback(() => {
    try {
      const raw = localStorage.getItem('jash_combined_channels');
      if (raw) setCombinedChannels(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadCombinedChannels(); }, [loadCombinedChannels]);

  const saveCombinedChannels = useCallback((list: CombinedChannel[]) => {
    localStorage.setItem('jash_combined_channels', JSON.stringify(list));
    setCombinedChannels(list);
  }, []);

  const addCombinedChannel = useCallback((ch: CombinedChannel) => {
    setCombinedChannels(prev => {
      const next = [...prev.filter(c => c.id !== ch.id), ch];
      localStorage.setItem('jash_combined_channels', JSON.stringify(next));
      return next;
    });
    notify(`Combined channel "${ch.name}" saved`, 'success');
  }, [notify]);

  const deleteCombinedChannel = useCallback((id: string) => {
    setCombinedChannels(prev => {
      const next = prev.filter(c => c.id !== id);
      localStorage.setItem('jash_combined_channels', JSON.stringify(next));
      return next;
    });
    notify('Combined channel deleted', 'success');
  }, [notify]);

  const toggleCombinedChannel = useCallback((id: string) => {
    setCombinedChannels(prev => {
      const next = prev.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c);
      localStorage.setItem('jash_combined_channels', JSON.stringify(next));
      return next;
    });
  }, []);

  // ─── Selection Models ─────────────────────────────────────────────────────

  const saveSelectionModel = useCallback((model: SelectionModel) => {
    setSelectionModels(prev => {
      const next = [...prev.filter(m => m.id !== model.id), model];
      saveModelsToStorage(next);
      return next;
    });
    notify(`Model "${model.name}" saved`, 'success');
  }, [notify]);

  const deleteSelectionModel = useCallback((id: string) => {
    setSelectionModels(prev => {
      const next = prev.filter(m => m.id !== id);
      saveModelsToStorage(next);
      return next;
    });
    notify('Model deleted', 'success');
  }, [notify]);

  /**
   * Apply a selection model to a source:
   * 1. Parse the raw M3U content (or refetch URL sources)
   * 2. Filter streams through the model
   * 3. Assign matched streams to a single group (model.defaultGroupName or source.selectionGroupName)
   * 4. Delete old streams from this source and replace with filtered set
   */
  const applyModelToSource = useCallback(async (sourceId: string, modelId: string | null) => {
    const source = sources.find(s => s.id === sourceId);
    if (!source) return;

    // Update the source's model assignment
    const updatedSource: Source = { ...source, selectionModelId: modelId || undefined };
    await sourcesDB.put(updatedSource);
    setSources(prev => prev.map(s => s.id === sourceId ? updatedSource : s));

    // Re-parse the source with the new model applied
    try {
      let m3uContent = source.content || '';
      if (!m3uContent && source.type === 'url' && source.url) {
        setSources(prev => prev.map(s => s.id === sourceId ? { ...s, status: 'loading' } : s));
        m3uContent = await fetchM3U(source.url, settings.corsProxy);
      }

      if (!m3uContent) {
        notify('No content to re-parse. Please refresh the source.', 'error');
        return;
      }

      // Delete old streams from this source
      await streamsDB.deleteBySource(sourceId);

      // Parse all streams
      const allParsed = parseM3U(m3uContent, sourceId);
      const existing  = await streamsDB.getAll();
      const baseOrder = existing.length;

      let finalStreams: Stream[];

      if (!modelId) {
        // No model → keep all streams
        finalStreams = allParsed.map((s, i) => ({ ...s, order: baseOrder + i }));
        updatedSource.rawStreamCount = undefined;
        updatedSource.streamCount    = allParsed.length;
      } else {
        const model = selectionModels.find(m => m.id === modelId);
        if (!model) {
          notify('Model not found', 'error');
          return;
        }

        const { matched } = filterStreamsByModel(allParsed, model.channels);
        const groupName   = updatedSource.selectionGroupName || model.defaultGroupName || source.name;

        if (model.singleGroup) {
          finalStreams = matched.map((s, i) => ({
            ...s,
            group: groupName,
            order: baseOrder + i,
          }));
        } else {
          finalStreams = matched.map((s, i) => ({ ...s, order: baseOrder + i }));
        }

        updatedSource.rawStreamCount = allParsed.length;
        updatedSource.streamCount    = matched.length;
      }

      updatedSource.status      = 'active';
      updatedSource.lastUpdated = Date.now();
      updatedSource.content     = m3uContent;

      await sourcesDB.put(updatedSource);
      await streamsDB.bulkPut(finalStreams);

      const allStreams = await streamsDB.getAll();
      setStreams(allStreams.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      await rebuildGroups(allStreams);
      setSources(prev => prev.map(s => s.id === sourceId ? updatedSource : s));

      if (modelId) {
        notify(`✅ Model applied: ${finalStreams.length} channels kept (${(updatedSource.rawStreamCount || 0) - finalStreams.length} filtered out)`, 'success');
      } else {
        notify(`✅ Model removed: all ${finalStreams.length} streams restored`, 'success');
      }
    } catch (e) {
      const msg = (e as Error).message;
      const errSrc = { ...updatedSource, status: 'error' as const, error: msg };
      await sourcesDB.put(errSrc);
      setSources(prev => prev.map(s => s.id === sourceId ? errSrc : s));
      notify(`Error applying model: ${msg}`, 'error');
    }
  }, [sources, selectionModels, settings.corsProxy, rebuildGroups, notify]);

  const updateSourceSelectionGroup = useCallback(async (sourceId: string, groupName: string) => {
    const source = sources.find(s => s.id === sourceId);
    if (!source) return;
    const updated = { ...source, selectionGroupName: groupName };
    await sourcesDB.put(updated);
    setSources(prev => prev.map(s => s.id === sourceId ? updated : s));
  }, [sources]);

  /**
   * combineSourceChannels — finds channels that appear in MULTIPLE sources
   * and creates CombinedChannel entries for them automatically.
   * The combined channels are saved and can then be synced to the backend.
   *
   * If sourceId is provided, only look for channels that appear in that source
   * AND at least one other source. If null, scan all enabled streams.
   */
  const combineSourceChannels = useCallback(async (
    sourceId: string | null,
    groupName = '⭐ Best Streams'
  ): Promise<number> => {
    const allStreams = sourceId
      ? streams  // we need all streams to find cross-source matches
      : streams;

    const enabled = allStreams.filter(s => s.enabled);

    // If a specific source is provided, filter to only include channels from that source
    // that ALSO exist in at least one other source
    const toSearch = sourceId
      ? enabled.filter(s => {
          if (s.sourceId !== sourceId) return true; // include all other sources for comparison
          return true;
        })
      : enabled;

    const grouped = groupStreamsByChannel(toSearch, 2);

    if (grouped.size === 0) {
      notify('No channels found in multiple sources to combine', 'info');
      return 0;
    }

    // If sourceId provided, only keep groups that include that source
    const filtered = sourceId
      ? new Map([...grouped].filter(([, val]) =>
          val.streams.some(s => s.sourceId === sourceId)
        ))
      : grouped;

    if (filtered.size === 0) {
      notify(`No channels from this source appear in other sources`, 'info');
      return 0;
    }

    // Create CombinedChannel entries
    const newCombined: CombinedChannel[] = [];
    const existing = combinedChannels.map(c => c.name.toLowerCase());

    for (const [, val] of filtered) {
      // Skip if already combined
      if (existing.includes(val.name.toLowerCase())) continue;

      const logo = val.streams.find(s => s.logo)?.logo || '';
      newCombined.push({
        id        : `comb_auto_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        name      : val.name,
        group     : groupName,
        logo,
        streamUrls: val.streams.map(s => s.url),
        enabled   : true,
        createdAt : Date.now(),
      });
    }

    if (newCombined.length === 0) {
      notify('All matching channels are already combined', 'info');
      return 0;
    }

    const next = [...combinedChannels, ...newCombined];
    localStorage.setItem('jash_combined_channels', JSON.stringify(next));
    setCombinedChannels(next);
    notify(`✅ Combined ${newCombined.length} channels from multiple sources into "${groupName}"`, 'success');
    return newCombined.length;
  }, [streams, combinedChannels, notify]);

  return {
    sources, streams, groups, settings, combinedChannels, selectionModels,
    activeTab, loading, notification,
    setActiveTab, notify,
    addSource, refreshSource, deleteSource, toggleSource,
    updateStream, deleteStream, bulkDeleteStreams, bulkMoveStreams, bulkToggleStreams,
    updateStreamStatus, reorderStreams,
    createGroup, deleteGroup, renameGroup,
    saveSettings,
    exportConfigData, importConfigData,
    downloadM3U, getM3UContent, getM3UBlobUrl,
    saveCombinedChannels, addCombinedChannel, deleteCombinedChannel, toggleCombinedChannel,
    saveSelectionModel, deleteSelectionModel, applyModelToSource, updateSourceSelectionGroup,
    combineSourceChannels,
    loadAll,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
