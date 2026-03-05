'use strict';

// =============================================================================
// HLS Proxy Server — Port 10001
//
// Handles redirect-chain HLS streams that cannot be played directly:
//   https://restream-bay.vercel.app/?id=380952&e=.m3u8
//   → follows redirects → fetches real HLS manifest
//   → rewrites segment URLs → proxies .ts segments to player
//
// Flow:
//   Player → GET /hls/:id/playlist.m3u8
//            → follow redirects (up to 10 hops)
//            → fetch real HLS manifest
//            → rewrite #EXTINF segment URLs → /hls/:id/seg/<encodedUrl>
//            → rewrite #EXT-X-KEY URI        → /hls/:id/key/<encodedUrl>
//            → serve rewritten manifest
//
//   Player → GET /hls/:id/seg/<encodedUrl>
//            → stream .ts segment directly to player (no buffering)
//
//   Player → GET /hls/:id/key/<encodedUrl>
//            → proxy AES-128 decryption key
// =============================================================================

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const https   = require('https');
const { URL } = require('url');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const HLS_PORT  = parseInt(process.env.HLS_PORT || '10001', 10);
const MAIN_PORT = parseInt(process.env.PORT     || '10000', 10);
const DB_FILE   = process.env.DB_FILE ||
  (fs.existsSync('/data') ? '/data/db/db.json' : path.join(__dirname, 'db.json'));

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Detect HLS redirect-chain URLs ──────────────────────────────────────────
// These URLs don't end with .m3u8 directly but redirect to HLS manifests
const HLS_REDIRECT_PATTERNS = [
  /restream/i,
  /vercel\.app/i,
  /workers\.dev/i,
  /cloudflare/i,
  /netlify\.app/i,
  /pages\.dev/i,
  /redirect/i,
  /proxy/i,
  /stream\.php/i,
  /get\.php/i,
  /play\.php/i,
  /index\.php/i,
  /live\.php/i,
  /channel\.php/i,
  /\?id=/i,
  /\?ch=/i,
  /\?stream=/i,
  /\?channel=/i,
  /\?e=\.m3u8/i,
];

function isHlsRedirectUrl(url) {
  if (!url) return false;
  // If ends with .m3u8 directly → direct HLS, no need to proxy
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.m3u8') || u.endsWith('.m3u')) return false;
  // If has .m3u8 in query string → redirect chain
  if (url.toLowerCase().includes('.m3u8') || url.toLowerCase().includes('.m3u')) return true;
  // Check patterns
  return HLS_REDIRECT_PATTERNS.some(p => p.test(url));
}

// ─── DB Reader ────────────────────────────────────────────────────────────────
function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { channels: [], sources: [] };
}

// ─── URL Utils ────────────────────────────────────────────────────────────────
function parsePipeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { url: '', headers: {} };
  const pipeIdx = rawUrl.indexOf('|');
  if (pipeIdx === -1) return { url: rawUrl.trim(), headers: {} };

  const url     = rawUrl.substring(0, pipeIdx).trim();
  const headers = {};
  rawUrl.substring(pipeIdx + 1).split('|').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const key = part.substring(0, eq).trim();
    const val = part.substring(eq + 1).trim();
    if (key && val) headers[key] = val;
  });
  return { url, headers };
}

// Resolve relative URLs against a base URL
function resolveUrl(base, relative) {
  if (!relative) return base;
  try {
    // Already absolute
    if (relative.startsWith('http://') || relative.startsWith('https://')) {
      return relative;
    }
    // Protocol-relative
    if (relative.startsWith('//')) {
      const baseUrl = new URL(base);
      return `${baseUrl.protocol}${relative}`;
    }
    // Root-relative
    if (relative.startsWith('/')) {
      const baseUrl = new URL(base);
      return `${baseUrl.protocol}//${baseUrl.host}${relative}`;
    }
    // Relative to base directory
    const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
    return baseDir + relative;
  } catch {
    return relative;
  }
}

// Get the base URL of a manifest (directory containing the manifest)
function getManifestBase(manifestUrl) {
  try {
    const u = new URL(manifestUrl);
    const path = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  }
}

// ─── HTTP/HTTPS request helper ────────────────────────────────────────────────
function makeRequest(targetUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib     = isHttps ? https : http;

      const options = {
        hostname           : parsed.hostname,
        port               : parsed.port || (isHttps ? 443 : 80),
        path               : parsed.pathname + parsed.search,
        method             : opts.method || 'GET',
        headers            : {
          'User-Agent'     : opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept'         : opts.accept   || '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection'     : 'keep-alive',
          ...(opts.referer  ? { 'Referer'    : opts.referer  } : {}),
          ...(opts.cookie   ? { 'Cookie'     : opts.cookie   } : {}),
          ...(opts.origin   ? { 'Origin'     : opts.origin   } : {}),
          ...(opts.headers  || {}),
        },
        timeout            : opts.timeout || 15000,
        rejectUnauthorized : false,
      };

      const req = lib.request(options, resolve);
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// ─── Follow redirects and fetch final response ────────────────────────────────
async function fetchWithRedirects(url, opts = {}, hops = 0) {
  if (hops > 10) throw new Error('Too many redirects');

  const res = await makeRequest(url, opts);

  // Follow redirects
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
    res.resume(); // drain
    const nextUrl = resolveUrl(url, res.headers.location);
    console.log(`[HLS-PROXY] Redirect ${hops + 1}: ${nextUrl.substring(0, 100)}`);
    return fetchWithRedirects(nextUrl, opts, hops + 1);
  }

  return { res, finalUrl: url };
}

// ─── Read full response body as text ─────────────────────────────────────────
function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// ─── Detect if content is HLS manifest ───────────────────────────────────────
function isHlsManifest(text) {
  const t = text.trim();
  return t.startsWith('#EXTM3U') || t.startsWith('#EXT-X-');
}

// ─── Rewrite HLS manifest — replace segment/key URLs with proxy URLs ─────────
function rewriteManifest(content, channelId, finalManifestUrl, proxyBase) {
  const lines    = content.split('\n');
  const rewritten = [];
  const base      = getManifestBase(finalManifestUrl);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimEnd();

    // ── #EXT-X-KEY — rewrite URI for key proxy ──────────────────────────────
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
      line = line.replace(/URI="([^"]+)"/g, (_, keyUri) => {
        const resolvedKey = resolveUrl(base, keyUri);
        const encoded     = encodeURIComponent(resolvedKey);
        return `URI="${proxyBase}/hls/${channelId}/key/${encoded}"`;
      });
      rewritten.push(line);
      continue;
    }

    // ── #EXT-X-MAP — init segment ────────────────────────────────────────────
    if (line.startsWith('#EXT-X-MAP')) {
      line = line.replace(/URI="([^"]+)"/g, (_, mapUri) => {
        const resolvedMap = resolveUrl(base, mapUri);
        const encoded     = encodeURIComponent(resolvedMap);
        return `URI="${proxyBase}/hls/${channelId}/seg/${encoded}"`;
      });
      rewritten.push(line);
      continue;
    }

    // ── Segment URL line (after #EXTINF or #EXT-X-BYTERANGE) ────────────────
    if (
      !line.startsWith('#') &&
      line.trim().length > 0
    ) {
      const resolved = resolveUrl(base, line.trim());
      const encoded  = encodeURIComponent(resolved);
      rewritten.push(`${proxyBase}/hls/${channelId}/seg/${encoded}`);
      continue;
    }

    // ── Sub-manifest (variant playlist, audio track, etc.) ──────────────────
    // Check if this is a URI in a tag like #EXT-X-MEDIA or #EXT-X-STREAM-INF
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
      line = line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const resolved = resolveUrl(base, uri);
        const encoded  = encodeURIComponent(resolved);
        return `URI="${proxyBase}/hls/${channelId}/manifest/${encoded}"`;
      });
    }

    rewritten.push(line);
  }

  return rewritten.join('\n');
}

// ─── Get channel headers from DB ─────────────────────────────────────────────
function getChannelHeaders(ch) {
  const headers = {};
  if (ch.userAgent) headers['User-Agent'] = ch.userAgent;
  if (ch.referer)   headers['Referer']    = ch.referer;
  if (ch.cookie)    headers['Cookie']     = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  // Parse pipe headers from rawUrl
  if (ch.rawUrl && ch.rawUrl.includes('|')) {
    const { headers: pipeHeaders } = parsePipeUrl(ch.rawUrl);
    Object.assign(headers, pipeHeaders);
  }

  return headers;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'hls-proxy', port: HLS_PORT });
});

// ── Playlist / Manifest ───────────────────────────────────────────────────────
app.get('/hls/:id/playlist.m3u8', async (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);

  if (!ch) {
    return res.status(404).json({ error: 'Channel not found', id: req.params.id });
  }

  const { url: cleanUrl } = parsePipeUrl(ch.rawUrl || ch.url || '');
  if (!cleanUrl) {
    return res.status(400).json({ error: 'Channel has no URL' });
  }

  const extraHeaders = getChannelHeaders(ch);
  const proto        = `${req.headers['x-forwarded-proto'] || req.protocol}`;
  const host         = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${HLS_PORT}`;
  const proxyBase    = `${proto}://${host}`;

  console.log(`[HLS-PROXY] Fetching manifest for: ${ch.name}`);
  console.log(`[HLS-PROXY] URL: ${cleanUrl.substring(0, 120)}`);

  try {
    const { res: upstreamRes, finalUrl } = await fetchWithRedirects(cleanUrl, {
      accept    : 'application/vnd.apple.mpegurl, application/x-mpegurl, */*',
      headers   : extraHeaders,
    });

    const body = await readBody(upstreamRes);

    if (!isHlsManifest(body)) {
      console.error(`[HLS-PROXY] Not an HLS manifest for ${ch.name}. Content: ${body.substring(0, 200)}`);
      return res.status(502).json({
        error     : 'URL did not return an HLS manifest',
        channel   : ch.name,
        url       : cleanUrl,
        finalUrl,
        preview   : body.substring(0, 300),
      });
    }

    const rewritten = rewriteManifest(body, ch.id, finalUrl, proxyBase);

    res.setHeader('Content-Type',                     'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control',                    'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin',      '*');
    res.setHeader('Access-Control-Expose-Headers',    'Content-Type');
    res.setHeader('X-HLS-Final-URL',                  finalUrl.substring(0, 200));
    res.setHeader('X-HLS-Channel',                    ch.name);
    res.send(rewritten);

  } catch (err) {
    console.error(`[HLS-PROXY] Error fetching ${ch.name}: ${err.message}`);
    res.status(502).json({
      error   : err.message,
      channel : ch.name,
      url     : cleanUrl,
    });
  }
});

// ── Sub-manifest proxy (variant/audio playlists) ──────────────────────────────
app.get('/hls/:id/manifest/:encodedUrl', async (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(req.params.encodedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL encoding' });
  }

  const extraHeaders = ch ? getChannelHeaders(ch) : {};
  const proto        = `${req.headers['x-forwarded-proto'] || req.protocol}`;
  const host         = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${HLS_PORT}`;
  const proxyBase    = `${proto}://${host}`;
  const channelId    = req.params.id;

  try {
    const { res: upstreamRes, finalUrl } = await fetchWithRedirects(targetUrl, {
      headers: extraHeaders,
    });
    const body      = await readBody(upstreamRes);
    const rewritten = rewriteManifest(body, channelId, finalUrl, proxyBase);

    res.setHeader('Content-Type',                'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control',               'no-cache, no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (err) {
    res.status(502).json({ error: err.message, url: targetUrl });
  }
});

// ── Segment proxy — streams .ts segments directly ─────────────────────────────
app.get('/hls/:id/seg/:encodedUrl', async (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);

  let segUrl;
  try {
    segUrl = decodeURIComponent(req.params.encodedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL encoding' });
  }

  const extraHeaders = ch ? getChannelHeaders(ch) : {};

  console.log(`[HLS-PROXY] Segment: ${segUrl.substring(0, 100)}`);

  try {
    const { res: upstreamRes } = await fetchWithRedirects(segUrl, {
      accept  : 'video/mp2t, application/octet-stream, */*',
      headers : extraHeaders,
    });

    const contentType = upstreamRes.headers['content-type'] || 'video/mp2t';
    const contentLen  = upstreamRes.headers['content-length'];

    res.setHeader('Content-Type',                contentType);
    res.setHeader('Cache-Control',               'public, max-age=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (contentLen) res.setHeader('Content-Length', contentLen);

    // Stream directly — no buffering
    upstreamRes.pipe(res);

    upstreamRes.on('error', err => {
      console.error(`[HLS-PROXY] Segment stream error: ${err.message}`);
      if (!res.headersSent) res.status(502).end();
    });

    req.on('close', () => {
      if (upstreamRes.destroy) upstreamRes.destroy();
    });

  } catch (err) {
    console.error(`[HLS-PROXY] Segment fetch error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: err.message, url: segUrl });
    }
  }
});

// ── Key proxy — AES-128 decryption keys ───────────────────────────────────────
app.get('/hls/:id/key/:encodedUrl', async (req, res) => {
  const db = readDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);

  let keyUrl;
  try {
    keyUrl = decodeURIComponent(req.params.encodedUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL encoding' });
  }

  const extraHeaders = ch ? getChannelHeaders(ch) : {};

  try {
    const { res: upstreamRes } = await fetchWithRedirects(keyUrl, {
      accept  : 'application/octet-stream, */*',
      headers : extraHeaders,
    });

    res.setHeader('Content-Type',                'application/octet-stream');
    res.setHeader('Cache-Control',               'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    upstreamRes.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message, url: keyUrl });
  }
});

// ── Check if URL needs HLS proxy ──────────────────────────────────────────────
app.get('/api/check', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: '?url= required' });

  const needsProxy = isHlsRedirectUrl(url);
  res.json({ url, needsProxy, reason: needsProxy ? 'redirect-chain' : 'direct' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(HLS_PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  📡  HLS Proxy Server — Redirect Chain Handler           ║
╠══════════════════════════════════════════════════════════╣
║  Port      : ${String(HLS_PORT).padEnd(43)}║
║  Main Port : ${String(MAIN_PORT).padEnd(43)}║
╠══════════════════════════════════════════════════════════╣
║  Handles: restream-bay.vercel.app, workers.dev, etc.     ║
║  GET /hls/:id/playlist.m3u8  → fetch + rewrite manifest  ║
║  GET /hls/:id/seg/:url       → stream .ts segments       ║
║  GET /hls/:id/key/:url       → proxy AES-128 keys        ║
║  GET /hls/:id/manifest/:url  → proxy sub-manifests       ║
╚══════════════════════════════════════════════════════════╝
`);
});
