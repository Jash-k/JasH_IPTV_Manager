import { Channel } from '../types';
import { parseM3U } from './m3uParser';
import { parseJsonSource, looksLikeJson } from './jsonParser';

export { parseM3U } from './m3uParser';
export { parseJsonSource, looksLikeJson, isJsonUrl } from './jsonParser';

export function detectFormat(content: string): 'm3u' | 'json' | 'unknown' {
  const t = content.trim();
  if (t.startsWith('#EXTM3U') || t.startsWith('#EXTINF') || t.includes('#EXTINF')) return 'm3u';
  if (looksLikeJson(t)) return 'json';
  return 'unknown';
}

export function parseAny(content: string, sourceId: string): Channel[] {
  const fmt = detectFormat(content);
  if (fmt === 'm3u') return parseM3U(content, sourceId);
  if (fmt === 'json') return parseJsonSource(content, sourceId);
  try { return parseM3U(content, sourceId); } catch { /* */ }
  try { return parseJsonSource(content, sourceId); } catch { /* */ }
  return [];
}

export function generateM3U(channels: Channel[], baseUrl: string): string {
  let m3u = '#EXTM3U\n';
  const active = channels.filter(c => c.isActive).sort((a, b) => a.order - b.order);
  active.forEach(ch => {
    const logo = ch.logo ? ` tvg-logo="${ch.logo}"` : '';
    const tvgId = ch.tvgId ? ` tvg-id="${ch.tvgId}"` : '';
    const tvgName = ch.tvgName ? ` tvg-name="${ch.tvgName}"` : '';
    const group = ` group-title="${ch.group}"`;
    const lang = ch.language ? ` tvg-language="${ch.language}"` : '';
    const country = ch.country ? ` tvg-country="${ch.country}"` : '';
    const streamUrl = ch.isDrm
      ? `${baseUrl}/proxy/drm/${ch.id}`
      : `${baseUrl}/proxy/redirect/${ch.id}`;
    m3u += `#EXTINF:-1${tvgId}${tvgName}${logo}${group}${lang}${country},${ch.name}\n${streamUrl}\n`;
  });
  return m3u;
}

const TAMIL_KEYWORDS = [
  'tamil', 'sun tv', 'vijay', 'zee tamil', 'kalaignar', 'puthiya thalaimurai',
  'news18 tamil', 'polimer', 'jaya', 'raj tv', 'captain tv', 'vendhar',
  'vasanth tv', 'adithya tv', 'mega tv', 'thanthi', 'sathiyam', 'sirippoli',
  'chutti tv', 'isai aruvi', 'makkal tv', 'zee thirai', 'dd tamil',
  'doordarshan tamil', 'imayam', 'sun music', 'star vijay', 'colors tamil',
  'news7 tamil', 'tamilnadu', 'madurai', 'coimbatore', 'et now tamil',
  'cnbc tamil', 'kaveri', 'rain bow', 'rainbow', 'vikatan', 'nakkheeran',
];

export function isTamilChannel(ch: Channel): boolean {
  const str = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));
  const lower = `${str(ch.name)} ${str(ch.group)} ${str(ch.language)} ${str(ch.tvgName)} ${str(ch.tvgId)}`.toLowerCase();
  return TAMIL_KEYWORDS.some(k => lower.includes(k)) || str(ch.language).toLowerCase() === 'tamil';
}

export function isTamilGroup(groupName: string): boolean {
  const lower = groupName.toLowerCase();
  return TAMIL_KEYWORDS.some(k => lower.includes(k)) || lower.includes('tamil');
}

export async function fetchSourceContent(url: string): Promise<string> {
  const corsProxies = [
    '',
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    `${window.location.origin}/proxy/cors?url=`,
  ];
  for (const proxy of corsProxies) {
    try {
      const fetchUrl = proxy
        ? (proxy.includes('?') ? `${proxy}${encodeURIComponent(url)}` : `${proxy}${url}`)
        : url;
      const res = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { Accept: '*/*' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (proxy.includes('allorigins')) {
        try { const json = JSON.parse(text) as { contents?: string }; return json.contents || text; } catch { return text; }
      }
      return text;
    } catch { /* try next */ }
  }
  throw new Error(`Failed to fetch: ${url}`);
}
