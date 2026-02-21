/**
 * JASH ADDON — Stream Extractor
 * Ports the exact Samsung Tizen-optimized HLS extraction logic.
 * Resolves master playlists → best variant → real segment URL.
 * Fixes HLS segment issues on Samsung Stremio.
 */

export interface ExtractResult {
  url: string;
  type: 'master' | 'media' | 'direct' | 'fallback';
  resolution?: string;
  bandwidth?: number;
  variantsFound?: number;
  selectedIndex?: number;
  isCached?: boolean;
  responseTimeMs?: number;
  error?: string;
  rawContent?: string;
}

interface Variant {
  url: string;
  bandwidth: number;
  resolution: string;
}

// In-memory stream cache (mirrors addon server cache)
const streamCache = new Map<string, { url: string; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const TIZEN_UA =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36';

const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
];

// ─────────────────────────────────────────────────────────────────────────────
// Fetch with CORS proxy fallback
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithProxy(url: string, timeoutMs = 10000): Promise<string> {
  const tryFetch = async (fetchUrl: string): Promise<string> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(fetchUrl, {
        signal: ctrl.signal,
        headers: { 'User-Agent': TIZEN_UA, Accept: '*/*' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. Try direct
  try { return await tryFetch(url); } catch { /* fall through */ }

  // 2. Try each CORS proxy
  for (const proxy of CORS_PROXIES) {
    try {
      const proxyUrl = `${proxy}${encodeURIComponent(url)}`;
      const text = await tryFetch(proxyUrl);
      if (proxy.includes('allorigins')) {
        try { const j = JSON.parse(text); return j.contents || text; } catch { return text; }
      }
      return text;
    } catch { /* try next */ }
  }

  throw new Error('All fetch attempts failed (direct + 3 proxies)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve relative URL against a base URL
// ─────────────────────────────────────────────────────────────────────────────
function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return `https:${url}`;
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  return base + url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract real stream URL from M3U8 content
// Exact port of the addon's extractRealStreamUrl function
// ─────────────────────────────────────────────────────────────────────────────
export interface ExtractMeta {
  type: 'master' | 'media' | 'direct' | 'fallback';
  resolution?: string;
  bandwidth?: number;
  variantsFound?: number;
  selectedIndex?: number;
}

export function extractRealStreamUrl(
  m3u8Content: string,
  baseUrl: string
): { url: string | null; meta: ExtractMeta } {
  const lines = m3u8Content.split('\n').map((l) => l.trim()).filter(Boolean);
  const isMasterPlaylist = lines.some((l) => l.includes('#EXT-X-STREAM-INF'));

  if (isMasterPlaylist) {
    // ── Master playlist → pick middle-quality variant ─────────────────────
    const variants: Variant[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('#EXT-X-STREAM-INF')) {
        const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/);
        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        const bandwidth  = bwMatch  ? parseInt(bwMatch[1])  : 0;
        const resolution = resMatch ? resMatch[1] : 'unknown';

        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            variants.push({ url: lines[j], bandwidth, resolution });
            break;
          }
        }
      }
    }

    if (variants.length === 0) {
      return { url: null, meta: { type: 'master', variantsFound: 0 } };
    }

    // Sort by bandwidth descending
    variants.sort((a, b) => b.bandwidth - a.bandwidth);

    // Select middle quality for Samsung TV stability (exact same logic as addon)
    const selectedIndex = Math.floor(variants.length / 2);
    const selected      = variants[selectedIndex];
    const variantUrl    = resolveUrl(selected.url, baseUrl);

    return {
      url: variantUrl,
      meta: {
        type: 'master',
        resolution: selected.resolution,
        bandwidth: selected.bandwidth,
        variantsFound: variants.length,
        selectedIndex,
      },
    };
  } else {
    // ── Media playlist → find first segment URL ───────────────────────────
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      if (
        line.includes('.ts')   ||
        line.includes('.m4s')  ||
        line.includes('.m3u8') ||
        line.includes('.aac')  ||
        line.includes('.mp4')
      ) {
        return { url: resolveUrl(line, baseUrl), meta: { type: 'media' } };
      }
    }
    return { url: null, meta: { type: 'media' } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full stream resolution pipeline (mirrors the addon's defineStreamHandler)
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveStream(streamUrl: string): Promise<ExtractResult> {
  const start = Date.now();

  // Check cache
  const cached = streamCache.get(streamUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { url: cached.url, type: 'direct', isCached: true, responseTimeMs: Date.now() - start };
  }

  // If URL is not HLS, treat as direct
  const isHLS =
    streamUrl.endsWith('.m3u8') ||
    streamUrl.endsWith('.m3u')  ||
    streamUrl.includes('.m3u8?') ||
    streamUrl.includes('/playlist') ||
    streamUrl.includes('play.m3u8');

  if (!isHLS) {
    return { url: streamUrl, type: 'direct', responseTimeMs: Date.now() - start };
  }

  try {
    const content   = await fetchWithProxy(streamUrl, 10000);
    const afterFetch = Date.now();

    if (!content.includes('#EXTM3U') && !content.includes('#EXT-X-')) {
      return { url: streamUrl, type: 'direct', responseTimeMs: afterFetch - start, rawContent: content.slice(0, 200) };
    }

    const { url: extractedUrl, meta } = extractRealStreamUrl(content, streamUrl);

    if (!extractedUrl) {
      return {
        url: streamUrl,
        type: 'fallback',
        resolution: meta.resolution,
        bandwidth: meta.bandwidth,
        variantsFound: meta.variantsFound,
        selectedIndex: meta.selectedIndex,
        responseTimeMs: Date.now() - start,
        error: 'No segments found in playlist',
        rawContent: content.slice(0, 300),
      };
    }

    // Cache the result
    streamCache.set(streamUrl, { url: extractedUrl, ts: Date.now() });

    return {
      url: extractedUrl,
      type: meta.type,
      resolution: meta.resolution,
      bandwidth: meta.bandwidth,
      variantsFound: meta.variantsFound,
      selectedIndex: meta.selectedIndex,
      responseTimeMs: Date.now() - start,
      rawContent: content.slice(0, 400),
    };
  } catch (err) {
    return {
      url: streamUrl,
      type: 'fallback',
      responseTimeMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch resolve streams
// ─────────────────────────────────────────────────────────────────────────────
export async function batchResolveStreams(
  urls: string[],
  onResult: (url: string, result: ExtractResult, index: number) => void,
  concurrency = 5,
  signal?: AbortSignal
): Promise<Map<string, ExtractResult>> {
  const results = new Map<string, ExtractResult>();
  let index = 0;

  for (let i = 0; i < urls.length; i += concurrency) {
    if (signal?.aborted) break;
    const batch       = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((url) => resolveStream(url)));
    batchResults.forEach((result, bi) => {
      results.set(batch[bi], result);
      onResult(batch[bi], result, ++index);
    });
  }

  return results;
}

export function clearStreamCache(): void  { streamCache.clear(); }
export function getStreamCacheSize(): number { return streamCache.size; }

// ─────────────────────────────────────────────────────────────────────────────
// Generate the complete addon server.js (Node.js) for deployment
// ─────────────────────────────────────────────────────────────────────────────
export function generateAddonServerCode(config: {
  addonId: string;
  addonName: string;
  streams: Array<{ id: string; name: string; url: string; group: string; logo?: string; tvgId?: string; enabled: boolean }>;
  groups: Array<{ id: string; name: string }>;
}): string {
  const { addonId, addonName, streams, groups } = config;
  const enabledStreams = streams.filter((s) => s.enabled);
  const streamCount    = enabledStreams.length;
  const groupCount     = groups.length;

  const streamsJson = JSON.stringify(
    enabledStreams.map((s) => ({ id: s.id, name: s.name, url: s.url, group: s.group, logo: s.logo || '', tvgId: s.tvgId || '' })),
    null, 2
  );
  const groupsJson = JSON.stringify(groups.map((g) => g.name), null, 2);

  return `#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         JASH ADDON SERVER — Stremio IPTV Addon               ║
 * ║   Samsung Tizen OS Optimized · HLS Segment Extraction        ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  Generated : ${new Date().toISOString()}          ║
 * ║  Streams   : ${String(streamCount).padEnd(10)} Groups: ${groupCount}                    ║
 * ║  Addon ID  : ${addonId.padEnd(44)} ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW TO RUN:
 *   npm install
 *   npm start
 *
 * INSTALL IN STREMIO:
 *   stremio://localhost:7000/manifest.json
 */

const { addonBuilder } = require('stremio-addon-sdk');
const http  = require('http');
const https = require('https');

// ─── Configuration ────────────────────────────────────────────────────────────
const APP_NAME       = '${addonName}';
const APP_ID         = '${addonId}';
const PORT           = process.env.PORT || 7000;
const REQUEST_TIMEOUT = 10000;
const CACHE_TTL      = 5 * 60 * 1000; // 5 minutes
const DEBUG          = process.env.DEBUG === 'true';

// ─── Logger ───────────────────────────────────────────────────────────────────
const log   = (...a) => console.log(new Date().toISOString(), '[JASH]', ...a);
const debug = (...a) => DEBUG && console.log(new Date().toISOString(), '[DEBUG]', ...a);
const error = (...a) => console.error(new Date().toISOString(), '[ERROR]', ...a);

// ─── Stream Cache ─────────────────────────────────────────────────────────────
const streamCache = new Map();

function getCached(url) {
  const c = streamCache.get(url);
  if (c && Date.now() - c.ts < CACHE_TTL) { debug('Cache hit:', url.substring(0, 50)); return c.url; }
  streamCache.delete(url);
  return null;
}

function setCache(url, resolved) {
  streamCache.set(url, { url: resolved, ts: Date.now() });
}

// ─── Stream Data (auto-generated) ────────────────────────────────────────────
const STREAMS = ${streamsJson};

const GROUPS = ${groupsJson};

log(\`Loaded \${STREAMS.length} streams across \${GROUPS.length} groups\`);

// ─── ID Helpers ───────────────────────────────────────────────────────────────
function encodeId(url) {
  return Buffer.from(url).toString('base64url');
}
function decodeId(id) {
  try { return Buffer.from(id, 'base64url').toString('utf8'); }
  catch { return ''; }
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
const builder = new addonBuilder({
  id          : APP_ID,
  version     : '1.0.0',
  name        : APP_NAME,
  description : 'Tizen-optimized IPTV · HLS extraction · ' + STREAMS.length + ' channels',
  logo        : 'https://dl.strem.io/addon-logo.png',
  resources   : ['catalog', 'meta', 'stream'],
  types       : ['tv'],
  idPrefixes  : ['jash:'],
  catalogs    : GROUPS.map((g, i) => ({
    type  : 'tv',
    id    : 'jash_cat_' + i,
    name  : g,
    extra : [{ name: 'search', isRequired: false }],
  })),
  behaviorHints: { adult: false, p2p: false },
});

// ─── Catalog Handler ──────────────────────────────────────────────────────────
builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv') return Promise.resolve({ metas: [] });

  const idx       = parseInt(id.replace('jash_cat_', ''), 10);
  const groupName = GROUPS[idx];
  if (!groupName) return Promise.resolve({ metas: [] });

  let list = STREAMS.filter(s => s.group === groupName);
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    list    = list.filter(s => s.name.toLowerCase().includes(q));
  }

  const metas = list.map(s => ({
    id         : 'jash:' + encodeId(s.url),
    type       : 'tv',
    name       : s.name,
    poster     : s.logo || '',
    background : s.logo || '',
    logo       : s.logo || '',
    description: 'Group: ' + s.group,
    genres     : [s.group],
  }));

  debug('[CATALOG]', groupName, '->', metas.length, 'items');
  return Promise.resolve({ metas });
});

// ─── Meta Handler ─────────────────────────────────────────────────────────────
builder.defineMetaHandler(({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('jash:')) return Promise.resolve({ meta: null });

  const url = decodeId(id.replace('jash:', ''));
  const s   = STREAMS.find(st => st.url === url);
  if (!s) return Promise.resolve({ meta: null });

  return Promise.resolve({
    meta: {
      id,
      type       : 'tv',
      name       : s.name,
      poster     : s.logo || '',
      logo       : s.logo || '',
      description: 'Group: ' + s.group,
      genres     : [s.group],
    },
  });
});

// ─── Stream Handler ───────────────────────────────────────────────────────────
// Samsung Tizen OS optimized: extracts real stream URL from HLS master playlists
// to fix segment playback issues on Stremio for Samsung TV.
builder.defineStreamHandler(async ({ type, id }) => {
  debug('[STREAM] type=' + type + ', id=' + id);

  if (type !== 'tv' || !id.startsWith('jash:')) return { streams: [] };

  let playlistUrl = '';
  try {
    playlistUrl = decodeId(id.replace('jash:', ''));
    if (!playlistUrl) throw new Error('Could not decode stream ID');

    // ── Cache Check ─────────────────────────────────────────────────────────
    const cached = getCached(playlistUrl);
    if (cached) {
      log('[STREAM] ⚡ Cache hit');
      return {
        streams: [{
          url          : cached,
          title        : '🔴 Live',
          name         : APP_NAME,
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    // ── Skip extraction for non-HLS direct streams ───────────────────────
    const isHLS =
      playlistUrl.endsWith('.m3u8') || playlistUrl.includes('.m3u8?') ||
      playlistUrl.endsWith('.m3u')  || playlistUrl.includes('/playlist') ||
      playlistUrl.includes('play.m3u8');

    if (!isHLS) {
      debug('[STREAM] Direct stream, skipping extraction');
      return {
        streams: [{
          url          : playlistUrl,
          title        : '🔴 Live',
          name         : APP_NAME,
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    log('[STREAM] Fetching playlist: ' + playlistUrl.substring(0, 70) + '...');

    // ── Fetch the M3U8 playlist ──────────────────────────────────────────
    const controller  = { aborted: false };
    const m3u8Content = await fetchPlaylist(playlistUrl);
    if (controller.aborted) return { streams: [] };

    log('[STREAM] Playlist fetched (' + m3u8Content.length + ' bytes)');

    // ── Extract real stream URL ──────────────────────────────────────────
    const realStreamUrl = extractRealStreamUrl(m3u8Content, playlistUrl);

    if (!realStreamUrl) {
      log('[STREAM] No real URL found, using original playlist URL');
      return {
        streams: [{
          url          : playlistUrl,
          title        : '🔴 Live',
          name         : APP_NAME,
          behaviorHints: { notWebReady: true },
        }],
      };
    }

    log('[STREAM] ✅ Real URL: ' + realStreamUrl.substring(0, 70) + '...');
    setCache(playlistUrl, realStreamUrl);

    return {
      streams: [{
        url          : realStreamUrl,
        title        : '🔴 Live Stream',
        name         : APP_NAME,
        behaviorHints: { notWebReady: true },
      }],
    };

  } catch (err) {
    error('[STREAM] Handler error:', err.message);

    // ── Fallback: return original URL so Stremio can try anyway ─────────
    if (playlistUrl) {
      return {
        streams: [{
          url          : playlistUrl,
          title        : '🔴 Live (Fallback)',
          name         : APP_NAME,
          behaviorHints: { notWebReady: true },
        }],
      };
    }
    return { streams: [] };
  }
});

// ─── Fetch Playlist (with Tizen User-Agent) ───────────────────────────────────
function fetchPlaylist(url) {
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('Request timeout')), REQUEST_TIMEOUT);

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.1 Chrome/56.0.2924.0 TV Safari/537.36',
        'Accept'    : '*/*',
        'Connection': 'keep-alive',
      },
    };

    const req = lib.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        // Follow redirect
        fetchPlaylist(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        clearTimeout(timeout);
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { clearTimeout(timeout); resolve(data); });
      res.on('error', e => { clearTimeout(timeout); reject(e); });
    });

    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
    req.end();
  });
}

// ─── Extract Real Stream URL ──────────────────────────────────────────────────
// Samsung Tizen fix: selects middle-quality variant from master playlists.
// This avoids the highest bitrate which can cause buffering on Samsung TVs,
// and avoids the lowest which looks bad. Middle = stability + quality balance.
function extractRealStreamUrl(m3u8Content, baseUrl) {
  try {
    const lines    = m3u8Content.split('\\n').map(l => l.trim()).filter(Boolean);
    const isMaster = lines.some(l => l.includes('#EXT-X-STREAM-INF'));

    if (isMaster) {
      debug('[EXTRACT] Master playlist detected');

      // Parse all quality variants
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const bwM   = lines[i].match(/BANDWIDTH=(\\d+)/);
          const resM  = lines[i].match(/RESOLUTION=(\\d+x\\d+)/);
          const bandwidth  = bwM  ? parseInt(bwM[1])  : 0;
          const resolution = resM ? resM[1] : 'unknown';

          // Next non-comment line is the variant URL
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].startsWith('#')) {
              variants.push({ url: lines[j], bandwidth, resolution });
              break;
            }
          }
        }
      }

      if (!variants.length) {
        debug('[EXTRACT] No variants found in master playlist');
        return null;
      }

      // Sort highest bandwidth first
      variants.sort((a, b) => b.bandwidth - a.bandwidth);

      // ★ KEY: Select MIDDLE quality index for Samsung TV stability
      const selectedIndex = Math.floor(variants.length / 2);
      const selected      = variants[selectedIndex];

      debug('[EXTRACT] Variants: ' + variants.length +
            ', Selected[' + selectedIndex + ']: ' +
            selected.resolution + ' @ ' + selected.bandwidth + 'bps');

      // Make absolute URL
      let variantUrl = selected.url;
      if (!variantUrl.startsWith('http')) {
        const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        variantUrl  = base + variantUrl;
      }
      return variantUrl;

    } else {
      // Media playlist — return first segment URL
      debug('[EXTRACT] Media playlist detected');

      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.includes('.ts')   || line.includes('.m4s') ||
            line.includes('.m3u8') || line.includes('.aac') ||
            line.includes('.mp4')) {
          let segUrl = line;
          if (!segUrl.startsWith('http')) {
            const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            segUrl     = base + line;
          }
          debug('[EXTRACT] Found segment: ' + segUrl.substring(0, 60) + '...');
          return segUrl;
        }
      }

      debug('[EXTRACT] No segments found in media playlist');
      return null;
    }
  } catch (err) {
    error('[EXTRACT] Error:', err.message);
    return null;
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const addonInterface = builder.getInterface();

const server = http.createServer((req, res) => {
  // CORS headers (required for Stremio)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status  : 'ok',
      addon   : APP_NAME,
      streams : STREAMS.length,
      groups  : GROUPS.length,
      cache   : streamCache.size,
      uptime  : Math.round(process.uptime()),
    }));
    return;
  }

  // Stremio addon routes
  addonInterface.router(req, res);
});

process.on('uncaughtException',  e => error('Uncaught:', e.message));
process.on('unhandledRejection', e => error('Unhandled:', e));

server.listen(PORT, () => {
  log('═══════════════════════════════════════════════');
  log('🚀 ' + APP_NAME + ' is running!');
  log('📡 URL     : http://localhost:' + PORT);
  log('📋 Manifest: http://localhost:' + PORT + '/manifest.json');
  log('📺 Streams : ' + STREAMS.length + ' across ' + GROUPS.length + ' groups');
  log('📥 Install : stremio://localhost:' + PORT + '/manifest.json');
  log('❤️  Health  : http://localhost:' + PORT + '/health');
  log('═══════════════════════════════════════════════');
});
`;
}

export function generatePackageJson(addonName: string, addonId: string, streamCount: number): string {
  return JSON.stringify(
    {
      name       : addonId,
      version    : '1.0.0',
      description: `${addonName} — Samsung Tizen optimized Stremio IPTV addon · ${streamCount} streams`,
      main       : 'server.js',
      scripts    : {
        start: 'node server.js',
        dev  : 'DEBUG=true node server.js',
      },
      dependencies: {
        'stremio-addon-sdk': '^1.6.10',
      },
      engines: { node: '>=16.0.0' },
      keywords: ['stremio', 'iptv', 'addon', 'samsung', 'tizen', 'hls'],
    },
    null,
    2
  );
}

export function generateReadme(addonName: string, streamCount: number, groupCount: number): string {
  return `# ${addonName} — Stremio IPTV Addon

> Samsung Tizen OS Optimized · HLS Segment Extraction · ${streamCount} streams · ${groupCount} groups

Generated by **Jash Addon Configurator** on ${new Date().toLocaleDateString()}.

## Quick Start

\`\`\`bash
# 1. Install dependencies
npm install

# 2. Start the addon server
npm start

# 3. Install in Stremio
# Open Stremio → Settings → Addons → Install from URL
# Paste: http://localhost:7000/manifest.json
\`\`\`

## Samsung Tizen Notes

This addon uses **HLS segment extraction** to fix the common HLS playback issue on Samsung Stremio:

- Fetches the M3U8 master playlist
- Parses all quality variants
- Selects the **middle quality** (bandwidth stability sweet spot for Samsung TVs)
- Returns the resolved segment URL to Stremio

This avoids the "black screen" issue caused by Stremio on Tizen trying to handle HLS internally.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| \`/manifest.json\` | Stremio addon manifest |
| \`/health\` | Health check (JSON) |
| \`/catalog/tv/:id.json\` | Channel catalog by group |
| \`/stream/tv/:id.json\` | Stream URL for a channel |

## Deploy to Production

\`\`\`bash
# Railway / Render / Heroku — set PORT environment variable
PORT=80 npm start

# Then install via public URL:
# stremio://your-server.com/manifest.json
\`\`\`

## Stats

- **Streams**: ${streamCount}
- **Groups**: ${groupCount}
- **Cache TTL**: 5 minutes
- **Timeout**: 10 seconds per request
`;
}
