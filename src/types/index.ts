export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group: string;
  tvgId?: string;
  tvgName?: string;
  language?: string;
  country?: string;
  isActive: boolean;
  enabled?: boolean;
  order: number;
  sourceId: string;
  tags?: string[];
  streamType?: 'hls' | 'dash' | 'direct';
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
  isTamil?: boolean;
  healthStatus?: 'ok' | 'error' | 'checking' | 'unknown';
  healthLatency?: number;
  lastHealthCheck?: string;
  multiSource?: boolean;
  combinedLinks?: CombinedLink[];
}

export interface CombinedLink {
  channelId: string;
  sourceId: string;
  sourceName?: string;
  url: string;
  latency?: number;
  status?: 'live' | 'dead' | 'unknown' | 'checking';
}

export interface Group {
  id: string;
  name: string;
  logo?: string;
  isActive: boolean;
  order: number;
  channelCount?: number;
  isTamil?: boolean;
}

export type SourceType = 'm3u' | 'json' | 'php' | 'url' | 'file';

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url?: string;
  content?: string;
  autoRefresh: boolean;
  refreshInterval: number;
  lastRefreshed?: string;
  status: 'idle' | 'loading' | 'success' | 'error';
  errorMessage?: string;
  channelCount?: number;
  tamilCount?: number;
  tamilFilter?: boolean;
  healthStatus?: 'ok' | 'error' | 'checking' | 'unknown';
}

export interface PlaylistConfig {
  id: string;
  name: string;
  generatedUrl: string;
  includeGroups: string[];
  excludeGroups: string[];
  tamilOnly?: boolean;
  filterTags?: string[];
  pinnedChannels: string[];
  blockedChannels: string[];
  createdAt: string;
  updatedAt: string;
}

// TabType — NO drm tab
export type TabType = 'sources' | 'channels' | 'groups' | 'playlists' | 'editor' | 'server';
