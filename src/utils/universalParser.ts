/**
 * Universal Auto-Detecting Parser
 * Handles M3U, JSON, PHP endpoints, plain-text URLs, worker endpoints
 * Auto-detects format from raw response content.
 *
 * Reference: fetchM3U.js pattern
 * Supports:
 *   - Standard M3U / M3U8 (#EXTM3U)
 *   - JSON (flat arrays, nested objects, JioTV, generic APIs)
 *   - Plain text with URLs
 *   - PHP / Cloudflare Workers / API endpoints
 *   - Pipe-header URLs: url|User-Agent=...|Referer=...
 */

import { Channel } from '../types';

// ─── Format Detection ─────────────────────────────────────────────────────────
export type ContentFormat = 'm3u' | 'json' | 'plaintext' | 'xml' | 'unknown';

export function detectFormat(raw: string): ContentFormat {
  const t = raw.trimStart();
  if (t.startsWith('#EXTM3U') || t.startsWith('#EXTINF')) return 'm3u';
  if (t.startsWith('{') || t.startsWith('['))              return 'json';
  if (t.startsWith('<?xml') || t.startsWith('<tv') || t.startsWith('<channels')) return 'xml';
  if (/https?:\/\//i.test(t))                              return 'plaintext';
  return 'unknown';
}

// ─── Safe string coercion ─────────────────────────────────────────────────────
function ss(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

// ─── Stream type detector ─────────────────────────────────────────────────────
function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = ss(url).toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u')) return 'hls';
  return 'direct';
}

// ─── Pipe-header URL parser ───────────────────────────────────────────────────
// Handles: https://stream.m3u8?token=abc|User-Agent=VLC|Referer=https://site.com
export function parsePipeHeaders(raw: string): {
  url: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  origin?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed.includes('|')) return { url: trimmed };

  const parts = trimmed.split('|');
  const url = parts[0].trim();
  const result: { url: string; userAgent?: string; referer?: string; cookie?: string; origin?: string } = { url };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.substring(0, eqIdx).trim().toLowerCase().replace(/-/g, '');
    const val = part.substring(eqIdx + 1).trim();
    if (!val) continue;
    if (key === 'useragent')             result.userAgent = val;
    else if (key === 'referer' || key === 'referrer') result.referer = val;
    else if (key === 'cookie')           result.cookie = val;
    else if (key === 'origin')           result.origin = val;
  }

  return result;
}

// ─── ID generator ────────────────────────────────────────────────────────────
let _counter = 0;
function genId(sourceId: string, index: number): string {
  return `${sourceId}_u${index}_${Date.now()}_${(++_counter).toString(36)}`;
}

// ─── M3U Parser ──────────────────────────────────────────────────────────────
interface ParsedPartial {
  name: string;
  url: string;           // clean URL (pipe headers stripped)
  rawUrl: string;        // EXACT original URL from source (preserved as-is)
  logo?: string;
  group: string;
  tvgId?: string;
  tvgName?: string;
  language?: string;
  country?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
  streamType: 'hls' | 'dash' | 'direct';
  skipDrm?: boolean;
}

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1].trim() : undefined;
}

function extractChannelName(extinf: string): string {
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');
  let inQuote = false;
  let quoteChar = '';
  let lastComma = -1;
  for (let j = 0; j < withoutPrefix.length; j++) {
    const ch = withoutPrefix[j];
    if (inQuote) { if (ch === quoteChar) inQuote = false; }
    else if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
    else if (ch === ',') lastComma = j;
  }
  if (lastComma !== -1) return withoutPrefix.substring(lastComma + 1).trim();
  const fallback = extinf.lastIndexOf(',');
  if (fallback !== -1) return extinf.substring(fallback + 1).trim();
  return 'Unknown Channel';
}

function parseM3UContent(text: string): ParsedPartial[] {
  const lines = text.split('\n');
  const results: ParsedPartial[] = [];
  let skipNext = false;
  let current: Partial<ParsedPartial> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      skipNext = false;
      current = {
        name:     extractChannelName(line) || 'Unknown Channel',
        tvgId:    attr(line, 'tvg-id'),
        tvgName:  attr(line, 'tvg-name'),
        logo:     attr(line, 'tvg-logo'),
        group:    attr(line, 'group-title') || 'Uncategorized',
        language: attr(line, 'tvg-language'),
        country:  attr(line, 'tvg-country'),
      };

    } else if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '');
      if (prop.includes('license_type') || prop.includes('license_key')) {
        skipNext = true;
        current.skipDrm = true;
      }

    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent=')) {
        current.userAgent = opt.replace('http-user-agent=', '').trim();
      } else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer=')) {
        current.referer = opt.split('=').slice(1).join('=').trim();
      }

    } else if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.replace('#EXTHTTP:', '').trim()) as Record<string, string>;
        if (h.cookie || h.Cookie) current.cookie = h.cookie || h.Cookie;
        if (h['User-Agent'] || h['user-agent']) {
          current.userAgent = current.userAgent || h['User-Agent'] || h['user-agent'];
        }
        current.httpHeaders = { ...current.httpHeaders, ...h };
      } catch { /* ignore */ }

    } else if (!line.startsWith('#')) {
      if (skipNext || current.skipDrm) {
        current = {};
        skipNext = false;
        continue;
      }

      const rawLine = line; // preserve exact original line with pipe headers
      const { url, userAgent, referer, cookie } = parsePipeHeaders(line);
      if (!url || (!url.startsWith('http') && !url.startsWith('rtmp') && !url.startsWith('rtsp'))) {
        current = {};
        continue;
      }

      results.push({
        name:       current.name       || 'Unknown Channel',
        url,
        rawUrl:     rawLine,           // exact original line preserved
        logo:       current.logo,
        group:      current.group      || 'Uncategorized',
        tvgId:      current.tvgId,
        tvgName:    current.tvgName,
        language:   current.language,
        country:    current.country,
        userAgent:  current.userAgent  || userAgent,
        referer:    current.referer    || referer,
        cookie:     current.cookie     || cookie,
        httpHeaders: current.httpHeaders,
        streamType: detectStreamType(url),
      });

      current = {};
    }
  }

  return results;
}

// ─── JSON Parser ──────────────────────────────────────────────────────────────
interface RawItem {
  url?: unknown; stream?: unknown; link?: unknown; streamUrl?: unknown;
  stream_url?: unknown; src?: unknown; playbackUrl?: unknown;
  name?: unknown; title?: unknown; channel?: unknown; channel_name?: unknown;
  label?: unknown; tvg_name?: unknown;
  logo?: unknown; image?: unknown; icon?: unknown; thumbnail?: unknown; tvg_logo?: unknown;
  group?: unknown; category?: unknown; genre?: unknown; group_title?: unknown;
  language?: unknown; country?: unknown;
  tvg_id?: unknown; tvgId?: unknown;
  licenseType?: unknown; licenseKey?: unknown; drmLicense?: unknown; drmScheme?: unknown;
  clearKey?: unknown; drmKey?: unknown;
  cookie?: unknown; userAgent?: unknown; referer?: unknown;
  headers?: Record<string, string>;
  channels?: unknown; items?: unknown; data?: unknown; streams?: unknown;
}

function extractRawUrl(r: RawItem): string {
  return ss(r.url ?? r.stream ?? r.link ?? r.streamUrl ?? r.stream_url ?? r.src ?? r.playbackUrl ?? '');
}

function extractRawName(r: RawItem, idx: number): string {
  return ss(r.name ?? r.title ?? r.channel ?? r.channel_name ?? r.label ?? r.tvg_name ?? '') || `Channel ${idx + 1}`;
}

function extractRawLogo(r: RawItem): string {
  return ss(r.logo ?? r.image ?? r.icon ?? r.thumbnail ?? r.tvg_logo ?? '');
}

function extractRawGroup(r: RawItem): string {
  return ss(r.group ?? r.category ?? r.genre ?? r.group_title ?? '') || 'Uncategorized';
}

function itemHasDRM(r: RawItem): boolean {
  return !!(ss(r.licenseType ?? '') || ss(r.licenseKey ?? '') ||
            ss(r.drmLicense ?? '') || ss(r.drmScheme ?? '') ||
            ss(r.clearKey ?? '')   || ss(r.drmKey ?? ''));
}

function flattenJson(raw: unknown): RawItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const result: RawItem[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const obj = item as RawItem;
        if (extractRawUrl(obj)) {
          result.push(obj);
        } else {
          if (Array.isArray(obj.channels)) result.push(...flattenJson(obj.channels));
          else if (Array.isArray(obj.streams)) result.push(...flattenJson(obj.streams));
          else if (Array.isArray(obj.items))   result.push(...flattenJson(obj.items));
        }
      }
    }
    return result;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as RawItem;
    if (Array.isArray(obj.channels)) return flattenJson(obj.channels);
    if (Array.isArray(obj.streams))  return flattenJson(obj.streams);
    if (Array.isArray(obj.items))    return flattenJson(obj.items);
    if (obj.data) {
      if (Array.isArray(obj.data)) return flattenJson(obj.data);
      if (typeof obj.data === 'object') {
        const d = obj.data as Record<string, unknown>;
        if (d.channels) return flattenJson(d.channels);
        if (d.streams)  return flattenJson(d.streams);
      }
    }
    if (extractRawUrl(obj)) return [obj];
  }
  return [];
}

function parseJSONContent(text: string): ParsedPartial[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Invalid JSON'); }

  const rawItems = flattenJson(parsed);
  const results: ParsedPartial[] = [];

  rawItems.forEach((r, i) => {
    if (itemHasDRM(r)) return;
    const originalUrl = extractRawUrl(r); // exact url from JSON field
    if (!originalUrl || !originalUrl.startsWith('http')) return;

    const { url, userAgent, referer, cookie } = parsePipeHeaders(originalUrl);
    if (!url) return;

    results.push({
      name:       extractRawName(r, i),
      url,
      rawUrl:     originalUrl,          // exact original URL from JSON preserved
      logo:       extractRawLogo(r) || undefined,
      group:      extractRawGroup(r),
      tvgId:      ss(r.tvgId ?? r.tvg_id ?? '') || undefined,
      tvgName:    ss(r.tvg_name ?? '') || undefined,
      language:   ss(r.language ?? '') || undefined,
      country:    ss(r.country  ?? '') || undefined,
      userAgent:  ss(r.userAgent ?? '') || userAgent || undefined,
      referer:    ss(r.referer   ?? '') || referer   || undefined,
      cookie:     ss(r.cookie    ?? '') || cookie     || undefined,
      httpHeaders: r.headers || undefined,
      streamType: detectStreamType(url),
    });
  });

  return results;
}

// ─── Plain Text URL Extractor ─────────────────────────────────────────────────
function parsePlainTextContent(text: string): ParsedPartial[] {
  const urlRegex = /https?:\/\/[^\s"'<>\n\r]+/g;
  const matches = text.match(urlRegex) || [];
  return matches.map((originalUrl, i) => {
    const { url } = parsePipeHeaders(originalUrl);
    if (!url) return null;
    const parts = url.split('/').filter(Boolean);
    const name = parts[parts.length - 1]?.replace(/[?#].*$/, '').replace(/\.[^.]+$/, '') || `Channel ${i + 1}`;
    return {
      name,
      url,
      rawUrl:     originalUrl,          // exact original URL preserved
      group: 'Uncategorized',
      streamType: detectStreamType(url),
    } as ParsedPartial;
  }).filter((x): x is ParsedPartial => x !== null);
}

// ─── Main Universal Parser ────────────────────────────────────────────────────
/**
 * Universally parses ANY content string into Channel[]:
 *
 * ✅ M3U / M3U8 (#EXTM3U)
 * ✅ JSON (flat arrays, nested, JioTV, generic APIs)
 * ✅ Plain text with URLs
 * ✅ PHP / Cloudflare Workers / API responses
 * ✅ Pipe-header URLs: url|User-Agent=...|Referer=...
 * ✅ Auto-strips DRM channels
 */
export function universalParse(content: string, sourceId: string): Channel[] {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Empty response from source');

  const format = detectFormat(trimmed);
  let partials: ParsedPartial[] = [];

  switch (format) {
    case 'm3u':
      partials = parseM3UContent(trimmed);
      break;

    case 'json':
      partials = parseJSONContent(trimmed);
      break;

    case 'plaintext':
      partials = parsePlainTextContent(trimmed);
      break;

    case 'xml':
      // XMLTV = EPG data, try to extract any embedded stream URLs
      partials = parsePlainTextContent(trimmed);
      break;

    case 'unknown':
    default:
      // Try JSON first, then M3U, then plain text
      try {
        partials = parseJSONContent(trimmed);
      } catch {
        try {
          partials = parseM3UContent(trimmed);
        } catch {
          partials = parsePlainTextContent(trimmed);
        }
      }
      if (partials.length === 0) {
        throw new Error(
          `Could not parse source. Unknown format. First 300 chars: ${trimmed.substring(0, 300)}`
        );
      }
  }

  if (partials.length === 0) {
    throw new Error(`Source parsed as "${format}" but no valid stream URLs found.`);
  }

  // Map to full Channel objects
  return partials.map((p, i): Channel => ({
    id:          genId(sourceId, i),
    name:        p.name        || 'Unknown Channel',
    url:         p.url,                           // clean URL (pipe headers stripped)
    rawUrl:      p.rawUrl      || p.url,          // EXACT original URL preserved
    logo:        p.logo        || undefined,
    group:       p.group       || 'Uncategorized',
    tvgId:       p.tvgId       || undefined,
    tvgName:     p.tvgName     || p.name || 'Unknown Channel',
    language:    p.language    || undefined,
    country:     p.country     || undefined,
    userAgent:   p.userAgent   || undefined,
    referer:     p.referer     || undefined,
    cookie:      p.cookie      || undefined,
    httpHeaders: p.httpHeaders || undefined,
    sourceId,
    isActive:    true,
    enabled:     true,
    order:       i,
    streamType:  p.streamType  || 'hls',
    isTamil:     isTamilChannel(p.name || '', p.group || '', p.language),
  }));
}

// ─── Tamil detection ──────────────────────────────────────────────────────────
const TAMIL_KEYWORDS = [
  'sun tv', 'vijay', 'zee tamil', 'star vijay', 'kalaignar',
  'raj tv', 'jaya tv', 'polimer', 'vendhar', 'puthuyugam',
  'captain', 'adithya', 'sathiyam', 'news18 tamil', 'news7',
  'thanthi', 'tamil', 'kollywood', 'chithiram', 'isai',
  'kushi', 'makkal', 'vasanth', 'mega', 'sirippoli',
];

export function isTamilChannel(name: string, group: string, language?: string): boolean {
  const n = ss(name).toLowerCase();
  const g = ss(group).toLowerCase();
  const l = ss(language).toLowerCase();
  if (l === 'tamil' || l === 'ta') return true;
  if (g.includes('tamil') || g.includes('kollywood')) return true;
  return TAMIL_KEYWORDS.some(k => n.includes(k) || g.includes(k));
}

/**
 * Detect if a URL likely returns non-M3U content (JSON/PHP/Worker)
 * that still needs to be parsed as a stream source
 */
export function isWorkerOrApiUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('workers.dev')   ||
    u.includes('.php')          ||
    u.includes('/api/')         ||
    u.includes('format=m3u')    ||
    u.includes('type=m3u')      ||
    u.includes('/channel/raw')  ||
    u.includes('/get.php')      ||
    u.includes('/playlist')     ||
    (u.includes('raw.github') && !u.endsWith('.m3u') && !u.endsWith('.m3u8'))
  );
}
