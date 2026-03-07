import { Channel } from '../types';

// ─── Safe string coercion ─────────────────────────────────────────────────────
const ss = (v: unknown): string =>
  typeof v === 'string' ? v.trim() :
  typeof v === 'number' ? String(v) : '';

// ─── M3U Parsed Item Interface ────────────────────────────────────────────────
export interface M3uParsedItem {
  name?: string;
  tvg?: {
    id?: string;
    name?: string;
    logo?: string;
    url?: string;
    rec?: string;
    shift?: string;
  };
  group?: {
    title?: string;
  };
  http?: {
    referrer?: string;
    'user-agent'?: string;
  };
  url?: string;
  raw?: string;
  line?: number;
  catchup?: {
    type?: string;
    days?: string;
    source?: string;
  };
  timeshift?: string;
  status?: string;
}

// ─── M3U Parsed Playlist Interface ────────────────────────────────────────────
export interface M3uParsedPlaylist {
  header?: {
    attrs?: Record<string, string>;
    raw?: string;
  };
  items: M3uParsedItem[];
}

// ─── Raw JSON stream interface ────────────────────────────────────────────────
export interface RawJsonStream {
  // ── URL fields ──────────────────────────────────────────────
  link?: unknown;
  url?: unknown;
  stream?: unknown;
  src?: unknown;
  streamUrl?: unknown;
  stream_url?: unknown;
  playbackUrl?: unknown;

  // ── URL arrays (streamUrls format) ─────────────────────────
  streamUrls?: unknown;
  urls?: unknown;
  streams?: unknown;

  // ── Name fields ─────────────────────────────────────────────
  name?: unknown;
  title?: unknown;
  channel?: unknown;
  channelName?: unknown;
  channel_name?: unknown;
  label?: unknown;
  tvgName?: unknown;
  tvg_name?: unknown;
  'tvg-name'?: unknown;

  // ── Logo fields ─────────────────────────────────────────────
  logo?: unknown;
  logoUrl?: unknown;
  logo_url?: unknown;
  icon?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  poster?: unknown;
  tvgLogo?: unknown;
  tvg_logo?: unknown;
  'tvg-logo'?: unknown;

  // ── Group / Category ────────────────────────────────────────
  group?: unknown;
  category?: unknown;
  genre?: unknown;
  groupTitle?: unknown;
  group_title?: unknown;
  'group-title'?: unknown;
  type?: unknown;

  // ── ID / TVG ────────────────────────────────────────────────
  id?: unknown;
  tvgId?: unknown;
  tvg_id?: unknown;
  'tvg-id'?: unknown;
  channelId?: unknown;
  channel_id?: unknown;

  // ── Language / Country ──────────────────────────────────────
  language?: unknown;
  lang?: unknown;
  country?: unknown;

  // ── DRM fields (used to detect + skip) ──────────────────────
  licenseType?: unknown;
  licenseKey?: unknown;
  drmLicense?: unknown;
  drmScheme?: unknown;
  clearKey?: unknown;
  drmKey?: unknown;
  widevineUrl?: unknown;
  inputstream?: unknown;

  // ── Header fields ───────────────────────────────────────────
  userAgent?: unknown;
  user_agent?: unknown;
  'user-agent'?: unknown;
  referer?: unknown;
  cookie?: unknown;
  headers?: Record<string, string>;
  httpHeaders?: Record<string, string>;

  // ── Nesting ─────────────────────────────────────────────────
  channels?: unknown;
  items?: unknown;
  data?: unknown;
  playlist?: unknown;

  // ── M3U Parsed JSON Format (from parsed M3U stored as JSON) ─
  tvg?: {
    id?: string;
    name?: string;
    logo?: string;
    url?: string;
    rec?: string;
    shift?: string;
  };
  http?: {
    referrer?: string;
    'user-agent'?: string;
  };
  catchup?: {
    type?: string;
    days?: string;
    source?: string;
  };
  timeshift?: unknown;
  status?: unknown;
  raw?: unknown;
  line?: unknown;

  // ── M3U Playlist wrapper (header + items) ───────────────────
  header?: {
    attrs?: Record<string, string>;
    raw?: string;
  };
}

// ─── Stream type detector ─────────────────────────────────────────────────────
function detectStreamType(url: string): 'hls' | 'dash' | 'direct' {
  const u = url.toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/') || u.includes('playlist.m3u') || u.includes('chunks.m3u8')) return 'hls';
  return 'direct';
}

// ─── DRM detector ────────────────────────────────────────────────────────────
function hasDRM(r: RawJsonStream): boolean {
  return !!(
    ss(r.licenseType)  || ss(r.licenseKey)  ||
    ss(r.drmLicense)   || ss(r.drmScheme)   ||
    ss(r.clearKey)     || ss(r.drmKey)      ||
    ss(r.widevineUrl)  || ss(r.inputstream)
  );
}

// ─── Check if object is M3U parsed playlist format ────────────────────────────
function isM3uParsedPlaylist(obj: unknown): obj is M3uParsedPlaylist {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  
  // Check for header + items structure OR just items with tvg
  if (o.items && Array.isArray(o.items)) {
    if (o.items.length > 0) {
      const firstItem = o.items[0] as Record<string, unknown>;
      // Must have tvg object and url to be M3U format
      return (
        firstItem.tvg !== undefined && 
        typeof firstItem.tvg === 'object' &&
        firstItem.url !== undefined
      );
    }
    // Empty items with header present
    return o.header !== undefined;
  }
  return false;
}

// ─── Check if object is M3U parsed item ───────────────────────────────────────
function isM3uParsedItem(obj: unknown): obj is M3uParsedItem {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    o.tvg !== undefined &&
    typeof o.tvg === 'object' &&
    o.url !== undefined &&
    typeof o.url === 'string'
  );
}

// ─── Convert M3U parsed item to RawJsonStream ─────────────────────────────────
function m3uItemToRawJsonStream(item: M3uParsedItem): RawJsonStream {
  return {
    url: item.url,
    name: item.name || '',
    tvg: item.tvg,
    group: item.group,
    http: item.http,
    catchup: item.catchup,
    timeshift: item.timeshift,
    status: item.status,
    raw: item.raw,
    line: item.line,
  };
}

// ─── Field extractors ─────────────────────────────────────────────────────────

/** Extract primary single URL (first streamUrls entry if array) */
function extractPrimaryUrl(r: RawJsonStream): string {
  // Array formats: streamUrls, urls
  if (Array.isArray(r.streamUrls) && r.streamUrls.length > 0) {
    return ss(r.streamUrls[0]);
  }
  if (Array.isArray(r.urls) && r.urls.length > 0) {
    return ss(r.urls[0]);
  }
  // Single URL formats
  return (
    ss(r.link)        ||
    ss(r.url)         ||
    ss(r.stream)      ||
    ss(r.src)         ||
    ss(r.streamUrl)   ||
    ss(r.stream_url)  ||
    ss(r.playbackUrl) ||
    ''
  );
}

/** Extract ALL URLs from the item (handles streamUrls array) */
function extractAllUrls(r: RawJsonStream): string[] {
  // streamUrls array
  if (Array.isArray(r.streamUrls) && r.streamUrls.length > 0) {
    return r.streamUrls.map(u => ss(u)).filter(Boolean);
  }
  // urls array
  if (Array.isArray(r.urls) && r.urls.length > 0) {
    return r.urls.map(u => ss(u)).filter(Boolean);
  }
  // streams array
  if (Array.isArray(r.streams) && r.streams.length > 0) {
    const urls = r.streams.map(u => (typeof u === 'string' ? u : ss((u as RawJsonStream)?.url))).filter(Boolean);
    if (urls.length > 0) return urls;
  }
  // Single URL
  const single = extractPrimaryUrl(r);
  return single ? [single] : [];
}

function extractName(r: RawJsonStream, idx: number): string {
  // ═══ M3U parsed format: tvg.name ═══
  if (r.tvg && typeof r.tvg === 'object' && r.tvg.name) {
    const tvgName = ss(r.tvg.name);
    if (tvgName) return tvgName;
  }
  
  // ═══ Direct name field (M3U item.name) ═══
  const directName = ss(r.name);
  if (directName) return directName;
  
  return (
    ss(r.title)       ||
    ss(r.channel)     ||
    ss(r.channelName) ||
    ss(r.channel_name)||
    ss(r.label)       ||
    ss(r.tvgName)     ||
    ss(r.tvg_name)    ||
    ss(r['tvg-name']) ||
    `Channel ${idx + 1}`
  );
}

function extractLogo(r: RawJsonStream): string | undefined {
  // ═══ M3U parsed format: tvg.logo ═══
  if (r.tvg && typeof r.tvg === 'object' && r.tvg.logo) {
    const tvgLogo = ss(r.tvg.logo);
    if (tvgLogo) return tvgLogo;
  }
  
  const logo = (
    ss(r.logoUrl)      ||
    ss(r.logo_url)     ||
    ss(r.logo)         ||
    ss(r.icon)         ||
    ss(r.image)        ||
    ss(r.thumbnail)    ||
    ss(r.poster)       ||
    ss(r.tvgLogo)      ||
    ss(r.tvg_logo)     ||
    ss(r['tvg-logo'])
  );
  
  return logo || undefined;
}

function extractGroup(r: RawJsonStream): string {
  // ═══ M3U parsed format: group.title ═══
  if (r.group && typeof r.group === 'object' && 'title' in r.group) {
    const groupTitle = ss((r.group as { title?: unknown }).title);
    if (groupTitle) return groupTitle;
  }
  
  // String group
  if (typeof r.group === 'string') {
    const g = ss(r.group);
    if (g) return g;
  }
  
  const typeVal = ss(r.type);
  return (
    ss(r.category)     ||
    ss(r.genre)        ||
    ss(r.groupTitle)   ||
    ss(r.group_title)  ||
    ss(r['group-title'])||
    (typeVal && !['hls', 'dash', 'direct'].includes(typeVal) ? typeVal : '') ||
    'Uncategorized'
  );
}

function extractTvgId(r: RawJsonStream): string | undefined {
  // ═══ M3U parsed format: tvg.id ═══
  if (r.tvg && typeof r.tvg === 'object' && r.tvg.id) {
    const tvgId = ss(r.tvg.id);
    if (tvgId) return tvgId;
  }
  
  const id = (
    ss(r.tvgId)       ||
    ss(r.tvg_id)      ||
    ss(r['tvg-id'])   ||
    ss(r.id)          ||
    ss(r.channelId)   ||
    ss(r.channel_id)
  );
  
  return id || undefined;
}

function extractTvgName(r: RawJsonStream): string | undefined {
  // ═══ M3U parsed format: tvg.name ═══
  if (r.tvg && typeof r.tvg === 'object' && r.tvg.name) {
    const tvgName = ss(r.tvg.name);
    if (tvgName) return tvgName;
  }
  
  const name = (
    ss(r.tvgName)     ||
    ss(r.tvg_name)    ||
    ss(r['tvg-name'])
  );
  
  return name || undefined;
}

function extractHeaders(r: RawJsonStream): {
  userAgent?: string;
  referer?: string;
  cookie?: string;
  httpHeaders?: Record<string, string>;
} {
  const result: { userAgent?: string; referer?: string; cookie?: string; httpHeaders?: Record<string, string> } = {};

  // ═══ M3U parsed format: http object ═══
  const m3uUserAgent = r.http && typeof r.http === 'object' ? ss(r.http['user-agent']) : '';
  const m3uReferer = r.http && typeof r.http === 'object' ? ss(r.http.referrer) : '';

  const ua = m3uUserAgent ||
             ss(r.userAgent) || ss(r.user_agent) || ss(r['user-agent']) ||
             ss(r.headers?.['User-Agent']) || ss(r.headers?.['user-agent']);
  if (ua) result.userAgent = ua;

  const ref = m3uReferer ||
              ss(r.referer) || ss(r.headers?.['Referer']) || ss(r.headers?.['referer']);
  if (ref) result.referer = ref;

  const ck = ss(r.cookie) || ss(r.headers?.['Cookie']) || ss(r.headers?.['cookie']);
  if (ck) result.cookie = ck;

  const all: Record<string, string> = {};
  if (r.headers && typeof r.headers === 'object') {
    Object.entries(r.headers).forEach(([k, v]) => { all[k] = ss(v); });
  }
  if (r.httpHeaders && typeof r.httpHeaders === 'object') {
    Object.entries(r.httpHeaders).forEach(([k, v]) => { all[k] = ss(v); });
  }
  if (Object.keys(all).length > 0) result.httpHeaders = all;

  return result;
}

// ─── Flatten nested JSON to flat array of raw items ──────────────────────────
function flattenJson(raw: unknown, depth = 0): RawJsonStream[] {
  if (!raw || typeof raw !== 'object' || depth > 8) return [];

  // ══════════════════════════════════════════════════════════════════════════
  // CHECK FOR M3U PARSED PLAYLIST FORMAT: { header: {...}, items: [...] }
  // Each item has: name, tvg: { id, name, logo }, group: { title }, url, http
  // ══════════════════════════════════════════════════════════════════════════
  if (isM3uParsedPlaylist(raw)) {
    const playlist = raw as M3uParsedPlaylist;
    return playlist.items
      .filter(item => item && item.url)
      .map(m3uItemToRawJsonStream);
  }

  if (Array.isArray(raw)) {
    const result: RawJsonStream[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      
      // ═══ Check if item is M3U parsed format (has tvg object + url) ═══
      if (isM3uParsedItem(item)) {
        result.push(m3uItemToRawJsonStream(item as M3uParsedItem));
        continue;
      }
      
      const obj = item as RawJsonStream;
      
      // Has a URL or streamUrls → it's a channel item
      if (extractPrimaryUrl(obj)) {
        result.push(obj);
      } else {
        // Try nested keys
        const nested =
          (Array.isArray(obj.channels) ? obj.channels : null) ||
          (Array.isArray(obj.streams)  ? obj.streams  : null) ||
          (Array.isArray(obj.items)    ? obj.items    : null) ||
          (Array.isArray(obj.playlist) ? obj.playlist : null);
        if (nested) result.push(...flattenJson(nested, depth + 1));
      }
    }
    return result;
  }

  // Object with wrapper keys
  const obj = raw as RawJsonStream;
  
  // ═══ Check for items array that might be M3U format ═══
  if (Array.isArray(obj.items)) {
    if (obj.items.length > 0 && isM3uParsedItem(obj.items[0])) {
      return (obj.items as M3uParsedItem[])
        .filter(item => item && item.url)
        .map(m3uItemToRawJsonStream);
    }
    return flattenJson(obj.items, depth + 1);
  }
  
  if (Array.isArray(obj.channels)) return flattenJson(obj.channels, depth + 1);
  if (Array.isArray(obj.streams))  return flattenJson(obj.streams,  depth + 1);
  if (Array.isArray(obj.playlist)) return flattenJson(obj.playlist, depth + 1);

  if (obj.data) {
    if (Array.isArray(obj.data)) return flattenJson(obj.data, depth + 1);
    if (typeof obj.data === 'object') {
      const d = obj.data as Record<string, unknown>;
      if (d.channels) return flattenJson(d.channels, depth + 1);
      if (d.streams)  return flattenJson(d.streams,  depth + 1);
      if (d.items)    return flattenJson(d.items,    depth + 1);
    }
  }

  if (extractPrimaryUrl(obj)) return [obj];
  return [];
}

// ─── Parse pipe-separated headers from URL ────────────────────────────────────
function parsePipeUrl(raw: string): { url: string; userAgent?: string; referer?: string; cookie?: string } {
  if (!raw.includes('|')) return { url: raw };
  const parts = raw.split('|');
  const url = parts[0].trim();
  const res: { url: string; userAgent?: string; referer?: string; cookie?: string } = { url };
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].substring(0, eq).trim().toLowerCase().replace(/-/g, '');
    const val = parts[i].substring(eq + 1).trim();
    if (!val) continue;
    if (key === 'useragent') res.userAgent = val;
    else if (key === 'referer' || key === 'referrer') res.referer = val;
    else if (key === 'cookie') res.cookie = val;
  }
  return res;
}

// ─── Main parser ─────────────────────────────────────────────────────────────
export function parseJsonSource(content: string, sourceId: string): Channel[] {
  let parsed: unknown;
  try { 
    parsed = JSON.parse(content); 
  } catch { 
    throw new Error('Invalid JSON — could not parse source content'); 
  }

  const rawItems = flattenJson(parsed);
  if (rawItems.length === 0) throw new Error('No channels found in JSON');

  const channels: Channel[] = [];
  let idx = 0;

  for (const r of rawItems) {
    if (hasDRM(r)) continue;

    const allUrls = extractAllUrls(r);
    if (allUrls.length === 0) continue;

    const baseName  = extractName(r, idx);
    const logo      = extractLogo(r);
    const group     = extractGroup(r);
    const tvgId     = extractTvgId(r);
    const tvgName   = extractTvgName(r);
    const hdrs      = extractHeaders(r);
    const language  = ss(r.language) || ss(r.lang) || undefined;
    const country   = ss(r.country) || undefined;

    // One channel per URL (streamUrls array → multiple entries)
    allUrls.forEach((rawUrl, ui) => {
      if (!rawUrl || !rawUrl.startsWith('http')) return;

      const { url, userAgent, referer, cookie } = parsePipeUrl(rawUrl);
      if (!url || !url.startsWith('http')) return;

      const suffix = allUrls.length > 1 ? ` (${ui + 1})` : '';
      const name   = baseName + suffix;

      channels.push({
        id:          `${sourceId}_json_${idx}_${ui}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        url,
        rawUrl,
        logo,
        group,
        tvgId:       tvgId || undefined,
        tvgName:     tvgName || name,
        language,
        country,
        sourceId,
        isActive:    true,
        enabled:     true,
        order:       idx * 10 + ui,
        streamType:  detectStreamType(url),
        userAgent:   hdrs.userAgent || userAgent || undefined,
        referer:     hdrs.referer   || referer   || undefined,
        cookie:      hdrs.cookie    || cookie    || undefined,
        httpHeaders: hdrs.httpHeaders || undefined,
      });
    });

    idx++;
  }

  return channels;
}

// ─── Utility functions ────────────────────────────────────────────────────────

export function looksLikeJson(content: string): boolean {
  const t = content.trimStart();
  return t.startsWith('[') || t.startsWith('{');
}

export function isJsonUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.endsWith('.json') ||
    u.includes('/json')  ||
    u.includes('format=json') ||
    u.includes('api/') ||
    (u.includes('raw.githubusercontent.com') && u.endsWith('.json')) ||
    (u.includes('gist.githubusercontent.com') && u.endsWith('.json'))
  );
}

// ─── Check if JSON is M3U parsed format ───────────────────────────────────────
export function isM3uParsedJson(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return isM3uParsedPlaylist(parsed);
  } catch {
    return false;
  }
}

// ─── Extract channel info from single M3U item (utility) ─────────────────────
export function extractChannelInfo(item: M3uParsedItem): {
  channel: string;
  logo: string;
  link: string;
  group: string;
  tvgId: string;
  userAgent: string;
  referer: string;
} {
  return {
    channel: item.name || item.tvg?.name || '',
    logo: item.tvg?.logo || '',
    link: item.url || '',
    group: item.group?.title || '',
    tvgId: item.tvg?.id || '',
    userAgent: item.http?.['user-agent'] || '',
    referer: item.http?.referrer || '',
  };
}

// ─── Parse M3U JSON and extract simple channel list ───────────────────────────
export function parseM3uJsonToSimpleList(content: string): Array<{
  channel: string;
  logo: string;
  link: string;
  group: string;
  tvgId: string;
}> {
  try {
    const parsed = JSON.parse(content);
    
    if (isM3uParsedPlaylist(parsed)) {
      return parsed.items
        .filter(item => item.url)
        .map(item => ({
          channel: item.name || item.tvg?.name || '',
          logo: item.tvg?.logo || '',
          link: item.url || '',
          group: item.group?.title || '',
          tvgId: item.tvg?.id || '',
        }));
    }
    
    return [];
  } catch {
    return [];
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
export { 
  M3uParsedItem, 
  M3uParsedPlaylist, 
  isM3uParsedPlaylist, 
  isM3uParsedItem,
  m3uItemToRawJsonStream,
  flattenJson,
  extractPrimaryUrl,
  extractAllUrls,
  extractName,
  extractLogo,
  extractGroup,
  extractTvgId,
  extractHeaders,
  detectStreamType,
  hasDRM,
  parsePipeUrl,
};
