/**
 * Universal Auto-Detecting Parser
 *
 * Handles ALL source formats:
 *   ✅ Standard M3U / M3U8
 *   ✅ JSON — flat arrays, nested, JioTV, generic APIs
 *   ✅ JSON — streamUrls[] array format (YOUR FORMAT)
 *   ✅ JSON — logoUrl, category, id fields (YOUR FORMAT)
 *   ✅ Plain text with URLs
 *   ✅ PHP / Cloudflare Workers / API endpoints
 *   ✅ Pipe-header URLs: url|User-Agent=...|Referer=...
 *   ✅ Auto-strips DRM channels
 *
 * YOUR JSON FORMAT:
 * {
 *   "id": "ThanthiOne.in",
 *   "name": "Thanthi One",
 *   "logoUrl": "https://...",
 *   "streamUrls": ["https://...index.m3u8"],
 *   "category": "India"
 * }
 */

import { Channel } from '../types';

// ─── Format Detection ─────────────────────────────────────────────────────────
export type ContentFormat = 'm3u' | 'json' | 'plaintext' | 'xml' | 'unknown';

export function detectFormat(raw: string): ContentFormat {
  const t = raw.trimStart();
  if (t.startsWith('#EXTM3U') || t.startsWith('#EXTINF'))          return 'm3u';
  if (t.startsWith('{') || t.startsWith('['))                       return 'json';
  if (t.startsWith('<?xml') || t.startsWith('<tv') || t.startsWith('<channels')) return 'xml';
  if (/https?:\/\//i.test(t))                                       return 'plaintext';
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
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u') || u.includes('chunks.m3u8')) return 'hls';
  return 'direct';
}

// ─── Pipe-header URL parser ───────────────────────────────────────────────────
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
    if (key === 'useragent')                          result.userAgent = val;
    else if (key === 'referer' || key === 'referrer') result.referer   = val;
    else if (key === 'cookie')                        result.cookie    = val;
    else if (key === 'origin')                        result.origin    = val;
  }

  return result;
}

// ─── ID generator ─────────────────────────────────────────────────────────────
let _counter = 0;
function genId(sourceId: string, index: number): string {
  return `${sourceId}_u${index}_${Date.now()}_${(++_counter).toString(36)}`;
}

// ─── Parsed partial channel ───────────────────────────────────────────────────
interface ParsedPartial {
  name: string;
  url: string;        // clean URL (pipe headers stripped)
  rawUrl: string;     // EXACT original URL from source
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// M3U PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1].trim() || undefined : undefined;
}

function extractChannelName(extinf: string): string {
  const withoutPrefix = extinf.replace(/^#EXTINF:\s*-?\d+(\.\d+)?\s*/, '');
  let inQuote = false, quoteChar = '', lastComma = -1;
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
  let current: Partial<ParsedPartial & { skipDrm?: boolean }> = {};

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
        group:    attr(line, 'group-title') || 'General',
        language: attr(line, 'tvg-language'),
        country:  attr(line, 'tvg-country'),
      };

    } else if (line.startsWith('#KODIPROP:')) {
      const prop = line.replace('#KODIPROP:', '');
      if (prop.includes('license_type') || prop.includes('license_key') ||
          prop.includes('inputstream.adaptive')) {
        skipNext = true;
        current.skipDrm = true;
      }

    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.replace('#EXTVLCOPT:', '').trim();
      if (opt.startsWith('http-user-agent='))
        current.userAgent = opt.replace('http-user-agent=', '').trim();
      else if (opt.startsWith('http-referrer=') || opt.startsWith('http-referer='))
        current.referer = opt.split('=').slice(1).join('=').trim();

    } else if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.replace('#EXTHTTP:', '').trim()) as Record<string, string>;
        if (h.cookie || h.Cookie) current.cookie = h.cookie || h.Cookie;
        if (h['User-Agent'] || h['user-agent'])
          current.userAgent = current.userAgent || h['User-Agent'] || h['user-agent'];
        current.httpHeaders = { ...current.httpHeaders, ...h };
      } catch { /* ignore */ }

    } else if (!line.startsWith('#')) {
      if (skipNext || current.skipDrm) {
        current = {}; skipNext = false; continue;
      }

      const exactLine = line;
      const { url, userAgent, referer, cookie } = parsePipeHeaders(line);
      if (!url || (!url.startsWith('http') && !url.startsWith('rtmp') && !url.startsWith('rtsp'))) {
        current = {}; continue;
      }

      results.push({
        name:        current.name        || 'Unknown Channel',
        url,
        rawUrl:      exactLine,
        logo:        current.logo,
        group:       current.group       || 'General',
        tvgId:       current.tvgId,
        tvgName:     current.tvgName,
        language:    current.language,
        country:     current.country,
        userAgent:   current.userAgent   || userAgent,
        referer:     current.referer     || referer,
        cookie:      current.cookie      || cookie,
        httpHeaders: current.httpHeaders,
        streamType:  detectStreamType(url),
      });

      current = {};
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON PARSER — handles ALL formats including YOUR streamUrls/logoUrl/category/id
// ═══════════════════════════════════════════════════════════════════════════════

interface RawItem {
  // ── Single URL fields ──────────────────────────────────────
  url?: unknown; stream?: unknown; link?: unknown;
  streamUrl?: unknown; stream_url?: unknown;
  src?: unknown; playbackUrl?: unknown;

  // ── URL array fields ── YOUR FORMAT ───────────────────────
  streamUrls?: unknown;   // ["https://...m3u8"]
  urls?: unknown;

  // ── Name fields ───────────────────────────────────────────
  name?: unknown; title?: unknown; channel?: unknown;
  channel_name?: unknown; channelName?: unknown;
  label?: unknown; tvg_name?: unknown; 'tvg-name'?: unknown;

  // ── Logo fields ── YOUR FORMAT: logoUrl ───────────────────
  logo?: unknown;
  logoUrl?: unknown;      // ← YOUR FORMAT
  logo_url?: unknown;
  icon?: unknown; image?: unknown; thumbnail?: unknown;
  tvg_logo?: unknown; 'tvg-logo'?: unknown;

  // ── Group / Category ── YOUR FORMAT: category ─────────────
  group?: unknown;
  category?: unknown;     // ← YOUR FORMAT
  genre?: unknown;
  group_title?: unknown; 'group-title'?: unknown; type?: unknown;

  // ── ID ── YOUR FORMAT: id = "ThanthiOne.in" ───────────────
  id?: unknown;           // ← YOUR FORMAT
  tvgId?: unknown; tvg_id?: unknown; 'tvg-id'?: unknown;
  channelId?: unknown; channel_id?: unknown;

  // ── Language / Country ────────────────────────────────────
  language?: unknown; lang?: unknown; country?: unknown;

  // ── DRM detection ─────────────────────────────────────────
  licenseType?: unknown; licenseKey?: unknown;
  drmLicense?: unknown; drmScheme?: unknown;
  clearKey?: unknown; drmKey?: unknown; widevineUrl?: unknown;

  // ── Headers ───────────────────────────────────────────────
  userAgent?: unknown; 'user-agent'?: unknown; user_agent?: unknown;
  referer?: unknown; cookie?: unknown;
  headers?: Record<string, string>;
  httpHeaders?: Record<string, string>;

  // ── Nesting ───────────────────────────────────────────────
  channels?: unknown; items?: unknown; data?: unknown;
  streams?: unknown; playlist?: unknown;
}

function itemHasDRM(r: RawItem): boolean {
  return !!(
    ss(r.licenseType) || ss(r.licenseKey)  ||
    ss(r.drmLicense)  || ss(r.drmScheme)   ||
    ss(r.clearKey)    || ss(r.drmKey)      ||
    ss(r.widevineUrl)
  );
}

/** Get all stream URLs from item — handles streamUrls[] array and single url */
function getAllUrls(r: RawItem): string[] {
  // streamUrls array — YOUR FORMAT: { "streamUrls": ["https://..."] }
  if (Array.isArray(r.streamUrls) && r.streamUrls.length > 0) {
    return r.streamUrls.map(u => ss(u)).filter(Boolean);
  }
  // urls array
  if (Array.isArray(r.urls) && r.urls.length > 0) {
    return r.urls.map(u => ss(u)).filter(Boolean);
  }
  // Single URL from any known field
  const single =
    ss(r.link)        ||
    ss(r.url)         ||
    ss(r.stream)      ||
    ss(r.src)         ||
    ss(r.streamUrl)   ||
    ss(r.stream_url)  ||
    ss(r.playbackUrl) ||
    '';
  return single ? [single] : [];
}

function getPrimaryUrl(r: RawItem): string {
  const all = getAllUrls(r);
  return all[0] || '';
}

function getRawName(r: RawItem, idx: number): string {
  return (
    ss(r.name)         ||
    ss(r.title)        ||
    ss(r.channel)      ||
    ss(r.channelName)  ||
    ss(r.channel_name) ||
    ss(r.label)        ||
    ss(r.tvg_name)     ||
    ss(r['tvg-name'])  ||
    `Channel ${idx + 1}`
  );
}

function getRawLogo(r: RawItem): string | undefined {
  return (
    ss(r.logoUrl)      ||   // ← YOUR FORMAT first
    ss(r.logo_url)     ||
    ss(r.logo)         ||
    ss(r.icon)         ||
    ss(r.image)        ||
    ss(r.thumbnail)    ||
    ss(r.tvg_logo)     ||
    ss(r['tvg-logo'])  ||
    undefined
  );
}

function getRawGroup(r: RawItem): string {
  const typeVal = ss(r.type);
  return (
    ss(r.group)         ||
    ss(r.category)      ||   // ← YOUR FORMAT
    ss(r.genre)         ||
    ss(r.group_title)   ||
    ss(r['group-title'])||
    (typeVal && !['hls', 'dash', 'direct'].includes(typeVal) ? typeVal : '') ||
    'General'
  );
}

function getRawTvgId(r: RawItem): string | undefined {
  return (
    ss(r.tvgId)       ||
    ss(r.tvg_id)      ||
    ss(r['tvg-id'])   ||
    ss(r.id)          ||   // ← YOUR FORMAT: "ThanthiOne.in"
    ss(r.channelId)   ||
    ss(r.channel_id)  ||
    undefined
  );
}

function getRawHeaders(r: RawItem) {
  const result: { userAgent?: string; referer?: string; cookie?: string; httpHeaders?: Record<string, string> } = {};
  const ua = ss(r.userAgent) || ss(r.user_agent) || ss(r['user-agent']) ||
             ss(r.headers?.['User-Agent']) || ss(r.headers?.['user-agent']);
  if (ua) result.userAgent = ua;
  const ref = ss(r.referer) || ss(r.headers?.['Referer']) || ss(r.headers?.['referer']);
  if (ref) result.referer = ref;
  const ck = ss(r.cookie) || ss(r.headers?.['Cookie']) || ss(r.headers?.['cookie']);
  if (ck) result.cookie = ck;
  const all: Record<string, string> = {};
  if (r.headers     && typeof r.headers     === 'object') Object.entries(r.headers).forEach(([k, v]) => { all[k] = ss(v); });
  if (r.httpHeaders && typeof r.httpHeaders === 'object') Object.entries(r.httpHeaders).forEach(([k, v]) => { all[k] = ss(v); });
  if (Object.keys(all).length > 0) result.httpHeaders = all;
  return result;
}

function flattenJson(raw: unknown, depth = 0): RawItem[] {
  if (!raw || typeof raw !== 'object' || depth > 8) return [];

  if (Array.isArray(raw)) {
    const result: RawItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as RawItem;
      if (getPrimaryUrl(obj)) {
        result.push(obj);
      } else {
        // Try nested keys
        for (const key of ['channels', 'streams', 'items', 'playlist', 'data']) {
          const nested = (obj as Record<string, unknown>)[key];
          if (Array.isArray(nested)) {
            result.push(...flattenJson(nested, depth + 1));
            break;
          }
        }
      }
    }
    return result;
  }

  const obj = raw as RawItem;
  for (const key of ['channels', 'streams', 'items', 'playlist']) {
    const val = (obj as Record<string, unknown>)[key];
    if (Array.isArray(val)) return flattenJson(val, depth + 1);
  }
  if (obj.data) {
    if (Array.isArray(obj.data)) return flattenJson(obj.data, depth + 1);
    if (typeof obj.data === 'object') {
      const d = obj.data as Record<string, unknown>;
      for (const key of ['channels', 'streams', 'items']) {
        if (Array.isArray(d[key])) return flattenJson(d[key], depth + 1);
      }
    }
  }
  if (getPrimaryUrl(obj)) return [obj];
  return [];
}

function parseJSONContent(text: string): ParsedPartial[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Invalid JSON'); }

  const rawItems = flattenJson(parsed);
  const results: ParsedPartial[] = [];
  let globalIdx = 0;

  for (const r of rawItems) {
    if (itemHasDRM(r)) continue;

    const allUrls = getAllUrls(r);
    if (allUrls.length === 0) continue;

    const baseName = getRawName(r, globalIdx);
    const logo     = getRawLogo(r);
    const group    = getRawGroup(r);
    const tvgId    = getRawTvgId(r);
    const hdrs     = getRawHeaders(r);
    const language = ss(r.language) || ss(r.lang) || undefined;
    const country  = ss(r.country)  || undefined;

    // One entry per URL (streamUrls array → multiple channels)
    allUrls.forEach((rawUrl, ui) => {
      if (!rawUrl || !rawUrl.startsWith('http')) return;

      const { url, userAgent, referer, cookie } = parsePipeHeaders(rawUrl);
      if (!url || !url.startsWith('http')) return;

      const suffix = allUrls.length > 1 ? ` (${ui + 1})` : '';

      results.push({
        name:        baseName + suffix,
        url,
        rawUrl,
        logo:        logo || undefined,
        group,
        tvgId:       tvgId || undefined,
        tvgName:     baseName + suffix,
        language,
        country,
        userAgent:   hdrs.userAgent || userAgent || undefined,
        referer:     hdrs.referer   || referer   || undefined,
        cookie:      hdrs.cookie    || cookie    || undefined,
        httpHeaders: hdrs.httpHeaders || undefined,
        streamType:  detectStreamType(url),
      });
    });

    globalIdx++;
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAIN TEXT PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parsePlainTextContent(text: string): ParsedPartial[] {
  const urlRegex = /https?:\/\/[^\s"'<>\n\r]+/g;
  const matches = text.match(urlRegex) || [];
  return matches
    .map((rawUrl, i) => {
      const { url } = parsePipeHeaders(rawUrl);
      if (!url) return null;
      const parts = url.split('/').filter(Boolean);
      const name = parts[parts.length - 1]
        ?.replace(/[?#].*$/, '')
        .replace(/\.[^.]+$/, '') || `Channel ${i + 1}`;
      return {
        name,
        url,
        rawUrl,
        group: 'General',
        streamType: detectStreamType(url),
      } as ParsedPartial;
    })
    .filter((x): x is ParsedPartial => x !== null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAMIL DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

const TAMIL_KEYWORDS = [
  'sun tv', 'vijay', 'zee tamil', 'star vijay', 'kalaignar',
  'raj tv', 'jaya tv', 'polimer', 'vendhar', 'puthuyugam',
  'captain', 'adithya', 'sathiyam', 'news18 tamil', 'news7',
  'thanthi', 'tamil', 'kollywood', 'chithiram', 'isai',
  'kushi', 'makkal', 'vasanth', 'mega', 'sirippoli',
  'zee thirai', 'sun music', 'sun life', 'chutti tv',
  'kaveri', 'pondicherry', 'thenral', 'thendral',
];

export function isTamilChannel(name: string, group: string, language?: string): boolean {
  const n = ss(name).toLowerCase();
  const g = ss(group).toLowerCase();
  const l = ss(language).toLowerCase();
  if (l === 'tamil' || l === 'ta' || l.includes('tamil')) return true;
  if (g.includes('tamil') || g.includes('kollywood'))     return true;
  return TAMIL_KEYWORDS.some(k => n.includes(k) || g.includes(k));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN UNIVERSAL PARSER
// ═══════════════════════════════════════════════════════════════════════════════

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
      // XMLTV = EPG data — extract any embedded stream URLs
      partials = parsePlainTextContent(trimmed);
      break;

    case 'unknown':
    default:
      // Try JSON → M3U → plain text
      try      { partials = parseJSONContent(trimmed); }
      catch    {
        try    { partials = parseM3UContent(trimmed); }
        catch  { partials = parsePlainTextContent(trimmed); }
      }
      if (partials.length === 0) {
        throw new Error(
          `Could not parse source (unknown format). First 300 chars:\n${trimmed.substring(0, 300)}`
        );
      }
  }

  if (partials.length === 0) {
    throw new Error(`Source parsed as "${format}" but no valid stream URLs found.`);
  }

  // Map partials → full Channel objects
  return partials.map((p, i): Channel => ({
    id:          genId(sourceId, i),
    name:        p.name        || 'Unknown Channel',
    url:         p.url,
    rawUrl:      p.rawUrl      || p.url,
    logo:        p.logo        || undefined,
    group:       p.group       || 'General',
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

export function isWorkerOrApiUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('workers.dev')  ||
    u.includes('.php')         ||
    u.includes('/api/')        ||
    u.includes('format=m3u')   ||
    u.includes('type=m3u')     ||
    u.includes('/channel/raw') ||
    u.includes('/get.php')     ||
    u.includes('/playlist')    ||
    (u.includes('raw.github') && !u.endsWith('.m3u') && !u.endsWith('.m3u8'))
  );
}
