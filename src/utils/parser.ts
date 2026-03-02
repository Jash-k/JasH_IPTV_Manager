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
  // CRITICAL: #EXTM3U must be first line, no BOM, no leading whitespace
  const lines: string[] = [];
  lines.push('#EXTM3U x-tvg-url=""');

  // Accept channels that are enabled (enabled !== false) OR isActive — both field names used
  const active = channels
    .filter(c => c.enabled !== false || c.isActive === true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  active.forEach(ch => {
    const tvgId   = ch.tvgId    ? ` tvg-id="${String(ch.tvgId).replace(/"/g,'')}"` : '';
    const tvgName = ` tvg-name="${String(ch.tvgName || ch.name || '').replace(/"/g,'')}"`;
    const logo    = ch.logo     ? ` tvg-logo="${String(ch.logo).replace(/"/g,'')}"` : '';
    const group   = ` group-title="${String(ch.group || 'Uncategorized').replace(/"/g,'')}"`;
    const lang    = ch.language ? ` tvg-language="${String(ch.language).replace(/"/g,'')}"` : '';
    const country = ch.country  ? ` tvg-country="${String(ch.country).replace(/"/g,'')}"` : '';
    const name    = String(ch.name || 'Unknown').replace(/,/g, ' ');
    const streamUrl = (ch.isDrm || ch.licenseType || ch.licenseKey)
      ? `${baseUrl}/proxy/drm/${ch.id}`
      : `${baseUrl}/proxy/redirect/${ch.id}`;
    lines.push(`#EXTINF:-1${tvgId}${tvgName}${logo}${group}${lang}${country},${name}`);
    lines.push(streamUrl);
  });

  return lines.join('\r\n') + '\r\n';
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

export async function fetchSourceContent(targetUrl: string): Promise<string> {
  // Server-side CORS proxy always goes first — it has 403 bypass with rotating UAs
  const serverProxy = `${window.location.origin}/proxy/cors?url=`;

  const proxies = [
    serverProxy,                              // Our server — best 403 bypass
    '',                                       // Direct (works if CORS allowed)
    'https://corsproxy.io/?',                 // Public fallback 1
    'https://api.allorigins.win/raw?url=',    // Public fallback 2
  ];

  let lastError: string = 'Unknown error';

  for (const proxy of proxies) {
    try {
      const fetchUrl = proxy
        ? `${proxy}${encodeURIComponent(targetUrl)}`
        : targetUrl;

      const res = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(25000),
        headers: {
          'Accept':          '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control':   'no-cache',
        },
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status} from ${proxy || 'direct'}`;
        continue;
      }

      const text = await res.text();

      // allorigins wraps in JSON
      if (proxy.includes('allorigins')) {
        try {
          const json = JSON.parse(text) as { contents?: string };
          return json.contents || text;
        } catch { return text; }
      }

      return text;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // continue to next proxy
    }
  }

  throw new Error(`Failed to fetch "${targetUrl}" via all proxies. Last error: ${lastError}`);
}
