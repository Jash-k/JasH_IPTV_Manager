/**
 * JSON Source Parser — Jash Addon
 *
 * Parses streams from JSON arrays of various formats:
 *
 * Format 1 (JioTV-style):
 *   { cookie, drmLicense, drmScheme, link, logo, name }
 *
 * Format 2 (Generic):
 *   { url/stream/src, name/title/channel, logo/icon/image, group/category/genre }
 *
 * Format 3 (Nested):
 *   { channels: [...], streams: [...], items: [...] }
 *
 * Format 4 (M3U-JSON hybrid):
 *   { url, tvgName, tvgLogo, groupTitle, headers: {...} }
 */

import { Stream } from '../types';

export interface RawJsonStream {
  // JioTV / JioStream format
  link?: string;
  name?: string;
  logo?: string;
  cookie?: string;
  drmLicense?: string;
  drmScheme?: string;

  // Generic formats
  url?: string;
  stream?: string;
  src?: string;
  streamUrl?: string;
  playbackUrl?: string;

  // Name variants
  title?: string;
  channel?: string;
  channelName?: string;
  label?: string;

  // Logo variants
  icon?: string;
  image?: string;
  thumbnail?: string;
  poster?: string;
  tvgLogo?: string;
  'tvg-logo'?: string;

  // Group variants
  group?: string;
  category?: string;
  genre?: string;
  groupTitle?: string;
  'group-title'?: string;
  type?: string;

  // TVG metadata
  tvgId?: string;
  'tvg-id'?: string;
  tvgName?: string;
  'tvg-name'?: string;

  // DRM variants
  licenseType?: string;
  licenseKey?: string;
  drmKey?: string;
  clearKey?: string;
  widevineUrl?: string;

  // Header variants
  userAgent?: string;
  'user-agent'?: string;
  referer?: string;
  headers?: Record<string, string>;
  httpHeaders?: Record<string, string>;

  // Nesting
  channels?: RawJsonStream[];
  streams?: RawJsonStream[];
  items?: RawJsonStream[];
  data?: RawJsonStream[] | { channels?: RawJsonStream[]; streams?: RawJsonStream[] };
}

function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u')) return 'hls';
  return 'direct';
}

/**
 * Extract a stream URL from a raw JSON object — tries all known field names
 */
function extractUrl(raw: RawJsonStream): string | null {
  return (
    raw.link ||
    raw.url ||
    raw.stream ||
    raw.src ||
    raw.streamUrl ||
    raw.playbackUrl ||
    null
  );
}

/**
 * Extract a stream name from a raw JSON object
 */
function extractName(raw: RawJsonStream): string {
  return (
    raw.name ||
    raw.title ||
    raw.channel ||
    raw.channelName ||
    raw.label ||
    raw.tvgName ||
    raw['tvg-name'] ||
    'Unknown Channel'
  );
}

/**
 * Extract a logo URL from a raw JSON object
 */
function extractLogo(raw: RawJsonStream): string | undefined {
  return (
    raw.logo ||
    raw.icon ||
    raw.image ||
    raw.thumbnail ||
    raw.poster ||
    raw.tvgLogo ||
    raw['tvg-logo'] ||
    undefined
  );
}

/**
 * Extract a group name from a raw JSON object
 */
function extractGroup(raw: RawJsonStream): string {
  return (
    raw.group ||
    raw.category ||
    raw.genre ||
    raw.groupTitle ||
    raw['group-title'] ||
    (raw.type && raw.type !== 'hls' && raw.type !== 'dash' && raw.type !== 'direct' ? raw.type : undefined) ||
    'Uncategorized'
  );
}

/**
 * Extract DRM info from a raw JSON stream object
 * Supports JioTV format: { drmLicense: "kid:key", drmScheme: "clearkey" }
 */
function extractDRM(raw: RawJsonStream): {
  licenseType?: string;
  licenseKey?: string;
} {
  // JioTV format: drmScheme + drmLicense
  if (raw.drmScheme && raw.drmLicense) {
    const scheme = raw.drmScheme.toLowerCase();
    // Normalize scheme names
    const licenseType =
      scheme === 'clearkey' ? 'clearkey' :
      scheme === 'widevine' ? 'widevine' :
      scheme === 'playready' ? 'playready' :
      scheme;
    return { licenseType, licenseKey: raw.drmLicense };
  }

  // Generic DRM fields
  if (raw.licenseType && raw.licenseKey) {
    return { licenseType: raw.licenseType, licenseKey: raw.licenseKey };
  }

  // Specific DRM type fields
  if (raw.clearKey) {
    return { licenseType: 'clearkey', licenseKey: raw.clearKey };
  }

  if (raw.drmKey) {
    return { licenseType: 'clearkey', licenseKey: raw.drmKey };
  }

  if (raw.widevineUrl) {
    return { licenseType: 'widevine', licenseKey: raw.widevineUrl };
  }

  return {};
}

/**
 * Extract HTTP headers from a raw JSON stream object
 */
function extractHeaders(raw: RawJsonStream): {
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
} {
  const result: {
    userAgent?: string;
    referer?: string;
    cookie?: string;
    httpHeaders?: Record<string, string>;
  } = {};

  // User-Agent
  result.userAgent = raw.userAgent || raw['user-agent'] || raw.headers?.['User-Agent'] || raw.headers?.['user-agent'] || undefined;

  // Referer
  result.referer = raw.referer || raw.headers?.['Referer'] || raw.headers?.['referer'] || undefined;

  // Cookie — JioTV stores it directly as `cookie` field
  const cookieVal = raw.cookie || raw.headers?.['Cookie'] || raw.headers?.['cookie'] || undefined;
  if (cookieVal) result.cookie = cookieVal;

  // Merge all headers
  const allHeaders: Record<string, string> = {};
  if (raw.headers) Object.assign(allHeaders, raw.headers);
  if (raw.httpHeaders) Object.assign(allHeaders, raw.httpHeaders);
  if (Object.keys(allHeaders).length > 0) result.httpHeaders = allHeaders;

  return result;
}

/**
 * Parse a single raw JSON object into a Stream
 */
function parseOneStream(raw: RawJsonStream, sourceId: string, index: number): Stream | null {
  const url = extractUrl(raw);
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;

  const name       = extractName(raw);
  const logo       = extractLogo(raw);
  const group      = extractGroup(raw);
  const drm        = extractDRM(raw);
  const headers    = extractHeaders(raw);
  const streamType = detectStreamType(url);

  const stream: Stream = {
    id      : `${sourceId}_json_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    url,
    logo,
    group,
    tvgId   : raw.tvgId || raw['tvg-id'] || undefined,
    tvgName : raw.tvgName || raw['tvg-name'] || name,
    sourceId,
    enabled : true,
    status  : 'unknown',
    streamType,
    ...drm,
    ...headers,
  };

  return stream;
}

/**
 * Flatten a raw JSON value into an array of raw stream objects.
 * Handles all nesting patterns.
 */
function flattenJsonToStreams(raw: unknown): RawJsonStream[] {
  if (!raw) return [];

  // Direct array of stream objects
  if (Array.isArray(raw)) {
    const result: RawJsonStream[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const obj = item as RawJsonStream;
        // Check if this item IS a stream (has url/link) or contains streams
        if (extractUrl(obj)) {
          result.push(obj);
        } else if (obj.channels || obj.streams || obj.items) {
          result.push(...flattenJsonToStreams(obj.channels || obj.streams || obj.items));
        }
      }
    }
    return result;
  }

  // Object with wrapper key
  if (raw && typeof raw === 'object') {
    const obj = raw as RawJsonStream;

    // Check common wrapper keys
    if (obj.channels && Array.isArray(obj.channels)) return flattenJsonToStreams(obj.channels);
    if (obj.streams  && Array.isArray(obj.streams))  return flattenJsonToStreams(obj.streams);
    if (obj.items    && Array.isArray(obj.items))    return flattenJsonToStreams(obj.items);

    // data wrapper
    if (obj.data) {
      if (Array.isArray(obj.data)) return flattenJsonToStreams(obj.data);
      if (typeof obj.data === 'object') {
        const data = obj.data as { channels?: RawJsonStream[]; streams?: RawJsonStream[] };
        if (data.channels) return flattenJsonToStreams(data.channels);
        if (data.streams)  return flattenJsonToStreams(data.streams);
      }
    }

    // Single stream object
    if (extractUrl(obj)) return [obj];
  }

  return [];
}

/**
 * Main entry point — parse any JSON content string into Streams
 */
export function parseJsonSource(content: string, sourceId: string): Stream[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    // Not valid JSON
    throw new Error('Invalid JSON: could not parse source content');
  }

  const rawStreams = flattenJsonToStreams(parsed);

  if (rawStreams.length === 0) {
    throw new Error('No streams found in JSON. Expected array of objects with url/link fields.');
  }

  const streams: Stream[] = [];
  for (let i = 0; i < rawStreams.length; i++) {
    const s = parseOneStream(rawStreams[i], sourceId, i);
    if (s) streams.push(s);
  }

  if (streams.length === 0) {
    throw new Error(`JSON parsed but no valid stream URLs found (checked ${rawStreams.length} objects).`);
  }

  return streams;
}

/**
 * Detect if a string looks like JSON (array or object)
 */
export function looksLikeJson(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

/**
 * Detect if a URL is likely to return JSON (not M3U)
 */
export function isJsonUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.endsWith('.json') ||
    u.includes('/json') ||
    u.includes('format=json') ||
    u.includes('type=json') ||
    u.includes('api/') ||
    u.includes('/api?') ||
    // Raw GitHub JSON files
    (u.includes('raw.githubusercontent.com') && u.endsWith('.json')) ||
    (u.includes('gist.githubusercontent.com') && u.endsWith('.json'))
  );
}
