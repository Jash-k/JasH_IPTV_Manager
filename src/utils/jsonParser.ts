import { Channel } from '../types';

export interface RawJsonStream {
  link?: string; name?: string; logo?: string; cookie?: string;
  drmLicense?: string; drmScheme?: string;
  url?: string; stream?: string; src?: string; streamUrl?: string; playbackUrl?: string;
  title?: string; channel?: string; channelName?: string; label?: string;
  icon?: string; image?: string; thumbnail?: string; poster?: string;
  tvgLogo?: string; 'tvg-logo'?: string;
  group?: string; category?: string; genre?: string; groupTitle?: string;
  'group-title'?: string; type?: string;
  tvgId?: string; 'tvg-id'?: string; tvgName?: string; 'tvg-name'?: string;
  licenseType?: string; licenseKey?: string; drmKey?: string; clearKey?: string; widevineUrl?: string;
  userAgent?: string; 'user-agent'?: string; referer?: string;
  headers?: Record<string, string>; httpHeaders?: Record<string, string>;
  channels?: RawJsonStream[]; streams?: RawJsonStream[]; items?: RawJsonStream[];
  data?: RawJsonStream[] | { channels?: RawJsonStream[]; streams?: RawJsonStream[] };
  language?: string; country?: string;
}

function detectStreamType(url: unknown): 'hls' | 'dash' | 'direct' {
  const u = ss(url).toLowerCase();
  if (u.includes('.mpd') || u.includes('/dash/') || u.includes('manifest.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/')) return 'hls';
  return 'direct';
}

// Safe string coercion — avoids ".toLowerCase is not a function" on number/object fields
const ss = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function extractUrl(raw: RawJsonStream): string | null {
  const u = ss(raw.link) || ss(raw.url) || ss(raw.stream) || ss(raw.src) || ss(raw.streamUrl) || ss(raw.playbackUrl);
  return u || null;
}

function extractName(raw: RawJsonStream): string {
  return ss(raw.name) || ss(raw.title) || ss(raw.channel) || ss(raw.channelName) || ss(raw.label) || ss(raw.tvgName) || ss(raw['tvg-name']) || 'Unknown Channel';
}

function extractLogo(raw: RawJsonStream): string | undefined {
  const v = ss(raw.logo) || ss(raw.icon) || ss(raw.image) || ss(raw.thumbnail) || ss(raw.poster) || ss(raw.tvgLogo) || ss(raw['tvg-logo']);
  return v || undefined;
}

function extractGroup(raw: RawJsonStream): string {
  const typeVal = ss(raw.type);
  return ss(raw.group) || ss(raw.category) || ss(raw.genre) || ss(raw.groupTitle) || ss(raw['group-title']) ||
    (typeVal && !['hls','dash','direct'].includes(typeVal) ? typeVal : '') || 'Uncategorized';
}

function extractDRM(raw: RawJsonStream): { licenseType?: string; licenseKey?: string; isDrm?: boolean } {
  const scheme = ss(raw.drmScheme);
  const license = ss(raw.drmLicense);
  if (scheme && license) {
    const sl = scheme.toLowerCase();
    const licenseType = sl === 'clearkey' ? 'clearkey' : sl === 'widevine' ? 'widevine' : sl === 'playready' ? 'playready' : sl;
    return { licenseType, licenseKey: license, isDrm: true };
  }
  const lt = ss(raw.licenseType); const lk = ss(raw.licenseKey);
  if (lt && lk) return { licenseType: lt, licenseKey: lk, isDrm: true };
  const ck = ss(raw.clearKey); if (ck) return { licenseType: 'clearkey', licenseKey: ck, isDrm: true };
  const dk = ss(raw.drmKey);   if (dk) return { licenseType: 'clearkey', licenseKey: dk, isDrm: true };
  const wv = ss(raw.widevineUrl); if (wv) return { licenseType: 'widevine', licenseKey: wv, isDrm: true };
  return {};
}

function extractHeaders(raw: RawJsonStream) {
  const result: { userAgent?: string; referer?: string; cookie?: string; httpHeaders?: Record<string, string> } = {};
  const ua = ss(raw.userAgent) || ss(raw['user-agent']) || ss(raw.headers?.['User-Agent']) || ss(raw.headers?.['user-agent']);
  if (ua) result.userAgent = ua;
  const ref = ss(raw.referer) || ss(raw.headers?.['Referer']) || ss(raw.headers?.['referer']);
  if (ref) result.referer = ref;
  const cookieVal = ss(raw.cookie) || ss(raw.headers?.['Cookie']) || ss(raw.headers?.['cookie']);
  if (cookieVal) result.cookie = cookieVal;
  const allHeaders: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object') Object.entries(raw.headers).forEach(([k, v]) => { allHeaders[k] = ss(v); });
  if (raw.httpHeaders && typeof raw.httpHeaders === 'object') Object.entries(raw.httpHeaders).forEach(([k, v]) => { allHeaders[k] = ss(v); });
  if (Object.keys(allHeaders).length > 0) result.httpHeaders = allHeaders;
  return result;
}

function parseOneStream(raw: RawJsonStream, sourceId: string, index: number): Channel | null {
  const url = extractUrl(raw);
  if (!url || !url.startsWith('http')) return null;
  const name = extractName(raw);
  const logo = extractLogo(raw);
  const group = extractGroup(raw);
  const drm = extractDRM(raw);
  const headers = extractHeaders(raw);
  const tvgId = ss(raw.tvgId) || ss(raw['tvg-id']) || undefined;
  const tvgName = ss(raw.tvgName) || ss(raw['tvg-name']) || name;
  const language = ss(raw.language) || undefined;
  const country = ss(raw.country) || undefined;
  const ch: Channel = {
    id: `${sourceId}_json_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name, url, logo, group,
    tvgId, tvgName, language, country,
    sourceId, isActive: true, enabled: true, order: index,
    streamType: detectStreamType(url),
    status: 'unknown',
    ...drm, ...headers,
  };
  return ch;
}

function flattenJsonToStreams(raw: unknown): RawJsonStream[] {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) {
    const result: RawJsonStream[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as RawJsonStream;
      if (extractUrl(obj)) {
        result.push(obj);
      } else {
        const nested = obj.channels || obj.streams || obj.items;
        if (nested) result.push(...flattenJsonToStreams(nested));
      }
    }
    return result;
  }
  // Plain object
  const obj = raw as RawJsonStream;
  if (obj.channels && Array.isArray(obj.channels)) return flattenJsonToStreams(obj.channels);
  if (obj.streams  && Array.isArray(obj.streams))  return flattenJsonToStreams(obj.streams);
  if (obj.items    && Array.isArray(obj.items))    return flattenJsonToStreams(obj.items);
  if (obj.data) {
    if (Array.isArray(obj.data)) return flattenJsonToStreams(obj.data);
    if (typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      const data = obj.data as { channels?: RawJsonStream[]; streams?: RawJsonStream[] };
      if (data.channels) return flattenJsonToStreams(data.channels);
      if (data.streams)  return flattenJsonToStreams(data.streams);
    }
  }
  if (extractUrl(obj)) return [obj];
  return [];
}

export function parseJsonSource(content: string, sourceId: string): Channel[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('Invalid JSON'); }
  const rawStreams = flattenJsonToStreams(parsed);
  if (rawStreams.length === 0) throw new Error('No streams found in JSON');
  const channels: Channel[] = [];
  for (let i = 0; i < rawStreams.length; i++) {
    const s = parseOneStream(rawStreams[i], sourceId, i);
    if (s) channels.push(s);
  }
  return channels;
}

export function looksLikeJson(content: string): boolean {
  const t = content.trimStart();
  return t.startsWith('[') || t.startsWith('{');
}

export function isJsonUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.endsWith('.json') || u.includes('/json') || u.includes('format=json') ||
    u.includes('api/') || (u.includes('raw.githubusercontent.com') && u.endsWith('.json'));
}
