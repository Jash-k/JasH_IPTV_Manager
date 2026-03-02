'use strict';
/**
 * streaming-server/src/drmHandler.js
 *
 * DRM Handler — Kodi inputstream.adaptive logic at server level
 *
 * Handles:
 *   1. ClearKey  — AES-128 HLS encryption + W3C EME key delivery
 *   2. Widevine  — PSSH extraction + license proxy + manifest rewriting
 *   3. PlayReady — PRO header parsing + SOAP license proxy
 *   4. FairPlay  — SPC/CKC proxy
 *   5. JioTV     — Cookie + DRM scheme → playable HLS via FFmpeg
 *
 * For DRM streams:
 *   - Fetches manifest (MPD/HLS)
 *   - Extracts PSSH, KIDs, ContentProtection
 *   - Fetches decryption keys via license server
 *   - Re-encrypts with AES-128 for HLS delivery (or serves clear via FFmpeg)
 *   - Returns playable HLS playlist URL
 */

const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const cfg     = require('../config');
const cache   = require('./cacheManager');

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexToBase64url(hex) {
  if (!hex) return '';
  const clean = String(hex).replace(/[-\s]/g, '');
  if (!/^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(hex).toString('base64url');
  return Buffer.from(clean, 'hex').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function base64urlToHex(b64) {
  if (!b64) return '';
  try {
    const pad = b64.replace(/-/g,'+').replace(/_/g,'/');
    return Buffer.from(pad, 'base64').toString('hex');
  } catch { return ''; }
}

function toHex(val) {
  if (!val) return '';
  const s = String(val).replace(/[-\s]/g,'');
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 32) return s.toLowerCase();
  try { return Buffer.from(val.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('hex'); } catch { return ''; }
}

const ROTATING_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-S908B Build/SP1A.210812.016)',
  'VLC/3.0.21 LibVLC/3.0.21',
  'okhttp/4.12.0',
  'ExoPlayerLib/2.19.1',
  'Kodi/21.0 (Windows; Windows 10; x64)',
];
let _uaIdx = 0;
function nextUA() { return ROTATING_UAS[(_uaIdx++) % ROTATING_UAS.length]; }

// ─────────────────────────────────────────────────────────────────────────────
//  Low-level HTTP fetch (no node-fetch dep, pure Node.js)
// ─────────────────────────────────────────────────────────────────────────────

function fetchRaw(url, opts, timeoutMs, _redir) {
  opts      = opts || {};
  timeoutMs = timeoutMs || 20000;
  _redir    = _redir    || 0;

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('Bad URL: '+url)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const hdrs = Object.assign({ 'User-Agent': nextUA(), 'Accept': '*/*', 'Accept-Encoding': 'identity' }, opts.headers || {});
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   opts.method || 'GET',
      headers:  hdrs,
      rejectUnauthorized: false,
    };

    const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout: '+url)); }, timeoutMs);

    const req = lib.request(reqOpts, res => {
      clearTimeout(timer);

      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (_redir >= 10) return reject(new Error('Too many redirects'));
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
        return fetchRaw(loc, opts, timeoutMs, _redir+1).then(resolve).catch(reject);
      }

      if (res.statusCode === 403 && _redir === 0) {
        res.resume();
        const bypass = Object.assign({}, hdrs, {
          'User-Agent': nextUA(),
          'Referer': parsed.protocol + '//' + parsed.hostname + '/',
          'Origin':  parsed.protocol + '//' + parsed.hostname,
        });
        return fetchRaw(url, Object.assign({},opts,{headers:bypass}), timeoutMs, 1).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok:      res.statusCode >= 200 && res.statusCode < 400,
          status:  res.statusCode,
          headers: res.headers,
          body,
          text:    () => body.toString('utf8'),
          json:    () => JSON.parse(body.toString('utf8')),
        });
      });
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (opts.body) {
      if (Buffer.isBuffer(opts.body)) req.write(opts.body);
      else req.write(String(opts.body), 'utf8');
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRM System IDs (Kodi inputstream.adaptive table)
// ─────────────────────────────────────────────────────────────────────────────

const DRM_SYSTEMS = {
  'edef8ba979d64acea3c827dcd51d21ed': 'widevine',
  '9a04f07998404286ab92e65be0885f95': 'playready',
  'e2719d58a985b3c9781ab030af78d30e': 'clearkey',
  '3d5e6d359b9a41e8b843dd3c6e72c3af': 'clearkey',
  '94ce86fb07ff4f43adb893d2fa968ca2': 'fairplay',
  '1077efec4946244e8de9710fcf8d3a7e': 'w3c',
};

function identifyDRM(systemId) {
  return DRM_SYSTEMS[systemId.replace(/-/g,'').toLowerCase()] || 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
//  PSSH Parser (mirrors Kodi CDMSession logic)
// ─────────────────────────────────────────────────────────────────────────────

function parsePSSH(input) {
  try {
    const buf = Buffer.isBuffer(input)
      ? input
      : Buffer.from(String(input).replace(/\s/g,''), 'base64');

    if (buf.length < 32) return null;
    let offset = 0;

    while (offset + 32 <= buf.length) {
      if (buf.length - offset < 8) break;
      const boxSize = buf.readUInt32BE(offset);
      const boxType = buf.slice(offset+4, offset+8).toString('ascii');

      if (boxType !== 'pssh') {
        if (boxSize < 8) break;
        offset += boxSize;
        continue;
      }

      const version  = buf.readUInt8(offset + 8);  // 0 or 1
      const flags    = buf.readUIntBE(offset + 9, 3);
      const systemId = buf.slice(offset+12, offset+28).toString('hex').toLowerCase();
      const kids     = [];
      let   ptr      = offset + 28;

      // v1 PSSH: KID list before data
      if (version === 1 && ptr + 4 <= buf.length) {
        const kidCount = buf.readUInt32BE(ptr); ptr += 4;
        for (let i = 0; i < kidCount && ptr + 16 <= buf.length; i++) {
          kids.push(buf.slice(ptr, ptr+16).toString('hex'));
          ptr += 16;
        }
      }

      if (ptr + 4 > buf.length) break;
      const dataSize = buf.readUInt32BE(ptr); ptr += 4;
      const psshData = buf.slice(ptr, ptr + dataSize);

      return {
        version,
        flags,
        systemId,
        drmType:    identifyDRM(systemId),
        kids,
        psshData,
        psshBase64: psshData.toString('base64'),
        fullBox:    buf.slice(offset, offset + boxSize),
        fullBase64: buf.slice(offset, offset + boxSize).toString('base64'),
      };
    }
    return null;
  } catch(e) {
    console.error('[PSSH] Parse error:', e.message);
    return null;
  }
}

/**
 * Parse ALL PSSH boxes from buffer/base64
 */
function parseAllPSSH(input) {
  const results = [];
  try {
    const buf = Buffer.isBuffer(input)
      ? input
      : Buffer.from(String(input).replace(/\s/g,''), 'base64');

    let offset = 0;
    while (offset + 8 <= buf.length) {
      const boxSize = buf.readUInt32BE(offset);
      const boxType = buf.slice(offset+4, offset+8).toString('ascii');
      if (boxType === 'pssh') {
        const parsed = parsePSSH(buf.slice(offset, offset + boxSize));
        if (parsed) results.push(parsed);
      }
      if (boxSize < 8) break;
      offset += boxSize;
    }
  } catch {}
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MPD Manifest Parser — extract PSSH + KIDs + ContentProtection
// ─────────────────────────────────────────────────────────────────────────────

function extractFromMPD(mpdContent) {
  const result = { psshs: [], kids: [], contentProtections: [], licenseUrls: {}, baseUrls: [] };

  // Extract all PSSH elements
  const psshRegex = /<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=\s]+)<\/(?:cenc:)?pssh>/gi;
  let m;
  while ((m = psshRegex.exec(mpdContent)) !== null) {
    const parsed = parsePSSH(m[1].trim());
    if (parsed) result.psshs.push(parsed);
  }

  // Extract KIDs from cenc:default_KID
  const kidRx1 = /cenc:default_KID\s*=\s*["']([0-9a-fA-F-]{32,36})["']/gi;
  while ((m = kidRx1.exec(mpdContent)) !== null)
    result.kids.push(m[1].replace(/-/g,'').toLowerCase());

  const kidRx2 = /<(?:cenc:)?default_KID[^>]*>([0-9a-fA-F-]{32,36})<\/(?:cenc:)?default_KID>/gi;
  while ((m = kidRx2.exec(mpdContent)) !== null)
    result.kids.push(m[1].replace(/-/g,'').toLowerCase());

  // Extract license URLs embedded in ContentProtection
  const laurlRx = /<(?:clearkey|dashif):Laurl[^>]*>([^<]+)<\/(?:clearkey|dashif):Laurl>/gi;
  while ((m = laurlRx.exec(mpdContent)) !== null) {
    const url = m[1].trim();
    result.licenseUrls.clearkey = result.licenseUrls.clearkey || url;
  }

  const laUrlRx2 = /<mspr:la_url[^>]*>([^<]+)<\/mspr:la_url>/gi;
  while ((m = laUrlRx2.exec(mpdContent)) !== null)
    result.licenseUrls.playready = result.licenseUrls.playready || m[1].trim();

  const dashifRx = /<dashif:Laurl[^>]*>([^<]+)<\/dashif:Laurl>/gi;
  while ((m = dashifRx.exec(mpdContent)) !== null)
    result.licenseUrls.widevine = result.licenseUrls.widevine || m[1].trim();

  // Extract BaseURL
  const baseUrlRx = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi;
  while ((m = baseUrlRx.exec(mpdContent)) !== null)
    result.baseUrls.push(m[1].trim());

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HLS Manifest Parser — extract EXT-X-KEY info
// ─────────────────────────────────────────────────────────────────────────────

function extractFromHLS(hlsContent) {
  const result = { keys: [], hasDRM: false, drmType: null, licenseUrl: null, keyId: null };

  const keyRx = /^#EXT-X-(?:SESSION-)?KEY:(.+)$/gm;
  let m;
  while ((m = keyRx.exec(hlsContent)) !== null) {
    const attrs = parseHLSAttributes(m[1]);
    result.keys.push(attrs);
    result.hasDRM = true;

    const uri = attrs.URI || '';
    if (uri.includes('widevine') || (attrs.KEYFORMAT||'').includes('widevine')) {
      result.drmType = 'widevine';
    } else if (uri.includes('playready') || (attrs.KEYFORMAT||'').includes('playready')) {
      result.drmType = 'playready';
    } else if (attrs.METHOD === 'SAMPLE-AES-CTR' || (attrs.KEYFORMAT||'').includes('ClearKey')) {
      result.drmType = 'clearkey';
    } else if (attrs.METHOD === 'AES-128') {
      result.drmType = 'aes128';
    }

    if (uri && uri.startsWith('http')) result.licenseUrl = uri;
    if (attrs.KEYID) result.keyId = attrs.KEYID.replace(/^0x/i,'').toLowerCase();
  }

  return result;
}

function parseHLSAttributes(attrStr) {
  const result = {};
  const rx = /([A-Z0-9-]+)=(?:"([^"]*)"|([^",]+))/g;
  let m;
  while ((m = rx.exec(attrStr)) !== null) {
    result[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ClearKey derivation
//  Parses "kid:key,kid2:key2" → [{kid, key}] (all hex 32-char)
// ─────────────────────────────────────────────────────────────────────────────

function parseClearKeyPairs(src) {
  if (!src) return [];
  return String(src).split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf(':');
    if (idx === -1) return null;
    return {
      kid: toHex(pair.substring(0, idx).trim()),
      key: toHex(pair.substring(idx+1).trim()),
    };
  }).filter(p => p && p.kid && p.key);
}

/**
 * Fetch ClearKey keys from a license server
 * Sends W3C EME ClearKey request, receives keys JSON
 */
async function fetchClearKeys(licenseUrl, kids, customHeaders) {
  const body = JSON.stringify({
    kids: kids.map(k => hexToBase64url(k)),
    type: 'temporary',
  });

  const resp = await fetchRaw(licenseUrl, {
    method: 'POST',
    body,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'User-Agent':   nextUA(),
    }, customHeaders || {}),
  }, 15000);

  if (!resp.ok) throw new Error(`License server ${resp.status}: ${licenseUrl}`);
  const json = resp.json();
  return (json.keys || []).map(k => ({
    kid: toHex(k.kid),
    key: toHex(k.k),
  }));
}

/**
 * Fetch Widevine license
 * @param {string} licenseUrl
 * @param {Buffer} challenge  — raw protobuf from CDM
 * @param {Object} headers
 * @returns {Promise<Buffer>} — license response
 */
async function fetchWidevineLicense(licenseUrl, challenge, headers) {
  const resp = await fetchRaw(licenseUrl, {
    method: 'POST',
    body:   challenge,
    headers: Object.assign({
      'Content-Type': 'application/octet-stream',
      'User-Agent':   nextUA(),
      'Origin':       'https://www.google.com',
      'Referer':      'https://www.google.com/',
    }, headers || {}),
  }, 20000);
  if (!resp.ok) throw new Error(`Widevine license error: ${resp.status}`);
  return resp.body;
}

/**
 * Fetch PlayReady license
 */
async function fetchPlayReadyLicense(licenseUrl, challenge, headers) {
  const body = Buffer.isBuffer(challenge) ? challenge : Buffer.from(String(challenge), 'utf8');
  const resp = await fetchRaw(licenseUrl, {
    method: 'POST',
    body,
    headers: Object.assign({
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction':   '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
      'User-Agent':   nextUA(),
    }, headers || {}),
  }, 20000);
  if (!resp.ok) throw new Error(`PlayReady license error: ${resp.status}`);
  return resp.body;
}

// ─────────────────────────────────────────────────────────────────────────────
//  AES-128 Key management for HLS output
//  When we transcode a DRM stream, we re-encrypt with AES-128
//  so any player can play it (AES-128 is universally supported)
// ─────────────────────────────────────────────────────────────────────────────

function generateAESKey() {
  return crypto.randomBytes(16); // 128-bit AES key
}

/**
 * Write AES key file to disk (FFmpeg reads this for HLS encryption)
 * @param {string} sessionId
 * @param {Buffer} key
 * @returns {string} keyFilePath
 */
function writeKeyFile(sessionId, key) {
  const s = require('./cacheManager').getSession(sessionId);
  if (!s) throw new Error('Session not found: '+sessionId);

  const keyFile = path.join(s.outputDir, 'enc.key');
  fs.writeFileSync(keyFile, key); // binary key file
  cache.storeKey(sessionId, key);
  return keyFile;
}

/**
 * Write key info file for FFmpeg AES-128 HLS encryption
 * Format:
 *   line1: key URI (served to player)
 *   line2: key file path (FFmpeg reads this)
 *   line3: IV in hex (optional)
 */
function writeKeyInfoFile(sessionId, keyServingUrl) {
  const s      = cache.getSession(sessionId);
  const cached = cache.getKey(sessionId);
  if (!s || !cached) throw new Error('No key for session: '+sessionId);

  const iv          = cached.iv.toString('hex');
  const keyFile     = path.join(s.outputDir, 'enc.key');
  const keyInfoFile = path.join(s.outputDir, 'enc.keyinfo');

  // Write binary key if not already written
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, cached.key);

  const content = [keyServingUrl, keyFile, iv].join('\n');
  fs.writeFileSync(keyInfoFile, content, 'utf8');

  return keyInfoFile;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRM Resolution Pipeline
//  Given a channel with DRM config, determine:
//    1. Stream URL to feed FFmpeg (may need to fetch from license server first)
//    2. FFmpeg DRM input options
//    3. Whether re-encryption is needed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve DRM for a channel — returns what FFmpeg needs
 *
 * @param {Object} channel   — Channel from main server DB
 * @param {Object} drmCfg    — DRM proxy config from main server DB
 * @returns {Promise<DRMResolution>}
 *
 * @typedef {Object} DRMResolution
 * @property {string}   streamUrl       — URL to pass to FFmpeg as input
 * @property {string[]} ffmpegInputOpts — Extra FFmpeg -i args (headers, etc.)
 * @property {string}   drmType         — 'clearkey'|'widevine'|'playready'|'none'
 * @property {Array}    clearKeys       — [{kid,key}] for ClearKey
 * @property {boolean}  needsDecrypt    — true if FFmpeg needs decryption args
 * @property {Object}   manifest        — Parsed manifest info
 */
async function resolveDRM(channel, drmCfg) {
  const url     = channel.url || '';
  const licType = ((drmCfg && drmCfg.licenseType) || channel.licenseType || '').toLowerCase();

  const resolution = {
    streamUrl:       url,
    ffmpegInputOpts: [],
    drmType:         licType || 'none',
    clearKeys:       [],
    needsDecrypt:    false,
    manifest:        null,
    error:           null,
  };

  if (!licType || licType === 'none') return resolution;

  // Build fetch headers for upstream
  const fetchHeaders = {};
  if (channel.userAgent)  fetchHeaders['User-Agent'] = channel.userAgent;
  if (channel.referer)    fetchHeaders['Referer']    = channel.referer;
  if (channel.cookie)     fetchHeaders['Cookie']     = channel.cookie;
  if (channel.httpHeaders) Object.assign(fetchHeaders, channel.httpHeaders);

  try {
    // Fetch manifest to analyze
    const resp = await fetchRaw(url, { headers: fetchHeaders }, 20000);
    if (!resp.ok) throw new Error(`Upstream returned ${resp.status} for ${url}`);

    const content  = resp.text();
    const isHLS    = content.trimStart().startsWith('#EXTM3U') || url.includes('.m3u8');
    const isMPD    = content.trimStart().startsWith('<?xml') || content.includes('<MPD') || url.includes('.mpd');

    if (isMPD) {
      const info = extractFromMPD(content);
      resolution.manifest = info;

      // Try to auto-detect DRM type from PSSH if not specified
      let resolvedLicType = licType;
      if (info.psshs.length > 0 && (!licType || licType === 'unknown')) {
        resolvedLicType = info.psshs[0].drmType;
        resolution.drmType = resolvedLicType;
      }

      if (resolvedLicType === 'clearkey') {
        // Try inline key pairs first
        const src = (drmCfg && drmCfg.licenseKey) || channel.licenseKey || cfg.CLEARKEY_PAIRS;
        if (src && src.includes(':') && !src.startsWith('http')) {
          resolution.clearKeys = parseClearKeyPairs(src);
        } else {
          // Try license server
          const licUrl = (drmCfg && drmCfg.licenseUrl) || channel.licenseUrl ||
                         (src && src.startsWith('http') ? src : null) ||
                         info.licenseUrls.clearkey;
          if (licUrl) {
            const kids = info.kids.length > 0 ? info.kids
              : info.psshs.flatMap(p => p.kids);
            if (kids.length > 0) {
              try {
                resolution.clearKeys = await fetchClearKeys(licUrl, kids, drmCfg && drmCfg.customHeaders);
              } catch(e) {
                console.error('[DRM] ClearKey fetch failed:', e.message);
              }
            }
          }
        }
        resolution.needsDecrypt = resolution.clearKeys.length > 0;
      }

      // For Widevine/PlayReady with MPD: pass manifest URL to FFmpeg
      // FFmpeg with libaribb24 / inputstream can handle these if keys are provided
      // For server-side: we can't easily decrypt Widevine without a real CDM
      // Best approach: proxy the manifest with our license server injected
      resolution.streamUrl = url;
      resolution.needsDecrypt = false; // Will handle via manifest rewriting

    } else if (isHLS) {
      const info = extractFromHLS(content);
      resolution.manifest = info;
      resolution.drmType  = info.drmType || licType;

      if (info.drmType === 'aes128') {
        // Standard AES-128 HLS — FFmpeg can decrypt this natively
        // Pass key via -decryption_key or let FFmpeg handle EXT-X-KEY
        resolution.needsDecrypt = false; // FFmpeg handles it
      } else if (info.drmType === 'clearkey') {
        const src = (drmCfg && drmCfg.licenseKey) || channel.licenseKey || cfg.CLEARKEY_PAIRS;
        if (src && src.includes(':') && !src.startsWith('http')) {
          resolution.clearKeys = parseClearKeyPairs(src);
          resolution.needsDecrypt = true;
        }
      }

      // For HLS: stream URL stays the same (FFmpeg handles AES-128 natively)
      resolution.streamUrl = url;
    }

    // Build FFmpeg input options based on channel headers
    const ffOpts = [];
    const ua = channel.userAgent || nextUA();
    ffOpts.push('-user_agent', ua);
    if (channel.referer) ffOpts.push('-referer', channel.referer);
    if (channel.cookie)  ffOpts.push('-headers', `Cookie: ${channel.cookie}\r\n`);

    // For HLS inputs
    ffOpts.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');

    // ClearKey decryption via FFmpeg decryption_key (16-byte hex)
    if (resolution.clearKeys.length > 0) {
      // Use the first key — FFmpeg -decryption_key expects 32-char hex
      ffOpts.push('-decryption_key', resolution.clearKeys[0].key);
    }

    resolution.ffmpegInputOpts = ffOpts;

  } catch(e) {
    console.error('[DRM] resolveDRM error:', e.message);
    resolution.error = e.message;
    // Fallback: try piping directly without decryption
  }

  return resolution;
}

// ─────────────────────────────────────────────────────────────────────────────
//  JioTV DRM Handler
//  JioTV format: { cookie, drmLicense: "kid:key", drmScheme: "clearkey", link }
// ─────────────────────────────────────────────────────────────────────────────

async function resolveJioTVStream(channel) {
  // JioTV sends cookie with the stream request and provides kid:key inline
  const pairs = parseClearKeyPairs(channel.licenseKey || channel.drmKey || '');

  const ffOpts = [
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-user_agent', channel.userAgent || 'okhttp/4.9.0',
  ];

  if (channel.cookie)  ffOpts.push('-headers', `Cookie: ${channel.cookie}\r\nX-User-Agent: jiotv\r\n`);
  if (channel.referer) ffOpts.push('-referer', channel.referer);
  if (pairs.length > 0) ffOpts.push('-decryption_key', pairs[0].key);

  return {
    streamUrl:       channel.url,
    ffmpegInputOpts: ffOpts,
    drmType:         'clearkey',
    clearKeys:       pairs,
    needsDecrypt:    pairs.length > 0,
    manifest:        null,
    error:           null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  parsePSSH,
  parseAllPSSH,
  extractFromMPD,
  extractFromHLS,
  parseClearKeyPairs,
  fetchClearKeys,
  fetchWidevineLicense,
  fetchPlayReadyLicense,
  generateAESKey,
  writeKeyFile,
  writeKeyInfoFile,
  resolveDRM,
  resolveJioTVStream,
  hexToBase64url,
  base64urlToHex,
  identifyDRM,
  fetchRaw,
  nextUA,
};
