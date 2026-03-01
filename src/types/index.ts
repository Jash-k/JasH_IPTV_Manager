export interface Channel {
  id: string;
  name: string;
  group: string;
  logo: string;
  url: string;
  kid: string;
  contentKey: string;
  enabled: boolean;
  language: string;
}

export interface Source {
  id: string;
  name: string;
  url: string;
  format: 'm3u' | 'json' | 'auto';
  lastRefresh: number | null;
  refreshInterval: number;
  totalParsed: number;
  tamilFiltered: number;
  enabled: boolean;
  tamilFilter: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  description: string;
  sourceIds: string[];
  tamilOnly: boolean;
  enabledOnly: boolean;
  groupFilter: string;
  sortBy: 'name' | 'group' | 'source' | 'none';
  createdAt: number;
  updatedAt: number;
}

export interface ServerConfig {
  serverUrl: string;
  port: number;
  playlistName: string;
  keepAliveEnabled: boolean;
  keepAliveInterval: number;
}

export type Tab = 'sources' | 'channels' | 'player' | 'generator' | 'playlists' | 'deploy';
