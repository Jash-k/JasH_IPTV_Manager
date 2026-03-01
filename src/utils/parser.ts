/**
 * parser.ts — Jash Addon
 * Exact parser provided by user.
 * Direct fetch only — no CORS proxies.
 * fetchSource goes through backend /api/fetch-source (server-side, no CORS).
 */

// parser.ts — no type imports needed from types (Channel defined here)

// ─── Tamil Keywords ──────────────────────────────────────────────────────────

export const TAMIL_KEYWORDS = [
  'tamil', 'tamizh', 'தமிழ்',
  'sun tv', 'sun life', 'sun music', 'sun news', 'kalaignar', 'ktv',
  'jaya tv', 'jaya plus', 'jaya max', 'zee tamil', 'colors tamil',
  'star vijay', 'vijay tv', 'vijay super', 'vijay music',
  'puthuyugam', 'polimer', 'adithya', 'raj tv', 'raj digital',
  'mega tv', 'vasanth', 'captain tv', 'makkal tv', 'thanthi',
  'news7', 'news 7', 'puthiya thalaimurai', 'sathiyam',
  'win tv', 'peppers', 'murasu', 'isaiaruvi', 'imayam',
  'chutti tv', 'siripoli', 'sirippoli', 'kalaignar tv',
  'dm tamil', 'dm movie', 'j movie', 'k tv',
  'sun hd', 'star tamil', 'dd podhigai', 'dd tamil',
  'discovery tamil', 'nat geo tamil', 'sony tamil',
  'tn ', ' tn', '(tn)', '[tn]', 'tamil hd', 'raj news',
  'lotus', 'sangeetha', 'madha tv', 'shemaroo tamil',
  'mxp tamil',
];

// ─── Channel type (for Tamil filter compat) ──────────────────────────────────

export interface Channel {
  id: string;
  name: string;
  group: string;
  logo: string;
  url: string;
  kid: string;
  contentKey: string;
  enabled: boolean;
  language: string;
}

// ─── Tamil filter helpers ─────────────────────────────────────────────────────

export function isTamilChannel(name: string, group: string, lang: string): boolean {
  const check = `${name} ${group} ${lang}`.toLowerCase();
  return TAMIL_KEYWORDS.some(kw => check.includes(kw));
}

export function filterTamilChannels(channels: Channel[]): Channel[] {
  return channels.filter(ch => isTamilChannel(ch.name, ch.group, ch.language));
}

// ─── Precise title extractor (handles commas inside quoted attributes) ────────

function extractTitle(line: string): string {
  // Use tvg-name if present — most reliable
  const tvgName = line.match(/tvg-name="([^"]*)"/i);
  if (tvgName && tvgName[1].trim()) {
    return tvgName[1].trim();
  }
  // Walk char-by-char, find last unquoted comma
  let inQuote = false;
  let quoteChar = '';
  let lastCommaIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
    } else {
      if (ch === '"' || ch === "'") { inQuote = true; quoteChar = ch; }
      else if (ch === ',') lastCommaIdx = i;
    }
  }
  if (lastCommaIdx === -1) return '';
  return line.slice(lastCommaIdx + 1).trim();
}

// ─── Quality / year strippers ─────────────────────────────────────────────────

const QUALITY_RE = /\s*[\[(]?\s*(4k|uhd|fhd|1080p|720p|480p|360p|hd|sd|vip|plus|premium)\s*[\])]?\s*$/i;

export function stripQuality(title: string): string {
  return title.replace(QUALITY_RE, '').trim();
}

// ─── M3U parser ───────────────────────────────────────────────────────────────

export function parseM3U(content: string, sourceId = ''): Channel[] {
  // Normalize line endings and remove BOM
  const raw = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').map(l => l.trim());
  const channels: Channel[] = [];
  let current: Partial<Channel> | null = null;
  let pendingKid = '';
  let pendingKey = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // DRM key
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      const val = line.split('=').slice(1).join('=').trim();
      if (val.includes(':') && !val.startsWith('http')) {
        const parts = val.split(':');
        pendingKid = parts[0] || '';
        pendingKey = parts[1] || '';
      }
      continue;
    }

    // DRM type — just mark, no action needed
    if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) continue;

    // User-Agent / cookie — store on current
    if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
      if (!current) current = {};
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) continue;

    if (line.startsWith('#EXTINF:')) {
      current = {};
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const logoMatch  = line.match(/tvg-logo="([^"]*)"/i);
      const langMatch  = line.match(/tvg-language="([^"]*)"/i);
      const idMatch    = line.match(/tvg-id="([^"]*)"/i);

      current.group    = groupMatch ? groupMatch[1] : '';
      current.logo     = logoMatch  ? logoMatch[1]  : '';
      current.language = langMatch  ? langMatch[1]  : '';
      current.name     = extractTitle(line);

      // Apply kid/key from previous #KODIPROP lines
      if (pendingKid) {
        current.kid        = pendingKid;
        current.contentKey = pendingKey;
        pendingKid = '';
        pendingKey = '';
      }

      // Use tvg-id if name is still empty
      if (!current.name && idMatch) current.name = idMatch[1];
      continue;
    }

    // URL line
    if (
      (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtsp')) &&
      current
    ) {
      current.url        = line;
      current.id         = sourceId
        ? `${sourceId}_${crypto.randomUUID()}`
        : crypto.randomUUID();
      current.enabled    = true;
      current.kid        = current.kid        || '';
      current.contentKey = current.contentKey || '';
      current.language   = current.language   || '';

      channels.push(current as Channel);
      current = null;
      continue;
    }

    // Skip other comment lines
    if (line.startsWith('#')) continue;
  }

  return channels;
}

// ─── JSON parser ──────────────────────────────────────────────────────────────

export function parseJSON(content: string, sourceId = ''): Channel[] {
  try {
    const data = JSON.parse(content);

    // Handle numeric-keyed objects like { "677": { url, name, ... } }
    if (!Array.isArray(data) && typeof data === 'object') {
      const keys = Object.keys(data);
      const firstVal = data[keys[0]];
      if (
        firstVal &&
        typeof firstVal === 'object' &&
        ('url' in firstVal || 'link' in firstVal)
      ) {
        // Numeric-keyed object — flatten to array using keys as channel IDs
        const list = keys.map(k => ({ ...data[k], _id: k }));
        return list.map((item: Record<string, string>) =>
          mapJsonItem(item, sourceId)
        );
      }
    }

    const list: Record<string, string>[] = Array.isArray(data)
      ? data
      : data.channels || data.items || data.data || data.streams || [];

    return list.map((item: Record<string, string>) => mapJsonItem(item, sourceId));
  } catch {
    return [];
  }
}

function mapJsonItem(item: Record<string, string>, sourceId: string): Channel {
  // Extract DRM key from drmLicense: "kid:key" or separate kid/key fields
  let kid = item.kid || item.key_id || '';
  let contentKey = item.contentKey || item.key || item.content_key || '';

  if (!kid && item.drmLicense) {
    const parts = item.drmLicense.split(':');
    if (parts.length === 2) { kid = parts[0]; contentKey = parts[1]; }
  }
  if (!kid && item.licenseKey) {
    const parts = item.licenseKey.split(':');
    if (parts.length === 2) { kid = parts[0]; contentKey = parts[1]; }
  }

  return {
    id         : sourceId ? `${sourceId}_${crypto.randomUUID()}` : crypto.randomUUID(),
    name       : item.name || item.title || item.channel_name || item.channel || item.label || '',
    group      : item.group || item.group_title || item['group-title'] || item.category || item.genre || '',
    logo       : item.logo || item.tvg_logo || item['tvg-logo'] || item.icon || item.image || item.thumbnail || '',
    url        : item.url || item.stream_url || item.link || item.src || item.streamUrl || item.playbackUrl || '',
    kid,
    contentKey,
    enabled    : true,
    language   : item.language || item.lang || '',
  };
}

// ─── Format detection ─────────────────────────────────────────────────────────

export function detectFormat(content: string): 'm3u' | 'json' {
  const trimmed = content.trim();
  if (trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXTINF')) return 'm3u';
  if (trimmed.startsWith('{') || trimmed.startsWith('['))              return 'json';
  // Check if JSON is embedded in HTML (CF Workers viewer)
  if (trimmed.includes('<pre>')) {
    const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
      const inner = preMatch[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) return 'json';
      if (inner.startsWith('#EXTM3U') || inner.startsWith('#EXTINF')) return 'm3u';
    }
  }
  return 'm3u';
}

// ─── HTML content extractor (for CF Workers / API browser views) ──────────────

function extractFromHtml(html: string): string {
  // 1. <pre> tags (most common for CF Workers)
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    const decoded = preMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (decoded.startsWith('{') || decoded.startsWith('[') ||
        decoded.startsWith('#EXTM3U') || decoded.startsWith('#EXTINF')) {
      return decoded;
    }
  }

  // 2. <script> JSON assignments
  const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scriptMatches) {
    const jsonMatch = m[1].match(/(?:var\s+\w+\s*=\s*|window\.\w+\s*=\s*|=\s*)(\[[\s\S]*?\]|\{[\s\S]*?\})\s*;/);
    if (jsonMatch) {
      try { JSON.parse(jsonMatch[1]); return jsonMatch[1]; } catch { /* next */ }
    }
  }

  // 3. Body text stripped of tags
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const text = bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const jsonStart = text.search(/[\[{]/);
    if (jsonStart !== -1) {
      const candidate = text.slice(jsonStart);
      try { JSON.parse(candidate); return candidate; } catch { /* next */ }
    }
    if (text.startsWith('#EXTM3U') || text.startsWith('#EXTINF')) return text;
  }

  // 4. Full stripped
  const fullStripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const jsonStart = fullStripped.search(/[\[{]/);
  if (jsonStart !== -1) {
    const candidate = fullStripped.slice(jsonStart);
    try { JSON.parse(candidate); return candidate; } catch { /* next */ }
  }

  return html; // fallback: return as-is
}

// ─── parseSource — main entry point ──────────────────────────────────────────

export function parseSource(
  rawContent: string,
  format: 'm3u' | 'json' | 'auto',
  sourceId = ''
): { all: Channel[]; tamil: Channel[] } {
  let content = rawContent;

  // If content looks like HTML, extract the real content first
  if (content.trim().startsWith('<!') || content.trim().startsWith('<html')) {
    content = extractFromHtml(content);
  }

  const fmt = format === 'auto' ? detectFormat(content) : format;
  const all   = fmt === 'json' ? parseJSON(content, sourceId) : parseM3U(content, sourceId);
  const tamil = filterTamilChannels(all);
  return { all, tamil };
}

// ─── URL normalizer ───────────────────────────────────────────────────────────

export function normalizeSourceUrl(url: string): string {
  let u = url.trim();

  // GitHub blob → raw
  const ghBlob = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (ghBlob) return `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;

  // Pastebin → raw
  const paste = u.match(/^https?:\/\/pastebin\.com\/(?!raw\/)([a-zA-Z0-9]+)$/);
  if (paste) return `https://pastebin.com/raw/${paste[1]}`;

  // Google Drive → download
  const gdrive = u.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (gdrive) return `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;

  // Dropbox → direct
  if (u.includes('dropbox.com')) {
    u = u.replace('?dl=0', '?dl=1').replace('?dl=2', '?dl=1');
    if (!u.includes('?dl=')) u += (u.includes('?') ? '&dl=1' : '?dl=1');
    return u;
  }

  // OneDrive
  if (u.includes('onedrive.live.com/redir')) return u.replace('/redir?', '/download?');

  return u;
}

// ─── fetchSource — direct fetch with backend fallback ────────────────────────

function getBackendBase(): string {
  if (typeof window === 'undefined') return '';
  const { protocol, hostname, port } = window.location;
  // In production (same host), use same origin
  if (port !== '5173' && port !== '5174' && port !== '3000') {
    return `${protocol}//${window.location.host}`;
  }
  // In dev, try backend on 7000 — but we'll use direct fetch first
  return `${protocol}//${hostname}:7000`;
}

// Try direct browser fetch first (works for CORS-enabled URLs like raw.github, pastebin/raw, etc.)
async function fetchDirect(url: string): Promise<string> {
  const resp = await fetch(url, {
    method : 'GET',
    headers: {
      'Accept': 'text/plain, application/json, application/x-mpegurl, */*',
    },
    signal: AbortSignal.timeout(20_000),
    cache : 'no-store',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// Fall back to backend /api/fetch-source (server-side fetch, no CORS)
async function fetchViaBackend(url: string): Promise<string> {
  const base = getBackendBase();
  if (!base) throw new Error('No backend available');

  const resp = await fetch(`${base}/api/fetch-source`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ url }),
    signal : AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(errData.error || `Backend fetch failed: ${resp.status}`);
  }

  const data = await resp.json();
  if (!data.content || data.content.trim().length === 0) {
    throw new Error('Backend returned empty content');
  }
  return data.content as string;
}

export async function fetchSource(url: string): Promise<string> {
  const normalized = normalizeSourceUrl(url);
  const hostname   = new URL(normalized).hostname;

  // URLs that always support CORS — fetch directly
  const corsEnabled =
    hostname.includes('raw.githubusercontent.com') ||
    hostname.includes('pastebin.com') ||
    hostname.includes('cdn.jsdelivr.net') ||
    hostname.includes('gist.githubusercontent.com') ||
    hostname.includes('gitlab.com');

  if (corsEnabled) {
    try {
      const text = await fetchDirect(normalized);
      if (text && text.trim().length > 0) return text;
    } catch (e) {
      // fall through to backend
    }
  }

  // Try direct first, if it fails try backend
  try {
    const text = await fetchDirect(normalized);
    if (text && text.trim().length > 0) return text;
  } catch (_directErr) {
    // Direct fetch failed (CORS blocked) — try backend
  }

  // Backend fallback (server-side fetch, bypasses CORS)
  return fetchViaBackend(normalized);
}

// parser.ts — end
