'use strict';
/**
 * IPTV Playlist Manager — Backend Server v6.0
 * ============================================================
 * ✅ Express 4   — stable wildcards, no path-to-regexp issues
 * ✅ CommonJS    — .cjs extension bypasses "type":"module"
 * ✅ Kodi inputstream.adaptive DRM logic
 *    ├─ ClearKey  : PSSH parse → kid:key → W3C EME JSON
 *    ├─ Widevine  : PSSH extract → binary license proxy
 *    ├─ PlayReady : PRO header → SOAP license proxy
 *    └─ JioTV     : cookie+DRM → playable HLS/DASH
 * ✅ MPD manifest rewriting  — ContentProtection injection
 * ✅ HLS manifest rewriting  — EXT-X-KEY + EXT-X-SESSION-KEY
 * ✅ KODIPROP M3U output     — Kodi-compatible playlist
 * ✅ 403 bypass              — rotating UAs, referer spoofing
 * ✅ Auto-refresh sources
 * ✅ Tamil filter
 * ✅ Persistent JSON DB
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const crypto  = require('crypto');

const app  = express();
const PORT = parseInt(process.env.PORT || '10000', 10);

// ─────────────────────────────────────────────────────────────────────────────
//  Rotating Browser + Player User-Agents
// ─────────────────────────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-S908B Build/SP1A.210812.016)',
  'Mozilla/5.0 (Linux; Android 12; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'VLC/3.0.21 LibVLC/3.0.21',
  'okhttp/4.12.0',
  'ExoPlayerLib/2.19.1',
  'Kodi/21.0 (Windows; Windows 10; x64)',
  'TiviMate/4.7.0',
  'GSE/7.6 (iPad; iOS 15.8; Scale/2.00)',
];
let uaIndex = 0;
function nextUA() { return USER_AGENTS[(uaIndex++) % USER_AGENTS.length]; }

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'] }));
app.options('*', cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Raw body for Widevine/PlayReady binary license challenges
app.use('/proxy/drm-license', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ─────────────────────────────────────────────────────────────────────────────
//  Persistent DB
// ─────────────────────────────────────────────────────────────────────────────
const DB_FILE  = process.env.DB_FILE || path.join(__dirname, 'db.json');
const EMPTY_DB = { channels: [], playlists: [], drmProxies: [], sources: [], groups: [] };

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return JSON.parse(JSON.stringify(EMPTY_DB));
    return Object.assign({}, JSON.parse(JSON.stringify(EMPTY_DB)), JSON.parse(fs.readFileSync(DB_FILE,'utf8')));
  } catch(e) { console.error('[DB] Load error:', e.message); return JSON.parse(JSON.stringify(EMPTY_DB)); }
}
function saveDB(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) { console.error('[DB] Save error:', e.message); return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tamil detector
// ─────────────────────────────────────────────────────────────────────────────
const TAMIL_KW = [
  'tamil','sun tv','vijay tv','zee tamil','kalaignar','raj tv','jaya tv',
  'polimer','captain tv','vendhar','vasanth','adithya','isai aruvi','mozhi',
  'puthuyugam','news7 tamil','news18 tamil','thanthi tv','sathiyam',
  'makkal isai','sirippoli','peppers tv','chutti tv','star vijay',
  'colors tamil','dd tamil','doordarshan tamil','sun music','imayam',
  'murasu','shakthi','gem tv','thirai','vijay super','keetru',
  'puthiya thalaimurai','tamilnadu','madurai','coimbatore','kaveri',
  'rainbow','vikatan','nakkheeran','mega tv','zee thirai','sun news',
];
function ss(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (v == null) return '';
  return String(v).toLowerCase();
}
function isTamil(ch) {
  if (!ch) return false;
  if (ch.isTamil === true) return true;
  const hay = ss(ch.name)+' '+ss(ch.group)+' '+ss(ch.language)+' '+ss(ch.tvgName)+' '+ss(ch.country)+' '+ss(ch.tvgId);
  return TAMIL_KW.some(k => hay.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────────
//  ██████╗ ██████╗ ███╗   ███╗    ██╗      ██████╗  ██████╗ ██╗ ██████╗
//  ██╔══██╗██╔══██╗████╗ ████║    ██║     ██╔═══██╗██╔════╝ ██║██╔════╝
//  ██║  ██║██████╔╝██╔████╔██║    ██║     ██║   ██║██║  ███╗██║██║
//  ██║  ██║██╔══██╗██║╚██╔╝██║    ██║     ██║   ██║██║   ██║██║██║
//  ██████╔╝██║  ██║██║ ╚═╝ ██║    ███████╗╚██████╔╝╚██████╔╝██║╚██████╗
//  ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝    ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝ ╚═════╝
//
//  Kodi inputstream.adaptive DRM Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert hex string to base64url (needed for W3C ClearKey JSON)
 * Handles UUID format (with dashes) and plain hex
 */
function hexToBase64url(hex) {
  if (!hex) return '';
  try {
    const clean = String(hex).replace(/[-\s]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(hex).toString('base64url');
    return Buffer.from(clean, 'hex')
      .toString('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  } catch(e) { return hex; }
}

/**
 * Convert base64url → hex
 */
function base64urlToHex(b64) {
  if (!b64) return '';
  try {
    const pad = b64.replace(/-/g,'+').replace(/_/g,'/');
    const buf = Buffer.from(pad, 'base64');
    return buf.toString('hex');
  } catch(e) { return ''; }
}

/**
 * Parse "kid1:key1,kid2:key2" ClearKey string into W3C keys array
 * Supports: hex, base64url, UUID-with-dashes formats
 */
function parseClearKeyString(src) {
  if (!src || typeof src !== 'string') return [];
  return src.split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(pair => {
      const idx = pair.indexOf(':');
      if (idx === -1) return null;
      let kid = pair.substring(0, idx).trim();
      let key = pair.substring(idx + 1).trim();
      // Detect format and normalize to base64url
      if (/^[0-9a-fA-F-]{32,36}$/.test(kid)) kid = hexToBase64url(kid);
      if (/^[0-9a-fA-F-]{32,36}$/.test(key)) key = hexToBase64url(key);
      return { kty: 'oct', kid, k: key };
    })
    .filter(Boolean);
}

/**
 * Parse PSSH box from base64 or buffer
 * Returns { systemId, psshData, kids[] }
 * Kodi does this in CDMSession to extract KIDs before requesting a license
 */
function parsePSSH(psshBase64OrBuffer) {
  try {
    const buf = Buffer.isBuffer(psshBase64OrBuffer)
      ? psshBase64OrBuffer
      : Buffer.from(String(psshBase64OrBuffer).replace(/\s/g,''), 'base64');

    if (buf.length < 32) return null;

    let offset = 0;
    while (offset < buf.length - 32) {
      const boxSize  = buf.readUInt32BE(offset);
      const boxType  = buf.slice(offset+4, offset+8).toString('ascii');

      if (boxType !== 'pssh') { offset += Math.max(boxSize, 8); continue; }

      const version  = buf.readUInt8(offset + 8);
      const systemId = buf.slice(offset+12, offset+28).toString('hex');

      const kids = [];
      let dataOffset = offset + 28;

      // Version 1 PSSH has KID list
      if (version === 1) {
        const kidCount = buf.readUInt32BE(dataOffset);
        dataOffset += 4;
        for (let i = 0; i < kidCount && dataOffset + 16 <= buf.length; i++) {
          kids.push(buf.slice(dataOffset, dataOffset+16).toString('hex'));
          dataOffset += 16;
        }
      }

      const dataLen  = buf.readUInt32BE(dataOffset);
      dataOffset += 4;
      const psshData = buf.slice(dataOffset, dataOffset + dataLen);

      return { systemId: systemId.toLowerCase(), psshData, psshBase64: psshData.toString('base64'), kids };
    }
    return null;
  } catch(e) {
    console.error('[PSSH] Parse error:', e.message);
    return null;
  }
}

/**
 * Extract all PSSH boxes from an MPD manifest
 * Returns array of { systemId, psshBase64, kids, licenseType }
 */
function extractPSSHFromMPD(mpdContent) {
  const results = [];
  // Match <cenc:pssh>base64</cenc:pssh> and <ContentProtection> pssh data
  const psshRegex = /<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=\s]+)<\/(?:cenc:)?pssh>/gi;
  let m;
  while ((m = psshRegex.exec(mpdContent)) !== null) {
    const parsed = parsePSSH(m[1].trim());
    if (parsed) {
      // Identify DRM system from systemId
      parsed.licenseType = identifyDRMSystem(parsed.systemId);
      results.push(parsed);
    }
  }
  return results;
}

/**
 * Known DRM System IDs (same as Kodi inputstream.adaptive)
 */
const DRM_SYSTEM_IDS = {
  'edef8ba979d64acea3c827dcd51d21ed': 'widevine',
  '9a04f07998404286ab92e65be0885f95': 'playready',
  'e2719d58a985b3c9781ab030af78d30e': 'clearkey',
  '94ce86fb07ff4f43adb893d2fa968ca2': 'fairplay',
  '3d5e6d359b9a41e8b843dd3c6e72c3af': 'clearkey',
  'adb41c242dbf4a6d958b4457c0d27b95': 'nagra',
  '1077efec4946244e8de9710fcf8d3a7e': 'w3c_common',
};

function identifyDRMSystem(systemId) {
  const clean = systemId.replace(/-/g,'').toLowerCase();
  return DRM_SYSTEM_IDS[clean] || 'unknown';
}

/**
 * Extract KIDs from MPD ContentProtection elements
 * Kodi reads cenc:default_KID attribute from <ContentProtection>
 */
function extractKIDsFromMPD(mpdContent) {
  const kids = new Set();
  // cenc:default_KID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  const kidRegex = /cenc:default_KID="([0-9a-fA-F-]{32,36})"/gi;
  let m;
  while ((m = kidRegex.exec(mpdContent)) !== null) {
    kids.add(m[1].replace(/-/g,'').toLowerCase());
  }
  // kid="..." in ContentProtection
  const kidRegex2 = /<(?:cenc:)?default_KID[^>]*>([0-9a-fA-F-]{32,36})<\/(?:cenc:)?default_KID>/gi;
  while ((m = kidRegex2.exec(mpdContent)) !== null) {
    kids.add(m[1].replace(/-/g,'').toLowerCase());
  }
  return Array.from(kids);
}

/**
 * Parse PlayReady PRO (Protection Header Object) from base64
 * Returns the license URL embedded in the PRO XML
 */
function parsePROHeader(proBase64) {
  try {
    const buf = Buffer.from(proBase64, 'base64');
    // PRO: 4 bytes length, 2 bytes count, then records
    // Each record: 2 bytes type, 2 bytes length, N bytes value (UTF-16LE)
    let offset = 6;
    while (offset + 4 < buf.length) {
      const recType = buf.readUInt16LE(offset);
      const recLen  = buf.readUInt16LE(offset + 2);
      offset += 4;
      if (recType === 1) { // License Acquisition URL
        const xml = buf.slice(offset, offset + recLen).toString('utf16le');
        const laMatch = xml.match(/<LA_URL[^>]*>([^<]+)<\/LA_URL>/i);
        if (laMatch) return laMatch[1].trim();
      }
      offset += recLen;
    }
  } catch(e) {}
  return null;
}

/**
 * Rewrite MPD manifest to inject our license server URL
 * Exactly mirrors Kodi inputstream.adaptive's manifest processing
 */
function rewriteMPDForDRM(mpdContent, drmCfg, baseUrl, channelId) {
  const licenseEndpoint = baseUrl + '/proxy/drm-license/' + (drmCfg.id || channelId);
  const licenseType     = (drmCfg.licenseType || 'clearkey').toLowerCase();

  let out = mpdContent;

  if (licenseType === 'clearkey') {
    // Inject ClearKey ContentProtection into every AdaptationSet
    // Use DASHIF ClearKey scheme UUID: e2719d58-a985-b3c9-781a-b030af78d30e
    const kids = extractKIDsFromMPD(mpdContent);

    // Replace existing ClearKey ContentProtection LA_URL
    out = out.replace(
      /<clearkey:Laurl[^>]*>[^<]*<\/clearkey:Laurl>/gi,
      `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licenseEndpoint}</clearkey:Laurl>`
    );

    // If no ContentProtection exists at all, inject before first AdaptationSet
    if (!out.includes('ContentProtection') && out.includes('<AdaptationSet')) {
      const kidAttrs = kids.length > 0
        ? ` cenc:default_KID="${kids[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5')}"`
        : '';
      const inject = [
        `<ContentProtection`,
        ` schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"`,
        ` value="ClearKey1.0"${kidAttrs}>`,
        `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">`,
        licenseEndpoint,
        `</clearkey:Laurl>`,
        `</ContentProtection>`,
      ].join('');
      out = out.replace(/<AdaptationSet/i, inject + '\n<AdaptationSet');
    } else {
      // Update existing Laurl if present
      out = out.replace(
        /(<clearkey:Laurl[^>]*>)[^<]*(<\/clearkey:Laurl>)/gi,
        `$1${licenseEndpoint}$2`
      );
      // Add Laurl inside existing ClearKey ContentProtection if missing
      out = out.replace(
        /(<ContentProtection[^>]*e2719d58[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
        (match, open, inner, close) => {
          if (inner.includes('Laurl')) return match;
          return open + inner +
            `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licenseEndpoint}</clearkey:Laurl>` +
            close;
        }
      );
    }

  } else if (licenseType === 'widevine') {
    // Inject/update Widevine license URL
    out = out.replace(
      /(<ContentProtection[^>]*edef8ba9[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
      (match, open, inner, close) => {
        // Update dashif:laurl
        let newInner = inner.replace(/<dashif:Laurl[^>]*>[^<]*<\/dashif:Laurl>/gi,
          `<dashif:Laurl xmlns:dashif="https://dashif.org" Lic_type="EME-1.0">${licenseEndpoint}</dashif:Laurl>`);
        if (!newInner.includes('dashif:Laurl')) {
          newInner += `<dashif:Laurl xmlns:dashif="https://dashif.org" Lic_type="EME-1.0">${licenseEndpoint}</dashif:Laurl>`;
        }
        return open + newInner + close;
      }
    );

  } else if (licenseType === 'playready') {
    // Inject/update PlayReady license URL
    out = out.replace(
      /(<ContentProtection[^>]*9a04f079[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
      (match, open, inner, close) => {
        let newInner = inner.replace(/<mspr:la_url[^>]*>[^<]*<\/mspr:la_url>/gi,
          `<mspr:la_url>${licenseEndpoint}</mspr:la_url>`);
        if (!newInner.includes('mspr:la_url')) {
          newInner += `<mspr:la_url xmlns:mspr="urn:microsoft:playready">${licenseEndpoint}</mspr:la_url>`;
        }
        return open + newInner + close;
      }
    );
  }

  return out;
}

/**
 * Rewrite HLS manifest to inject EXT-X-KEY for DRM
 * Kodi inputstream.adaptive reads #EXT-X-KEY and #EXT-X-SESSION-KEY
 */
function rewriteHLSForDRM(hlsContent, drmCfg, baseUrl, channelId) {
  const licenseEndpoint = baseUrl + '/proxy/drm-license/' + (drmCfg.id || channelId);
  const licenseType     = (drmCfg.licenseType || 'clearkey').toLowerCase();

  let out = hlsContent;
  const kid = drmCfg.keyId ? drmCfg.keyId.replace(/-/g,'') : '';

  if (licenseType === 'clearkey') {
    // Remove existing EXT-X-KEY lines
    out = out.replace(/^#EXT-X-KEY:.*$/gm, '');
    out = out.replace(/^#EXT-X-SESSION-KEY:.*$/gm, '');
    // Inject ClearKey EXT-X-KEY
    const keyId  = kid ? `,KEYID=0x${kid}` : '';
    const keyLine = `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="${licenseEndpoint}"${keyId}`;
    const sessionLine = `#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="${licenseEndpoint}"${keyId}`;
    // Insert after #EXTM3U or at top
    if (out.includes('#EXTM3U')) {
      out = out.replace('#EXTM3U', '#EXTM3U\n' + sessionLine + '\n' + keyLine);
    } else {
      out = sessionLine + '\n' + keyLine + '\n' + out;
    }

  } else if (licenseType === 'widevine') {
    out = out.replace(/^#EXT-X-KEY:.*$/gm, '');
    const keyLine = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${licenseEndpoint}",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"`;
    if (out.includes('#EXTM3U')) {
      out = out.replace('#EXTM3U', '#EXTM3U\n' + keyLine);
    } else {
      out = keyLine + '\n' + out;
    }

  } else if (licenseType === 'playready') {
    out = out.replace(/^#EXT-X-KEY:.*$/gm, '');
    const keyLine = `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${licenseEndpoint}",KEYFORMAT="com.microsoft.playready",KEYFORMATVERSIONS="1"`;
    if (out.includes('#EXTM3U')) {
      out = out.replace('#EXTM3U', '#EXTM3U\n' + keyLine);
    } else {
      out = keyLine + '\n' + out;
    }
  }

  return out;
}

/**
 * Generate KODIPROP lines for a DRM channel
 * This is exactly what Kodi inputstream.adaptive expects in M3U playlists
 */
function generateKodiProps(ch, baseUrl) {
  const lines = [];
  const licType  = (ch.licenseType || 'clearkey').toLowerCase();
  const licEndpoint = baseUrl + '/proxy/drm-license/' + ch.id;

  // inputstream.adaptive is required for DRM
  lines.push('#KODIPROP:inputstream=inputstream.adaptive');

  if (ch.streamType === 'dash' || (ch.url && ch.url.toLowerCase().includes('.mpd'))) {
    lines.push('#KODIPROP:inputstream.adaptive.manifest_type=mpd');
  } else {
    lines.push('#KODIPROP:inputstream.adaptive.manifest_type=hls');
  }

  if (licType === 'widevine') {
    lines.push('#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha');
    lines.push(`#KODIPROP:inputstream.adaptive.license_key=${licEndpoint}||R{SSM}|`);

  } else if (licType === 'playready') {
    lines.push('#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready');
    lines.push(`#KODIPROP:inputstream.adaptive.license_key=${licEndpoint}||R{SSM}|`);

  } else if (licType === 'clearkey') {
    // ClearKey — embed kid:key directly or use license server
    if (ch.licenseKey && ch.licenseKey.includes(':') && !ch.licenseKey.startsWith('http')) {
      // Inline kid:key format — Kodi can use directly
      lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
      lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.licenseKey}`);
    } else {
      lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
      lines.push(`#KODIPROP:inputstream.adaptive.license_key=${licEndpoint}||R{SSM}|`);
    }
  }

  // User-Agent
  const ua = ch.userAgent || nextUA();
  lines.push(`#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=${encodeURIComponent(ua)}`);

  // Additional stream headers
  if (ch.referer) {
    lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);
  }
  if (ch.cookie) {
    lines.push(`#EXTHTTP:{"Cookie":"${ch.cookie.replace(/"/g,'\\"')}"}`);
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
//  M3U Generator — Always valid #EXTM3U with KODIPROP for DRM
// ─────────────────────────────────────────────────────────────────────────────
function generateM3U(channels, baseUrl, playlistName, kodiMode) {
  const lines = [];
  lines.push(`#EXTM3U x-tvg-url="" playlist-name="${(playlistName || 'IPTV Playlist').replace(/"/g,'')}"`);

  channels.forEach(ch => {
    if (!ch || !ch.id || !ch.url) return;

    const hasDRM = !!(ch.licenseType || ch.licenseKey || ch.isDrm);
    const streamUrl = hasDRM
      ? `${baseUrl}/proxy/drm/${ch.id}`
      : `${baseUrl}/proxy/redirect/${ch.id}`;

    // KODIPROP lines for DRM (Kodi inputstream.adaptive)
    if (hasDRM && kodiMode) {
      generateKodiProps(ch, baseUrl).forEach(l => lines.push(l));
    } else if (hasDRM) {
      // Standard EME-compatible output (for non-Kodi players)
      lines.push(`#KODIPROP:inputstream=inputstream.adaptive`);
      const lt = (ch.licenseType || 'clearkey').toLowerCase();
      if (lt === 'widevine') {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${baseUrl}/proxy/drm-license/${ch.id}||R{SSM}|`);
      } else if (lt === 'playready') {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready`);
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${baseUrl}/proxy/drm-license/${ch.id}||R{SSM}|`);
      } else {
        lines.push(`#KODIPROP:inputstream.adaptive.license_type=clearkey`);
        if (ch.licenseKey && ch.licenseKey.includes(':') && !ch.licenseKey.startsWith('http')) {
          lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.licenseKey}`);
        } else {
          lines.push(`#KODIPROP:inputstream.adaptive.license_key=${baseUrl}/proxy/drm-license/${ch.id}||R{SSM}|`);
        }
      }
    }

    // Headers via EXTVLCOPT
    if (ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${ch.userAgent}`);
    if (ch.referer)   lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);

    // EXTINF attributes
    let attrs = '';
    if (ch.tvgId)    attrs += ` tvg-id="${String(ch.tvgId||'').replace(/"/g,'')}"`;
    attrs += ` tvg-name="${String(ch.tvgName||ch.name||'').replace(/"/g,'')}"`;
    if (ch.logo)     attrs += ` tvg-logo="${String(ch.logo||'').replace(/"/g,'')}"`;
    attrs += ` group-title="${String(ch.group||'Uncategorized').replace(/"/g,'')}"`;
    if (ch.language) attrs += ` tvg-language="${String(ch.language||'').replace(/"/g,'')}"`;
    if (ch.country)  attrs += ` tvg-country="${String(ch.country||'').replace(/"/g,'')}"`;

    const name = String(ch.name || 'Unknown Channel').replace(/,/g,' ');
    lines.push(`#EXTINF:-1${attrs},${name}`);
    lines.push(streamUrl);
  });

  return lines.join('\r\n') + '\r\n';
}

function filterChannels(pl, allChannels) {
  return allChannels
    .filter(ch => {
      if (!ch) return false;
      const active = ch.enabled !== false || ch.isActive === true;
      if (!active) return false;
      if (pl.tamilOnly && !isTamil(ch)) return false;
      if (pl.includeGroups && pl.includeGroups.length > 0 && !pl.includeGroups.includes(ch.group)) return false;
      if (pl.excludeGroups && pl.excludeGroups.includes(ch.group)) return false;
      return true;
    })
    .sort((a,b) => (a.order||0) - (b.order||0));
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP fetch with 403-bypass + redirect follow
// ─────────────────────────────────────────────────────────────────────────────
function buildHeaders(ch, overrides) {
  ch = ch || {}; overrides = overrides || {};
  const hdrs = {};
  if (ch.httpHeaders) Object.assign(hdrs, ch.httpHeaders);
  hdrs['User-Agent']      = ch.userAgent || overrides['User-Agent'] || nextUA();
  hdrs['Accept']          = overrides['Accept'] || '*/*';
  hdrs['Accept-Language'] = 'en-US,en;q=0.9';
  hdrs['Accept-Encoding'] = 'identity';
  hdrs['Connection']      = 'keep-alive';
  if (ch.referer) { hdrs['Referer'] = ch.referer; hdrs['Origin'] = ch.referer.replace(/\/[^/]*$/,''); }
  if (ch.cookie)  { hdrs['Cookie'] = ch.cookie; }
  Object.assign(hdrs, overrides);
  return hdrs;
}

function safeFetch(targetUrl, options, timeoutMs, _redirect) {
  options   = options   || {};
  timeoutMs = timeoutMs || 20000;
  _redirect = _redirect || 0;

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('Invalid URL: ' + targetUrl)); }

    const lib    = parsed.protocol === 'https:' ? https : http;
    const hdrs   = Object.assign({ 'User-Agent': nextUA(), 'Accept': '*/*' }, options.headers || {});
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     (parsed.pathname||'/') + (parsed.search||''),
      method:   options.method || 'GET',
      headers:  hdrs,
      rejectUnauthorized: false,
    };

    const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout: '+targetUrl)); }, timeoutMs);

    const req = lib.request(reqOpts, res => {
      clearTimeout(timer);

      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        if (_redirect >= 10) return reject(new Error('Too many redirects'));
        res.resume();
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
        return safeFetch(loc, options, timeoutMs, _redirect+1).then(resolve).catch(reject);
      }

      // 403 retry with bypass headers
      if (res.statusCode === 403 && _redirect === 0) {
        res.resume();
        const bypass = Object.assign({}, hdrs, {
          'User-Agent':      nextUA(),
          'Referer':         parsed.protocol+'//'+parsed.hostname+'/',
          'Origin':          parsed.protocol+'//'+parsed.hostname,
          'X-Forwarded-For': '8.8.8.8',
          'Cache-Control':   'no-cache',
        });
        return safeFetch(targetUrl, Object.assign({},options,{headers:bypass}), timeoutMs, 1).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok:         res.statusCode >= 200 && res.statusCode < 400,
          status:     res.statusCode,
          statusText: res.statusMessage || String(res.statusCode),
          headers: {
            raw: res.headers,
            get: k => res.headers[String(k).toLowerCase()] || null,
          },
          body,
          text:        () => Promise.resolve(body.toString('utf8')),
          json:        () => Promise.resolve(JSON.parse(body.toString('utf8'))),
          arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength)),
        });
      });
      res.on('error', reject);
    });

    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Socket timeout')); });

    if (options.body) {
      if (Buffer.isBuffer(options.body)) req.write(options.body);
      else if (typeof options.body === 'string') req.write(options.body, 'utf8');
      else req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

function pipeStream(targetUrl, headers, res, _redirect) {
  _redirect = _redirect || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('Invalid URL: '+targetUrl)); }

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
        if (_redirect < 10) return pipeStream(loc, headers, res, _redirect+1).then(resolve).catch(reject);
      }
      const ct = upstream.headers['content-type'] || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      res.status(upstream.statusCode === 200 ? 200 : upstream.statusCode);
      upstream.pipe(res);
      upstream.on('end',   resolve);
      upstream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status:'ok', uptime:process.uptime(), version:'6.0.0' }));

// ─────────────────────────────────────────────────────────────────────────────
//  STATS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db   = loadDB();
  const chs  = db.channels || [];
  const BASE = req.protocol + '://' + req.get('host');
  res.json({
    serverVersion:  '6.0.0',
    uptime:         Math.floor(process.uptime()),
    nodeVersion:    process.version,
    channels:       chs.length,
    activeChannels: chs.filter(c => c.enabled !== false).length,
    tamilChannels:  chs.filter(isTamil).length,
    drmChannels:    chs.filter(c => c.licenseType||c.isDrm).length,
    groups:         new Set(chs.map(c => c.group||'Uncategorized')).size,
    playlists:      (db.playlists||[]).length,
    sources:        (db.sources||[]).length,
    drmProxies:     (db.drmProxies||[]).length,
    drmEngine:      'Kodi inputstream.adaptive v6',
    playlistUrls: (db.playlists||[]).map(p => {
      const cs = filterChannels(p, chs);
      return { id:p.id, name:p.name, url:BASE+'/api/playlist/'+p.id+'.m3u',
               channels:cs.length, tamil:cs.filter(isTamil).length };
    }),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PLAYLIST ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/playlist/:id.m3u', (req, res) => {
  const db   = loadDB();
  const pl   = (db.playlists||[]).find(p => p.id === req.params.id);
  const BASE = req.protocol + '://' + req.get('host');
  const kodi = req.query.kodi === '1';

  if (!pl) {
    res.setHeader('Content-Type','application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin','*');
    return res.send('#EXTM3U\r\n#EXTINF:-1,Playlist Not Found\r\nhttp://localhost/notfound\r\n');
  }

  const channels = filterChannels(pl, db.channels||[]);
  const m3u      = generateM3U(channels, BASE, pl.name, kodi);
  console.log(`[Playlist] ${pl.name} → ${channels.length} ch | Tamil:${channels.filter(isTamil).length} | DRM:${channels.filter(c=>c.licenseType).length}`);

  res.setHeader('Content-Type','application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.setHeader('Content-Disposition',`inline; filename="${(pl.name||'playlist').replace(/[^a-z0-9_\-]/gi,'_')}.m3u"`);
  res.send(m3u);
});

app.get('/api/playlist/all.m3u', (req, res) => {
  const db   = loadDB();
  const BASE = req.protocol + '://' + req.get('host');
  const chs  = (db.channels||[]).filter(c => c.enabled !== false);
  res.setHeader('Content-Type','application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-cache');
  res.send(generateM3U(chs, BASE, 'All Channels', req.query.kodi==='1'));
});

app.get('/api/playlist/tamil.m3u', (req, res) => {
  const db   = loadDB();
  const BASE = req.protocol + '://' + req.get('host');
  const chs  = (db.channels||[]).filter(c => c.enabled !== false && isTamil(c));
  res.setHeader('Content-Type','application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-cache');
  res.send(generateM3U(chs, BASE, 'Tamil Channels', req.query.kodi==='1'));
});

app.get('/api/playlists', (req, res) => {
  const db   = loadDB();
  const BASE = req.protocol + '://' + req.get('host');
  res.json((db.playlists||[]).map(pl => {
    const cs = filterChannels(pl, db.channels||[]);
    return Object.assign({}, pl, { m3uUrl:BASE+'/api/playlist/'+pl.id+'.m3u', channelCount:cs.length, tamilCount:cs.filter(isTamil).length });
  }));
});
app.get('/api/playlists/:id', (req, res) => {
  const db   = loadDB();
  const BASE = req.protocol + '://' + req.get('host');
  const pl   = (db.playlists||[]).find(p => p.id===req.params.id);
  if (!pl) return res.status(404).json({error:'Not found'});
  const cs = filterChannels(pl, db.channels||[]);
  res.json(Object.assign({}, pl, { m3uUrl:BASE+'/api/playlist/'+pl.id+'.m3u', channelCount:cs.length }));
});
app.post('/api/playlists', (req, res) => {
  const db   = loadDB();
  const BASE = req.protocol + '://' + req.get('host');
  const pl   = Object.assign({}, req.body, { id:'pl_'+Date.now(), createdAt:new Date().toISOString() });
  db.playlists = (db.playlists||[]).concat([pl]);
  saveDB(db);
  res.json(Object.assign({}, pl, { m3uUrl:BASE+'/api/playlist/'+pl.id+'.m3u' }));
});
app.put('/api/playlists/:id', (req, res) => {
  const db = loadDB(); let found=false;
  db.playlists = (db.playlists||[]).map(p => { if(p.id!==req.params.id) return p; found=true; return Object.assign({},p,req.body,{id:p.id,updatedAt:new Date().toISOString()}); });
  if(!found) return res.status(404).json({error:'Not found'});
  saveDB(db); res.json({ok:true});
});
app.delete('/api/playlists/:id', (req, res) => {
  const db = loadDB();
  db.playlists = (db.playlists||[]).filter(p => p.id!==req.params.id);
  saveDB(db); res.json({ok:true});
});

// ─────────────────────────────────────────────────────────────────────────────
//  CHANNELS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const db = loadDB();
  let chs  = db.channels || [];
  if (req.query.group)       chs = chs.filter(c => c.group===req.query.group);
  if (req.query.tamil==='1') chs = chs.filter(isTamil);
  if (req.query.active==='1')chs = chs.filter(c => c.enabled!==false);
  if (req.query.drm==='1')   chs = chs.filter(c => c.licenseType||c.isDrm);
  res.json(chs);
});
app.get('/api/channels/:id', (req, res) => {
  const db = loadDB();
  const ch = (db.channels||[]).find(c => c.id===req.params.id);
  if (!ch) return res.status(404).json({error:'Not found'});
  res.json(ch);
});
app.post('/api/channels', (req, res) => {
  const db = loadDB();
  const ch = Object.assign({}, req.body, { id:req.body.id||('ch_'+Date.now()), order:(db.channels||[]).length, enabled:true, isTamil:isTamil(req.body) });
  db.channels = (db.channels||[]).concat([ch]);
  saveDB(db); res.json(ch);
});
app.put('/api/channels/:id', (req, res) => {
  const db = loadDB(); let found=false;
  db.channels = (db.channels||[]).map(c => { if(c.id!==req.params.id) return c; found=true; const u=Object.assign({},c,req.body,{id:c.id}); u.isTamil=isTamil(u); return u; });
  if(!found) return res.status(404).json({error:'Not found'});
  saveDB(db); res.json({ok:true});
});
app.delete('/api/channels/:id', (req, res) => {
  const db = loadDB();
  db.channels   = (db.channels||[]).filter(c => c.id!==req.params.id);
  db.drmProxies = (db.drmProxies||[]).filter(d => d.channelId!==req.params.id);
  saveDB(db); res.json({ok:true});
});
app.post('/api/channels/bulk/toggle', (req, res) => {
  const ids=Array.isArray(req.body.ids)?req.body.ids:[], enabled=!!req.body.enabled;
  const db = loadDB();
  db.channels = (db.channels||[]).map(c => ids.includes(c.id)?Object.assign({},c,{enabled,isActive:enabled}):c);
  saveDB(db); res.json({ok:true,updated:ids.length});
});
app.delete('/api/channels/bulk/delete', (req, res) => {
  const ids=Array.isArray(req.body.ids)?req.body.ids:[];
  const db = loadDB();
  db.channels = (db.channels||[]).filter(c => !ids.includes(c.id));
  saveDB(db); res.json({ok:true,deleted:ids.length});
});

// ─────────────────────────────────────────────────────────────────────────────
//  GROUPS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  const db = loadDB(); const chs = db.channels||[];
  const names = Array.from(new Set(chs.map(c => c.group||'Uncategorized')));
  res.json(names.map(name => {
    const saved = (db.groups||[]).find(g => g.name===name);
    return { name, count:chs.filter(c=>(c.group||'Uncategorized')===name).length,
             tamilCount:chs.filter(c=>(c.group||'Uncategorized')===name&&isTamil(c)).length,
             isActive:saved?(saved.isActive!==false):true };
  }));
});
app.put('/api/groups/:name', (req, res) => {
  const db=loadDB(), name=decodeURIComponent(req.params.name);
  if (req.body.newName && req.body.newName!==name)
    db.channels=(db.channels||[]).map(c=>(c.group||'Uncategorized')===name?Object.assign({},c,{group:req.body.newName}):c);
  const existing=(db.groups||[]).find(g=>g.name===name);
  db.groups = existing
    ? (db.groups||[]).map(g=>g.name===name?Object.assign({},g,req.body):g)
    : (db.groups||[]).concat([Object.assign({name},req.body)]);
  saveDB(db); res.json({ok:true});
});
app.delete('/api/groups/:name', (req, res) => {
  const db=loadDB(), name=decodeURIComponent(req.params.name);
  db.channels=(db.channels||[]).filter(c=>(c.group||'Uncategorized')!==name);
  db.groups  =(db.groups||[]).filter(g=>g.name!==name);
  saveDB(db); res.json({ok:true});
});

// ─────────────────────────────────────────────────────────────────────────────
//  SOURCES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/sources', (_req, res) => { res.json(loadDB().sources||[]); });
app.post('/api/sources', (req, res) => {
  const db=loadDB();
  const src=Object.assign({},req.body,{id:req.body.id||('src_'+Date.now()),createdAt:new Date().toISOString()});
  db.sources=(db.sources||[]).concat([src]); saveDB(db); res.json(src);
});
app.put('/api/sources/:id', (req, res) => {
  const db=loadDB();
  db.sources=(db.sources||[]).map(s=>s.id===req.params.id?Object.assign({},s,req.body,{id:s.id}):s);
  saveDB(db); res.json({ok:true});
});
app.delete('/api/sources/:id', (req, res) => {
  const db=loadDB();
  db.sources=(db.sources||[]).filter(s=>s.id!==req.params.id);
  saveDB(db); res.json({ok:true});
});

// ─────────────────────────────────────────────────────────────────────────────
//  DRM PROXIES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/drm', (_req, res) => { res.json(loadDB().drmProxies||[]); });
app.post('/api/drm', (req, res) => {
  const db=loadDB(), BASE=req.protocol+'://'+req.get('host');
  const id='drm_'+Date.now();
  const proxy=Object.assign({},req.body,{
    id, isActive:true,
    proxyUrl:        BASE+'/proxy/drm/'+req.body.channelId,
    licenseEndpoint: BASE+'/proxy/drm-license/'+id,
    createdAt:       new Date().toISOString(),
  });
  db.drmProxies=(db.drmProxies||[]).concat([proxy]); saveDB(db); res.json(proxy);
});
app.put('/api/drm/:id', (req, res) => {
  const db=loadDB();
  db.drmProxies=(db.drmProxies||[]).map(d=>d.id===req.params.id?Object.assign({},d,req.body,{id:d.id}):d);
  saveDB(db); res.json({ok:true});
});
app.delete('/api/drm/:id', (req, res) => {
  const db=loadDB();
  db.drmProxies=(db.drmProxies||[]).filter(d=>d.id!==req.params.id);
  saveDB(db); res.json({ok:true});
});

// ─────────────────────────────────────────────────────────────────────────────
//  SYNC
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data||typeof data!=='object') return res.status(400).json({error:'Invalid payload'});
    if (Array.isArray(data.channels))
      data.channels = data.channels.map(ch => Object.assign({},ch,{isTamil:isTamil(ch)}));
    const ok = saveDB(Object.assign({},EMPTY_DB,data));
    console.log(`[Sync] ch=${(data.channels||[]).length} pl=${(data.playlists||[]).length} drm=${(data.drmProxies||[]).length} src=${(data.sources||[]).length}`);
    res.json({ ok, synced:{ channels:(data.channels||[]).length, playlists:(data.playlists||[]).length, drmProxies:(data.drmProxies||[]).length, sources:(data.sources||[]).length } });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CORS PROXY
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/cors', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');
  safeFetch(targetUrl, { headers: { 'User-Agent':nextUA(), 'Accept':'*/*', 'Referer':req.query.referer||'' } }, 25000)
  .then(resp => {
    res.setHeader('Content-Type', resp.headers.get('content-type')||'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','no-cache');
    res.send(resp.body);
  })
  .catch(e => res.status(502).send('Fetch error: '+e.message));
});

// ─────────────────────────────────────────────────────────────────────────────
//  STREAM REDIRECT PROXY
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/redirect/:id', (req, res) => {
  const db = loadDB();
  const ch = (db.channels||[]).find(c => c.id===req.params.id);
  if (!ch||!ch.url) return res.status(404).send('Channel not found');

  const headers  = buildHeaders(ch, {});
  const needsPipe= !!(ch.referer||ch.cookie||ch.userAgent||(ch.httpHeaders&&Object.keys(ch.httpHeaders).length>0));

  if (needsPipe) {
    pipeStream(ch.url, headers, res).catch(e => {
      if (!res.headersSent) res.status(502).send('Stream error: '+e.message);
    });
  } else {
    res.redirect(302, ch.url);
  }
});

app.get('/proxy/stream/:id', (req, res) => {
  const db = loadDB();
  const ch = (db.channels||[]).find(c => c.id===req.params.id);
  if (!ch||!ch.url) return res.status(404).send('Not found');
  pipeStream(ch.url, buildHeaders(ch,{}), res)
    .catch(e => { if(!res.headersSent) res.status(502).send('Upstream error: '+e.message); });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ██████╗ ██████╗ ███╗   ███╗    ██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗
//  ██╔══██╗██╔══██╗████╗ ████║    ██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝
//  ██║  ██║██████╔╝██╔████╔██║    ██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝
//  ██║  ██║██╔══██╗██║╚██╔╝██║    ██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝
//  ██████╔╝██║  ██║██║ ╚═╝ ██║    ██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║
//  ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝    ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝
//
//  Kodi inputstream.adaptive DRM Stream Proxy
// ─────────────────────────────────────────────────────────────────────────────
app.get('/proxy/drm/:id', (req, res) => {
  const db  = loadDB();
  const ch  = (db.channels||[]).find(c => c.id===req.params.id);
  if (!ch) return res.status(404).send('Channel not found');

  // Resolve DRM config — explicit record OR inline channel fields
  let drmCfg = (db.drmProxies||[]).find(d => d.channelId===ch.id && d.isActive!==false);
  if (!drmCfg && (ch.licenseType || ch.licenseKey)) {
    drmCfg = {
      id:          ch.id,
      channelId:   ch.id,
      licenseType: ch.licenseType || 'clearkey',
      licenseKey:  ch.licenseKey  || ch.drmKey || '',
      licenseUrl:  ch.licenseUrl  || (ch.licenseKey && ch.licenseKey.startsWith('http') ? ch.licenseKey : ''),
      keyId:       ch.keyId       || ch.drmKeyId || '',
      key:         ch.key         || '',
      customHeaders: ch.httpHeaders || {},
      isActive:    true,
    };
  }

  // No DRM — just redirect/pipe
  if (!drmCfg) return res.redirect(302, ch.url);

  const headers  = buildHeaders(ch, {});
  const BASE     = req.protocol + '://' + req.get('host');
  const licType  = (drmCfg.licenseType || 'clearkey').toLowerCase();

  // ── Determine manifest type ────────────────────────────────────────────────
  const urlLower  = (ch.url || '').toLowerCase();
  const isMPD     = urlLower.includes('.mpd')  || urlLower.includes('/dash/') || urlLower.includes('manifest.mpd');
  const isHLS     = urlLower.includes('.m3u8') || urlLower.includes('/hls/');

  // ── Fetch manifest, rewrite it, serve ─────────────────────────────────────
  safeFetch(ch.url, { headers }, 20000)
  .then(upstream => {
    if (!upstream.ok) {
      return res.status(upstream.status).send('Upstream: '+upstream.status);
    }

    const ct          = upstream.headers.get('content-type') || '';
    const manifestStr = upstream.body.toString('utf8');
    const isMPDContent= ct.includes('dash') || isMPD || manifestStr.trimStart().startsWith('<?xml') || manifestStr.includes('<MPD');
    const isHLSContent= ct.includes('mpegurl') || isHLS || manifestStr.trimStart().startsWith('#EXTM3U');

    if (isMPDContent) {
      // ── DASH/MPD: Rewrite ContentProtection + PSSH ──────────────────────
      const psshs   = extractPSSHFromMPD(manifestStr);
      const kids    = extractKIDsFromMPD(manifestStr);

      console.log(`[DRM MPD] ${ch.name} | type=${licType} | KIDs:${kids.length} | PSSHs:${psshs.length}`);

      // If we found PSSH, store KIDs for later license matching
      if (kids.length > 0 && drmCfg) {
        const db2 = loadDB();
        db2.drmProxies = (db2.drmProxies||[]).map(d =>
          d.id===drmCfg.id ? Object.assign({},d,{detectedKids:kids}) : d
        );
        // Also update inline channel record
        db2.channels = (db2.channels||[]).map(c =>
          c.id===ch.id ? Object.assign({},c,{detectedKids:kids}) : c
        );
        saveDB(db2);
      }

      const rewritten = rewriteMPDForDRM(manifestStr, drmCfg, BASE, ch.id);

      res.setHeader('Content-Type','application/dash+xml; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin','*');
      res.setHeader('Cache-Control','no-cache');
      return res.send(rewritten);
    }

    if (isHLSContent) {
      // ── HLS: Inject EXT-X-KEY ──────────────────────────────────────────
      console.log(`[DRM HLS] ${ch.name} | type=${licType}`);
      const rewritten = rewriteHLSForDRM(manifestStr, drmCfg, BASE, ch.id);
      res.setHeader('Content-Type','application/x-mpegurl; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin','*');
      res.setHeader('Cache-Control','no-cache');
      return res.send(rewritten);
    }

    // ── Raw stream (TS/MP4) — pipe directly ───────────────────────────────
    console.log(`[DRM Raw] ${ch.name} | ct=${ct}`);
    res.setHeader('Content-Type', ct || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','no-cache');
    return res.send(upstream.body);
  })
  .catch(e => {
    console.error(`[DRM] Fetch error [${ch.name}]:`, e.message);
    if (!res.headersSent) res.redirect(302, ch.url);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DRM LICENSE ENDPOINT
//  Kodi inputstream.adaptive sends license challenge here
//  Route: POST /proxy/drm-license/:id
// ─────────────────────────────────────────────────────────────────────────────
app.post('/proxy/drm-license/:id', (req, res) => {
  const db  = loadDB();
  const id  = req.params.id;

  // Resolve DRM config
  let drmCfg = (db.drmProxies||[]).find(d => (d.id===id||d.channelId===id) && d.isActive!==false);
  if (!drmCfg) {
    const ch = (db.channels||[]).find(c => c.id===id);
    if (ch && (ch.licenseType||ch.licenseKey)) {
      drmCfg = {
        id: ch.id, channelId: ch.id,
        licenseType: ch.licenseType || 'clearkey',
        licenseKey:  ch.licenseKey  || ch.drmKey || '',
        licenseUrl:  ch.licenseUrl  || (ch.licenseKey&&ch.licenseKey.startsWith('http')?ch.licenseKey:''),
        keyId:       ch.keyId       || ch.drmKeyId || '',
        key:         ch.key         || '',
        customHeaders: ch.httpHeaders || {},
      };
    }
  }

  if (!drmCfg) return res.status(404).json({ error: 'DRM config not found: '+id });

  const licType = (drmCfg.licenseType || 'clearkey').toLowerCase();

  // ── ClearKey License (W3C EME JSON) ───────────────────────────────────────
  if (licType === 'clearkey' || licType === 'clear-key') {
    let keys = [];

    const src = drmCfg.licenseUrl || drmCfg.licenseKey || '';

    if (src && src.includes(':') && !src.startsWith('http')) {
      // "kid:key,kid2:key2" inline format — direct key delivery
      keys = parseClearKeyString(src);

    } else if (drmCfg.keyId && (drmCfg.key || drmCfg.licenseKey)) {
      // Separate keyId + key fields
      keys = [{
        kty: 'oct',
        kid: hexToBase64url(drmCfg.keyId),
        k:   hexToBase64url(drmCfg.key || drmCfg.licenseKey),
      }];

    } else if (src && src.startsWith('http')) {
      // ClearKey license server URL — proxy the request
      const challenge = Buffer.isBuffer(req.body) ? req.body
        : Buffer.from(typeof req.body==='string' ? req.body : JSON.stringify(req.body||{}));

      safeFetch(src, {
        method:  'POST',
        body:    challenge,
        headers: Object.assign({ 'Content-Type':'application/json', 'User-Agent':nextUA() }, drmCfg.customHeaders||{}),
      }, 15000)
      .then(resp => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(resp.body);
      })
      .catch(e => res.status(502).json({ error: 'ClearKey license proxy error: '+e.message }));
      return;

    } else {
      // Try to parse challenge body for KID and look up in known pairs
      try {
        let challenge;
        if (Buffer.isBuffer(req.body)) challenge = JSON.parse(req.body.toString('utf8'));
        else if (typeof req.body === 'object') challenge = req.body;

        if (challenge && Array.isArray(challenge.kids)) {
          const pairs = parseClearKeyString(drmCfg.licenseKey||drmCfg.key||'');
          const pairMap = {};
          pairs.forEach(p => { pairMap[p.kid] = p; });

          keys = challenge.kids
            .map(kid => {
              // Try direct match, then hex variants
              if (pairMap[kid]) return pairMap[kid];
              const hexKid = base64urlToHex(kid);
              const found  = pairs.find(p => base64urlToHex(p.kid) === hexKid);
              return found || null;
            })
            .filter(Boolean);
        }
      } catch(e) { /* ignore parse errors */ }

      if (keys.length === 0) {
        keys = parseClearKeyString(drmCfg.licenseKey || drmCfg.key || '');
      }
    }

    console.log(`[DRM License ClearKey] id=${id} keys=${keys.length}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys, type: 'temporary' });
  }

  // ── Widevine License Proxy ─────────────────────────────────────────────────
  // Kodi sends binary Widevine challenge (protobuf) — we forward to real license server
  if (licType === 'widevine') {
    const licUrl = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    if (!licUrl || !licUrl.startsWith('http')) {
      return res.status(400).json({ error: 'Widevine license URL not configured' });
    }

    // Extract challenge — Kodi sends raw binary or base64
    let challenge;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      challenge = req.body;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      try { challenge = Buffer.from(req.body, 'base64'); }
      catch(e) { challenge = Buffer.from(req.body, 'utf8'); }
    } else {
      challenge = Buffer.alloc(0);
    }

    // Build Widevine request headers (Kodi inputstream.adaptive format)
    const wvHeaders = Object.assign({
      'Content-Type':  'application/octet-stream',
      'User-Agent':    nextUA(),
      'Origin':        'https://www.google.com',
      'Referer':       'https://www.google.com/',
    }, drmCfg.customHeaders || {});

    console.log(`[DRM License Widevine] id=${id} url=${licUrl} challenge=${challenge.length}B`);

    safeFetch(licUrl, { method:'POST', body:challenge, headers:wvHeaders }, 20000)
    .then(resp => {
      if (!resp.ok) {
        console.error(`[Widevine] License server error: ${resp.status}`);
        return res.status(resp.status).send(`Widevine license server: ${resp.status}`);
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(resp.body);
    })
    .catch(e => {
      console.error('[Widevine License]', e.message);
      res.status(502).json({ error: 'Widevine license error: '+e.message });
    });
    return;
  }

  // ── PlayReady License Proxy ────────────────────────────────────────────────
  // Kodi sends SOAP XML challenge — forward to PlayReady license server
  if (licType === 'playready') {
    const licUrl = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    if (!licUrl || !licUrl.startsWith('http')) {
      return res.status(400).json({ error: 'PlayReady license URL not configured' });
    }

    let challenge;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      challenge = req.body;
    } else {
      challenge = Buffer.from(String(req.body||''), 'utf8');
    }

    const prHeaders = Object.assign({
      'Content-Type':  'text/xml; charset=utf-8',
      'SOAPAction':    '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
      'User-Agent':    nextUA(),
    }, drmCfg.customHeaders || {});

    console.log(`[DRM License PlayReady] id=${id} url=${licUrl} challenge=${challenge.length}B`);

    safeFetch(licUrl, { method:'POST', body:challenge, headers:prHeaders }, 20000)
    .then(resp => {
      const ct = resp.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(resp.body);
    })
    .catch(e => {
      console.error('[PlayReady License]', e.message);
      res.status(502).json({ error: 'PlayReady license error: '+e.message });
    });
    return;
  }

  // ── FairPlay License Proxy ─────────────────────────────────────────────────
  if (licType === 'fairplay') {
    const licUrl = drmCfg.licenseUrl || '';
    if (!licUrl) return res.status(400).json({ error: 'FairPlay license URL not configured' });

    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body||''));

    safeFetch(licUrl, {
      method: 'POST',
      body:   challenge,
      headers: Object.assign({ 'Content-Type':'application/octet-stream', 'User-Agent':nextUA() }, drmCfg.customHeaders||{}),
    }, 20000)
    .then(resp => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(resp.body);
    })
    .catch(e => res.status(502).json({ error: 'FairPlay error: '+e.message }));
    return;
  }

  res.status(400).json({ error: 'Unsupported DRM type: '+licType });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PSSH INFO endpoint — returns parsed PSSH info for a channel
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/drm/pssh/:id', (req, res) => {
  const db  = loadDB();
  const ch  = (db.channels||[]).find(c => c.id===req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });

  safeFetch(ch.url, { headers: buildHeaders(ch,{}) }, 20000)
  .then(upstream => {
    const content = upstream.body.toString('utf8');
    const psshs   = extractPSSHFromMPD(content);
    const kids    = extractKIDsFromMPD(content);
    res.json({
      channelId: ch.id,
      channelName: ch.name,
      url: ch.url,
      psshs: psshs.map(p => ({ systemId:p.systemId, licenseType:p.licenseType, kids:p.kids, psshBase64:p.psshBase64 })),
      kids,
      manifestSnippet: content.substring(0,500),
    });
  })
  .catch(e => res.status(502).json({ error: e.message }));
});

// ─────────────────────────────────────────────────────────────────────────────
//  DB EXPORT / IMPORT
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/db/export', (_req, res) => {
  const db = loadDB();
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition',`attachment; filename="iptv-db-${Date.now()}.json"`);
  res.json(db);
});
app.post('/api/db/import', (req, res) => {
  try {
    const data = req.body;
    if (!data||typeof data!=='object') return res.status(400).json({error:'Invalid JSON'});
    saveDB(data);
    res.json({ ok:true, channels:(data.channels||[]).length });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-REFRESH SOURCES
// ─────────────────────────────────────────────────────────────────────────────
function doAutoRefresh() {
  const db      = loadDB();
  const sources = (db.sources||[]).filter(s => s.autoRefresh && s.url && (s.refreshInterval||0)>0);
  if (!sources.length) return;

  sources.forEach(src => {
    const lastRefresh = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    const intervalMs  = (src.refreshInterval||30) * 60 * 1000;
    if (Date.now() - lastRefresh < intervalMs) return;

    console.log('[AutoRefresh]', src.name, src.url);
    safeFetch(src.url, { headers:{'User-Agent':nextUA()} }, 25000)
    .then(resp => {
      const freshDB = loadDB();
      freshDB.sources = (freshDB.sources||[]).map(s =>
        s.id!==src.id ? s : Object.assign({},s,{ lastRefreshed:new Date().toISOString(), status:resp.ok?'success':'error', statusCode:resp.status })
      );
      saveDB(freshDB);
    })
    .catch(e => {
      const freshDB = loadDB();
      freshDB.sources = (freshDB.sources||[]).map(s =>
        s.id!==src.id ? s : Object.assign({},s,{ status:'error', errorMessage:e.message })
      );
      saveDB(freshDB);
    });
  });
}

setInterval(doAutoRefresh, 60*1000);
setTimeout(doAutoRefresh, 8*1000);

// ─────────────────────────────────────────────────────────────────────────────
//  SPA FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) {
    return res.status(404).json({ error: 'Not found: '+req.path });
  }
  const indexFile = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);

  res.status(200).type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IPTV Manager Server v6.0</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f172a;color:#e2e8f0;font-family:ui-monospace,monospace;padding:2rem;line-height:1.6}
h1{color:#38bdf8;font-size:1.8rem;margin-bottom:1rem}h2{color:#7dd3fc;margin:1.5rem 0 .5rem}
.ok{color:#10b981;font-weight:bold}.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem;margin:.5rem 0}
code{background:#0f172a;color:#f472b6;padding:2px 6px;border-radius:4px;font-size:.9em}
a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-top:1rem}
.badge{display:inline-block;background:#1d4ed8;color:#fff;padding:2px 8px;border-radius:12px;font-size:.75em;margin-left:6px}
</style></head><body>
<h1>🚀 IPTV Manager Server v6.0 <span class="badge">Kodi DRM Engine</span></h1>
<p><span class="ok">✅ SERVER RUNNING</span> — <a href="/api/stats">/api/stats</a> | <a href="/health">/health</a></p>
<h2>📺 Playlist URLs</h2>
<div class="grid">
<div class="card"><b>All Channels</b><br><a href="/api/playlist/all.m3u">/api/playlist/all.m3u</a><br><small>Kodi mode: <a href="/api/playlist/all.m3u?kodi=1">?kodi=1</a></small></div>
<div class="card"><b>Tamil Only</b><br><a href="/api/playlist/tamil.m3u">/api/playlist/tamil.m3u</a></div>
</div>
<h2>🔐 DRM Engine (Kodi inputstream.adaptive)</h2>
<div class="grid">
<div class="card"><b>ClearKey</b><br><code>POST /proxy/drm-license/:id</code><br><small>W3C EME JSON — kid:key inline or license server</small></div>
<div class="card"><b>Widevine</b><br><code>POST /proxy/drm-license/:id</code><br><small>Binary protobuf challenge → license server proxy</small></div>
<div class="card"><b>PlayReady</b><br><code>POST /proxy/drm-license/:id</code><br><small>SOAP XML challenge → license server proxy</small></div>
<div class="card"><b>PSSH Info</b><br><code>GET /api/drm/pssh/:id</code><br><small>Extract KIDs + PSSH boxes from MPD</small></div>
</div>
<h2>🔌 API</h2>
<div class="grid">
<div class="card"><b>Sync DB</b><br><code>POST /api/sync</code></div>
<div class="card"><b>CORS Proxy</b><br><code>GET /proxy/cors?url=...</code></div>
<div class="card"><b>Stream Proxy</b><br><code>GET /proxy/redirect/:id</code></div>
<div class="card"><b>DRM Stream</b><br><code>GET /proxy/drm/:id</code></div>
<div class="card"><b>Export DB</b><br><a href="/api/db/export">/api/db/export</a></div>
</div>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🚀  IPTV Manager Server v6.0  —  Kodi DRM Engine         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  🌐  URL:        http://0.0.0.0:${PORT}`);
  console.log(`  📺  All:        http://0.0.0.0:${PORT}/api/playlist/all.m3u`);
  console.log(`  📺  Kodi:       http://0.0.0.0:${PORT}/api/playlist/all.m3u?kodi=1`);
  console.log(`  🇮🇳  Tamil:      http://0.0.0.0:${PORT}/api/playlist/tamil.m3u`);
  console.log(`  🔐  DRM:        http://0.0.0.0:${PORT}/proxy/drm/:id`);
  console.log(`  🗝️   License:    http://0.0.0.0:${PORT}/proxy/drm-license/:id`);
  console.log(`  🧬  PSSH Info:  http://0.0.0.0:${PORT}/api/drm/pssh/:id`);
  console.log(`  📡  Redirect:   http://0.0.0.0:${PORT}/proxy/redirect/:id`);
  console.log(`  🔁  CORS:       http://0.0.0.0:${PORT}/proxy/cors?url=...`);
  console.log(`  📊  Stats:      http://0.0.0.0:${PORT}/api/stats`);
  console.log(`  💾  DB:         ${DB_FILE}`);
  console.log('');
});
