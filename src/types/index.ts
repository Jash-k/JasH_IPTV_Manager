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

  // ── Extended stream metadata (parsed from #KODIPROP / #EXTVLCOPT / #EXTHTTP) ──
  /** Protocol type detected from URL */
  streamType?: 'hls' | 'dash' | 'direct';
  /** DRM type: 'clearkey' | 'widevine' | 'playready' */
  licenseType?: string;
  /** DRM key pair(s): "kid:key" for clearkey, or license server URL for Widevine */
  licenseKey?: string;
  /** Custom User-Agent header */
  userAgent?: string;
  /** HTTP Referer header */
  referer?: string;
  /** HTTP Cookie header */
  cookie?: string;
  /** All custom HTTP headers from #EXTHTTP */
  httpHeaders?: Record<string, string>;
}

export interface Source {
  id: string;
  name: string;
  /** 'json' = URL or file returning JSON array of stream objects (JioTV format etc.) */
  type: 'url' | 'file' | 'cloud' | 'single' | 'manual' | 'json';
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
  /** Auto-refresh interval in minutes (0 = disabled) */
  autoRefreshInterval?: number;
  /** Timestamp of last auto-refresh attempt */
  lastAutoRefresh?: number;
  /** Next scheduled auto-refresh time */
  nextAutoRefresh?: number;
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

export type Tab = 'sources' | 'streams' | 'groups' | 'health' | 'statistics' | 'handler' | 'export' | 'backend' | 'settings' | 'install' | 'models' | 'player' | 'movies';

// ── Movie Addon Types ────────────────────────────────────────────────────────

export interface MovieStream {
  id: string;
  title: string;
  year?: number;
  url: string;
  quality?: string;  // '720p' | '1080p' | '4K' | '480p' etc.
  size?: string;
  codec?: string;
  language?: string;
  source?: string;
  logo?: string;
  group?: string;
  sourceId: string;
  enabled: boolean;
  // TMDB / IMDB metadata
  tmdbId?: number;
  imdbId?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  rating?: number;
  genres?: string[];
  releaseDate?: string;
  runtime?: number;
  // DRM
  licenseType?: string;
  licenseKey?: string;
  userAgent?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
}

export interface MovieSource {
  id: string;
  name: string;
  type: 'url' | 'file' | 'json';
  url?: string;
  content?: string;
  enabled: boolean;
  streamCount: number;
  lastUpdated?: number;
  status: 'active' | 'error' | 'loading' | 'idle';
  error?: string;
  autoRefreshInterval?: number;
  nextAutoRefresh?: number;
}

export interface MovieAddonSettings {
  addonId: string;
  addonName: string;
  tmdbApiKey: string;
  autoFetchMetadata: boolean;
  removeDuplicates: boolean;
  combineQualities: boolean;
  defaultLanguage: string;
}

export interface ParsedM3U {
  streams: Omit<Stream, 'id' | 'sourceId' | 'enabled' | 'status'>[];
}

export interface HealthCheckResult {
  streamId: string;
  status: 'alive' | 'dead';
  responseTime?: number;
  checkedAt: number;
}
