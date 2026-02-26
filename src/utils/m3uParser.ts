import { Stream } from '../types';

export interface ParsedStream {
  name: string;
  url: string;
  logo?: string;
  group: string;
  tvgId?: string;
  tvgName?: string;
  // Extended stream metadata
  licenseType?: string;    // clearkey, widevine, playready
  licenseKey?: string;     // DRM key (clearkey: "kid:key")
  userAgent?: string;      // Custom User-Agent
  referer?: string;        // HTTP Referer
  cookie?: string;         // HTTP Cookie
  httpHeaders?: Record<string, string>; // All custom HTTP headers
  streamType?: 'hls' | 'dash' | 'direct'; // Stream protocol type
}

function extractAttribute(line: string, attr: string): string | undefined {
  const patterns = [
    new RegExp(`${attr}="([^"]*)"`, 'i'),
    new RegExp(`${attr}='([^']*)'`, 'i'),
    new RegExp(`${attr}=([^\\s,]+)`, 'i'),
  ];
  for (const p of patterns) {
    const m = line.match(p);
    if (m) return m[1].trim();
  }
  return undefined;
}

function extractName(extinf: string): string {
  const commaIdx = extinf.lastIndexOf(',');
  if (commaIdx !== -1) {
    return extinf.substring(commaIdx + 1).trim();
  }
  return 'Unknown Channel';
}

function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u')) return 'hls';
  return 'direct';
}

export function parseM3U(content: string, sourceId: string): Stream[] {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const streams: Stream[] = [];

  let currentExtInf: string | null = null;
  let pendingLicenseType: string | undefined;
  let pendingLicenseKey: string | undefined;
  let pendingUserAgent: string | undefined;
  let pendingReferer: string | undefined;
  let pendingCookie: string | undefined;
  let pendingHeaders: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
      // Reset pending metadata for new stream
      pendingLicenseType = undefined;
      pendingLicenseKey = undefined;
      pendingUserAgent = undefined;
      pendingReferer = undefined;
      pendingCookie = undefined;
      pendingHeaders = {};
    }

    // ── DRM / Kodi properties ─────────────────────────────────────────────
    else if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '');
      if (prop.startsWith('inputstream.adaptive.license_type=')) {
        pendingLicenseType = prop.split('=').slice(1).join('=').trim();
      } else if (prop.startsWith('inputstream.adaptive.license_key=')) {
        pendingLicenseKey = prop.split('=').slice(1).join('=').trim();
      }
    }

    // ── VLC options ───────────────────────────────────────────────────────
    else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) {
        pendingUserAgent = opt.replace('http-user-agent=', '').trim();
      } else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer=')) {
        pendingReferer = opt.split('=').slice(1).join('=').trim();
      }
    }

    // ── HTTP headers (cookie, etc.) via #EXTHTTP ──────────────────────────
    // Format: #EXTHTTP:{"cookie":"...","User-Agent":"..."}
    else if (line.startsWith('#EXTHTTP:')) {
      try {
        const jsonStr = line.replace('#EXTHTTP:', '').trim();
        const headers = JSON.parse(jsonStr);
        if (headers.cookie || headers.Cookie) {
          pendingCookie = headers.cookie || headers.Cookie;
        }
        if (headers['User-Agent'] || headers['user-agent']) {
          pendingUserAgent = pendingUserAgent || headers['User-Agent'] || headers['user-agent'];
        }
        // Store all headers
        Object.entries(headers).forEach(([k, v]) => {
          pendingHeaders[k] = String(v);
        });
      } catch { /* invalid JSON — ignore */ }
    }

    // ── Stream URL ────────────────────────────────────────────────────────
    else if (
      !line.startsWith('#') &&
      (
        line.startsWith('http') ||
        line.startsWith('rtmp') ||
        line.startsWith('rtsp') ||
        line.endsWith('.m3u8') ||
        line.endsWith('.mpd') ||
        line.endsWith('.ts')
      )
    ) {
      const url = line;
      let name = 'Unknown Channel';
      let logo: string | undefined;
      let group = 'Uncategorized';
      let tvgId: string | undefined;
      let tvgName: string | undefined;

      if (currentExtInf) {
        name = extractName(currentExtInf) || 'Unknown Channel';
        logo = extractAttribute(currentExtInf, 'tvg-logo');
        group = extractAttribute(currentExtInf, 'group-title') || 'Uncategorized';
        tvgId = extractAttribute(currentExtInf, 'tvg-id');
        tvgName = extractAttribute(currentExtInf, 'tvg-name');
        currentExtInf = null;
      }

      const streamType = detectStreamType(url);

      // Build the stream — include all extended metadata
      const stream: Stream = {
        id: `${sourceId}_${streams.length}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        url,
        logo,
        group,
        tvgId,
        tvgName,
        sourceId,
        enabled: true,
        status: 'unknown',
        streamType,
        // DRM / headers metadata
        ...(pendingLicenseType && { licenseType: pendingLicenseType }),
        ...(pendingLicenseKey  && { licenseKey:  pendingLicenseKey }),
        ...(pendingUserAgent   && { userAgent:   pendingUserAgent }),
        ...(pendingReferer     && { referer:     pendingReferer }),
        ...(pendingCookie      && { cookie:      pendingCookie }),
        ...(Object.keys(pendingHeaders).length > 0 && { httpHeaders: { ...pendingHeaders } }),
      };

      streams.push(stream);

      // Reset pending metadata
      pendingLicenseType = undefined;
      pendingLicenseKey  = undefined;
      pendingUserAgent   = undefined;
      pendingReferer     = undefined;
      pendingCookie      = undefined;
      pendingHeaders     = {};
    }

    // Skip other directives
    else if (line.startsWith('#')) {
      continue;
    }
  }

  return streams;
}

export async function fetchM3U(url: string, corsProxy: string): Promise<string> {
  const proxies = [
    corsProxy,
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    'https://cors-anywhere.herokuapp.com/',
  ].filter(Boolean);

  let lastError: Error | null = null;

  // Try direct first
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (resp.ok) return await resp.text();
  } catch (e) {
    lastError = e as Error;
  }

  // Try proxies
  for (const proxy of proxies) {
    try {
      const proxyUrl = proxy.includes('?') ? `${proxy}${encodeURIComponent(url)}` : `${proxy}${url}`;
      const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const text = await resp.text();
        // allorigins wraps in JSON
        if (proxy.includes('allorigins')) {
          try {
            const json = JSON.parse(text);
            return json.contents || text;
          } catch { return text; }
        }
        return text;
      }
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw lastError || new Error('Failed to fetch M3U from all sources');
}
