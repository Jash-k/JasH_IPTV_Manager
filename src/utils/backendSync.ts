/**
 * JASH ADDON — Backend Sync Utility v2
 * Pushes stream configuration from React frontend to the backend server.
 */

export interface SyncResult {
  ok: boolean;
  streams?: number;
  error?: string;
  version?: string;
  backendUrl?: string;
}

export interface BackendHealth {
  status: string;
  addon: string;
  streams: number;
  groups: number;
  cache: number;
  uptime: number;
  publicUrl: string;
  manifestUrl: string;
}

/**
 * Detect the backend base URL.
 * • Production (Render/Koyeb/Railway): same origin as the React app
 * • Local dev: Vite runs on :5173 but backend runs on :7000
 */
export function getBackendBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:7000';

  const { protocol, hostname, port } = window.location;

  // Production — same host serves both frontend and backend
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    const portSuffix =
      port && port !== '80' && port !== '443' ? `:${port}` : '';
    return `${protocol}//${hostname}${portSuffix}`;
  }

  // Local dev — backend runs on 7000, Vite on 5173
  return 'http://localhost:7000';
}

/**
 * Manifest URL — the https:// URL to paste into Stremio.
 */
export function getManifestUrl(): string {
  return `${getBackendBase()}/manifest.json`;
}

/**
 * Stremio deep-link format:
 *   stremio://HOST:PORT/manifest.json
 * (no protocol prefix — Stremio handles this itself)
 */
export function getStremioInstallUrl(): string {
  const base    = getBackendBase();
  const noProto = base.replace(/^https?:\/\//, '');
  return `stremio://${noProto}/manifest.json`;
}

/**
 * Sync the full configuration to the backend.
 * After this call, the backend bumps its manifest version so
 * Stremio detects new channels without requiring addon reinstall.
 */
export async function syncConfigToBackend(config: {
  streams: unknown[];
  groups: unknown[];
  settings: unknown;
  sources?: unknown[];
  combinedChannels?: unknown[];
}): Promise<SyncResult> {
  const base    = getBackendBase();
  const syncUrl = `${base}/api/sync`;

  try {
    const response = await fetch(syncUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(config),
      signal : AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      return { ok: false, error: `HTTP ${response.status}: ${text}`, backendUrl: syncUrl };
    }

    const data = await response.json();
    return {
      ok      : true,
      streams : data.streams,
      version : data.version,
      backendUrl: base,
    };

  } catch (e) {
    const msg = (e as Error).message || String(e);
    const isNetErr =
      msg.includes('Failed to fetch') ||
      msg.includes('ECONNREFUSED')    ||
      msg.includes('NetworkError')    ||
      msg.includes('Load failed')     ||
      msg.includes('AbortError')      ||
      msg.includes('timeout');

    return {
      ok       : false,
      error    : isNetErr
        ? 'Backend not reachable. Is the server running? Check the Backend tab.'
        : msg,
      backendUrl: syncUrl,
    };
  }
}

/**
 * Check if the backend is alive and return health data.
 */
export async function checkBackendHealth(): Promise<BackendHealth | null> {
  const base = getBackendBase();
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return await response.json() as BackendHealth;
  } catch {
    return null;
  }
}

/**
 * Clear the backend HLS stream cache.
 */
export async function clearBackendCache(): Promise<boolean> {
  const base = getBackendBase();
  try {
    const response = await fetch(`${base}/api/cache`, {
      method : 'DELETE',
      signal : AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
