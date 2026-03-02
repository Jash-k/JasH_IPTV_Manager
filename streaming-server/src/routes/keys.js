'use strict';
/**
 * streaming-server/src/routes/keys.js
 *
 * DRM License / Key routes:
 *   POST /keys/clearkey/:id      — W3C ClearKey license endpoint
 *   POST /keys/widevine/:id      — Widevine license proxy
 *   POST /keys/playready/:id     — PlayReady SOAP license proxy
 *   POST /keys/fairplay/:id      — FairPlay SPC→CKC proxy
 *   GET  /keys/info/:channelId   — PSSH + KID inspector
 *   GET  /keys/aes/:sessionId    — AES-128 key (for HLS EXT-X-KEY)
 */

const express = require('express');
const router  = express.Router();
const cache   = require('../cacheManager');
const drm     = require('../drmHandler');
const cfg     = require('../../config');

// Raw body for binary license challenges
router.use(require('express').raw({ type: '*/*', limit: '2mb' }));

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: fetch channel + DRM config from main server
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDRMConfig(id) {
  const db = `${cfg.MAIN_SERVER}/api`;

  // Try DRM proxy list first
  try {
    const resp = await drm.fetchRaw(`${db}/drm`, {}, 8000);
    if (resp.ok) {
      const list = resp.json();
      const found = list.find(d => d.id===id || d.channelId===id);
      if (found) return { drmConfig: found, channel: null };
    }
  } catch {}

  // Try channel directly
  try {
    const resp = await drm.fetchRaw(`${db}/channels/${id}`, {}, 8000);
    if (resp.ok) {
      const ch = resp.json();
      return {
        channel: ch,
        drmConfig: {
          id:          ch.id,
          channelId:   ch.id,
          licenseType: ch.licenseType || 'clearkey',
          licenseKey:  ch.licenseKey  || ch.drmKey || '',
          licenseUrl:  ch.licenseUrl  || '',
          keyId:       ch.keyId       || ch.drmKeyId || '',
          key:         ch.key         || '',
          customHeaders: ch.httpHeaders || {},
        },
      };
    }
  } catch {}

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ClearKey license — W3C EME JSON format
//  Kodi inputstream.adaptive and most EME players use this
// ─────────────────────────────────────────────────────────────────────────────

router.post('/clearkey/:id', async (req, res) => {
  const id = req.params.id;

  // Parse challenge body
  let challenge = null;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    try { challenge = JSON.parse(req.body.toString('utf8')); } catch {}
  } else if (req.body && typeof req.body === 'object') {
    challenge = req.body;
  }

  const requestedKids = (challenge && Array.isArray(challenge.kids)) ? challenge.kids : [];

  try {
    const result = await fetchDRMConfig(id);
    if (!result) return res.status(404).json({ error: 'DRM config not found: '+id });
    const { drmConfig } = result;

    const src = drmConfig.licenseUrl || drmConfig.licenseKey || '';

    let keys = [];

    if (src && src.includes(':') && !src.startsWith('http')) {
      // Inline kid:key pairs — parse and serve directly
      const pairs = drm.parseClearKeyPairs(src);

      if (requestedKids.length > 0) {
        // Filter to only requested KIDs
        keys = requestedKids.map(b64kid => {
          const hexKid = drm.base64urlToHex(b64kid);
          const found  = pairs.find(p => p.kid === hexKid || drm.hexToBase64url(p.kid) === b64kid);
          return found ? { kty:'oct', kid: drm.hexToBase64url(found.kid), k: drm.hexToBase64url(found.key) } : null;
        }).filter(Boolean);
      } else {
        keys = pairs.map(p => ({ kty:'oct', kid: drm.hexToBase64url(p.kid), k: drm.hexToBase64url(p.key) }));
      }

    } else if (src && src.startsWith('http')) {
      // Proxy to external ClearKey license server
      const body = challenge
        ? JSON.stringify(challenge)
        : JSON.stringify({ kids: requestedKids, type: 'temporary' });

      try {
        const fetchedKeys = await drm.fetchClearKeys(src, requestedKids.map(drm.base64urlToHex), drmConfig.customHeaders);
        keys = fetchedKeys.map(k => ({ kty:'oct', kid: drm.hexToBase64url(k.kid), k: drm.hexToBase64url(k.key) }));
      } catch(e) {
        return res.status(502).json({ error: 'ClearKey license server error: '+e.message });
      }

    } else if (drmConfig.keyId && drmConfig.key) {
      // Separate keyId + key fields
      keys = [{ kty:'oct', kid: drm.hexToBase64url(drmConfig.keyId), k: drm.hexToBase64url(drmConfig.key) }];

    } else {
      // Try global config
      if (cfg.CLEARKEY_PAIRS) {
        const pairs = drm.parseClearKeyPairs(cfg.CLEARKEY_PAIRS);
        keys = pairs.map(p => ({ kty:'oct', kid: drm.hexToBase64url(p.kid), k: drm.hexToBase64url(p.key) }));
      }
    }

    console.log(`[ClearKey] id=${id} keys=${keys.length} requested=${requestedKids.length}`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys, type: 'temporary' });

  } catch(e) {
    console.error('[ClearKey License]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Widevine license proxy
//  Kodi sends binary protobuf challenge — we forward to real license server
// ─────────────────────────────────────────────────────────────────────────────

router.post('/widevine/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const result = await fetchDRMConfig(id);
    if (!result) return res.status(404).json({ error: 'DRM config not found: '+id });
    const { drmConfig } = result;

    const licUrl = drmConfig.licenseUrl || drmConfig.licenseKey || '';
    if (!licUrl || !licUrl.startsWith('http')) {
      return res.status(400).json({ error: 'Widevine license URL not configured for: '+id });
    }

    let challenge;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      challenge = req.body;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      try { challenge = Buffer.from(req.body, 'base64'); }
      catch { challenge = Buffer.from(req.body, 'utf8'); }
    } else {
      challenge = Buffer.alloc(0);
    }

    console.log(`[Widevine] id=${id} url=${licUrl} challenge=${challenge.length}B`);

    const licenseResp = await drm.fetchWidevineLicense(licUrl, challenge, drmConfig.customHeaders);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(licenseResp);

  } catch(e) {
    console.error('[Widevine License]', e.message);
    res.status(502).json({ error: 'Widevine license error: '+e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PlayReady license proxy
//  Kodi sends SOAP XML challenge
// ─────────────────────────────────────────────────────────────────────────────

router.post('/playready/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const result = await fetchDRMConfig(id);
    if (!result) return res.status(404).json({ error: 'DRM config not found: '+id });
    const { drmConfig } = result;

    const licUrl = drmConfig.licenseUrl || drmConfig.licenseKey || '';
    if (!licUrl || !licUrl.startsWith('http')) {
      return res.status(400).json({ error: 'PlayReady license URL not configured for: '+id });
    }

    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    console.log(`[PlayReady] id=${id} url=${licUrl} challenge=${challenge.length}B`);

    const licenseResp = await drm.fetchPlayReadyLicense(licUrl, challenge, drmConfig.customHeaders);

    const ct = 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(licenseResp);

  } catch(e) {
    console.error('[PlayReady License]', e.message);
    res.status(502).json({ error: 'PlayReady license error: '+e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  FairPlay license proxy
// ─────────────────────────────────────────────────────────────────────────────

router.post('/fairplay/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const result = await fetchDRMConfig(id);
    if (!result) return res.status(404).json({ error: 'DRM config not found: '+id });
    const { drmConfig } = result;

    const licUrl = drmConfig.licenseUrl || '';
    if (!licUrl) return res.status(400).json({ error: 'FairPlay license URL not configured' });

    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

    const resp = await drm.fetchRaw(licUrl, {
      method: 'POST',
      body:   challenge,
      headers: Object.assign({
        'Content-Type': 'application/octet-stream',
        'User-Agent':   drm.nextUA(),
      }, drmConfig.customHeaders || {}),
    }, 20000);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(resp.body);

  } catch(e) {
    res.status(502).json({ error: 'FairPlay error: '+e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PSSH / KID Inspector
//  GET /keys/info/:channelId
// ─────────────────────────────────────────────────────────────────────────────

router.get('/info/:channelId', async (req, res) => {
  const id = req.params.channelId;

  try {
    const result = await fetchDRMConfig(id);
    if (!result) return res.status(404).json({ error: 'Channel not found: '+id });

    const { channel, drmConfig } = result;
    const ch  = channel || { id, url: drmConfig.channelUrl };
    const url = ch.url || drmConfig.channelUrl;
    if (!url) return res.status(400).json({ error: 'No URL for channel: '+id });

    const headers = {};
    if (ch.userAgent)   headers['User-Agent'] = ch.userAgent;
    if (ch.referer)     headers['Referer']    = ch.referer;
    if (ch.cookie)      headers['Cookie']     = ch.cookie;
    if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

    const resp = await drm.fetchRaw(url, { headers }, 20000);
    const content = resp.text();

    const isHLS  = content.trimStart().startsWith('#EXTM3U');
    const isMPD  = content.includes('<MPD') || content.includes('<?xml');

    let psshs = [], kids = [], licenseUrls = {}, hlsKeys = [];

    if (isMPD) {
      const info = drm.extractFromMPD(content);
      psshs       = info.psshs.map(p => ({
        systemId:   p.systemId,
        drmType:    p.drmType,
        kids:       p.kids,
        psshBase64: p.psshBase64,
      }));
      kids        = info.kids;
      licenseUrls = info.licenseUrls;
    } else if (isHLS) {
      const info = drm.extractFromHLS(content);
      hlsKeys    = info.keys;
      if (info.licenseUrl) licenseUrls.detected = info.licenseUrl;
    }

    res.json({
      channelId:   id,
      url,
      manifestType: isMPD ? 'dash' : isHLS ? 'hls' : 'unknown',
      status:       resp.status,
      psshs,
      kids,
      licenseUrls,
      hlsKeys,
      drmType:      drmConfig ? drmConfig.licenseType : 'none',
      manifestSnippet: content.substring(0, 800),
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AES-128 Key endpoint for HLS EXT-X-KEY
// ─────────────────────────────────────────────────────────────────────────────

router.get('/aes/:sessionId', (req, res) => {
  const keyData = cache.getKey(req.params.sessionId);
  if (!keyData) return res.status(404).send('Key not found');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.send(keyData.key);
});

module.exports = router;
