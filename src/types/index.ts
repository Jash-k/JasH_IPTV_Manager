export interface Stream {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group: string;
  sourceId: string;
  enabled: boolean;
  tvgId?: string;
  tvgName?: string;
  status?: 'alive' | 'dead' | 'unknown' | 'checking';
  responseTime?: number;
  lastChecked?: number;
  /** Manual sort order — set by drag-and-drop reorder */
  order?: number;
}

export interface Source {
  id: string;
  name: string;
  type: 'url' | 'file' | 'cloud' | 'single' | 'manual';
  url?: string;
  content?: string;
  cloudProvider?: 'gdrive' | 'dropbox' | 'onedrive';
  enabled: boolean;
  priority: number;
  streamCount: number;
  lastUpdated?: number;
  status: 'active' | 'error' | 'loading';
  error?: string;
  /** If set, only channels matching this model are kept when source is parsed */
  selectionModelId?: string;
  /** Group name to assign matched channels (defaults to source name) */
  selectionGroupName?: string;
  /** Original stream count before model filtering */
  rawStreamCount?: number;
}

/**
 * A Selection Model is a named list of channel patterns.
 * When applied to a source, only matching channels are kept.
 * Matching is liberal — "Sun TV" matches "Sun TV HD", "SunTV 4K", "SUN TV USA" etc.
 */
export interface SelectionModel {
  id: string;
  name: string;
  /** One channel name per line. Liberal fuzzy matching applied. */
  channels: string[];
  /** If true, matched streams are grouped under a single group */
  singleGroup: boolean;
  /** Default group name for matched streams */
  defaultGroupName: string;
  createdAt: number;
  updatedAt: number;
  isBuiltIn?: boolean;
}

export interface Group {
  id: string;
  name: string;
  streamCount: number;
  enabled: boolean;
  color?: string;
  sourceIds: string[];
}

export interface AppConfig {
  sources: Source[];
  streams: Stream[];
  groups: Group[];
  settings: Settings;
}

export interface Settings {
  addonId: string;
  addonName: string;
  corsProxy: string;
  autoRemoveDead: boolean;
  combineByGroups: boolean;
  /** Combine channels with same name+group into one entry with multiple quality streams */
  combineMultiQuality: boolean;
  /** Sort streams alphabetically by group then name in Stremio */
  sortAlphabetically: boolean;
  healthCheckInterval: number;
  lastSync?: number;
}

/** A custom combined channel — multiple stream URLs shown as one catalog entry */
export interface CombinedChannel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  streamUrls: string[];
  enabled: boolean;
  createdAt: number;
}

export type Tab = 'sources' | 'streams' | 'groups' | 'health' | 'statistics' | 'combine' | 'handler' | 'export' | 'backend' | 'settings' | 'install' | 'models';

export interface ParsedM3U {
  streams: Omit<Stream, 'id' | 'sourceId' | 'enabled' | 'status'>[];
}

export interface HealthCheckResult {
  streamId: string;
  status: 'alive' | 'dead';
  responseTime?: number;
  checkedAt: number;
}
