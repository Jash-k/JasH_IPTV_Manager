// ─── Backend URL Detection ─────────────────────────────────────────────────────
export function getBackendBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:7000';
  const { protocol, hostname, port } = window.location;
  // In production (Render/Koyeb/Railway), the backend serves the frontend too
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  }
  // Local development: Vite runs on 5173, backend on 7000
  return 'http://localhost:7000';
}

export function getManifestUrl(): string {
  return `${getBackendBase()}/manifest.json`;
}

export function getMovieManifestUrl(): string {
  return `${getBackendBase()}/movie/manifest.json`;
}

export function getStremioInstallUrl(): string {
  const base = getBackendBase().replace(/^https?:\/\//, '');
  return `stremio://${base}/manifest.json`;
}

export function getMovieStremioInstallUrl(): string {
  const base = getBackendBase().replace(/^https?:\/\//, '');
  return `stremio://${base}/movie/manifest.json`;
}

export function getPlaylistUrl(): string {
  return `${getBackendBase()}/playlist.m3u`;
}

export function getShortPlaylistUrls(): Record<string, string> {
  const base = getBackendBase();
  return {
    main    : `${base}/playlist.m3u`,
    short   : `${base}/p.m3u`,
    iptv    : `${base}/iptv.m3u`,
    live    : `${base}/live.m3u`,
    channels: `${base}/channels.m3u`,
  };
}

export function getGroupPlaylistUrl(groupName: string): string {
  return `${getBackendBase()}/playlist/${encodeURIComponent(groupName)}.m3u`;
}

export function getInstallPageUrl(): string {
  return `${getBackendBase()}/install`;
}

// ─── Health Check ──────────────────────────────────────────────────────────────
export async function checkBackendHealth(): Promise<{
  online: boolean;
  data?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const res = await fetch(`${getBackendBase()}/health`, {
      method : 'GET',
      headers: { 'Accept': 'application/json' },
      signal : AbortSignal.timeout(8000),
    });
    if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { online: true, data };
  } catch (e: unknown) {
    return { online: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── IPTV Sync ─────────────────────────────────────────────────────────────────
export async function syncConfigToBackend(payload: {
  streams: unknown[];
  groups?: unknown[];
  combinedChannels?: unknown[];
  settings?: Record<string, unknown>;
}): Promise<{ ok: boolean; message: string; version?: string; data?: unknown }> {
  try {
    const res = await fetch(`${getBackendBase()}/api/sync`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload),
      signal : AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.error || `HTTP ${res.status}` };
    }
    return {
      ok     : true,
      message: `✅ Synced ${data.streams} streams${data.autoCombined ? ` (${data.autoCombined} auto-combined)` : ''} · v${data.version}`,
      version: data.version,
      data,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('fetch') || msg.includes('Failed')) {
      return { ok: false, message: '❌ Backend offline. Deploy the server first.' };
    }
    return { ok: false, message: `❌ Sync failed: ${msg}` };
  }
}

// ─── Movie Sync ────────────────────────────────────────────────────────────────
export async function syncMoviesToBackend(payload: {
  streams: unknown[];
  settings?: Record<string, unknown>;
}): Promise<{ ok: boolean; message: string; version?: string; data?: unknown }> {
  try {
    const res = await fetch(`${getBackendBase()}/api/movie-sync`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload),
      signal : AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.error || `HTTP ${res.status}` };
    }
    return {
      ok     : true,
      message: `✅ Synced ${data.streams} streams · ${data.uniqueMovies} unique movies · v${data.version}`,
      version: data.version,
      data,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `❌ Movie sync failed: ${msg}` };
  }
}

// ─── Clear Cache ───────────────────────────────────────────────────────────────
export async function clearBackendCache(): Promise<{ ok: boolean; cleared?: number }> {
  try {
    const res  = await fetch(`${getBackendBase()}/api/cache`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return { ok: true, cleared: data.cleared };
  } catch { return { ok: false }; }
}

// ─── Fetch Playlist Info ───────────────────────────────────────────────────────
export async function fetchPlaylistInfo(): Promise<{
  total: number; groups: number;
  playlistUrl: string; shortUrls: Record<string, string>;
  groupUrls: { group: string; url: string; count: number }[];
} | null> {
  try {
    const res  = await fetch(`${getBackendBase()}/api/playlist-info`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Fetch Install Info ────────────────────────────────────────────────────────
export async function fetchInstallInfo(): Promise<{
  iptv: { manifestUrl: string; stremioUrl: string; webInstallUrl: string; version: string; streams: number };
  movie: { manifestUrl: string; stremioUrl: string; webInstallUrl: string; version: string; movies: number };
  configureUrl: string; playlistUrl: string;
  shortUrls: Record<string, string>;
} | null> {
  try {
    const res  = await fetch(`${getBackendBase()}/api/install`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
