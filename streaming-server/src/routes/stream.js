'use strict';
/**
 * streaming-server/src/routes/stream.js
 *
 * Stream routes:
 *   GET  /stream/start/:channelId         — Start/resume a stream session
 *   GET  /stream/:sessionId/master.m3u8   — HLS master playlist
 *   GET  /stream/:sessionId/:file         — Serve HLS segment / key file
 *   GET  /stream/status/:channelId        — Session status
 *   POST /stream/stop/:channelId          — Stop stream
 *   GET  /stream/sessions                 — All active sessions
 *
 *   GET  /hls-proxy/manifest/:id          — Proxy remote M3U8 (no transcoding)
 *   GET  /hls-proxy/seg/:id              — Proxy remote segment
 *   GET  /hls-proxy/key/:id              — Proxy remote key file
 */

const express    = require('express');
const router     = express.Router();
const path       = require('path');
const fs         = require('fs');
const http       = require('http');
const https      = require('https');
const cache      = require('../cacheManager');
const transcoder = require('../transcoder');
const hlsManager = require('../hlsManager');
const drm        = require('../drmHandler');
const cfg        = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: fetch channel from main server
// ─────────────────────────────────────────────────────────────────────────────

async function fetchChannel(channelId) {
  const url = `${cfg.MAIN_SERVER}/api/channels/${channelId}`;
  const resp = await drm.fetchRaw(url, {}, 10000);
  if (!resp.ok) throw new Error(`Channel ${channelId} not found on main server`);
  return resp.json();
}

async function fetchDRMConfig(channelId) {
  try {
    const url  = `${cfg.MAIN_SERVER}/api/drm`;
    const resp = await drm.fetchRaw(url, {}, 10000);
    if (!resp.ok) return null;
    const list = resp.json();
    return list.find(d => d.channelId === channelId && d.isActive !== false) || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/sessions — list all active sessions
// ─────────────────────────────────────────────────────────────────────────────

router.get('/sessions', (req, res) => {
  const sessions = cache.getAllSessions().map(s => ({
    id:          s.id,
    channelId:   s.channelId,
    channelName: s.channelName,
    status:      s.status,
    viewers:     s.viewers,
    startedAt:   s.startedAt,
    lastAccess:  s.lastAccess,
    uptime:      Math.floor((Date.now() - s.startedAt) / 1000),
    playlistUrl: s.playlistUrl,
    hasDRM:      !!(s.drmConfig || (s.channel && (s.channel.licenseType || s.channel.licenseKey))),
    metrics:     s.metrics || {},
  }));
  res.json({ sessions, stats: cache.getStats() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/start/:channelId — Start or resume a stream
// ─────────────────────────────────────────────────────────────────────────────

router.get('/start/:channelId', async (req, res) => {
  const { channelId } = req.params;
  const BASE          = req.protocol + '://' + req.get('host');
  const forceNew      = req.query.force === '1';

  try {
    // Check for existing running session
    if (!forceNew) {
      const existing = cache.getSessionByChannel(channelId);
      if (existing && existing.status === 'running') {
        cache.addViewer(existing.id);
        return res.redirect(302, `${BASE}/stream/${existing.id}/master.m3u8`);
      }
    }

    // Fetch channel info from main server
    let channel;
    try {
      channel = await fetchChannel(channelId);
    } catch(e) {
      return res.status(404).json({ error: 'Channel not found: '+e.message });
    }

    const hasDRM    = !!(channel.licenseType || channel.licenseKey || channel.isDrm);
    const drmConfig = hasDRM ? await fetchDRMConfig(channelId) : null;

    if (hasDRM) {
      // ── DRM Stream: transcode via FFmpeg ────────────────────────────────
      const keyUrl = `${BASE}/stream/key/${channelId}`;
      const session = await transcoder.startSession(channelId, channel, drmConfig, {
        encrypt: true,
        keyUrl,
      });

      cache.addViewer(session.id);
      console.log(`[Route] Started DRM session ${session.id} for ${channel.name} → ${session.playlistUrl}`);

      // Redirect to the HLS playlist
      return res.redirect(302, `${BASE}/stream/${session.id}/master.m3u8`);

    } else {
      // ── Non-DRM: use HLS proxy (no transcoding needed) ──────────────────
      const proxyUrl = `${BASE}/hls-proxy/manifest/${channelId}?url=${encodeURIComponent(channel.url)}`;
      return res.redirect(302, proxyUrl);
    }

  } catch(e) {
    console.error('[Route /start]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/status/:channelId
// ─────────────────────────────────────────────────────────────────────────────

router.get('/status/:channelId', (req, res) => {
  const session = cache.getSessionByChannel(req.params.channelId);
  if (!session) return res.json({ status: 'idle', channelId: req.params.channelId });
  res.json({
    sessionId:   session.id,
    channelId:   session.channelId,
    channelName: session.channelName,
    status:      session.status,
    viewers:     session.viewers,
    playlistUrl: session.playlistUrl,
    uptime:      Math.floor((Date.now() - session.startedAt) / 1000),
    metrics:     session.metrics,
    hasDRM:      !!(session.drmConfig),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/:sessionId/master.m3u8 — HLS playlist
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:sessionId/master.m3u8', (req, res) => {
  const { sessionId } = req.params;
  const BASE          = req.protocol + '://' + req.get('host');

  cache.touchSession(sessionId);

  const content = hlsManager.getSessionPlaylist(sessionId, BASE);
  if (!content) {
    // Session might still be starting
    const session = cache.getSession(sessionId);
    if (session && session.status === 'starting') {
      // Return a minimal waiting playlist
      const waitPl = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '# Stream is starting, please wait...',
      ].join('\n');
      res.setHeader('Content-Type', 'application/x-mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(waitPl);
    }
    return res.status(404).json({ error: 'Playlist not found for session: '+sessionId });
  }

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(content);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/key/:channelId — Serve AES-128 key
// ─────────────────────────────────────────────────────────────────────────────

router.get('/key/:channelId', (req, res) => {
  const session = cache.getSessionByChannel(req.params.channelId);
  if (!session) return res.status(404).send('Session not found');

  const keyData = cache.getKey(session.id);
  if (!keyData) return res.status(404).send('Key not found');

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', keyData.key.length);
  res.send(keyData.key);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /stream/:sessionId/:file — Serve HLS segment
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:sessionId/:file', (req, res) => {
  const { sessionId, file } = req.params;
  cache.touchSession(sessionId);

  const filePath = hlsManager.getSegmentPath(sessionId, file);
  if (!filePath) return res.status(404).send('Segment not found: '+file);

  // Determine content type
  let ct = 'video/mp2t';
  if (file.endsWith('.m3u8'))   ct = 'application/x-mpegurl';
  if (file.endsWith('.aac'))    ct = 'audio/aac';
  if (file.endsWith('.m4s'))    ct = 'video/iso.segment';
  if (file.endsWith('.mp4'))    ct = 'video/mp4';
  if (file.endsWith('.key'))    ct = 'application/octet-stream';

  try {
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', file.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=300');

    // Update metrics
    const s = cache.getSession(sessionId);
    if (s && s.metrics) {
      s.metrics.bytesServed   = (s.metrics.bytesServed || 0) + stat.size;
      s.metrics.segmentsGenerated = (s.metrics.segmentsGenerated || 0) + (file.endsWith('.ts') ? 1 : 0);
    }

    res.sendFile(filePath);
  } catch(e) {
    res.status(500).send('Error serving file: '+e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /stream/stop/:channelId
// ─────────────────────────────────────────────────────────────────────────────

router.post('/stop/:channelId', (req, res) => {
  const session = cache.getSessionByChannel(req.params.channelId);
  if (!session) return res.json({ ok: false, error: 'No active session' });

  transcoder.stopSession(session.id);
  cache.deleteSession(session.id);
  res.json({ ok: true, stopped: session.id });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HLS Proxy Routes (no transcoding — for non-DRM streams)
//  GET /hls-proxy/manifest/:id?url=...
//  GET /hls-proxy/seg/:id?url=...
//  GET /hls-proxy/key/:id?url=...
// ─────────────────────────────────────────────────────────────────────────────

router.get('/proxy/manifest/:id', async (req, res) => {
  const { id }     = req.params;
  const manifestUrl = req.query.url;
  if (!manifestUrl) return res.status(400).send('Missing ?url=');

  const BASE = req.protocol + '://' + req.get('host');

  try {
    // Fetch channel to get headers (best effort)
    let channel = { id };
    try { channel = await fetchChannel(id); } catch {}

    const playlist = await hlsManager.proxyManifest(manifestUrl, channel, BASE, id);

    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(playlist);
  } catch(e) {
    console.error('[HLS Proxy Manifest]', e.message);
    res.status(502).send('Manifest proxy error: '+e.message);
  }
});

router.get('/proxy/seg/:id', async (req, res) => {
  const { id }  = req.params;
  const segUrl  = req.query.url;
  if (!segUrl)  return res.status(400).send('Missing ?url=');

  try {
    let channel = { id };
    try { channel = await fetchChannel(id); } catch {}
    await hlsManager.proxySegment(segUrl, channel, res);
  } catch(e) {
    console.error('[HLS Proxy Seg]', e.message);
    if (!res.headersSent) res.status(502).send('Segment proxy error: '+e.message);
  }
});

router.get('/proxy/key/:id', async (req, res) => {
  const { id }  = req.params;
  const keyUrl  = req.query.url;
  if (!keyUrl)  return res.status(400).send('Missing ?url=');

  try {
    let channel = { id };
    try { channel = await fetchChannel(id); } catch {}
    await hlsManager.proxySegment(keyUrl, channel, res);
  } catch(e) {
    if (!res.headersSent) res.status(502).send('Key proxy error: '+e.message);
  }
});

module.exports = router;
