/**
 * parser.ts — Central orchestrator
 *
 * Exports:
 *   parseAny()           — parse any content → Channel[]
 *   fetchSourceContent() — fetch a URL robustly
 *   generateM3U()        — generate M3U playlist from channels
 *   generateTamilM3U()   — generate Tamil-only M3U
 *   isTamilChannel()     — Tamil detection
 */

import { Channel, PlaylistConfig, Source } from '../types';
import { universalParse, isTamilChannel } from './universalParser';

export { isTamilChannel };

// ─── Robust URL fetcher ───────────────────────────────────────────────────────
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS_PROXIES = [
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

function isPublicCDN(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('raw.githubusercontent.com') ||
    u.includes('gist.githubusercontent.com') ||
    u.includes('workers.dev') ||
    u.includes('github.io')
  );
}

function getServerProxy(url: string): string | null {
  if (typeof window === 'undefined') return null;
  const origin = window.location.origin;
  if (
    !origin ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes(':517')
  ) return null;
  return `${origin}/proxy/cors?url=${encodeURIComponent(url)}`;
}

async function tryFetch(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal:  ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function unwrap(raw: string): Promise<string> {
  const t = raw.trimStart();
  if (!t.startsWith('{')) return raw;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (typeof j.contents === 'string') return j.contents;
  } catch { /* ignore */ }
  return raw;
}

export async function fetchSourceContent(url: string): Promise<string> {
  const errs: string[] = [];

  // 1. Server-side CORS proxy (deployed app — best anti-403 bypass)
  const serverProxy = getServerProxy(url);
  if (serverProxy) {
    try { return await tryFetch(serverProxy); }
    catch (e) { errs.push(`server-proxy: ${(e as Error).message}`); }
  }

  // 2. Direct — always works for GitHub, workers.dev (CORS headers present)
  if (isPublicCDN(url)) {
    try { return await tryFetch(url); }
    catch (e) { errs.push(`direct-cdn: ${(e as Error).message}`); }
  }

  // 3. Direct attempt for any URL
  try { return await tryFetch(url); }
  catch (e) { errs.push(`direct: ${(e as Error).message}`); }

  // 4. CORS proxies
  for (const make of CORS_PROXIES) {
    try {
      const raw = await tryFetch(make(url));
      return await unwrap(raw);
    } catch (e) {
      errs.push(`proxy: ${(e as Error).message}`);
    }
  }

  throw new Error(
    `Failed to fetch "${url}" via all methods.\n${errs.slice(0, 4).join('\n')}`
  );
}

// ─── Main parse entry point ───────────────────────────────────────────────────
/**
 * Parse any content (M3U, JSON, plain URLs, PHP/worker response) → Channel[]
 * Automatically detects format. Strips DRM channels.
 *
 * Examples:
 *   parseAny('#EXTM3U\n#EXTINF:-1 tvg-id="9XJalwa.in@SD",9X Jalwa (1080p)\nhttps://b.jsrdn.com/...', 'src_1')
 *   parseAny('[{"id":"ThanthiOne.in","name":"Thanthi One","streamUrls":["https://..."]}]', 'src_2')
 */
export function parseAny(content: string, sourceId: string): Channel[] {
  return universalParse(content, sourceId);
}

// ─── M3U generator ───────────────────────────────────────────────────────────
/**
 * Generate M3U playlist from channels.
 * Uses rawUrl (exact source URL with pipe headers) for maximum player compatibility.
 *
 * Generated URL format:
 *   Direct streams   → exact rawUrl (e.g. https://stream.m3u8?token=abc|User-Agent=...)
 *   Redirect streams → /redirect/:id (pure 302 on server)
 *   HLS redirects    → /hls/:id/playlist.m3u8 (proxy on server)
 */
export function generateM3U(
  channels: Channel[],
  _serverUrl: string,
  playlist?: PlaylistConfig,
  sources?: Source[]
): string {
  let list = channels.filter(c => c.isActive !== false && c.enabled !== false);

  if (playlist) {
    // Tamil-only filter
    if (playlist.tamilOnly) {
      list = list.filter(c =>
        isTamilChannel(String(c.name || ''), String(c.group || ''), String(c.language || ''))
      );
    }

    // Per-source Tamil filters
    if (sources && sources.length > 0) {
      list = list.filter(c => {
        const src = sources.find(s => s.id === c.sourceId);
        if (!src || !src.tamilFilter) return true;
        return isTamilChannel(
          String(c.name || ''), String(c.group || ''), String(c.language || '')
        );
      });
    }

    // Include groups
    if (playlist.includeGroups && playlist.includeGroups.length > 0) {
      list = list.filter(c => playlist.includeGroups.includes(String(c.group || '')));
    }

    // Exclude groups
    if (playlist.excludeGroups && playlist.excludeGroups.length > 0) {
      list = list.filter(c => !playlist.excludeGroups.includes(String(c.group || '')));
    }

    // Blocked channels
    if (playlist.blockedChannels && playlist.blockedChannels.length > 0) {
      list = list.filter(c => !playlist.blockedChannels.includes(c.id));
    }

    // Pinned channels first
    if (playlist.pinnedChannels && playlist.pinnedChannels.length > 0) {
      const pinned = list.filter(c =>  playlist.pinnedChannels.includes(c.id));
      const rest   = list.filter(c => !playlist.pinnedChannels.includes(c.id));
      list = [...pinned, ...rest];
    }
  }

  // Sort by order field
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let m3u = '#EXTM3U\r\n';

  for (const ch of list) {
    const name    = String(ch.name    || 'Unknown Channel');
    const logo    = String(ch.logo    || '');
    const group   = String(ch.group   || 'General');
    const tvgId   = String(ch.tvgId   || ch.id   || '');
    const tvgName = String(ch.tvgName || name);

    // Use EXACT original URL (rawUrl) — preserves pipe headers like:
    //   https://stream.m3u8?token=abc|User-Agent=ReactNativeVideo/9.3.0|Referer=https://fancode.com/
    // Most players (TiviMate, VLC, IPTV Smarters, Kodi) read pipe headers natively.
    const streamUrl = String(ch.rawUrl || ch.url || '');
    if (!streamUrl) continue;

    m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${logo}" group-title="${group}",${name}\r\n`;

    // Emit VLC options for players that prefer explicit directives
    const hasPipeHeaders = ch.rawUrl && ch.rawUrl !== ch.url && ch.rawUrl.includes('|');
    if (!hasPipeHeaders) {
      if (ch.userAgent) m3u += `#EXTVLCOPT:http-user-agent=${ch.userAgent}\r\n`;
      if (ch.referer)   m3u += `#EXTVLCOPT:http-referrer=${ch.referer}\r\n`;
    }

    m3u += `${streamUrl}\r\n`;
  }

  return m3u;
}

// ─── Tamil-only M3U generator ─────────────────────────────────────────────────
export function generateTamilM3U(channels: Channel[], serverUrl: string): string {
  const tamil = channels.filter(
    c =>
      c.isActive !== false &&
      c.enabled  !== false &&
      isTamilChannel(String(c.name || ''), String(c.group || ''), String(c.language || ''))
  );
  return generateM3U(tamil, serverUrl);
}
