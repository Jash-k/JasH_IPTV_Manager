import { useState, useEffect, useCallback } from 'react';
import { AppConfig, Source, Stream, Group, Settings, Tab } from '../types';
import { sourcesDB, streamsDB, groupsDB, settingsDB, getDefaultSettings, exportConfig, importConfig } from '../utils/db';
import { parseM3U, fetchM3U } from '../utils/m3uParser';
import { downloadM3UFile, generateM3U, generateM3UBlobUrl } from '../utils/m3uExporter';

export function useAppStore() {
  const [sources,      setSources]      = useState<Source[]>([]);
  const [streams,      setStreams]       = useState<Stream[]>([]);
  const [groups,       setGroups]        = useState<Group[]>([]);
  const [settings,     setSettings]      = useState<Settings>(getDefaultSettings());
  const [activeTab,    setActiveTab]     = useState<Tab>('sources');
  const [loading,      setLoading]       = useState(true);
  const [notification, setNotification]  = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

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

  return {
    sources, streams, groups, settings, activeTab, loading, notification,
    setActiveTab, notify,
    addSource, refreshSource, deleteSource, toggleSource,
    updateStream, deleteStream, bulkDeleteStreams, bulkMoveStreams, bulkToggleStreams,
    updateStreamStatus, reorderStreams,
    createGroup, deleteGroup, renameGroup,
    saveSettings,
    exportConfigData, importConfigData,
    downloadM3U, getM3UContent, getM3UBlobUrl,
    loadAll,
  };
}

export type AppStore = ReturnType<typeof useAppStore>;
