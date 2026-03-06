/**
 * universalParser.ts — Auto-detecting format router
 *
 * Detects format and delegates to the correct specialized parser:
 *   M3U   → m3uParser.ts  (parseM3U)
 *   JSON  → jsonParser.ts (parseJsonSource)
 *   Plain → inline URL extractor
 *   XML   → inline URL extractor
 *
 * Supported source formats:
 *
 * ── M3U ──────────────────────────────────────────────────────────────────────
 * #EXTM3U
 * #EXTINF:-1 tvg-id="9XJalwa.in@SD",9X Jalwa (1080p)
 * https://b.jsrdn.com/strm/channels/9xjalwa/master.m3u8
 *
 * #EXTINF:-1 tvg-id="9XJhakaas.in@SD",9X Jhakaas
 * https://9xjio.wiseplayout.com/9X_Jhakaas/master.m3u8
 *
 * ── JSON (streamUrls array — YOUR FORMAT) ────────────────────────────────────
 * [
 *   {
 *     "id": "ThanthiOne.in",
 *     "name": "Thanthi One",
 *     "logoUrl": "https://jiotvimages.cdn.jio.com/...",
 *     "streamUrls": ["https://mumt02.tangotv.in/THANTHIONE/index.m3u8"],
 *     "category": "India"
 *   }
 * ]
 *
 * ── JSON (generic) ────────────────────────────────────────────────────────────
 * [{ "url": "https://...", "name": "Channel", "group": "Sports" }]
 *
 * ── Worker / PHP endpoint ─────────────────────────────────────────────────────
 * https://server.lrl45.workers.dev/channel/raw?format=m3u
 * → response auto-detected as M3U or JSON
 *
 * ── Pipe headers (preserved in rawUrl) ───────────────────────────────────────
 * https://stream.m3u8?token=abc|User-Agent=ReactNativeVideo/9.3.0|Referer=https://fancode.com/
 */

import { Channel } from '../types';
import { parseM3U } from './m3uParser';
import { parseJsonSource } from './jsonParser';

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
  if (
    u.includes('.m3u8') || u.includes('/hls/') ||
    u.includes('playlist.m3u') || u.includes('chunks.m3u8')
  ) return 'hls';
  return 'direct';
}

// ─── Pipe-header URL parser (re-exported) ─────────────────────────────────────
export function parsePipeHeadersLocal(raw: string): {
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
    if (key === 'useragent')                          result.userAgent = val;
    else if (key === 'referer' || key === 'referrer') result.referer   = val;
    else if (key === 'cookie')                        result.cookie    = val;
  }
  return result;
}

// ─── Format detection ─────────────────────────────────────────────────────────
export type ContentFormat = 'M3U' | 'JSON' | 'PLAINTEXT' | 'XML' | 'UNKNOWN';

export function detectFormat(content: string): ContentFormat {
  // Strip BOM and leading whitespace
  const t = content.replace(/^\uFEFF/, '').trimStart();

  // M3U — starts with #EXTM3U or #EXTINF (no header M3U files)
  if (t.startsWith('#EXTM3U') || t.startsWith('#EXTINF:')) return 'M3U';

  // JSON — starts with { or [
  if (t.startsWith('{') || t.startsWith('[')) return 'JSON';

  // XML / XMLTV
  if (t.startsWith('<?xml') || t.startsWith('<tv') || t.startsWith('<channels')) return 'XML';

  // Plain text with URLs
  if (/https?:\/\//i.test(t)) return 'PLAINTEXT';

  return 'UNKNOWN';
}

// ─── Plain text / XML URL extractor ──────────────────────────────────────────
let _counter = 0;
function parsePlainText(text: string, sourceId: string): Channel[] {
  const urlRegex = /https?:\/\/[^\s"'<>\n\r|,]+/g;
  const matches  = text.match(urlRegex) || [];
  const channels: Channel[] = [];

  for (const rawUrl of matches) {
    const url = rawUrl.trim();
    if (!url) continue;

    // Derive name from URL path
    const parts = url.split('/').filter(Boolean);
    const last  = parts[parts.length - 1] || '';
    const name  = last
      .replace(/[?#].*$/, '')
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .trim() || `Channel ${channels.length + 1}`;

    channels.push({
      id:         `${sourceId}_pt_${channels.length}_${Date.now()}_${(++_counter).toString(36)}`,
      name,
      url,
      rawUrl:     url,
      group:      'General',
      tvgName:    name,
      sourceId,
      isActive:   true,
      enabled:    true,
      order:      channels.length,
      streamType: detectStreamType(url),
      isTamil:    false,
    });
  }

  return channels;
}

// ─── Tamil detection ──────────────────────────────────────────────────────────
const TAMIL_KEYWORDS = [
  'sun tv', 'vijay', 'zee tamil', 'star vijay', 'kalaignar',
  'raj tv', 'jaya tv', 'polimer', 'vendhar', 'puthuyugam',
  'captain', 'adithya', 'sathiyam', 'news18 tamil', 'news7',
  'thanthi', 'tamil', 'kollywood', 'chithiram', 'isai',
  'kushi', 'makkal', 'vasanth', 'mega', 'sirippoli',
  'zee thirai', 'sun music', 'sun life', 'chutti tv',
  'kaveri', 'pondicherry', 'thenral', 'thendral',
  '9x jalwa', '9x jhakaas', '9x tashan', 'colors tamil',
];

export function isTamilChannel(name: string, group?: string, language?: string): boolean {
  const n = ss(name).toLowerCase();
  const g = ss(group).toLowerCase();
  const l = ss(language).toLowerCase();
  if (l === 'tamil' || l === 'ta' || l.includes('tamil')) return true;
  if (g.includes('tamil') || g.includes('kollywood'))     return true;
  return TAMIL_KEYWORDS.some(k => n.includes(k) || g.includes(k));
}

// ─── Main universal parser ────────────────────────────────────────────────────
export function universalParse(content: string, sourceId: string): Channel[] {
  if (!content || !content.trim()) {
    throw new Error('Empty content — source returned no data');
  }

  // Strip BOM
  const cleaned = content.replace(/^\uFEFF/, '');
  const format  = detectFormat(cleaned);

  let channels: Channel[] = [];

  switch (format) {
    case 'M3U':
      // Delegate 100% to m3uParser.ts — THE authoritative M3U parser
      channels = parseM3U(cleaned, sourceId);
      break;

    case 'JSON':
      // Delegate 100% to jsonParser.ts — THE authoritative JSON parser
      channels = parseJsonSource(cleaned, sourceId);
      break;

    case 'XML':
      // XMLTV is EPG data — extract embedded stream URLs
      channels = parsePlainText(cleaned, sourceId);
      break;

    case 'PLAINTEXT':
      channels = parsePlainText(cleaned, sourceId);
      break;

    case 'UNKNOWN':
    default:
      // Try in order: JSON → M3U → plain text
      try {
        channels = parseJsonSource(cleaned, sourceId);
        if (channels.length > 0) break;
      } catch { /* not JSON */ }

      try {
        channels = parseM3U(cleaned, sourceId);
        if (channels.length > 0) break;
      } catch { /* not M3U */ }

      channels = parsePlainText(cleaned, sourceId);
      break;
  }

  if (channels.length === 0) {
    throw new Error(
      `Source parsed as "${format}" but no valid stream URLs found.\n` +
      `First 200 chars: ${cleaned.substring(0, 200)}`
    );
  }

  // Tag isTamil on every channel
  return channels.map(ch => ({
    ...ch,
    isTamil: isTamilChannel(ch.name || '', ch.group || '', ch.language),
  }));
}

// ─── Utility exports ──────────────────────────────────────────────────────────
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

export function isHlsRedirectUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    (u.includes('restream') && u.includes('.vercel.app')) ||
    (u.includes('?id=') && u.includes('e=.m3u8'))         ||
    u.includes('?stream=')                                 ||
    u.includes('?channel=')                                ||
    (u.includes('workers.dev') && u.includes('?id='))
  );
}
