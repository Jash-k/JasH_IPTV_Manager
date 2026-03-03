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

// ── DRM check ─────────────────────────────────────────────────────────────────
export function isDRMChannel(ch: Channel): boolean {
  return !!(ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmKeyId || ch.isDrm);
}

// ── M3U Generator — pure 302 redirect, NO DRM logic ──────────────────────────
export function generateM3U(channels: Channel[], baseUrl: string): string {
  const lines: string[] = [];
  lines.push('#EXTM3U x-tvg-url=""');

  const esc = (s: unknown) =>
    String(s || '').replace(/"/g, "'").replace(/[\r\n]/g, ' ');

  const normKey = (n: string) =>
    String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

  // Only direct (non-DRM) channels
  const active = channels
    .filter(c => {
      if (c.enabled === false || c.isActive === false) return false;
      if (isDRMChannel(c)) return false;
      return true;
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Count occurrences of each normalized name for multi-source detection
  const nameCount: Record<string, number> = {};
  active.forEach(ch => {
    const k = normKey(ch.name);
    nameCount[k] = (nameCount[k] || 0) + 1;
  });

  const seen = new Set<string>();

  active.forEach(ch => {
    const key     = normKey(ch.name);
    const isMulti = (nameCount[key] || 0) > 1;

    // For multi-source channels, only emit one entry (the first encountered)
    if (isMulti && seen.has(key)) return;
    seen.add(key);

    const tvgId   = ch.tvgId    ? ` tvg-id="${esc(ch.tvgId)}"`          : '';
    const tvgName = ` tvg-name="${esc(ch.tvgName || ch.name)}"`;
    const logo    = ch.logo     ? ` tvg-logo="${esc(ch.logo)}"`          : '';
    const group   = ` group-title="${esc(ch.group || 'Uncategorized')}"`;
    const lang    = ch.language ? ` tvg-language="${esc(ch.language)}"` : '';
    const country = ch.country  ? ` tvg-country="${esc(ch.country)}"`   : '';
    const tamil   = ch.isTamil  ? ` x-tamil="true"`                     : '';
    const multi   = isMulti     ? ` x-multi-source="true" x-link-count="${nameCount[key]}"` : '';
    const name    = esc(ch.name || 'Unknown');

    // ALL streams → pure 302 redirect (no proxy, no DRM)
    const streamUrl = isMulti
      ? `${baseUrl}/redirect/best/${encodeURIComponent(ch.name)}`
      : `${baseUrl}/redirect/${ch.id}`;

    lines.push(
      `#EXTINF:-1${tvgId}${tvgName}${logo}${group}${lang}${country}${tamil}${multi},${name}`
    );
    lines.push(streamUrl);
    lines.push('');
  });

  return lines.join('\r\n');
}

// ── Tamil detection ───────────────────────────────────────────────────────────
const TAMIL_KEYWORDS = [
  'tamil', 'sun tv', 'vijay', 'zee tamil', 'kalaignar', 'puthiya thalaimurai',
  'news18 tamil', 'polimer', 'jaya', 'raj tv', 'captain tv', 'vendhar',
  'vasanth tv', 'adithya tv', 'mega tv', 'thanthi', 'sathiyam', 'sirippoli',
  'chutti tv', 'isai aruvi', 'makkal tv', 'zee thirai', 'dd tamil',
  'doordarshan tamil', 'imayam', 'sun music', 'star vijay', 'colors tamil',
  'news7 tamil', 'tamilnadu', 'madurai', 'coimbatore', 'et now tamil',
  'cnbc tamil', 'kaveri', 'rain bow', 'rainbow', 'vikatan', 'nakkheeran',
  'kollywood', 'tamizh',
];

export function isTamilChannel(ch: Channel): boolean {
  const str = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''));
  const lower = [
    str(ch.name), str(ch.group), str(ch.language),
    str(ch.tvgName), str(ch.tvgId),
  ].join(' ').toLowerCase();
  return TAMIL_KEYWORDS.some(k => lower.includes(k)) || str(ch.language).toLowerCase() === 'tamil';
}

export function isTamilGroup(groupName: string): boolean {
  const lower = groupName.toLowerCase();
  return TAMIL_KEYWORDS.some(k => lower.includes(k)) || lower.includes('tamil');
}

export { fetchUrl as fetchSourceContent } from './fetcher';
