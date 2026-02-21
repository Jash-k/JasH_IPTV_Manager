import { Stream } from '../types';

export interface ParsedStream {
  name: string;
  url: string;
  logo?: string;
  group: string;
  tvgId?: string;
  tvgName?: string;
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

export function parseM3U(content: string, sourceId: string): Stream[] {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const streams: Stream[] = [];
  let currentExtInf: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXTINF:')) {
      currentExtInf = line;
    } else if (line.startsWith('#')) {
      // skip other directives
      continue;
    } else if (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp') || line.endsWith('.m3u8') || line.endsWith('.ts')) {
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

      streams.push({
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
      });
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
