/**
 * MediaFlow Proxy Integration
 * https://github.com/mhdzumair/mediaflow-proxy
 *
 * MediaFlow is a Python proxy that handles:
 *   - HLS streams (with/without headers)
 *   - DASH streams (with/without DRM)
 *   - ClearKey DRM decryption
 *   - Widevine DRM (via key extraction)
 *   - Custom headers (Cookie, UA, Referer)
 *
 * Endpoints used:
 *   /proxy/hls/manifest.m3u8  — HLS proxy
 *   /proxy/mpd/manifest.m3u8  — DASH/DRM proxy (converts to HLS!)
 *   /proxy/stream             — Direct stream proxy
 */

export interface MediaFlowConfig {
  url: string;        // e.g. https://mf.yourapp.com
  apiPassword: string; // MEDIAFLOW_API_PASSWORD
}

export interface MediaFlowStream {
  proxyUrl: string;
  type: 'hls' | 'mpd' | 'stream';
  originalUrl: string;
}

// ─── Build MediaFlow proxy URL ────────────────────────────────────────────────

/**
 * Build a MediaFlow proxy URL for any stream type.
 * MediaFlow converts DASH+DRM → HLS on-the-fly so any player can play it.
 */
export function buildMediaFlowUrl(
  mfBase: string,
  mfPassword: string,
  streamUrl: string,
  options: {
    kid?: string;
    key?: string;
    cookie?: string;
    userAgent?: string;
    referer?: string;
    headers?: Record<string, string>;
  } = {}
): string {
  const url = mfBase.replace(/\/$/, '');
  const lower = streamUrl.toLowerCase();

  // Build query params
  const params: Record<string, string> = {
    api_password: mfPassword,
    d: streamUrl,
  };

  // Add headers as individual params
  const hdrs: Record<string, string> = {};
  if (options.userAgent) hdrs['User-Agent'] = options.userAgent;
  if (options.referer)   hdrs['Referer']    = options.referer;
  if (options.cookie)    hdrs['Cookie']     = options.cookie;
  if (options.headers)   Object.assign(hdrs, options.headers);

  if (Object.keys(hdrs).length > 0) {
    params.h = JSON.stringify(hdrs);
  }

  // Add ClearKey DRM params if present
  if (options.kid && options.key) {
    params.key_id = options.kid;
    params.key    = options.key;
  }

  const qs = new URLSearchParams(params).toString();

  // Choose endpoint based on stream type
  if (lower.includes('.mpd') || lower.includes('manifest(format=mpd')) {
    // DASH/DRM → MediaFlow converts to HLS
    return `${url}/proxy/mpd/manifest.m3u8?${qs}`;
  } else if (lower.includes('.m3u8') || lower.includes('.m3u')) {
    // HLS proxy
    return `${url}/proxy/hls/manifest.m3u8?${qs}`;
  } else {
    // Direct stream proxy
    return `${url}/proxy/stream?${qs}`;
  }
}

/**
 * Get the MediaFlow endpoint type for display
 */
export function getMediaFlowEndpoint(streamUrl: string): 'mpd' | 'hls' | 'stream' {
  const lower = streamUrl.toLowerCase();
  if (lower.includes('.mpd')) return 'mpd';
  if (lower.includes('.m3u8') || lower.includes('.m3u')) return 'hls';
  return 'stream';
}

/**
 * Test if MediaFlow proxy is reachable
 */
export async function testMediaFlow(mfBase: string, _mfPassword: string): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  try {
    const url = `${mfBase.replace(/\/$/, '')}/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      message: 'MediaFlow proxy is online',
      version: (data as { version?: string }).version,
    };
  } catch (e) {
    return { ok: false, message: `Cannot reach MediaFlow: ${String(e)}` };
  }
}

/**
 * Generate sample MediaFlow docker-compose.yml
 */
export function getDockerCompose(mfPassword: string): string {
  return `version: '3.8'
services:
  mediaflow-proxy:
    image: mhdzumair/mediaflow-proxy:latest
    ports:
      - "8888:8888"
    environment:
      - API_PASSWORD=${mfPassword || 'your_secret_password'}
      - TRANSPORT_ROUTES={}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8888/health"]
      interval: 30s
      timeout: 10s
      retries: 3`;
}

/**
 * Generate sample nginx reverse proxy config
 */
export function getNginxConfig(domain: string): string {
  return `server {
    listen 443 ssl;
    server_name ${domain || 'mf.yourdomain.com'};

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
    }
}`;
}
