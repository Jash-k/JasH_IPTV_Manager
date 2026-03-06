/**
 * m3uParser.ts — THE authoritative M3U/M3U8 parser
 *
 * Handles ALL M3U formats including:
 *
 * Format 1 — Minimal (only tvg-id):
 *   #EXTINF:-1 tvg-id="9XJalwa.in@SD",9X Jalwa (1080p)
 *   https://b.jsrdn.com/strm/channels/9xjalwa/master.m3u8
 *
 * Format 2 — Full attributes:
 *   #EXTINF:-1 tvg-id="SunTV.in" tvg-name="Sun TV" tvg-logo="https://logo.png" group-title="Tamil",Sun TV HD
 *   https://stream.suntv.com/live.m3u8
 *
 * Format 3 — With KODIPROP DRM (auto-stripped):
 *   #KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
 *   #EXTINF:-1,Protected Channel
 *   https://drm.example.com/stream.mpd
 *
 * Format 4 — With VLC options:
 *   #EXTVLCOPT:http-user-agent=Mozilla/5.0
 *   #EXTVLCOPT:http-referrer=https://example.com
 *   #EXTINF:-1,VLC Channel
 *   https://stream.example.com/live.m3u8
 *
 * Format 5 — Pipe headers:
 *   #EXTINF:-1,FanCode Sport
 *   https://stream.m3u8?token=abc|User-Agent=ReactNativeVideo/9.3.0|Referer=https://fancode.com/
 *
 * Format 6 — No #EXTM3U header (just #EXTINF lines):
 *   #EXTINF:-1 tvg-id="9XJhakaas.in@SD",9X Jhakaas
 *   https://9xjio.wiseplayout.com/9X_Jhakaas/master.m3u8
 */

import { Channel } from '../types';

// ─── Attribute extractor ──────────────────────────────────────────────────────
function extractAttribute(line: string, attr: string): string | undefined {
  // Try double-quoted, single-quoted, then unquoted
  const patterns = [
    new RegExp(`${attr}="([^"]*)"`, 'i'),
    new RegExp(`${attr}='([^']*)'`, 'i'),
    new RegExp(`${attr}=([^\\s,>"']+)`, 'i'),
  ];
  for (const p of patterns) {
    const m = line.match(p);
    if (m && m[1] !== undefined) return m[1].trim() || undefined;
  }
  return undefined;
}

// ─── Channel name extractor ───────────────────────────────────────────────────
// Finds the LAST comma that is NOT inside a quoted attribute value
// e.g.: tvg-logo="url,with,commas.jpg" group-title="X",Channel Name, HD
//        → "Channel Name, HD"
function extractChannelName(extinf: string): string {
  // Strip the #EXTINF:-1 prefix (handles: -1, 0, 3600, 3600.5, -1.0)
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');

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
    const name = withoutPrefix.substring(lastUnquotedComma + 1).trim();
    if (name) return name;
  }

  // Fallback: everything after the last comma
  const fallback = extinf.lastIndexOf(',');
  if (fallback !== -1) {
    const name = extinf.substring(fallback + 1).trim();
    if (name) return name;
  }

  return 'Unknown Channel';
}

// ─── Stream type detector ─────────────────────────────────────────────────────
function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (
    u.includes('.m3u8') || u.includes('/hls/') ||
    u.includes('playlist.m3u') || u.includes('chunks.m3u8') ||
    u.includes('master.m3u8') || u.includes('index.m3u8')
  ) return 'hls';
  return 'direct';
}

// ─── Pipe header parser ───────────────────────────────────────────────────────
export function parsePipeHeaders(raw: string): {
  url: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
} {
  if (!raw.includes('|')) return { url: raw.trim() };
  const parts = raw.split('|');
  const url = parts[0].trim();
  const result: { url: string; userAgent?: string; referer?: string; cookie?: string } = { url };
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].substring(0, eq).trim().toLowerCase().replace(/[-_]/g, '');
    const val = parts[i].substring(eq + 1).trim();
    if (!val) continue;
    if (key === 'useragent')                        result.userAgent = val;
    else if (key === 'referer' || key === 'referrer') result.referer = val;
    else if (key === 'cookie')                       result.cookie = val;
  }
  return result;
}

// ─── DRM detector ────────────────────────────────────────────────────────────
function isDRMProp(prop: string): boolean {
  const p = prop.toLowerCase();
  return (
    p.includes('license_type') ||
    p.includes('license_key')  ||
    p.includes('inputstream.adaptive') ||
    p.includes('com.widevine') ||
    p.includes('com.microsoft.playready')
  );
}

// ─── URL validator ────────────────────────────────────────────────────────────
function isStreamUrl(line: string): boolean {
  const t = line.trim();
  return /^(https?|rtmp|rtmps|rtsp|mms|udp|rtp|srt):\/\//i.test(t) ||
         t.endsWith('.m3u8') || t.endsWith('.mpd') || t.endsWith('.ts');
}

// ─── Main M3U parser ──────────────────────────────────────────────────────────
export function parseM3U(content: string, sourceId: string): Channel[] {
  // Strip BOM if present
  const cleaned = content.replace(/^\uFEFF/, '');
  const lines   = cleaned.split(/\r?\n/);
  const channels: Channel[] = [];

  let currentExtInf: string | null  = null;
  let pendingDRM      = false;
  let pendingUA: string | undefined  = undefined;
  let pendingRef: string | undefined = undefined;
  let pendingCookie: string | undefined = undefined;
  let pendingHeaders: Record<string, string> = {};

  const reset = () => {
    currentExtInf  = null;
    pendingDRM     = false;
    pendingUA      = undefined;
    pendingRef     = undefined;
    pendingCookie  = undefined;
    pendingHeaders = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ── #EXTM3U header — skip ────────────────────────────────────────
    if (line.startsWith('#EXTM3U')) continue;

    // ── #EXTINF — channel metadata ───────────────────────────────────
    if (line.startsWith('#EXTINF:')) {
      reset();
      currentExtInf = line;
      continue;
    }

    // ── #KODIPROP — DRM detection ────────────────────────────────────
    if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '').trim();
      if (isDRMProp(prop)) {
        pendingDRM = true;
      }
      continue;
    }

    // ── #EXTVLCOPT — VLC options ─────────────────────────────────────
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) {
        pendingUA = opt.replace('http-user-agent=', '').trim();
      } else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer=')) {
        pendingRef = opt.split('=').slice(1).join('=').trim();
      }
      continue;
    }

    // ── #EXTHTTP — JSON headers ──────────────────────────────────────
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.replace('#EXTHTTP:', '').trim()) as Record<string, string>;
        if (h.cookie || h.Cookie)          pendingCookie = h.cookie || h.Cookie;
        if (h['User-Agent'] || h['user-agent'])
          pendingUA = pendingUA || h['User-Agent'] || h['user-agent'];
        Object.entries(h).forEach(([k, v]) => { pendingHeaders[k] = String(v); });
      } catch { /* invalid JSON — ignore */ }
      continue;
    }

    // ── Stream URL ───────────────────────────────────────────────────
    if (!line.startsWith('#') && isStreamUrl(line)) {
      // Skip DRM channels
      if (pendingDRM) { reset(); continue; }

      // Parse pipe headers from URL
      const { url, userAgent, referer, cookie } = parsePipeHeaders(line);
      const rawUrl = line; // exact original line

      if (!url) { reset(); continue; }

      // Extract metadata from #EXTINF
      let name     = 'Unknown Channel';
      let logo: string | undefined;
      let group    = 'General';
      let tvgId: string | undefined;
      let tvgName: string | undefined;
      let language: string | undefined;
      let country: string | undefined;

      if (currentExtInf) {
        name     = extractChannelName(currentExtInf);
        logo     = extractAttribute(currentExtInf, 'tvg-logo');
        group    = extractAttribute(currentExtInf, 'group-title') || 'General';
        tvgId    = extractAttribute(currentExtInf, 'tvg-id');
        tvgName  = extractAttribute(currentExtInf, 'tvg-name');
        language = extractAttribute(currentExtInf, 'tvg-language');
        country  = extractAttribute(currentExtInf, 'tvg-country');
      }

      const ch: Channel = {
        id:          `${sourceId}_m3u_${channels.length}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name:        name || 'Unknown Channel',
        url,
        rawUrl:      rawUrl !== url ? rawUrl : url,
        logo,
        group,
        tvgId,
        tvgName:     tvgName || name,
        language,
        country,
        sourceId,
        isActive:    true,
        enabled:     true,
        order:       channels.length,
        streamType:  detectStreamType(url),
        userAgent:   pendingUA   || userAgent  || undefined,
        referer:     pendingRef  || referer    || undefined,
        cookie:      pendingCookie || cookie   || undefined,
        httpHeaders: Object.keys(pendingHeaders).length > 0 ? { ...pendingHeaders } : undefined,
      };

      channels.push(ch);
      reset();
      continue;
    }

    // ── Unknown # directive — skip ───────────────────────────────────
  }

  return channels;
}

// ─── Re-export fetchM3U for backward compat ───────────────────────────────────
export async function fetchM3U(url: string, _corsProxy?: string): Promise<string> {
  const { fetchUrl } = await import('./fetcher');
  return fetchUrl(url);
}
