/**
 * JASH ADDON — Backend Sync Utility
 * Pushes the current stream configuration from the React frontend
 * to the backend server so Stremio can access it via the addon endpoints.
 */

export interface SyncResult {
  ok: boolean;
  streams?: number;
  error?: string;
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

/** Detect the backend base URL — same origin in production, localhost:7000 in dev */
export function getBackendBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:7000';
  const { protocol, hostname, port } = window.location;
  // Production: same origin as the React app (Render/Koyeb/Railway)
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    return `${protocol}//${hostname}${port && port !== '80' && port !== '443' ? `:${port}` : ''}`;
  }
  // Development: backend runs on 7000, Vite on 5173
  return 'http://localhost:7000';
}

/**
 * Sync the full configuration to the backend.
 */
export async function syncConfigToBackend(config: {
  streams: unknown[];
  groups: unknown[];
  settings: unknown;
  sources?: unknown[];
}): Promise<SyncResult> {
  const base    = getBackendBase();
  const syncUrl = `${base}/api/sync`;

  try {
    const response = await fetch(syncUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(config),
      signal : AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      return { ok: false, error: `HTTP ${response.status}: ${text}`, backendUrl: syncUrl };
    }

    const data = await response.json();
    return { ok: true, streams: data.streams, backendUrl: base };

  } catch (e) {
    const msg = (e as Error).message;
    if (
      msg.includes('Failed to fetch') ||
      msg.includes('ECONNREFUSED')    ||
      msg.includes('NetworkError')    ||
      msg.includes('Load failed')
    ) {
      return {
        ok       : false,
        error    : 'Backend not reachable. Running in offline/frontend-only mode.',
        backendUrl: syncUrl,
      };
    }
    return { ok: false, error: msg, backendUrl: syncUrl };
  }
}

/**
 * Check if the backend is reachable and get health status.
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
 * Get the manifest URL — always the real backend URL.
 * In production this is the same origin as the React app.
 * In dev this points to localhost:7000.
 */
export function getManifestUrl(): string {
  return `${getBackendBase()}/manifest.json`;
}

/**
 * Get the Stremio deep-link install URL.
 * Stremio protocol: stremio://host/manifest.json
 * Works on Windows/Mac/Android Stremio app.
 * For Samsung TV — user must manually enter the manifest URL.
 */
export function getStremioInstallUrl(): string {
  const base     = getBackendBase();
  // Strip protocol → stremio://host:port/manifest.json
  const noProto  = base.replace(/^https?:\/\//, '');
  return `stremio://${noProto}/manifest.json`;
}

/**
 * Get a human-readable HTTP manifest URL for copying into Stremio.
 */
export function getHttpManifestUrl(): string {
  return getManifestUrl();
}

/**
 * Clear the backend stream cache.
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
