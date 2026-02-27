import { Stream } from '../types';

export interface ParsedStream {
  name: string;
  url: string;
  logo?: string;
  group: string;
  tvgId?: string;
  tvgName?: string;
  licenseType?: string;
  licenseKey?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
  streamType?: 'hls' | 'dash' | 'direct';
}

// ── Attribute extractor ───────────────────────────────────────────────────────
function extractAttribute(line: string, attr: string): string | undefined {
  const patterns = [
    new RegExp(`${attr}="([^"]*)"`, 'i'),
    new RegExp(`${attr}='([^']*)'`, 'i'),
  ];
  for (const p of patterns) {
    const m = line.match(p);
    if (m) return m[1].trim();
  }
  return undefined;
}

// ── Channel name extractor — precise, handles commas inside attribute values ──
//
// M3U format:  #EXTINF:-1 tvg-logo="url,with,commas" group-title="X", Channel Name
//
// Strategy:
//   1. Find the last comma that is NOT inside a quoted attribute value
//   2. Everything after that comma is the channel name
function extractName(extinf: string): string {
  // Remove the #EXTINF:-1 leader and duration
  // The line looks like: #EXTINF:-1 [attributes],Channel Name
  // or:                  #EXTINF:0 [attributes],Channel Name

  // Step 1 — strip the #EXTINF:-N  prefix
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');
  // withoutPrefix is now: [attributes..] , Channel Name
  //  e.g.: tvg-logo="a,b,c.jpg" group-title="Movies", 12 B

  // Step 2 — walk character by character, tracking quote state
  let inQuote = false;
  let quoteChar = '';
  let lastUnquotedComma = -1;

  for (let i = 0; i < withoutPrefix.length; i++) {
    const ch = withoutPrefix[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ',') {
        lastUnquotedComma = i;
      }
    }
  }

  if (lastUnquotedComma !== -1) {
    return withoutPrefix.substring(lastUnquotedComma + 1).trim();
  }

  // Fallback: everything after the last comma (original behaviour)
  const fallback = extinf.lastIndexOf(',');
  if (fallback !== -1) return extinf.substring(fallback + 1).trim();

  return 'Unknown Channel';
}

// ── Stream type detector ──────────────────────────────────────────────────────
function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u')) return 'hls';
  return 'direct';
}

// ── Main M3U parser ───────────────────────────────────────────────────────────
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

  const resetPending = () => {
    pendingLicenseType = undefined;
    pendingLicenseKey  = undefined;
    pendingUserAgent   = undefined;
    pendingReferer     = undefined;
    pendingCookie      = undefined;
    pendingHeaders     = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── #EXTINF ───────────────────────────────────────────────────────────
    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
      resetPending();
      continue;
    }

    // ── DRM / Kodi properties ─────────────────────────────────────────────
    if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '');
      if (prop.startsWith('inputstream.adaptive.license_type=')) {
        pendingLicenseType = prop.split('=').slice(1).join('=').trim();
      } else if (prop.startsWith('inputstream.adaptive.license_key=')) {
        pendingLicenseKey = prop.split('=').slice(1).join('=').trim();
      }
      continue;
    }

    // ── VLC options ───────────────────────────────────────────────────────
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) {
        pendingUserAgent = opt.replace('http-user-agent=', '').trim();
      } else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer=')) {
        pendingReferer = opt.split('=').slice(1).join('=').trim();
      }
      continue;
    }

    // ── HTTP headers via #EXTHTTP ─────────────────────────────────────────
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const jsonStr = line.replace('#EXTHTTP:', '').trim();
        const headers = JSON.parse(jsonStr);
        if (headers.cookie || headers.Cookie) {
          pendingCookie = headers.cookie || headers.Cookie;
        }
        if (headers['User-Agent'] || headers['user-agent']) {
          pendingUserAgent = pendingUserAgent || headers['User-Agent'] || headers['user-agent'];
        }
        Object.entries(headers).forEach(([k, v]) => {
          pendingHeaders[k] = String(v);
        });
      } catch { /* invalid JSON — ignore */ }
      continue;
    }

    // ── Stream URL ────────────────────────────────────────────────────────
    if (
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
      let name  = 'Unknown Channel';
      let logo: string | undefined;
      let group = 'Uncategorized';
      let tvgId: string | undefined;
      let tvgName: string | undefined;

      if (currentExtInf) {
        name    = extractName(currentExtInf) || 'Unknown Channel';
        logo    = extractAttribute(currentExtInf, 'tvg-logo');
        group   = extractAttribute(currentExtInf, 'group-title') || 'Uncategorized';
        tvgId   = extractAttribute(currentExtInf, 'tvg-id');
        tvgName = extractAttribute(currentExtInf, 'tvg-name');
        currentExtInf = null;
      }

      const streamType = detectStreamType(url);

      const stream: Stream = {
        id         : `${sourceId}_${streams.length}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        url,
        logo,
        group,
        tvgId,
        tvgName,
        sourceId,
        enabled    : true,
        status     : 'unknown',
        streamType,
        ...(pendingLicenseType && { licenseType: pendingLicenseType }),
        ...(pendingLicenseKey  && { licenseKey:  pendingLicenseKey }),
        ...(pendingUserAgent   && { userAgent:   pendingUserAgent }),
        ...(pendingReferer     && { referer:     pendingReferer }),
        ...(pendingCookie      && { cookie:      pendingCookie }),
        ...(Object.keys(pendingHeaders).length > 0 && { httpHeaders: { ...pendingHeaders } }),
      };

      streams.push(stream);
      resetPending();
      currentExtInf = null;
      continue;
    }

    // Skip other # directives
  }

  return streams;
}

// ── Remote M3U fetcher ────────────────────────────────────────────────────────
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
      const proxyUrl = proxy.includes('?')
        ? `${proxy}${encodeURIComponent(url)}`
        : `${proxy}${url}`;
      const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const text = await resp.text();
        if (proxy.includes('allorigins')) {
          try { const json = JSON.parse(text); return json.contents || text; } catch { return text; }
        }
        return text;
      }
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw lastError || new Error('Failed to fetch M3U from all sources');
}
