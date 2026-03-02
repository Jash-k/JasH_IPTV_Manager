'use strict';
/**
 * streaming-server/src/hlsManager.js
 *
 * HLS Playlist Manager
 *
 * Responsibilities:
 *   1. Serve master.m3u8 and segment .ts files from output dir
 *   2. Rewrite M3U8 playlist URLs to point to our server
 *   3. Proxy remote HLS manifests + segments (for streams that don't need transcoding)
 *   4. Inject EXT-X-KEY for AES-128 re-encryption
 *   5. Handle multi-quality variant playlists
 */

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const cache   = require('./cacheManager');
const cfg     = require('../config');
const { nextUA, fetchRaw } = require('./drmHandler');

// ─────────────────────────────────────────────────────────────────────────────
//  HLS Playlist Reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read master.m3u8 from session output dir and rewrite segment URLs
 * so they point to our server (not the filesystem path)
 */
function getSessionPlaylist(sessionId, serverBaseUrl) {
  const session = cache.getSession(sessionId);
  if (!session) return null;

  const m3u8Path = session.playlistPath;
  if (!fs.existsSync(m3u8Path)) return null;

  let content = fs.readFileSync(m3u8Path, 'utf8');

  // Rewrite segment URLs: seg00001.ts → {serverBaseUrl}/stream/{id}/seg00001.ts
  content = content.replace(/^(seg\d+\.ts)$/gm, `${serverBaseUrl}/stream/${sessionId}/$1`);
  content = content.replace(/^(seg\d+\.aac)$/gm, `${serverBaseUrl}/stream/${sessionId}/$1`);
  content = content.replace(/^(seg\d+\.m4s)$/gm, `${serverBaseUrl}/stream/${sessionId}/$1`);

  // Rewrite relative sub-playlist URLs
  content = content.replace(/^([^\s#][^/\s]+\.m3u8)$/gm, `${serverBaseUrl}/stream/${sessionId}/$1`);

  return content;
}

/**
 * Serve a specific file from a session's output dir
 * @returns {string|null} full file path or null
 */
function getSegmentPath(sessionId, filename) {
  const session = cache.getSession(sessionId);
  if (!session) return null;

  // Sanitize filename (prevent path traversal)
  const safe = path.basename(filename);
  if (!safe.match(/^(seg\d+\.(ts|aac|m4s)|master\.m3u8|enc\.key|init\.(mp4|m4i))$/)) return null;

  const fullPath = path.join(session.outputDir, safe);
  return fs.existsSync(fullPath) ? fullPath : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Remote HLS Proxy
//  For streams that don't need transcoding — we proxy the M3U8 + segments
//  This avoids FFmpeg entirely for simple streams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and rewrite a remote HLS manifest
 * All segment URLs are rewritten to go through our proxy
 *
 * @param {string} manifestUrl  - Remote M3U8 URL
 * @param {Object} channel      - Channel object (for headers)
 * @param {string} serverBase   - Our server base URL
 * @param {string} proxyId      - ID to use in proxy URLs
 */
async function proxyManifest(manifestUrl, channel, serverBase, proxyId) {
  const fetchHeaders = buildChannelHeaders(channel);

  const resp = await fetchRaw(manifestUrl, { headers: fetchHeaders }, 20000);
  if (!resp.ok) throw new Error(`Manifest fetch failed: ${resp.status} ${manifestUrl}`);

  const content = resp.text();

  // Parse base URL for relative segment resolution
  const parsedManifest = new URL(manifestUrl);
  const baseUrl = parsedManifest.origin + parsedManifest.pathname.replace(/\/[^/]+$/, '/');

  return rewriteManifest(content, manifestUrl, baseUrl, serverBase, proxyId, channel);
}

/**
 * Rewrite all URLs in an M3U8 playlist to go through our proxy
 */
function rewriteManifest(content, manifestUrl, baseUrl, serverBase, proxyId, channel) {
  const lines = content.split('\n');
  const out   = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) { out.push(''); continue; }

    // Pass through comment/directive lines unchanged (except EXT-X-KEY)
    if (line.startsWith('#')) {
      // Rewrite EXT-X-KEY URI to go through our key proxy
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        const rewritten = line.replace(/URI="([^"]+)"/, (match, uri) => {
          const keyUrl = resolveUrl(uri, baseUrl);
          const encoded = encodeURIComponent(keyUrl);
          return `URI="${serverBase}/hls-proxy/key/${proxyId}?url=${encoded}"`;
        });
        out.push(rewritten);
      } else if (line.startsWith('#EXT-X-MAP:')) {
        // Rewrite init segment URL
        const rewritten = line.replace(/URI="([^"]+)"/, (match, uri) => {
          const segUrl = resolveUrl(uri, baseUrl);
          const encoded = encodeURIComponent(segUrl);
          return `URI="${serverBase}/hls-proxy/seg/${proxyId}?url=${encoded}"`;
        });
        out.push(rewritten);
      } else {
        out.push(line);
      }
      continue;
    }

    // URL lines (segments or sub-playlists)
    if (line.startsWith('http://') || line.startsWith('https://')) {
      const isM3U8 = line.endsWith('.m3u8') || line.includes('.m3u8?');
      if (isM3U8) {
        // Sub-playlist (variant stream) — proxy it recursively
        const encoded = encodeURIComponent(line);
        out.push(`${serverBase}/hls-proxy/manifest/${proxyId}?url=${encoded}`);
      } else {
        // Segment
        const encoded = encodeURIComponent(line);
        out.push(`${serverBase}/hls-proxy/seg/${proxyId}?url=${encoded}`);
      }
    } else if (line.endsWith('.ts') || line.endsWith('.aac') || line.endsWith('.m4s') || line.endsWith('.mp4')) {
      // Relative segment URL
      const absUrl  = resolveUrl(line, baseUrl);
      const encoded = encodeURIComponent(absUrl);
      out.push(`${serverBase}/hls-proxy/seg/${proxyId}?url=${encoded}`);
    } else if (line.endsWith('.m3u8') || line.includes('.m3u8?')) {
      // Relative sub-playlist
      const absUrl  = resolveUrl(line, baseUrl);
      const encoded = encodeURIComponent(absUrl);
      out.push(`${serverBase}/hls-proxy/manifest/${proxyId}?url=${encoded}`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

/**
 * Resolve a possibly-relative URL against a base URL
 */
function resolveUrl(url, base) {
  if (!url) return base;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return base.replace(/[^/]+$/, '') + url;
  }
}

/**
 * Build headers for channel fetching
 */
function buildChannelHeaders(channel) {
  const hdrs = { 'User-Agent': nextUA(), 'Accept': '*/*' };
  if (channel.userAgent)   hdrs['User-Agent']  = channel.userAgent;
  if (channel.referer)     hdrs['Referer']      = channel.referer;
  if (channel.cookie)      hdrs['Cookie']       = channel.cookie;
  if (channel.httpHeaders) Object.assign(hdrs, channel.httpHeaders);
  return hdrs;
}

/**
 * Proxy a segment (TS/M4S/AAC/key) from remote URL
 * Pipes the response directly to client res object
 */
async function proxySegment(segUrl, channel, res) {
  const headers = buildChannelHeaders(channel);
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(segUrl); } catch(e) { return reject(new Error('Bad segment URL: '+segUrl)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     (parsed.pathname||'/') + (parsed.search||''),
      method:   'GET',
      headers,
      rejectUnauthorized: false,
    }, upstream => {
      if ([301,302,307,308].includes(upstream.statusCode) && upstream.headers.location) {
        upstream.resume();
        let loc = upstream.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol+'//'+parsed.host+loc;
        return proxySegment(loc, channel, res).then(resolve).catch(reject);
      }

      const ct = upstream.headers['content-type'] || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      if (upstream.headers['content-length'])
        res.setHeader('Content-Length', upstream.headers['content-length']);

      res.status(upstream.statusCode < 400 ? upstream.statusCode : 200);
      upstream.pipe(res);
      upstream.on('end',   resolve);
      upstream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Playlist generator for channel list
//  Generates an M3U8 that references our streaming server URLs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a channel playlist that points to this streaming server
 */
function generateStreamingPlaylist(channels, serverBase, options) {
  options = options || {};
  const lines = [`#EXTM3U x-tvg-url="" playlist-name="${options.name || 'IPTV Stream'}"`];

  channels.forEach(ch => {
    if (!ch || !ch.id || !ch.url) return;

    const hasDRM = !!(ch.licenseType || ch.licenseKey || ch.isDrm);

    // Use streaming server URL for DRM channels, direct proxy for others
    let streamUrl;
    if (hasDRM) {
      streamUrl = `${serverBase}/stream/start/${ch.id}`;
    } else {
      // Non-DRM: use HLS proxy (faster, no transcoding)
      streamUrl = `${serverBase}/hls-proxy/manifest/${ch.id}?url=${encodeURIComponent(ch.url)}`;
    }

    // EXTINF
    let attrs = '';
    if (ch.tvgId)    attrs += ` tvg-id="${ch.tvgId}"`;
    attrs += ` tvg-name="${(ch.tvgName || ch.name || '').replace(/"/g,'')}"`;
    if (ch.logo)     attrs += ` tvg-logo="${ch.logo}"`;
    attrs += ` group-title="${(ch.group || 'Uncategorized').replace(/"/g,'')}"`;

    const name = (ch.name || 'Unknown').replace(/,/g,' ');
    lines.push(`#EXTINF:-1${attrs},${name}`);
    lines.push(streamUrl);
  });

  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  getSessionPlaylist,
  getSegmentPath,
  proxyManifest,
  proxySegment,
  rewriteManifest,
  resolveUrl,
  generateStreamingPlaylist,
  buildChannelHeaders,
};
