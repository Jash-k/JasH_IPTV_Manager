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
  enabled?: boolean;        // alias for isActive — used by JSON parsers
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
  status?: string;          // 'unknown' | 'ok' | 'error' from parsers
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
}

export interface PlaylistConfig {
  id: string;
  name: string;
  generatedUrl: string;
  includeGroups: string[];
  excludeGroups: string[];
  tamilOnly?: boolean;
  filterTags?: string[];
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

export type TabType = 'sources' | 'channels' | 'groups' | 'playlists' | 'drm' | 'server';
