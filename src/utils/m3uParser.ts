import { Channel } from '../types';

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

function extractName(extinf: string): string {
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');
  let inQuote = false;
  let quoteChar = '';
  let lastUnquotedComma = -1;
  for (let i = 0; i < withoutPrefix.length; i++) {
    const ch = withoutPrefix[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      else if (ch === ',') lastUnquotedComma = i;
    }
  }
  if (lastUnquotedComma !== -1) return withoutPrefix.substring(lastUnquotedComma + 1).trim();
  const fallback = extinf.lastIndexOf(',');
  if (fallback !== -1) return extinf.substring(fallback + 1).trim();
  return 'Unknown Channel';
}

function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u')) return 'hls';
  return 'direct';
}

export function parseM3U(content: string, sourceId: string): Channel[] {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const channels: Channel[] = [];
  let currentExtInf: string | null = null;
  let pendingLicenseType: string | undefined;
  let pendingLicenseKey: string | undefined;
  let pendingUserAgent: string | undefined;
  let pendingReferer: string | undefined;
  let pendingCookie: string | undefined;
  let pendingHeaders: Record<string, string> = {};

  const resetPending = () => {
    pendingLicenseType = undefined; pendingLicenseKey = undefined;
    pendingUserAgent = undefined; pendingReferer = undefined;
    pendingCookie = undefined; pendingHeaders = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) { currentExtInf = line; resetPending(); continue; }
    if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '');
      if (prop.startsWith('inputstream.adaptive.license_type='))
        pendingLicenseType = prop.split('=').slice(1).join('=').trim();
      else if (prop.startsWith('inputstream.adaptive.license_key='))
        pendingLicenseKey = prop.split('=').slice(1).join('=').trim();
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) pendingUserAgent = opt.replace('http-user-agent=', '').trim();
      else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer='))
        pendingReferer = opt.split('=').slice(1).join('=').trim();
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const headers = JSON.parse(line.replace('#EXTHTTP:', '').trim()) as Record<string, string>;
        if (headers.cookie || headers.Cookie) pendingCookie = headers.cookie || headers.Cookie;
        if (headers['User-Agent'] || headers['user-agent'])
          pendingUserAgent = pendingUserAgent || headers['User-Agent'] || headers['user-agent'];
        Object.entries(headers).forEach(([k, v]) => { pendingHeaders[k] = String(v); });
      } catch { /* ignore */ }
      continue;
    }
    if (!line.startsWith('#') && (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp') || line.endsWith('.m3u8') || line.endsWith('.mpd') || line.endsWith('.ts'))) {
      const url = line;
      let name = 'Unknown Channel', logo: string | undefined, group = 'Uncategorized';
      let tvgId: string | undefined, tvgName: string | undefined, language: string | undefined, country: string | undefined;
      if (currentExtInf) {
        name = extractName(currentExtInf) || 'Unknown Channel';
        logo = extractAttribute(currentExtInf, 'tvg-logo');
        group = extractAttribute(currentExtInf, 'group-title') || 'Uncategorized';
        tvgId = extractAttribute(currentExtInf, 'tvg-id');
        tvgName = extractAttribute(currentExtInf, 'tvg-name');
        language = extractAttribute(currentExtInf, 'tvg-language');
        country = extractAttribute(currentExtInf, 'tvg-country');
        currentExtInf = null;
      }
      // Store DRM fields as unknown so the store's hasDRM() filter can detect and strip them
      const raw: Record<string, unknown> = {
        id: `${sourceId}_${channels.length}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name, url, logo, group, tvgId, tvgName, language, country,
        sourceId, isActive: true, enabled: true, order: channels.length,
        streamType: detectStreamType(url),
      };
      if (pendingLicenseType) { raw.licenseType = pendingLicenseType; raw.isDrm = true; }
      if (pendingLicenseKey)  { raw.licenseKey  = pendingLicenseKey;  raw.isDrm = true; }
      if (pendingUserAgent)   raw.userAgent  = pendingUserAgent;
      if (pendingReferer)     raw.referer    = pendingReferer;
      if (pendingCookie)      raw.cookie     = pendingCookie;
      if (Object.keys(pendingHeaders).length > 0) raw.httpHeaders = { ...pendingHeaders };
      const ch = raw as unknown as Channel;
      channels.push(ch);
      resetPending();
      currentExtInf = null;
    }
  }
  return channels;
}

export async function fetchM3U(url: string, _corsProxy?: string): Promise<string> {
  const { fetchUrl } = await import('./fetcher');
  return fetchUrl(url);
}
