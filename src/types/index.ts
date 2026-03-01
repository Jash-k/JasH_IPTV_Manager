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
  refreshInterval: number; // minutes, 0 = no auto
  totalParsed: number;
  tamilFiltered: number;
  enabled: boolean;
}

export interface ServerConfig {
  serverUrl: string;
  port: number;
  playlistName: string;
  keepAliveEnabled: boolean;
  keepAliveInterval: number; // minutes
}

export type Tab = 'sources' | 'channels' | 'player' | 'generator' | 'deploy';
