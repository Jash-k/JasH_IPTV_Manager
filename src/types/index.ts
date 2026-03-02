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
  isDrm?: boolean;
  drmKeyId?: string;
  drmKey?: string;
  keyId?: string;
  key?: string;
  isActive: boolean;
  enabled?: boolean;
  order: number;
  sourceId: string;
  tags?: string[];
  streamType?: 'hls' | 'dash' | 'direct';
  licenseType?: string;
  licenseKey?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
  isTamil?: boolean;
  status?: string;
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
  pinnedChannels: string[];    // channel IDs explicitly pinned/added
  blockedChannels: string[];   // channel IDs explicitly blocked/removed
  createdAt: string;
  updatedAt: string;
}

export interface DrmProxy {
  id: string;
  channelId: string;
  channelName?: string;
  keyId: string;
  key: string;
  licenseUrl?: string;
  licenseType?: string;
  proxyUrl: string;
  isActive: boolean;
  notes?: string;
}

export type TabType = 'sources' | 'channels' | 'groups' | 'playlists' | 'editor' | 'drm' | 'server';
