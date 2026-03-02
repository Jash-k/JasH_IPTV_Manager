'use strict';
/**
 * IPTV Playlist Manager — Server v9.0
 * =====================================
 * ROUTING RULES:
 *   - NON-DRM streams  → 302 redirect to original URL (zero server overhead)
 *     - If Cookie/UA/Referer needed → transparent pipe with injected headers
 *   - DRM streams only → /live/:id.mpd | /live/:id.m3u8 | /live/:id.ts
 *
 * HEALTH CHECK:
 *   - GET  /api/health/:id       → single channel HEAD check
 *   - POST /api/health/batch     → up to 50 channels concurrently
 *   - GET  /api/health/all       → check all channels
 *
 * TAMIL FILTER:
 *   - Per-source: tamilFilter flag on source object
 *   - /api/playlist/tamil.m3u
 *   - /api/playlist/source/:id/tamil.m3u
 *   - /api/channels?tamil=1
 */

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const http       = require('http');
const https      = require('https');
const { spawn }  = require('child_process');
const { URL }    = require('url');

const app  = express();
const PORT = parseInt(process.env.PORT || '10000', 10);
const API_KEY = process.env.API_KEY || 'iptv_secret_2024';

// ─── Rotating User-Agents ────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-S908B Build/SP1A.210812.016)',
  'Mozilla/5.0 (Linux; Android 12; SM-S908B) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36',
  'VLC/3.0.21 LibVLC/3.0.21',
  'okhttp/4.12.0',
  'ExoPlayerLib/2.19.1',
  'Kodi/21.0 (Windows; Windows 10; x64)',
  'TiviMate/4.7.0',
  'stagefright/1.2 (Linux;Android 12)',
];
let _uaIdx = 0;
function nextUA() { return USER_AGENTS[(_uaIdx++) % USER_AGENTS.length]; }

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'] }));
app.options('*', cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/license',           express.raw({ type: '*/*', limit: '4mb' }));
app.use('/proxy/drm-license', express.raw({ type: '*/*', limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Persistent DB ───────────────────────────────────────────────────────────
const DB_FILE  = process.env.DB_FILE || path.join(__dirname, 'db.json');
const EMPTY_DB = { channels: [], playlists: [], drmProxies: [], sources: [], groups: [] };

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return JSON.parse(JSON.stringify(EMPTY_DB));
    return Object.assign({}, JSON.parse(JSON.stringify(EMPTY_DB)), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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

// Fast O(1) channel lookup
let _channelsMap = {};
function rebuildMap() {
  const db = loadDB();
  _channelsMap = {};
  (db.channels || []).forEach(ch => { if (ch && ch.id) _channelsMap[ch.id] = ch; });
}
rebuildMap();
function getChannel(id) { return _channelsMap[id] || null; }

// ─── Channel Type Helpers ────────────────────────────────────────────────────
function isDrmChannel(ch) {
  return !!(ch && (ch.isDrm || ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmLicense));
}

function needsHeaderProxy(ch) {
  return !!(ch && (ch.cookie || ch.referer || ch.userAgent ||
    (ch.httpHeaders && Object.keys(ch.httpHeaders || {}).length > 0)));
}

// ─── Tamil Channel Detection ─────────────────────────────────────────────────
const TAMIL_KW = [
  'tamil','sun tv','vijay tv','star vijay','zee tamil','kalaignar','raj tv',
  'jaya tv','jaya max','polimer','captain tv','vendhar','vasanth','adithya',
  'isai aruvi','mozhi','puthuyugam','news7 tamil','news18 tamil','thanthi tv',
  'sathiyam','makkal isai','sirippoli','peppers tv','chutti tv','colors tamil',
  'dd tamil','doordarshan tamil','sun music','imayam','murasu','shakthi',
  'gem tv','thirai','vijay super','puthiya thalaimurai','tamilnadu','sun news',
  'mega tv','zee thirai','kaveri','rainbow','vikatan','nakkheeran','seithigal',
  'news 7 tamil','news 18 tamil','covai news','madurai','coimbatore','trichy',
];

function ss(v) {
  if (typeof v === 'string') return v.toLowerCase();
  if (v == null) return '';
  return String(v).toLowerCase();
}

function isTamil(ch) {
  if (!ch) return false;
  if (ch.isTamil === true) return true;
  const hay = `${ss(ch.name)} ${ss(ch.group)} ${ss(ch.language)} ${ss(ch.tvgName)} ${ss(ch.country)} ${ss(ch.tvgId)}`;
  return TAMIL_KW.some(k => hay.includes(k)) || ss(ch.language) === 'tamil';
}

// ─── Auth ────────────────────────────────────────────────────────────────────
function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── DRM Helpers ─────────────────────────────────────────────────────────────
function hexToBase64url(hex) {
  if (!hex) return '';
  try {
    const clean = String(hex).replace(/[-\s]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(hex).toString('base64url');
    return Buffer.from(clean, 'hex').toString('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  } catch { return hex; }
}

function base64urlToHex(b64) {
  if (!b64) return '';
  try { return Buffer.from(b64.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('hex'); }
  catch { return ''; }
}

function toHex(val) {
  if (!val) return '';
  const s = String(val).replace(/[-\s]/g,'');
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 32) return s.toLowerCase();
  try { return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('hex'); }
  catch { return ''; }
}

function parseClearKeyString(src) {
  if (!src || typeof src !== 'string') return [];
  return src.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf(':');
    if (idx === -1) return null;
    let kid = pair.substring(0, idx).trim();
    let key = pair.substring(idx + 1).trim();
    if (/^[0-9a-fA-F-]{32,36}$/.test(kid)) kid = hexToBase64url(kid);
    if (/^[0-9a-fA-F-]{32,36}$/.test(key)) key = hexToBase64url(key);
    return { kty: 'oct', kid, k: key };
  }).filter(Boolean);
}

function parseClearKeyPairs(src) {
  if (!src) return [];
  return String(src).split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf(':');
    if (idx === -1) return null;
    return { kid: toHex(pair.substring(0, idx).trim()), key: toHex(pair.substring(idx + 1).trim()) };
  }).filter(p => p && p.kid && p.key);
}

// PSSH Parser (Kodi CDM Session logic)
function parsePSSH(input) {
  try {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input).replace(/\s/g,''), 'base64');
    if (buf.length < 32) return null;
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const boxSize = buf.readUInt32BE(offset);
      const boxType = buf.slice(offset + 4, offset + 8).toString('ascii');
      if (boxType !== 'pssh') { if (boxSize < 8) break; offset += boxSize; continue; }
      const version  = buf.readUInt8(offset + 8);
      const systemId = buf.slice(offset + 12, offset + 28).toString('hex').toLowerCase();
      const kids = []; let ptr = offset + 28;
      if (version === 1 && ptr + 4 <= buf.length) {
        const kc = buf.readUInt32BE(ptr); ptr += 4;
        for (let i = 0; i < kc && ptr + 16 <= buf.length; i++) { kids.push(buf.slice(ptr, ptr + 16).toString('hex')); ptr += 16; }
      }
      if (ptr + 4 > buf.length) break;
      const dataSize = buf.readUInt32BE(ptr); ptr += 4;
      const psshData = buf.slice(ptr, ptr + dataSize);
      const DRM_IDS = {
        'edef8ba979d64acea3c827dcd51d21ed': 'widevine',
        '9a04f07998404286ab92e65be0885f95': 'playready',
        'e2719d58a985b3c9781ab030af78d30e': 'clearkey',
        '94ce86fb07ff4f43adb893d2fa968ca2': 'fairplay',
      };
      return {
        version, systemId, drmType: DRM_IDS[systemId] || 'unknown', kids,
        psshBase64: psshData.toString('base64'), fullBase64: buf.slice(offset, offset + boxSize).toString('base64'),
      };
    }
  } catch(e) { console.error('[PSSH]', e.message); }
  return null;
}

function extractFromMPD(mpdContent) {
  const result = { psshs: [], kids: [], licenseUrls: {} };
  const psshRx = /<(?:cenc:)?pssh[^>]*>([A-Za-z0-9+/=\s]+)<\/(?:cenc:)?pssh>/gi;
  let m;
  while ((m = psshRx.exec(mpdContent)) !== null) { const p = parsePSSH(m[1].trim()); if (p) result.psshs.push(p); }
  const kidRx1 = /cenc:default_KID\s*=\s*["']([0-9a-fA-F-]{32,36})["']/gi;
  while ((m = kidRx1.exec(mpdContent)) !== null) result.kids.push(m[1].replace(/-/g,'').toLowerCase());
  const kidRx2 = /<(?:cenc:)?default_KID[^>]*>([0-9a-fA-F-]{32,36})<\/(?:cenc:)?default_KID>/gi;
  while ((m = kidRx2.exec(mpdContent)) !== null) result.kids.push(m[1].replace(/-/g,'').toLowerCase());
  const lauRx = /<(?:clearkey|dashif):Laurl[^>]*>([^<]+)<\/(?:clearkey|dashif):Laurl>/gi;
  while ((m = lauRx.exec(mpdContent)) !== null) result.licenseUrls.clearkey = result.licenseUrls.clearkey || m[1].trim();
  const prRx = /<mspr:la_url[^>]*>([^<]+)<\/mspr:la_url>/gi;
  while ((m = prRx.exec(mpdContent)) !== null) result.licenseUrls.playready = result.licenseUrls.playready || m[1].trim();
  return result;
}

// ─── HTTP Fetch — pure Node.js, 403 bypass ───────────────────────────────────
function safeFetch(targetUrl, options, timeoutMs, _redir) {
  options   = options   || {};
  timeoutMs = timeoutMs || 20000;
  _redir    = _redir    || 0;

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('Invalid URL: ' + targetUrl)); }

    const lib  = parsed.protocol === 'https:' ? https : http;
    const hdrs = Object.assign({
      'User-Agent':      nextUA(),
      'Accept':          '*/*',
      'Accept-Encoding': 'identity',
      'Connection':      'keep-alive',
    }, options.headers || {});

    const reqOpts = {
      hostname:           parsed.hostname,
      port:               parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:               (parsed.pathname || '/') + (parsed.search || ''),
      method:             options.method || 'GET',
      headers:            hdrs,
      rejectUnauthorized: false,
    };

    const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout: ' + targetUrl)); }, timeoutMs);

    const req = lib.request(reqOpts, res => {
      clearTimeout(timer);
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (_redir >= 10) return reject(new Error('Too many redirects'));
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
        return safeFetch(loc, options, timeoutMs, _redir + 1).then(resolve).catch(reject);
      }
      // 403 bypass — retry with browser spoofing headers
      if (res.statusCode === 403 && _redir === 0) {
        res.resume();
        const bypass = Object.assign({}, hdrs, {
          'User-Agent':      nextUA(),
          'Referer':         parsed.protocol + '//' + parsed.hostname + '/',
          'Origin':          parsed.protocol + '//' + parsed.hostname,
          'X-Forwarded-For': '8.8.8.8',
          'Cache-Control':   'no-cache',
          'Pragma':          'no-cache',
          'Sec-Fetch-Dest':  'video',
          'Sec-Fetch-Mode':  'cors',
          'Sec-Fetch-Site':  'cross-site',
        });
        return safeFetch(targetUrl, Object.assign({}, options, { headers: bypass }), timeoutMs, 1).then(resolve).catch(reject);
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
    if (options.body) {
      if (Buffer.isBuffer(options.body)) req.write(options.body);
      else req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8');
    }
    req.end();
  });
}

// ─── HEAD check for health (no body download) ────────────────────────────────
function headCheck(targetUrl, headers, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { return resolve({ ok: false, status: 0, latency: 0, error: 'invalid url' }); }

    const lib   = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, status: 0, latency: timeoutMs, error: 'timeout' });
    }, timeoutMs);

    const req = lib.request({
      hostname:           parsed.hostname,
      port:               parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:               (parsed.pathname || '/') + (parsed.search || ''),
      method:             'HEAD',
      headers:            Object.assign({ 'User-Agent': nextUA(), 'Accept': '*/*' }, headers || {}),
      rejectUnauthorized: false,
    }, res => {
      clearTimeout(timer);
      res.resume();
      const latency = Date.now() - start;
      const ok = res.statusCode >= 200 && res.statusCode < 500;
      resolve({ ok, status: res.statusCode, latency, contentType: res.headers['content-type'] || '' });
    });
    req.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, latency: Date.now() - start, error: e.message });
    });
    req.end();
  });
}

function buildHeaders(ch, overrides) {
  ch = ch || {}; overrides = overrides || {};
  const hdrs = {};
  if (ch.httpHeaders) Object.assign(hdrs, ch.httpHeaders);
  hdrs['User-Agent']      = ch.userAgent || overrides['User-Agent'] || nextUA();
  hdrs['Accept']          = overrides['Accept'] || '*/*';
  hdrs['Accept-Language'] = 'en-US,en;q=0.9';
  hdrs['Accept-Encoding'] = 'identity';
  hdrs['Connection']      = 'keep-alive';
  if (ch.referer) { hdrs['Referer'] = ch.referer; hdrs['Origin'] = ch.referer.replace(/\/[^/]*$/, ''); }
  if (ch.cookie)  hdrs['Cookie'] = ch.cookie;
  Object.assign(hdrs, overrides);
  return hdrs;
}

/** Pipe upstream live stream to player response */
function pipeStream(targetUrl, headers, res, _redir) {
  _redir = _redir || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('Bad URL: ' + targetUrl)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname:           parsed.hostname,
      port:               parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:               (parsed.pathname || '/') + (parsed.search || ''),
      method:             'GET',
      headers,
      rejectUnauthorized: false,
    }, upstream => {
      if ([301,302,307,308].includes(upstream.statusCode) && upstream.headers.location) {
        upstream.resume();
        let loc = upstream.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
        if (_redir < 10) return pipeStream(loc, headers, res, _redir + 1).then(resolve).catch(reject);
      }
      if (!res.headersSent) {
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      upstream.pipe(res);
      upstream.on('end', resolve);
      upstream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function getBaseUrl(url) {
  try { return url.substring(0, url.lastIndexOf('/') + 1); } catch { return ''; }
}

// ─── MPD Rewriter (Kodi inputstream.adaptive pattern) ────────────────────────
function rewriteMPD(mpdContent, channelId, baseUrl, proxyHost, drmCfg) {
  let out = mpdContent;

  out = out.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, url) => {
    const full = url.startsWith('http') ? url : baseUrl + url;
    return `<BaseURL>${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(full)}</BaseURL>`;
  });

  out = out.replace(/media="([^"]+)"/g, (match, url) => {
    if (url.startsWith('http')) return `media="${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(url)}"`;
    return `media="${proxyHost}/proxy/${channelId}/segment?path=${encodeURIComponent(url)}"`;
  });

  out = out.replace(/initialization="([^"]+)"/g, (match, url) => {
    if (url.startsWith('http')) return `initialization="${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(url)}"`;
    return `initialization="${proxyHost}/proxy/${channelId}/segment?path=${encodeURIComponent(url)}"`;
  });

  if (drmCfg) {
    const licEndpoint = `${proxyHost}/license/${channelId}`;
    const licType     = (drmCfg.licenseType || 'clearkey').toLowerCase();
    const info        = extractFromMPD(mpdContent);
    const kids        = Array.from(new Set([...info.kids, ...(info.psshs.flatMap(p => p.kids) || [])]));
    const kidAttr     = kids.length > 0 ? ` cenc:default_KID="${kids[0].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}"` : '';

    if (licType === 'clearkey') {
      if (out.includes('e2719d58')) {
        out = out.replace(
          /(<ContentProtection[^>]*e2719d58[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
          (match, open, inner, close) => {
            let ni = inner.replace(/<clearkey:Laurl[^>]*>[^<]*<\/clearkey:Laurl>/gi,
              `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licEndpoint}</clearkey:Laurl>`);
            if (!ni.includes('Laurl'))
              ni += `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licEndpoint}</clearkey:Laurl>`;
            return open + ni + close;
          });
      } else if (!out.includes('ContentProtection') && out.includes('<AdaptationSet')) {
        const inject = `<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"${kidAttr}><clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licEndpoint}</clearkey:Laurl></ContentProtection>`;
        out = out.replace(/<AdaptationSet/i, inject + '\n<AdaptationSet');
      }
    } else if (licType === 'widevine') {
      out = out.replace(
        /(<ContentProtection[^>]*edef8ba9[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
        (match, open, inner, close) => {
          let ni = inner.replace(/<dashif:Laurl[^>]*>[^<]*<\/dashif:Laurl>/gi,
            `<dashif:Laurl xmlns:dashif="https://dashif.org" Lic_type="EME-1.0">${licEndpoint}</dashif:Laurl>`);
          if (!ni.includes('dashif:Laurl'))
            ni += `<dashif:Laurl xmlns:dashif="https://dashif.org" Lic_type="EME-1.0">${licEndpoint}</dashif:Laurl>`;
          return open + ni + close;
        });
    } else if (licType === 'playready') {
      out = out.replace(
        /(<ContentProtection[^>]*9a04f079[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi,
        (match, open, inner, close) => {
          let ni = inner.replace(/<mspr:la_url[^>]*>[^<]*<\/mspr:la_url>/gi,
            `<mspr:la_url>${licEndpoint}</mspr:la_url>`);
          if (!ni.includes('mspr:la_url'))
            ni += `<mspr:la_url xmlns:mspr="urn:microsoft:playready">${licEndpoint}</mspr:la_url>`;
          return open + ni + close;
        });
    }
  }
  return out;
}

/** Rewrite HLS manifest — proxy all segments + inject DRM key lines */
function rewriteHLS(hlsContent, channelId, manifestUrl, proxyHost, drmCfg) {
  const lines   = hlsContent.split(/\r?\n/);
  const baseUrl = getBaseUrl(manifestUrl);
  const out     = [];

  if (drmCfg) {
    const licEndpoint = `${proxyHost}/license/${channelId}`;
    const licType     = (drmCfg.licenseType || 'clearkey').toLowerCase();
    const kid         = drmCfg.keyId ? `,KEYID=0x${(drmCfg.keyId || '').replace(/-/g, '')}` : '';
    if (licType === 'clearkey')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="${licEndpoint}"${kid}`);
    else if (licType === 'widevine')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="${licEndpoint}",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"`);
    else if (licType === 'playready')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="${licEndpoint}",KEYFORMAT="com.microsoft.playready",KEYFORMATVERSIONS="1"`);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (drmCfg && (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-SESSION-KEY:'))) continue;

    if (trimmed && !trimmed.startsWith('#')) {
      let segUrl = trimmed;
      if (!segUrl.startsWith('http') && !segUrl.startsWith('//')) {
        segUrl = segUrl.startsWith('/')
          ? (new URL(manifestUrl).origin + segUrl)
          : (baseUrl + segUrl);
      }
      out.push(`${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(segUrl)}`);
      continue;
    }
    if (trimmed.startsWith('#EXT-X-KEY:') && !drmCfg) {
      const modified = line.replace(/URI="([^"]+)"/, (match, uri) => {
        const fullUri = uri.startsWith('http') ? uri : baseUrl + uri;
        return `URI="${proxyHost}/proxy/${channelId}/key?url=${encodeURIComponent(fullUri)}"`;
      });
      out.push(modified);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ─── M3U Generator ───────────────────────────────────────────────────────────
// DRM → /live/:id.mpd|.m3u8|.ts  |  Direct → /proxy/redirect/:id (302)
function generateM3U(channels, baseUrl, playlistName, kodiMode) {
  const lines = [];
  lines.push(`#EXTM3U x-tvg-url="" playlist-name="${(playlistName || 'IPTV').replace(/"/g, '')}"`);

  channels.forEach(ch => {
    if (!ch || !ch.id || !ch.url) return;

    const hasDRM   = isDrmChannel(ch);
    const urlLower = (ch.url || '').toLowerCase();
    const isMPD    = urlLower.includes('.mpd')  || urlLower.includes('/dash/') || urlLower.includes('manifest.mpd');
    const isM3U8   = urlLower.includes('.m3u8') || urlLower.includes('/hls/');

    // ── Smart URL Routing ──────────────────────────────────────────────────
    // DRM streams      → server proxy (full pipeline)
    // Direct streams   → /proxy/redirect/:id (server sends 302 to original URL)
    //                    OR pipes if Cookie/UA/Referer needed
    let streamUrl;
    if (hasDRM) {
      if      (isMPD)  streamUrl = `${baseUrl}/live/${ch.id}.mpd`;
      else if (isM3U8) streamUrl = `${baseUrl}/live/${ch.id}.m3u8`;
      else             streamUrl = `${baseUrl}/live/${ch.id}.ts`;
    } else {
      streamUrl = `${baseUrl}/proxy/redirect/${ch.id}`;
    }

    // ── KODIPROP for DRM ───────────────────────────────────────────────────
    if (hasDRM) {
      const lt  = (ch.licenseType || 'clearkey').toLowerCase();
      const lic = `${baseUrl}/license/${ch.id}`;
      lines.push('#KODIPROP:inputstream=inputstream.adaptive');
      lines.push(isMPD
        ? '#KODIPROP:inputstream.adaptive.manifest_type=mpd'
        : '#KODIPROP:inputstream.adaptive.manifest_type=hls');
      if (lt === 'widevine') {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
      } else if (lt === 'playready') {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
      } else {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
        if (ch.licenseKey && ch.licenseKey.includes(':') && !ch.licenseKey.startsWith('http'))
          lines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.licenseKey}`);
        else
          lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
      }
      if (kodiMode) {
        const ua = ch.userAgent || nextUA();
        lines.push(`#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=${encodeURIComponent(ua)}`);
      }
    }

    if (ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${ch.userAgent}`);
    if (ch.referer)   lines.push(`#EXTVLCOPT:http-referrer=${ch.referer}`);
    if (ch.cookie)    lines.push(`#EXTHTTP:{"Cookie":"${ch.cookie.replace(/"/g, '\\"')}"}`);

    let attrs = '';
    if (ch.tvgId)    attrs += ` tvg-id="${ss(ch.tvgId).replace(/"/g, '')}"`;
    attrs            += ` tvg-name="${ss(ch.tvgName || ch.name).replace(/"/g, '')}"`;
    if (ch.logo)     attrs += ` tvg-logo="${String(ch.logo || '').replace(/"/g, '')}"`;
    attrs            += ` group-title="${String(ch.group || 'Uncategorized').replace(/"/g, '')}"`;
    if (ch.language) attrs += ` tvg-language="${ss(ch.language).replace(/"/g, '')}"`;
    if (ch.country)  attrs += ` tvg-country="${ss(ch.country).replace(/"/g, '')}"`;

    const name = String(ch.name || 'Unknown').replace(/,/g, ' ');
    lines.push(`#EXTINF:-1${attrs},${name}`);
    lines.push(streamUrl);
  });

  return lines.join('\r\n') + '\r\n';
}

function filterChannels(pl, allChannels) {
  return allChannels.filter(ch => {
    if (!ch) return false;
    if (ch.enabled === false && ch.isActive !== true) return false;
    if (pl.tamilOnly && !isTamil(ch)) return false;
    if (pl.includeGroups && pl.includeGroups.length > 0 && !pl.includeGroups.includes(ch.group)) return false;
    if (pl.excludeGroups && pl.excludeGroups.includes(ch.group)) return false;
    return true;
  }).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// ─── FFmpeg TS Streamer (DRM decrypt + pipe) ──────────────────────────────────
function streamFFmpegTS(ch, res) {
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Transfer-Encoding', 'chunked');

  const args = [
    '-re', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-user_agent', ch.userAgent || nextUA(),
  ];

  const extraHeaders = [];
  if (ch.referer)     extraHeaders.push(`Referer: ${ch.referer}`);
  if (ch.cookie)      extraHeaders.push(`Cookie: ${ch.cookie}`);
  if (ch.httpHeaders) Object.entries(ch.httpHeaders).forEach(([k,v]) => extraHeaders.push(`${k}: ${v}`));
  if (extraHeaders.length > 0) args.push('-headers', extraHeaders.map(h => h + '\r\n').join(''));

  const keyStr = ch.licenseKey || ch.drmKey || ch.drmLicense || '';
  const pairs  = parseClearKeyPairs(keyStr);
  if (pairs.length > 0) args.push('-decryption_key', pairs[0].key);
  else if (ch.key)      args.push('-decryption_key', toHex(ch.key));

  args.push('-i', ch.url, '-c', 'copy', '-f', 'mpegts', 'pipe:1');

  console.log(`[FFmpeg] TS → ${ch.name} (${ch.id})`);
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', d => { const l = d.toString().trim(); if (l) console.error(`[FFmpeg:${ch.id}] ${l}`); });
  ffmpeg.on('error', err => {
    console.error(`[FFmpeg] Error ${ch.id}:`, err.message);
    if (!res.headersSent) res.status(500).send('FFmpeg error: ' + err.message);
  });
  ffmpeg.on('close', code => {
    console.log(`[FFmpeg] Exit(${code}) ${ch.id}`);
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => ffmpeg.kill('SIGTERM'));
}

function resolveDRMConfig(channelId, ch, db) {
  let drmCfg = (db.drmProxies || []).find(d => d.channelId === channelId && d.isActive !== false);
  if (!drmCfg && isDrmChannel(ch)) {
    drmCfg = {
      id:            ch.id,
      channelId:     ch.id,
      licenseType:   ch.licenseType  || 'clearkey',
      licenseKey:    ch.licenseKey   || ch.drmKey || ch.drmLicense || '',
      licenseUrl:    ch.licenseUrl   || (ch.licenseKey && ch.licenseKey.startsWith('http') ? ch.licenseKey : ''),
      keyId:         ch.keyId        || ch.drmKeyId || '',
      key:           ch.key          || '',
      customHeaders: ch.httpHeaders  || {},
    };
  }
  return drmCfg || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ██╗  ██╗███████╗ █████╗ ██╗  ████████╗██╗  ██╗
//  HEALTH CHECK ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /health — server heartbeat */
app.get('/health', (_req, res) => res.json({
  status: 'ok', uptime: process.uptime(), version: '9.0.0', ffmpeg: true,
  routing: 'DRM→proxy | Direct→302',
}));

/**
 * GET /api/health/:id
 * Single channel health check — HEAD request to upstream
 * Returns: { ok, status, latency, contentType, isDrm, streamType, proxyUrl }
 */
app.get('/api/health/:id', async (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel not found' });

  const hdrs   = buildHeaders(ch, {});
  const hasDRM = isDrmChannel(ch);
  const result = await headCheck(ch.url, hdrs, 10000);

  const urlLower   = (ch.url || '').toLowerCase();
  const streamType = urlLower.includes('.mpd') || urlLower.includes('/dash/') ? 'dash'
                   : urlLower.includes('.m3u8') || urlLower.includes('/hls/')  ? 'hls' : 'direct';

  const BASE     = req.protocol + '://' + req.get('host');
  const proxyUrl = hasDRM
    ? (streamType === 'dash' ? `${BASE}/live/${ch.id}.mpd`
       : streamType === 'hls' ? `${BASE}/live/${ch.id}.m3u8`
       : `${BASE}/live/${ch.id}.ts`)
    : `${BASE}/proxy/redirect/${ch.id}`;

  // Update health status in DB
  const db = loadDB();
  db.channels = (db.channels || []).map(c => c.id === ch.id
    ? Object.assign({}, c, { healthStatus: result.ok ? 'ok' : 'error', lastHealthCheck: new Date().toISOString(), healthLatency: result.latency })
    : c);
  saveDB(db); rebuildMap();

  res.json({
    ok:          result.ok,
    status:      result.status,
    latency:     result.latency,
    contentType: result.contentType || '',
    error:       result.error || null,
    isDrm:       hasDRM,
    streamType,
    proxyUrl,
    channelName:  ch.name,
    channelGroup: ch.group,
    isTamil:     isTamil(ch),
    checkedAt:   new Date().toISOString(),
  });
});

/**
 * POST /api/health/batch
 * Body: { ids: ['id1', 'id2', ...] }  — check up to 50 channels concurrently
 */
app.post('/api/health/batch', async (req, res) => {
  const ids  = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 50) : [];
  const BASE = req.protocol + '://' + req.get('host');

  const results = await Promise.allSettled(
    ids.map(async id => {
      const ch = getChannel(id);
      if (!ch) return { id, ok: false, error: 'Not found' };
      const hdrs  = buildHeaders(ch, {});
      const check = await headCheck(ch.url, hdrs, 8000);
      return { id, name: ch.name, group: ch.group, isTamil: isTamil(ch), isDrm: isDrmChannel(ch), ...check };
    })
  );

  const healthMap = {};
  results.forEach((r, i) => {
    healthMap[ids[i]] = r.status === 'fulfilled' ? r.value : { id: ids[i], ok: false, error: String(r.reason) };
  });

  // Persist health status to DB
  const db = loadDB();
  db.channels = (db.channels || []).map(ch => {
    if (!healthMap[ch.id]) return ch;
    return Object.assign({}, ch, {
      healthStatus:    healthMap[ch.id].ok ? 'ok' : 'error',
      lastHealthCheck: new Date().toISOString(),
      healthLatency:   healthMap[ch.id].latency,
    });
  });
  saveDB(db); rebuildMap();

  res.json({ checked: ids.length, results: healthMap, checkedAt: new Date().toISOString(), serverUrl: BASE });
});

/**
 * GET /api/health/all — check ALL channels (paginated, max 100)
 */
app.get('/api/health/all', async (req, res) => {
  const db   = loadDB();
  const skip = parseInt(req.query.skip || '0', 10);
  const take = Math.min(parseInt(req.query.take || '50', 10), 100);
  const chs  = (db.channels || []).slice(skip, skip + take);

  const results = await Promise.allSettled(
    chs.map(async ch => {
      const check = await headCheck(ch.url, buildHeaders(ch, {}), 6000);
      return { id: ch.id, name: ch.name, isDrm: isDrmChannel(ch), isTamil: isTamil(ch), ...check };
    })
  );

  const out = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { id: chs[i].id, ok: false, error: String(r.reason) });

  // Persist
  const hmap = {};
  out.forEach(r => { hmap[r.id] = r; });
  db.channels = (db.channels || []).map(c => hmap[c.id]
    ? Object.assign({}, c, { healthStatus: hmap[c.id].ok ? 'ok' : 'error', lastHealthCheck: new Date().toISOString(), healthLatency: hmap[c.id].latency })
    : c);
  saveDB(db); rebuildMap();

  res.json({ total: (db.channels||[]).length, checked: out.length, skip, take, results: out });
});

// ─── Stats ───────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db   = loadDB();
  const chs  = db.channels || [];
  const BASE = req.protocol + '://' + req.get('host');
  res.json({
    serverVersion:  '9.0.0',
    uptime:         Math.floor(process.uptime()),
    nodeVersion:    process.version,
    channels:       chs.length,
    activeChannels: chs.filter(c => c.enabled !== false).length,
    tamilChannels:  chs.filter(isTamil).length,
    drmChannels:    chs.filter(isDrmChannel).length,
    directChannels: chs.filter(c => !isDrmChannel(c)).length,
    healthyChannels:chs.filter(c => c.healthStatus === 'ok').length,
    groups:         new Set(chs.map(c => c.group || 'Uncategorized')).size,
    playlists:      (db.playlists || []).length,
    sources:        (db.sources   || []).length,
    drmEngine:      'Kodi inputstream.adaptive v9 + FFmpeg',
    routing:        'DRM→proxy | Direct→302 redirect',
    quickUrls: {
      all:        `${BASE}/api/playlist/all.m3u`,
      allKodi:    `${BASE}/api/playlist/all.m3u?kodi=1`,
      tamil:      `${BASE}/api/playlist/tamil.m3u`,
      tamilKodi:  `${BASE}/api/playlist/tamil.m3u?kodi=1`,
      legacy:     `${BASE}/playlist.m3u`,
    },
  });
});

// ─── Playlist Endpoints ───────────────────────────────────────────────────────
app.get('/playlist.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, 'IPTV Playlist', req.query.kodi === '1'));
});

app.get('/api/playlist/all.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, 'All Channels', req.query.kodi === '1'));
});

app.get('/api/playlist/tamil.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false && isTamil(c));
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, 'Tamil Channels', req.query.kodi === '1'));
});

// Per-source playlists
app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false && c.sourceId === req.params.sourceId && isTamil(c));
  const src = (db.sources  || []).find(s => s.id === req.params.sourceId);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, `${src ? src.name : 'Source'} — Tamil`, req.query.kodi === '1'));
});

app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const src  = (db.sources  || []).find(s => s.id === req.params.sourceId);
  let chs    = (db.channels || []).filter(c => c.enabled !== false && c.sourceId === req.params.sourceId);
  // Respect per-source Tamil filter flag
  if (src && src.tamilFilter) chs = chs.filter(isTamil);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, src ? src.name : 'Source Playlist', req.query.kodi === '1'));
});

app.get('/api/playlist/:id.m3u', (req, res) => {
  const db  = loadDB();
  const pl  = (db.playlists || []).find(p => p.id === req.params.id);
  const BASE = req.protocol + '://' + req.get('host');

  if (!pl) {
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send('#EXTM3U\r\n#EXTINF:-1,Playlist Not Found\r\nhttp://localhost/notfound\r\n');
  }

  const chs = filterChannels(pl, db.channels || []);
  console.log(`[Playlist] "${pl.name}" → ${chs.length} ch | DRM:${chs.filter(isDrmChannel).length} | Tamil:${chs.filter(isTamil).length}`);

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', `inline; filename="${(pl.name || 'playlist').replace(/[^a-z0-9_\-]/gi, '_')}.m3u"`);
  res.send(generateM3U(chs, BASE, pl.name, req.query.kodi === '1'));
});

app.get('/api/playlists', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  res.json((db.playlists || []).map(pl => {
    const cs = filterChannels(pl, db.channels || []);
    return Object.assign({}, pl, { m3uUrl: `${BASE}/api/playlist/${pl.id}.m3u`, channelCount: cs.length, tamilCount: cs.filter(isTamil).length });
  }));
});

app.post('/api/playlists', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const pl = Object.assign({}, req.body, { id: 'pl_' + Date.now(), createdAt: new Date().toISOString() });
  db.playlists = (db.playlists || []).concat([pl]); saveDB(db);
  res.json(Object.assign({}, pl, { m3uUrl: `${BASE}/api/playlist/${pl.id}.m3u` }));
});

app.put('/api/playlists/:id', (req, res) => {
  const db = loadDB(); let found = false;
  db.playlists = (db.playlists || []).map(p => {
    if (p.id !== req.params.id) return p;
    found = true;
    return Object.assign({}, p, req.body, { id: p.id, updatedAt: new Date().toISOString() });
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db); res.json({ ok: true });
});

app.delete('/api/playlists/:id', (req, res) => {
  const db = loadDB();
  db.playlists = (db.playlists || []).filter(p => p.id !== req.params.id);
  saveDB(db); res.json({ ok: true });
});

// ─── Live Stream Endpoints (DRM streams ONLY) ─────────────────────────────────

/** DRM DASH → fetch MPD + rewrite ContentProtection + proxy all segments */
app.get('/live/:id.mpd', async (req, res) => {
  const id = req.params.id;
  const ch = getChannel(id);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + id });

  const db     = loadDB();
  const drmCfg = resolveDRMConfig(id, ch, db);
  const HOST   = req.protocol + '://' + req.get('host');
  const base   = getBaseUrl(ch.url);

  try {
    const resp = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 20000);
    if (!resp.ok) return res.status(resp.status).send('Upstream error: ' + resp.status);

    const content   = resp.text();
    const rewritten = rewriteMPD(content, id, base, HOST, drmCfg);

    // Store detected KIDs
    if (drmCfg) {
      const info = extractFromMPD(content);
      if (info.kids.length > 0) {
        const freshDB = loadDB();
        freshDB.channels = (freshDB.channels || []).map(c =>
          c.id === id ? Object.assign({}, c, { detectedKids: info.kids }) : c);
        saveDB(freshDB); rebuildMap();
      }
    }

    res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch(e) {
    console.error(`[MPD] ${id}:`, e.message);
    res.status(502).json({ error: 'MPD fetch failed', details: e.message });
  }
});

/** DRM HLS → fetch M3U8 + rewrite EXT-X-KEY + proxy all segments */
app.get('/live/:id.m3u8', async (req, res) => {
  const id = req.params.id;
  const ch = getChannel(id);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + id });

  const db     = loadDB();
  const drmCfg = resolveDRMConfig(id, ch, db);
  const HOST   = req.protocol + '://' + req.get('host');

  try {
    const resp = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 20000);
    if (!resp.ok) return res.status(resp.status).send('Upstream error: ' + resp.status);

    const content   = resp.text();
    const rewritten = rewriteHLS(content, id, ch.url, HOST, drmCfg);

    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(rewritten);
  } catch(e) {
    console.error(`[HLS] ${id}:`, e.message);
    res.status(502).json({ error: 'HLS fetch failed', details: e.message });
  }
});

/** DRM MPEGTS → FFmpeg -decryption_key pipe */
app.get('/live/:id.ts', (req, res) => {
  const id = req.params.id.replace(/\.ts$/, '');
  const ch = getChannel(id);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + id });
  console.log(`[TS] ${ch.name} (${id})`);
  streamFFmpegTS(ch, res);
});

// ─── Redirect Endpoint (NON-DRM direct streams) ───────────────────────────────
// → Pure 302 redirect if no custom headers (zero server overhead)
// → Transparent pipe if Cookie/UA/Referer needed
app.get('/proxy/redirect/:id', (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch || !ch.url) return res.status(404).send('Channel not found');

  // Escalate to DRM endpoint if source turned out to be DRM
  if (isDrmChannel(ch)) {
    const urlLower = (ch.url || '').toLowerCase();
    const HOST = req.protocol + '://' + req.get('host');
    if (urlLower.includes('.mpd') || urlLower.includes('/dash/'))
      return res.redirect(302, `${HOST}/live/${ch.id}.mpd`);
    if (urlLower.includes('.m3u8') || urlLower.includes('/hls/'))
      return res.redirect(302, `${HOST}/live/${ch.id}.m3u8`);
    return res.redirect(302, `${HOST}/live/${ch.id}.ts`);
  }

  if (needsHeaderProxy(ch)) {
    // Transparent pipe — injects Cookie/UA/Referer
    pipeStream(ch.url, buildHeaders(ch, {}), res).catch(e => {
      if (!res.headersSent) res.status(502).send('Stream error: ' + e.message);
    });
  } else {
    // Pure 302 → player talks directly to source, zero server overhead
    res.redirect(302, ch.url);
  }
});

// ─── Segment Proxy (DRM segments with Cookie/UA/Referer) ─────────────────────
app.get('/proxy/:id/', async (req, res) => {
  const id        = req.params.id;
  const ch        = getChannel(id);
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');

  try {
    const hdrs = buildHeaders(ch || {}, {});
    const resp = await safeFetch(targetUrl, { headers: hdrs }, 20000);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(resp.body);
  } catch(e) {
    console.error(`[Proxy] ${id}:`, e.message);
    res.status(502).send('Proxy error: ' + e.message);
  }
});

app.get('/proxy/:id/segment', async (req, res) => {
  const id      = req.params.id;
  const ch      = getChannel(id);
  const segPath = req.query.path;
  if (!ch || !segPath) return res.status(400).send('Bad request');

  const base    = getBaseUrl(ch.url);
  const fullUrl = segPath.startsWith('http') ? segPath : base + segPath;

  try {
    const resp = await safeFetch(fullUrl, { headers: buildHeaders(ch, {}) }, 20000);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(resp.body);
  } catch(e) {
    console.error(`[Segment] ${id}:`, e.message);
    res.status(502).send('Segment error: ' + e.message);
  }
});

app.get('/proxy/:id/key', async (req, res) => {
  const id     = req.params.id;
  const ch     = getChannel(id);
  const keyUrl = req.query.url;
  if (!keyUrl) return res.status(400).send('Missing ?url=');
  try {
    const resp = await safeFetch(keyUrl, { headers: buildHeaders(ch || {}, {}) }, 10000);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(resp.body);
  } catch(e) { res.status(502).send('Key fetch error: ' + e.message); }
});

/** CORS proxy — used by frontend to fetch source URLs */
app.get('/proxy/cors', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url=');
  safeFetch(targetUrl, { headers: { 'User-Agent': nextUA(), 'Accept': '*/*' } }, 25000)
    .then(resp => {
      res.setHeader('Content-Type', resp.headers['content-type'] || 'text/plain');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(resp.body);
    })
    .catch(e => res.status(502).send('Fetch error: ' + e.message));
});

// ─── License Endpoint (ClearKey / Widevine / PlayReady / FairPlay) ───────────
async function handleLicense(req, res, channelId) {
  const db  = loadDB();
  const ch  = (db.channels || []).find(c => c.id === channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + channelId });

  const drmCfg = resolveDRMConfig(channelId, ch, db);
  if (!drmCfg) return res.status(404).json({ error: 'No DRM config for: ' + channelId });

  const licType = (drmCfg.licenseType || 'clearkey').toLowerCase();

  // ── ClearKey ───────────────────────────────────────────────────────────────
  if (licType === 'clearkey' || licType === 'clear-key') {
    const src = drmCfg.licenseUrl || drmCfg.licenseKey || '';
    let keys  = [];

    if (src && src.includes(':') && !src.startsWith('http')) {
      keys = parseClearKeyString(src);
    } else if (drmCfg.keyId && (drmCfg.key || drmCfg.licenseKey)) {
      keys = [{ kty: 'oct', kid: hexToBase64url(drmCfg.keyId), k: hexToBase64url(drmCfg.key || drmCfg.licenseKey) }];
    } else if (src && src.startsWith('http')) {
      const challenge = Buffer.isBuffer(req.body) ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      try {
        const resp = await safeFetch(src, {
          method: 'POST', body: challenge,
          headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': nextUA() }, drmCfg.customHeaders || {}),
        }, 15000);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(resp.body);
      } catch(e) { return res.status(502).json({ error: 'ClearKey proxy error: ' + e.message }); }
    } else {
      try {
        let challenge;
        if (Buffer.isBuffer(req.body)) challenge = JSON.parse(req.body.toString('utf8'));
        else if (typeof req.body === 'object') challenge = req.body;
        if (challenge && Array.isArray(challenge.kids)) {
          const pairs   = parseClearKeyString(drmCfg.licenseKey || drmCfg.key || '');
          const pairMap = {};
          pairs.forEach(p => { pairMap[p.kid] = p; pairMap[base64urlToHex(p.kid)] = p; });
          keys = challenge.kids.map(kid => pairMap[kid] || pairMap[base64urlToHex(kid)] || null).filter(Boolean);
        }
      } catch {}
      if (!keys.length) keys = parseClearKeyString(drmCfg.licenseKey || drmCfg.key || '');
    }

    console.log(`[License ClearKey] ${channelId} → ${keys.length} keys`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys, type: 'temporary' });
  }

  // ── Widevine ───────────────────────────────────────────────────────────────
  if (licType === 'widevine') {
    const licUrl = drmCfg.licenseUrl || (drmCfg.licenseKey && drmCfg.licenseKey.startsWith('http') ? drmCfg.licenseKey : '');
    if (!licUrl) return res.status(400).json({ error: 'Widevine license URL not configured' });
    const challenge = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '', 'base64');
    try {
      const resp = await safeFetch(licUrl, {
        method: 'POST', body: challenge,
        headers: Object.assign({
          'Content-Type': 'application/octet-stream',
          'User-Agent':   nextUA(),
          'Origin':       'https://www.google.com',
          'Referer':      'https://www.google.com/',
        }, drmCfg.customHeaders || {}),
      }, 20000);
      if (!resp.ok) return res.status(resp.status).send('Widevine license server: ' + resp.status);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    } catch(e) { return res.status(502).json({ error: 'Widevine error: ' + e.message }); }
  }

  // ── PlayReady ──────────────────────────────────────────────────────────────
  if (licType === 'playready') {
    const licUrl = drmCfg.licenseUrl || '';
    if (!licUrl) return res.status(400).json({ error: 'PlayReady license URL not configured' });
    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    try {
      const resp = await safeFetch(licUrl, {
        method: 'POST', body: challenge,
        headers: Object.assign({
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction':   '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"',
          'User-Agent':   nextUA(),
        }, drmCfg.customHeaders || {}),
      }, 20000);
      res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    } catch(e) { return res.status(502).json({ error: 'PlayReady error: ' + e.message }); }
  }

  // ── FairPlay ───────────────────────────────────────────────────────────────
  if (licType === 'fairplay') {
    const licUrl = drmCfg.licenseUrl || '';
    if (!licUrl) return res.status(400).json({ error: 'FairPlay license URL not configured' });
    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    try {
      const resp = await safeFetch(licUrl, {
        method: 'POST', body: challenge,
        headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'User-Agent': nextUA() }, drmCfg.customHeaders || {}),
      }, 20000);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    } catch(e) { return res.status(502).json({ error: 'FairPlay error: ' + e.message }); }
  }

  res.status(400).json({ error: 'Unsupported DRM type: ' + licType });
}

app.post('/license/:id',           (req, res) => handleLicense(req, res, req.params.id));
app.post('/proxy/drm-license/:id', (req, res) => handleLicense(req, res, req.params.id));
app.get('/license/:id',            (req, res) => handleLicense(req, res, req.params.id));

// ─── PSSH Inspector ───────────────────────────────────────────────────────────
app.get('/api/drm/pssh/:id', async (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  try {
    const resp    = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 20000);
    const content = resp.text();
    const info    = extractFromMPD(content);
    res.json({
      channelId: ch.id, channelName: ch.name, url: ch.url,
      psshs: info.psshs.map(p => ({ systemId: p.systemId, drmType: p.drmType, kids: p.kids, psshBase64: p.psshBase64 })),
      kids: info.kids, licenseUrls: info.licenseUrls, manifestSnippet: content.substring(0, 500),
    });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ─── Channels CRUD ────────────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const db = loadDB(); let chs = db.channels || [];
  if (req.query.group)        chs = chs.filter(c => c.group === req.query.group);
  if (req.query.tamil === '1') chs = chs.filter(isTamil);
  if (req.query.active === '1') chs = chs.filter(c => c.enabled !== false);
  if (req.query.drm === '1')   chs = chs.filter(isDrmChannel);
  if (req.query.direct === '1') chs = chs.filter(c => !isDrmChannel(c));
  if (req.query.source)        chs = chs.filter(c => c.sourceId === req.query.source);
  if (req.query.health)        chs = chs.filter(c => c.healthStatus === req.query.health);
  res.json(chs);
});
app.get('/api/channels/:id', (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  res.json(ch);
});
app.post('/api/channels', (req, res) => {
  const db = loadDB();
  const ch = Object.assign({}, req.body, {
    id: req.body.id || ('ch_' + Date.now()),
    order: (db.channels || []).length,
    enabled: true, isActive: true,
    isTamil: isTamil(req.body),
  });
  db.channels = (db.channels || []).concat([ch]); saveDB(db); rebuildMap(); res.json(ch);
});
app.put('/api/channels/:id', (req, res) => {
  const db = loadDB(); let found = false;
  db.channels = (db.channels || []).map(c => {
    if (c.id !== req.params.id) return c;
    found = true;
    const u = Object.assign({}, c, req.body, { id: c.id });
    u.isTamil = isTamil(u);
    return u;
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db); rebuildMap(); res.json({ ok: true });
});
app.patch('/api/channel/:id', (req, res) => {
  const db = loadDB();
  db.channels = (db.channels || []).map(c => c.id === req.params.id ? Object.assign({}, c, req.body) : c);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});
app.delete('/api/channels/:id', (req, res) => {
  const db = loadDB();
  db.channels   = (db.channels   || []).filter(c => c.id !== req.params.id);
  db.drmProxies = (db.drmProxies || []).filter(d => d.channelId !== req.params.id);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});

// ─── Groups CRUD ──────────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  const db = loadDB(), chs = db.channels || [];
  const names = Array.from(new Set(chs.map(c => c.group || 'Uncategorized')));
  res.json(names.map(name => {
    const saved = (db.groups || []).find(g => g.name === name);
    return {
      name,
      count:       chs.filter(c => (c.group || 'Uncategorized') === name).length,
      tamilCount:  chs.filter(c => (c.group || 'Uncategorized') === name && isTamil(c)).length,
      drmCount:    chs.filter(c => (c.group || 'Uncategorized') === name && isDrmChannel(c)).length,
      healthyCount:chs.filter(c => (c.group || 'Uncategorized') === name && c.healthStatus === 'ok').length,
      isActive:    saved ? (saved.isActive !== false) : true,
    };
  }));
});
app.put('/api/groups/:name', (req, res) => {
  const db = loadDB(), name = decodeURIComponent(req.params.name);
  if (req.body.newName && req.body.newName !== name)
    db.channels = (db.channels || []).map(c => (c.group || 'Uncategorized') === name ? Object.assign({}, c, { group: req.body.newName }) : c);
  const existing = (db.groups || []).find(g => g.name === name);
  db.groups = existing
    ? (db.groups || []).map(g => g.name === name ? Object.assign({}, g, req.body) : g)
    : (db.groups || []).concat([Object.assign({ name }, req.body)]);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});
app.delete('/api/groups/:name', (req, res) => {
  const db = loadDB(), name = decodeURIComponent(req.params.name);
  db.channels = (db.channels || []).filter(c => (c.group || 'Uncategorized') !== name);
  db.groups   = (db.groups   || []).filter(g => g.name !== name);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});

// ─── Sources CRUD ─────────────────────────────────────────────────────────────
app.get('/api/sources', (_req, res) => { res.json(loadDB().sources || []); });
app.post('/api/sources', (req, res) => {
  const db  = loadDB();
  const src = Object.assign({}, req.body, { id: req.body.id || ('src_' + Date.now()), createdAt: new Date().toISOString() });
  db.sources = (db.sources || []).concat([src]); saveDB(db); res.json(src);
});
app.put('/api/sources/:id', (req, res) => {
  const db = loadDB();
  db.sources = (db.sources || []).map(s => s.id === req.params.id ? Object.assign({}, s, req.body, { id: s.id }) : s);
  saveDB(db); res.json({ ok: true });
});
app.delete('/api/sources/:id', (req, res) => {
  const db = loadDB();
  db.sources = (db.sources || []).filter(s => s.id !== req.params.id);
  saveDB(db); res.json({ ok: true });
});

// ─── DRM Proxies CRUD ─────────────────────────────────────────────────────────
app.get('/api/drm', (_req, res) => { res.json(loadDB().drmProxies || []); });
app.post('/api/drm', (req, res) => {
  const db  = loadDB(), BASE = req.protocol + '://' + req.get('host'), id = 'drm_' + Date.now();
  const proxy = Object.assign({}, req.body, {
    id, isActive: true,
    proxyUrl:        `${BASE}/live/${req.body.channelId}.mpd`,
    licenseEndpoint: `${BASE}/license/${id}`,
    createdAt:       new Date().toISOString(),
  });
  db.drmProxies = (db.drmProxies || []).concat([proxy]); saveDB(db); res.json(proxy);
});
app.put('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).map(d => d.id === req.params.id ? Object.assign({}, d, req.body, { id: d.id }) : d);
  saveDB(db); res.json({ ok: true });
});
app.delete('/api/drm/:id', (req, res) => {
  const db = loadDB();
  db.drmProxies = (db.drmProxies || []).filter(d => d.id !== req.params.id);
  saveDB(db); res.json({ ok: true });
});

// ─── Sync — push full DB from UI ─────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    if (Array.isArray(data.channels))
      data.channels = data.channels.map(ch => Object.assign({}, ch, { isTamil: isTamil(ch) }));
    const ok = saveDB(Object.assign({}, EMPTY_DB, data));
    rebuildMap();
    const chs = data.channels || [];
    console.log(`[Sync] ch=${chs.length} drm=${chs.filter(isDrmChannel).length} direct=${chs.filter(c => !isDrmChannel(c)).length} tamil=${chs.filter(isTamil).length}`);
    res.json({
      ok, synced: {
        channels:       chs.length,
        playlists:      (data.playlists  || []).length,
        drmProxies:     (data.drmProxies || []).length,
        sources:        (data.sources    || []).length,
        drmChannels:    chs.filter(isDrmChannel).length,
        directChannels: chs.filter(c => !isDrmChannel(c)).length,
        tamilChannels:  chs.filter(isTamil).length,
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DB Export / Import ───────────────────────────────────────────────────────
app.get('/api/db/export', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="iptv-db-${Date.now()}.json"`);
  res.json(loadDB());
});
app.post('/api/db/import', (req, res) => {
  try { saveDB(req.body); rebuildMap(); res.json({ ok: true, channels: (req.body.channels || []).length }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Test endpoint
app.get('/api/test/:id', authCheck, async (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  try {
    const resp = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 10000);
    res.json({
      success:     resp.ok,
      status:      resp.status,
      contentType: resp.headers['content-type'],
      size:        resp.body.length,
      name:        ch.name,
      isDrm:       isDrmChannel(ch),
      isTamil:     isTamil(ch),
      needsProxy:  isDrmChannel(ch) || needsHeaderProxy(ch),
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Auto-Refresh Sources ─────────────────────────────────────────────────────
function doAutoRefresh() {
  const db      = loadDB();
  const sources = (db.sources || []).filter(s => s.autoRefresh && s.url && (s.refreshInterval || 0) > 0);
  if (!sources.length) return;
  sources.forEach(src => {
    const lastRefresh = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    const intervalMs  = (src.refreshInterval || 30) * 60 * 1000;
    if (Date.now() - lastRefresh < intervalMs) return;
    console.log('[AutoRefresh]', src.name, src.url);
    safeFetch(src.url, { headers: { 'User-Agent': nextUA() } }, 25000)
      .then(resp => {
        const freshDB = loadDB();
        freshDB.sources = (freshDB.sources || []).map(s => s.id !== src.id ? s
          : Object.assign({}, s, { lastRefreshed: new Date().toISOString(), status: resp.ok ? 'success' : 'error' }));
        saveDB(freshDB);
      })
      .catch(e => {
        const freshDB = loadDB();
        freshDB.sources = (freshDB.sources || []).map(s => s.id !== src.id ? s
          : Object.assign({}, s, { status: 'error', errorMessage: e.message }));
        saveDB(freshDB);
      });
  });
}
setInterval(doAutoRefresh, 60 * 1000);
setTimeout(doAutoRefresh, 8 * 1000);

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/') ||
      req.path.startsWith('/live/') || req.path.startsWith('/license/')) {
    return res.status(404).json({ error: 'Not found: ' + req.path });
  }
  const indexFile = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(200).type('html').send(`<!DOCTYPE html><html><head><title>IPTV Manager v9</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem}
a{color:#38bdf8}.ok{color:#10b981}.badge{background:#1d4ed8;color:#fff;padding:2px 8px;border-radius:12px;font-size:.75em}
</style></head><body>
<h1>🚀 IPTV Manager Server v9.0 <span class="badge">HEALTH + DRM + TAMIL</span></h1>
<p><span class="ok">✅ RUNNING</span> | <a href="/health">/health</a> | <a href="/api/stats">/api/stats</a></p>
<h3>📺 Playlists</h3>
<p><a href="/api/playlist/all.m3u">/api/playlist/all.m3u</a> · <a href="/api/playlist/tamil.m3u">/api/playlist/tamil.m3u</a></p>
<h3>🏥 Health</h3>
<p>GET /api/health/:id · POST /api/health/batch · GET /api/health/all</p>
<h3>🔐 DRM (proxy only for DRM streams)</h3>
<p>GET /live/:id.mpd · GET /live/:id.m3u8 · GET /live/:id.ts · POST /license/:id</p>
<h3>🔁 Direct Streams</h3>
<p>GET /proxy/redirect/:id → 302 to original URL (zero overhead)</p>
</body></html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🚀  IPTV Manager Server v9.0  —  Health + DRM + Tamil    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  🌐  URL:          http://0.0.0.0:${PORT}`);
  console.log(`  📺  All:          http://0.0.0.0:${PORT}/api/playlist/all.m3u`);
  console.log(`  🇮🇳  Tamil:        http://0.0.0.0:${PORT}/api/playlist/tamil.m3u`);
  console.log(`  🔁  Direct:       302 redirect → original URL (zero overhead)`);
  console.log(`  🔐  DRM DASH:     http://0.0.0.0:${PORT}/live/:id.mpd`);
  console.log(`  🔐  DRM HLS:      http://0.0.0.0:${PORT}/live/:id.m3u8`);
  console.log(`  🎬  DRM TS:       http://0.0.0.0:${PORT}/live/:id.ts [FFmpeg]`);
  console.log(`  🏥  Health:       http://0.0.0.0:${PORT}/api/health/:id`);
  console.log(`  📊  Stats:        http://0.0.0.0:${PORT}/api/stats`);
  console.log(`  💾  DB:           ${DB_FILE}\n`);
});
