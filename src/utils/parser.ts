/**
 * parser.ts — Central parsing + M3U generation
 * Uses universalParse for all source imports
 */

import { Channel, PlaylistConfig, Source } from '../types';
import { universalParse, isTamilChannel } from './universalParser';

export { isTamilChannel };

// ─── Robust URL fetcher ───────────────────────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS_PROXIES = [
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

function isGithubRaw(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes('raw.githubusercontent.com') || u.includes('gist.githubusercontent.com');
}

function getServerProxy(url: string): string | null {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes(':517')) {
    return null;
  }
  return `${origin}/proxy/cors?url=${encodeURIComponent(url)}`;
}

async function tryFetch(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*' },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function unwrapAllOrigins(raw: string): Promise<string> {
  if (!raw.trimStart().startsWith('{')) return raw;
  try {
    const j = JSON.parse(raw);
    if (typeof j.contents === 'string') return j.contents;
  } catch { /* ignore */ }
  return raw;
}

export async function fetchSourceContent(url: string): Promise<string> {
  const errors: string[] = [];

  // 1. Server-side CORS proxy (deployed server — best 403 bypass)
  const serverProxy = getServerProxy(url);
  if (serverProxy) {
    try { return await tryFetch(serverProxy); }
    catch (e) { errors.push(`server-proxy: ${(e as Error).message}`); }
  }

  // 2. Direct fetch — always works for GitHub raw, public CDNs, workers.dev
  if (isGithubRaw(url) || url.includes('workers.dev')) {
    try { return await tryFetch(url); }
    catch (e) { errors.push(`direct: ${(e as Error).message}`); }
  }

  // 3. Try direct anyway
  try { return await tryFetch(url); }
  catch (e) { errors.push(`direct: ${(e as Error).message}`); }

  // 4. CORS proxies
  for (const makeProxy of CORS_PROXIES) {
    const proxyUrl = makeProxy(url);
    try {
      const raw = await tryFetch(proxyUrl);
      return await unwrapAllOrigins(raw);
    } catch (e) {
      errors.push(`proxy(${proxyUrl.substring(0, 40)}): ${(e as Error).message}`);
    }
  }

  throw new Error(`Failed to fetch "${url}" via all methods.\n${errors.join('\n')}`);
}

// ─── Main parse entry point ───────────────────────────────────────────────────
/**
 * Parse any content string (M3U, JSON, plain URLs, PHP/worker response)
 * into Channel[] — strips DRM automatically.
 */
export function parseAny(content: string, sourceId: string): Channel[] {
  return universalParse(content, sourceId);
}

// ─── M3U generator ───────────────────────────────────────────────────────────
/**
 * Generate an M3U playlist from channels.
 * - Uses /redirect/:id for all streams (pure 302)
 * - Multiple sources for same name → multiple entries
 * - Respects tamilOnly and group filters from playlist config
 */
export function generateM3U(
  channels: Channel[],
  _serverUrl: string,
  playlist?: PlaylistConfig,
  sources?: Source[]
): string {
  let filtered = channels.filter(c => c.isActive !== false && c.enabled !== false);

  if (playlist) {
    // Tamil filter
    if (playlist.tamilOnly) {
      filtered = filtered.filter(c =>
        isTamilChannel(String(c.name || ''), String(c.group || ''), String(c.language || ''))
      );
    }

    // Source tamil filters
    if (sources && sources.length > 0) {
      filtered = filtered.filter(c => {
        const src = sources.find(s => s.id === c.sourceId);
        if (!src || !src.tamilFilter) return true;
        return isTamilChannel(String(c.name || ''), String(c.group || ''), String(c.language || ''));
      });
    }

    // Include groups filter
    if (playlist.includeGroups && playlist.includeGroups.length > 0) {
      filtered = filtered.filter(c => playlist.includeGroups.includes(String(c.group || '')));
    }

    // Exclude groups filter
    if (playlist.excludeGroups && playlist.excludeGroups.length > 0) {
      filtered = filtered.filter(c => !playlist.excludeGroups.includes(String(c.group || '')));
    }

    // Blocked channels
    if (playlist.blockedChannels && playlist.blockedChannels.length > 0) {
      filtered = filtered.filter(c => !playlist.blockedChannels.includes(c.id));
    }

    // Pinned channels first
    if (playlist.pinnedChannels && playlist.pinnedChannels.length > 0) {
      const pinned = filtered.filter(c => playlist.pinnedChannels.includes(c.id));
      const rest   = filtered.filter(c => !playlist.pinnedChannels.includes(c.id));
      filtered = [...pinned, ...rest];
    }
  }

  // Sort by order
  filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let m3u = '#EXTM3U\r\n';

  for (const ch of filtered) {
    const name    = String(ch.name    || 'Unknown Channel');
    const logo    = String(ch.logo    || '');
    const group   = String(ch.group   || 'General');
    const tvgId   = String(ch.tvgId   || ch.id || '');
    const tvgName = String(ch.tvgName || name);

    // Use EXACT original URL (rawUrl) — preserves pipe headers like |User-Agent=...|Referer=...
    // Fall back to clean url if rawUrl not available
    const streamUrl = String(ch.rawUrl || ch.url || '');
    if (!streamUrl) continue;

    m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${logo}" group-title="${group}",${name}\r\n`;

    // Re-emit VLC/player header opts if pipe headers were present
    if (ch.rawUrl && ch.rawUrl !== ch.url) {
      // The rawUrl already contains |User-Agent=...|Referer=... — use as-is
      // Most players (VLC, TiviMate, Kodi, ExoPlayer) read pipe-headers natively
      m3u += `${streamUrl}\r\n`;
    } else {
      // No pipe headers — emit #EXTVLCOPT for players that prefer explicit opts
      if (ch.userAgent) m3u += `#EXTVLCOPT:http-user-agent=${ch.userAgent}\r\n`;
      if (ch.referer)   m3u += `#EXTVLCOPT:http-referrer=${ch.referer}\r\n`;
      m3u += `${streamUrl}\r\n`;
    }
  }

  return m3u;
}

// ─── Tamil source playlist generator ─────────────────────────────────────────
export function generateTamilM3U(channels: Channel[], serverUrl: string): string {
  const tamilChannels = channels.filter(c =>
    (c.isActive !== false || c.enabled !== false) &&
    isTamilChannel(String(c.name || ''), String(c.group || ''), String(c.language || ''))
  );
  return generateM3U(tamilChannels, serverUrl);
}
