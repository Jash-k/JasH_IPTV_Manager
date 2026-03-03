'use strict';
/**
 * IPTV Manager Server v10.0
 * ══════════════════════════════════════════════════════════════════════════════
 * ROUTING:
 *   Non-DRM streams  → GET /proxy/redirect/:id  → pure 302 to original URL
 *   DRM streams ONLY → /live/:id.mpd | .m3u8 | .ts  (full proxy pipeline)
 *
 * MULTI-SOURCE BEST-LINK:
 *   GET /api/bestlink/:name  → HEAD all links for same channel name → fastest wins
 *   GET /proxy/best/:name    → redirect to the best live link dynamically
 *
 * KEEP-ALIVE (Render free tier):
 *   Pings /health every 14 min to prevent sleep
 *
 * HEALTH:
 *   GET  /health              → server heartbeat
 *   GET  /api/health/:id      → single channel HEAD check
 *   POST /api/health/batch    → up to 50 channels concurrently
 */

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const https     = require('https');
const { spawn } = require('child_process');
const { URL }   = require('url');

const app  = express();
const PORT = parseInt(process.env.PORT || '10000', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'] }));
app.options('*', cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/license',           express.raw({ type: '*/*', limit: '4mb' }));
app.use('/proxy/drm-license', express.raw({ type: '*/*', limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Database ─────────────────────────────────────────────────────────────────
const DB_FILE  = process.env.DB_FILE || path.join(__dirname, 'db.json');
const EMPTY_DB = { channels: [], playlists: [], drmProxies: [], sources: [], groups: [] };

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return JSON.parse(JSON.stringify(EMPTY_DB));
    return Object.assign({}, JSON.parse(JSON.stringify(EMPTY_DB)), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) { console.error('[DB] Load error:', e.message); return JSON.parse(JSON.stringify(EMPTY_DB)); }
}

function saveDB(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('[DB] Save error:', e.message); return false; }
}

// O(1) channel lookup map
let _channelsMap = {};
let _channelsByName = {}; // grouped by normalized name for multi-source best-link

function rebuildMap() {
  const db = loadDB();
  _channelsMap = {};
  _channelsByName = {};
  (db.channels || []).forEach(ch => {
    if (!ch || !ch.id) return;
    _channelsMap[ch.id] = ch;
    const key = normName(ch.name);
    if (!_channelsByName[key]) _channelsByName[key] = [];
    _channelsByName[key].push(ch);
  });
}
rebuildMap();

function getChannel(id)  { return _channelsMap[id] || null; }
function normName(n)     { return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim(); }

// ─── User Agents ──────────────────────────────────────────────────────────────
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-S908B Build/SP1A.210812.016)',
  'ExoPlayerLib/2.19.1', 'VLC/3.0.21 LibVLC/3.0.21',
  'okhttp/4.12.0', 'TiviMate/4.7.0', 'Kodi/21.0 (Windows; Windows 10; x64)',
];
let _uaIdx = 0;
function nextUA() { return UAS[(_uaIdx++) % UAS.length]; }

// ─── Stream helpers ───────────────────────────────────────────────────────────
function isDRM(ch) {
  return !!(ch && (ch.isDrm || ch.licenseType || ch.licenseKey || ch.drmKey || ch.drmLicense));
}
function needsHeaderPipe(ch) {
  return !!(ch && (ch.cookie || ch.referer || ch.userAgent ||
    (ch.httpHeaders && Object.keys(ch.httpHeaders || {}).length > 0)));
}
function getStreamType(ch) {
  const u = (ch.url || '').toLowerCase();
  if (u.includes('.mpd')  || u.includes('/dash/'))  return 'dash';
  if (u.includes('.m3u8') || u.includes('/hls/'))   return 'hls';
  return 'direct';
}

// ─── Tamil detection ──────────────────────────────────────────────────────────
const TAMIL_KW = [
  'tamil','sun tv','vijay tv','star vijay','zee tamil','kalaignar','raj tv',
  'jaya tv','jaya max','polimer','captain tv','vendhar','vasanth','adithya',
  'isai aruvi','mozhi','puthuyugam','news7 tamil','news18 tamil','thanthi tv',
  'sathiyam','makkal isai','sirippoli','peppers tv','chutti tv','colors tamil',
  'dd tamil','doordarshan tamil','sun music','imayam','murasu','shakthi',
  'gem tv','thirai','vijay super','puthiya thalaimurai','tamilnadu','sun news',
  'mega tv','zee thirai','kaveri','rainbow','vikatan','nakkheeran','seithigal',
  'news 7 tamil','news 18 tamil','covai','madurai','coimbatore','trichy',
];
function ss(v) { return typeof v === 'string' ? v.toLowerCase() : String(v || '').toLowerCase(); }
function isTamil(ch) {
  if (!ch) return false;
  if (ch.isTamil === true) return true;
  const hay = `${ss(ch.name)} ${ss(ch.group)} ${ss(ch.language)} ${ss(ch.tvgName)} ${ss(ch.country)} ${ss(ch.tvgId)}`;
  return TAMIL_KW.some(k => hay.includes(k)) || ss(ch.language) === 'tamil';
}

// ─── HTTP fetch (Node native, no dependencies) ────────────────────────────────
function safeFetch(targetUrl, options, timeoutMs, _redir) {
  options   = options || {};
  timeoutMs = timeoutMs || 20000;
  _redir    = _redir || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error('Invalid URL: ' + targetUrl)); }
    const lib  = parsed.protocol === 'https:' ? https : http;
    const hdrs = Object.assign({ 'User-Agent': nextUA(), 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive' }, options.headers || {});
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.pathname || '/') + (parsed.search || ''),
      method: options.method || 'GET',
      headers: hdrs,
      rejectUnauthorized: false,
    };
    const timer = setTimeout(() => { try { req.destroy(); } catch {} reject(new Error('Timeout')); }, timeoutMs);
    const req = lib.request(reqOpts, res => {
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (_redir >= 10) return reject(new Error('Too many redirects'));
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = parsed.protocol + '//' + parsed.host + loc;
        return safeFetch(loc, options, timeoutMs, _redir + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, headers: res.headers, body, text: () => body.toString('utf8') });
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

// ─── HEAD check (stream health, no body download) ────────────────────────────
function headCheck(targetUrl, headers, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return resolve({ ok: false, status: 0, latency: 0, error: 'invalid url' }); }
    const lib   = parsed.protocol === 'https:' ? https : http;
    const start = Date.now();
    const timer = setTimeout(() => { try { req.destroy(); } catch {} resolve({ ok: false, status: 0, latency: timeoutMs, error: 'timeout' }); }, timeoutMs);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.pathname || '/') + (parsed.search || ''),
      method: 'HEAD',
      headers: Object.assign({ 'User-Agent': nextUA(), 'Accept': '*/*' }, headers || {}),
      rejectUnauthorized: false,
    }, res => {
      clearTimeout(timer);
      res.resume();
      const latency = Date.now() - start;
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, latency, contentType: res.headers['content-type'] || '' });
    });
    req.on('error', e => { clearTimeout(timer); resolve({ ok: false, status: 0, latency: Date.now() - start, error: e.message }); });
    req.end();
  });
}

function buildHeaders(ch, overrides) {
  ch = ch || {}; overrides = overrides || {};
  const hdrs = {};
  if (ch.httpHeaders) Object.assign(hdrs, ch.httpHeaders);
  hdrs['User-Agent']      = ch.userAgent || nextUA();
  hdrs['Accept']          = '*/*';
  hdrs['Accept-Language'] = 'en-US,en;q=0.9';
  hdrs['Accept-Encoding'] = 'identity';
  hdrs['Connection']      = 'keep-alive';
  if (ch.referer) { hdrs['Referer'] = ch.referer; hdrs['Origin'] = ch.referer.replace(/\/[^/]*$/, ''); }
  if (ch.cookie)  hdrs['Cookie'] = ch.cookie;
  Object.assign(hdrs, overrides);
  return hdrs;
}

// ─── Pipe live stream to player ───────────────────────────────────────────────
function pipeStream(targetUrl, headers, res, _redir) {
  _redir = _redir || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error('Bad URL')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.pathname || '/') + (parsed.search || ''),
      method: 'GET', headers, rejectUnauthorized: false,
    }, upstream => {
      if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
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

// ─── DRM Helpers ──────────────────────────────────────────────────────────────
function hexToBase64url(hex) {
  if (!hex) return '';
  try {
    const clean = String(hex).replace(/[-\s]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(clean)) return Buffer.from(hex).toString('base64url');
    return Buffer.from(clean, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch { return hex; }
}
function base64urlToHex(b64) {
  if (!b64) return '';
  try { return Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'); } catch { return ''; }
}
function toHex(val) {
  if (!val) return '';
  const s = String(val).replace(/[-\s]/g, '');
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 32) return s.toLowerCase();
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'); } catch { return ''; }
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

function resolveDRMConfig(channelId, ch, db) {
  let cfg = (db.drmProxies || []).find(d => d.channelId === channelId && d.isActive !== false);
  if (!cfg && isDRM(ch)) {
    cfg = {
      id: ch.id, channelId: ch.id,
      licenseType: ch.licenseType || 'clearkey',
      licenseKey:  ch.licenseKey || ch.drmKey || ch.drmLicense || '',
      licenseUrl:  ch.licenseUrl || (ch.licenseKey && ch.licenseKey.startsWith('http') ? ch.licenseKey : ''),
      keyId:       ch.keyId || ch.drmKeyId || '',
      key:         ch.key || '',
      customHeaders: ch.httpHeaders || {},
    };
  }
  return cfg || null;
}

// ─── MPD Rewriter ─────────────────────────────────────────────────────────────
function getBaseUrl(url) { try { return url.substring(0, url.lastIndexOf('/') + 1); } catch { return ''; } }

function rewriteMPD(mpdContent, channelId, baseUrl, proxyHost, drmCfg) {
  let out = mpdContent;
  out = out.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (_, url) => {
    const full = url.startsWith('http') ? url : baseUrl + url;
    return `<BaseURL>${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(full)}</BaseURL>`;
  });
  out = out.replace(/media="([^"]+)"/g, (_, url) => {
    if (url.startsWith('http')) return `media="${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(url)}"`;
    return `media="${proxyHost}/proxy/${channelId}/segment?path=${encodeURIComponent(url)}"`;
  });
  out = out.replace(/initialization="([^"]+)"/g, (_, url) => {
    if (url.startsWith('http')) return `initialization="${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(url)}"`;
    return `initialization="${proxyHost}/proxy/${channelId}/segment?path=${encodeURIComponent(url)}"`;
  });
  if (drmCfg) {
    const licEndpoint = `${proxyHost}/license/${channelId}`;
    const lt = (drmCfg.licenseType || 'clearkey').toLowerCase();
    if (lt === 'clearkey') {
      if (!out.includes('ContentProtection')) {
        const inject = `<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"><clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licEndpoint}</clearkey:Laurl></ContentProtection>`;
        out = out.replace(/<AdaptationSet/i, inject + '\n<AdaptationSet');
      } else {
        out = out.replace(/(<ContentProtection[^>]*e2719d58[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi, (m, o, i, c) => {
          if (!i.includes('Laurl')) i += `<clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">${licEndpoint}</clearkey:Laurl>`;
          return o + i + c;
        });
      }
    } else if (lt === 'widevine') {
      out = out.replace(/(<ContentProtection[^>]*edef8ba9[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi, (m, o, i, c) => {
        if (!i.includes('dashif:Laurl')) i += `<dashif:Laurl xmlns:dashif="https://dashif.org" Lic_type="EME-1.0">${licEndpoint}</dashif:Laurl>`;
        return o + i + c;
      });
    } else if (lt === 'playready') {
      out = out.replace(/(<ContentProtection[^>]*9a04f079[^>]*>)([\s\S]*?)(<\/ContentProtection>)/gi, (m, o, i, c) => {
        if (!i.includes('mspr:la_url')) i += `<mspr:la_url xmlns:mspr="urn:microsoft:playready">${licEndpoint}</mspr:la_url>`;
        return o + i + c;
      });
    }
  }
  return out;
}

// ─── HLS Rewriter ─────────────────────────────────────────────────────────────
function rewriteHLS(hlsContent, channelId, manifestUrl, proxyHost, drmCfg) {
  const lines = hlsContent.split(/\r?\n/);
  const base  = getBaseUrl(manifestUrl);
  const out   = [];
  if (drmCfg) {
    const licEndpoint = `${proxyHost}/license/${channelId}`;
    const lt = (drmCfg.licenseType || 'clearkey').toLowerCase();
    if (lt === 'clearkey')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="${licEndpoint}"`);
    else if (lt === 'widevine')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="${licEndpoint}",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"`);
    else if (lt === 'playready')
      out.push(`#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="${licEndpoint}",KEYFORMAT="com.microsoft.playready",KEYFORMATVERSIONS="1"`);
  }
  for (const line of lines) {
    const t = line.trim();
    if (drmCfg && (t.startsWith('#EXT-X-KEY:') || t.startsWith('#EXT-X-SESSION-KEY:'))) continue;
    if (t && !t.startsWith('#')) {
      let segUrl = t;
      if (!segUrl.startsWith('http') && !segUrl.startsWith('//'))
        segUrl = segUrl.startsWith('/') ? (new URL(manifestUrl).origin + segUrl) : (base + segUrl);
      out.push(`${proxyHost}/proxy/${channelId}/?url=${encodeURIComponent(segUrl)}`);
      continue;
    }
    if (t.startsWith('#EXT-X-KEY:') && !drmCfg) {
      out.push(line.replace(/URI="([^"]+)"/, (_, uri) => {
        const full = uri.startsWith('http') ? uri : base + uri;
        return `URI="${proxyHost}/proxy/${channelId}/key?url=${encodeURIComponent(full)}"`;
      }));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ─── FFmpeg DRM stream ────────────────────────────────────────────────────────
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
  const extraHdrs = [];
  if (ch.referer)     extraHdrs.push(`Referer: ${ch.referer}`);
  if (ch.cookie)      extraHdrs.push(`Cookie: ${ch.cookie}`);
  if (ch.httpHeaders) Object.entries(ch.httpHeaders).forEach(([k, v]) => extraHdrs.push(`${k}: ${v}`));
  if (extraHdrs.length) args.push('-headers', extraHdrs.map(h => h + '\r\n').join(''));
  const keyStr = ch.licenseKey || ch.drmKey || ch.drmLicense || '';
  const pairs  = parseClearKeyPairs(keyStr);
  if (pairs.length > 0) args.push('-decryption_key', pairs[0].key);
  else if (ch.key)      args.push('-decryption_key', toHex(ch.key));
  args.push('-i', ch.url, '-c', 'copy', '-f', 'mpegts', 'pipe:1');
  console.log(`[FFmpeg] ${ch.name}`);
  const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', d => { const l = d.toString().trim(); if (l) console.error(`[FFmpeg:${ch.id}] ${l}`); });
  ffmpeg.on('error', err => { if (!res.headersSent) res.status(500).send('FFmpeg error: ' + err.message); });
  ffmpeg.on('close', () => { if (!res.writableEnded) res.end(); });
  res.on('close', () => ffmpeg.kill('SIGTERM'));
}

// ─── M3U Generator ───────────────────────────────────────────────────────────
// DRM   → /live/:id.mpd|.m3u8|.ts
// Direct → /proxy/redirect/:id (server does 302 to original URL — zero overhead)
function generateM3U(channels, baseUrl, playlistName) {
  const lines = [`#EXTM3U x-tvg-url="" playlist-name="${String(playlistName || 'IPTV').replace(/"/g, '')}"`];
  channels.forEach(ch => {
    if (!ch || !ch.id || !ch.url) return;
    const hasDRM   = isDRM(ch);
    const urlLower = (ch.url || '').toLowerCase();
    const isMPD    = urlLower.includes('.mpd')  || urlLower.includes('/dash/');
    const isM3U8   = urlLower.includes('.m3u8') || urlLower.includes('/hls/');

    let streamUrl;
    if (hasDRM) {
      if      (isMPD)  streamUrl = `${baseUrl}/live/${ch.id}.mpd`;
      else if (isM3U8) streamUrl = `${baseUrl}/live/${ch.id}.m3u8`;
      else             streamUrl = `${baseUrl}/live/${ch.id}.ts`;
    } else {
      // Direct streams → 302 redirect to original URL, player connects directly
      streamUrl = `${baseUrl}/proxy/redirect/${ch.id}`;
    }

    if (hasDRM) {
      const lt  = (ch.licenseType || 'clearkey').toLowerCase();
      const lic = `${baseUrl}/license/${ch.id}`;
      lines.push('#KODIPROP:inputstream=inputstream.adaptive');
      lines.push(isMPD ? '#KODIPROP:inputstream.adaptive.manifest_type=mpd' : '#KODIPROP:inputstream.adaptive.manifest_type=hls');
      if (lt === 'widevine') {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
      } else if (lt === 'playready') {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
      } else {
        lines.push('#KODIPROP:inputstream.adaptive.license_type=clearkey');
        lines.push(`#KODIPROP:inputstream.adaptive.license_key=${lic}||R{SSM}|`);
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Health / Keepalive ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), version: '10.0.0', routing: 'DRM→proxy | Direct→302' });
});

// ─── Stream Health Check ──────────────────────────────────────────────────────
app.get('/api/health/:id', async (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel not found' });
  const hasDRM  = isDRM(ch);
  const result  = await headCheck(ch.url, buildHeaders(ch, {}), 10000);
  const st      = getStreamType(ch);
  const BASE    = req.protocol + '://' + req.get('host');
  const proxyUrl = hasDRM
    ? (st === 'dash' ? `${BASE}/live/${ch.id}.mpd` : st === 'hls' ? `${BASE}/live/${ch.id}.m3u8` : `${BASE}/live/${ch.id}.ts`)
    : `${BASE}/proxy/redirect/${ch.id}`;

  const db = loadDB();
  db.channels = (db.channels || []).map(c => c.id === ch.id
    ? Object.assign({}, c, { healthStatus: result.ok ? 'ok' : 'error', lastHealthCheck: new Date().toISOString(), healthLatency: result.latency })
    : c);
  saveDB(db); rebuildMap();

  res.json({ ok: result.ok, status: result.status, latency: result.latency, contentType: result.contentType || '',
    error: result.error || null, isDrm: hasDRM, streamType: st, proxyUrl,
    channelName: ch.name, channelGroup: ch.group, isTamil: isTamil(ch), routing: hasDRM ? 'drm-proxy' : 'direct-302',
    checkedAt: new Date().toISOString() });
});

app.post('/api/health/batch', async (req, res) => {
  const ids  = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 50) : [];
  const BASE = req.protocol + '://' + req.get('host');
  const results = await Promise.allSettled(ids.map(async id => {
    const ch = getChannel(id);
    if (!ch) return { id, ok: false, error: 'Not found' };
    const check = await headCheck(ch.url, buildHeaders(ch, {}), 8000);
    return { id, name: ch.name, group: ch.group, isTamil: isTamil(ch), isDrm: isDRM(ch), routing: isDRM(ch) ? 'drm-proxy' : 'direct-302', ...check };
  }));
  const healthMap = {};
  results.forEach((r, i) => { healthMap[ids[i]] = r.status === 'fulfilled' ? r.value : { id: ids[i], ok: false, error: String(r.reason) }; });
  const db = loadDB();
  db.channels = (db.channels || []).map(ch => {
    if (!healthMap[ch.id]) return ch;
    return Object.assign({}, ch, { healthStatus: healthMap[ch.id].ok ? 'ok' : 'error', lastHealthCheck: new Date().toISOString(), healthLatency: healthMap[ch.id].latency });
  });
  saveDB(db); rebuildMap();
  res.json({ checked: ids.length, results: healthMap, checkedAt: new Date().toISOString(), serverUrl: BASE });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MULTI-SOURCE BEST-LINK SELECTOR
//  When multiple sources have the same channel name, HEAD all links in parallel
//  and redirect to the fastest responding live link.
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/bestlink/:name', async (req, res) => {
  const key  = normName(req.params.name);
  const chs  = _channelsByName[key] || [];
  if (!chs.length) return res.status(404).json({ error: 'No channels found with name: ' + req.params.name });

  const checks = await Promise.allSettled(chs.map(async ch => {
    const start = Date.now();
    const r = await headCheck(ch.url, buildHeaders(ch, {}), 6000);
    return { id: ch.id, name: ch.name, url: ch.url, sourceId: ch.sourceId, isDrm: isDRM(ch),
      ok: r.ok, status: r.status, latency: Date.now() - start, contentType: r.contentType };
  }));

  const candidates = checks
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value)
    .sort((a, b) => a.latency - b.latency);

  res.json({
    channelName: req.params.name,
    totalLinks: chs.length,
    liveLinks: candidates.length,
    best: candidates[0] || null,
    all: checks.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) }),
  });
});

// Redirect to best live link for a channel name — used in playlists
app.get('/proxy/best/:name', async (req, res) => {
  const key  = normName(req.params.name);
  const chs  = _channelsByName[key] || [];
  if (!chs.length) return res.status(404).send('No channels found');

  // Head check all in parallel with 5s timeout
  const checks = await Promise.allSettled(chs.map(async ch => {
    const start = Date.now();
    const r = await headCheck(ch.url, buildHeaders(ch, {}), 5000);
    return { ch, ok: r.ok, latency: Date.now() - start };
  }));

  const best = checks
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value)
    .sort((a, b) => a.latency - b.latency)[0];

  if (!best) return res.status(502).send('No live links found for: ' + req.params.name);

  const ch  = best.ch;
  const BASE = req.protocol + '://' + req.get('host');

  if (isDRM(ch)) {
    const st = getStreamType(ch);
    if (st === 'dash')     return res.redirect(302, `${BASE}/live/${ch.id}.mpd`);
    if (st === 'hls')      return res.redirect(302, `${BASE}/live/${ch.id}.m3u8`);
    return res.redirect(302, `${BASE}/live/${ch.id}.ts`);
  }

  if (needsHeaderPipe(ch)) {
    pipeStream(ch.url, buildHeaders(ch, {}), res).catch(e => {
      if (!res.headersSent) res.status(502).send('Stream error: ' + e.message);
    });
  } else {
    res.redirect(302, ch.url);
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db  = loadDB();
  const chs = db.channels || [];
  const BASE = req.protocol + '://' + req.get('host');
  const multiSourceNames = Object.entries(_channelsByName).filter(([, arr]) => arr.length > 1);
  res.json({
    version: '10.0.0', uptime: Math.floor(process.uptime()), nodeVersion: process.version,
    channels: chs.length, activeChannels: chs.filter(c => c.enabled !== false).length,
    tamilChannels: chs.filter(isTamil).length, drmChannels: chs.filter(isDRM).length,
    directChannels: chs.filter(c => !isDRM(c)).length, healthyChannels: chs.filter(c => c.healthStatus === 'ok').length,
    multiSourceChannels: multiSourceNames.length,
    groups: new Set(chs.map(c => c.group || 'Uncategorized')).size,
    playlists: (db.playlists || []).length, sources: (db.sources || []).length,
    routing: 'DRM→proxy | Direct→302',
    quickUrls: {
      all:     `${BASE}/api/playlist/all.m3u`,
      tamil:   `${BASE}/api/playlist/tamil.m3u`,
      legacy:  `${BASE}/playlist.m3u`,
      bestLink: `${BASE}/proxy/best/:channelName`,
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
  res.send(generateM3U(chs, BASE, 'IPTV Playlist'));
});

app.get('/api/playlist/all.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, 'All Channels'));
});

app.get('/api/playlist/tamil.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false && isTamil(c));
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, 'Tamil Channels'));
});

app.get('/api/playlist/source/:sourceId/tamil.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const chs = (db.channels || []).filter(c => c.enabled !== false && c.sourceId === req.params.sourceId && isTamil(c));
  const src = (db.sources  || []).find(s => s.id === req.params.sourceId);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, `${src ? src.name : 'Source'} — Tamil`));
});

app.get('/api/playlist/source/:sourceId.m3u', (req, res) => {
  const db = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const src = (db.sources  || []).find(s => s.id === req.params.sourceId);
  let chs   = (db.channels || []).filter(c => c.enabled !== false && c.sourceId === req.params.sourceId);
  if (src && src.tamilFilter) chs = chs.filter(isTamil);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3U(chs, BASE, src ? src.name : 'Source Playlist'));
});

app.get('/api/playlist/:id.m3u', (req, res) => {
  const db  = loadDB(), BASE = req.protocol + '://' + req.get('host');
  const pl  = (db.playlists || []).find(p => p.id === req.params.id);
  if (!pl) {
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send('#EXTM3U\r\n#EXTINF:-1,Playlist Not Found\r\nhttp://localhost/notfound\r\n');
  }
  const chs = filterChannels(pl, db.channels || []);
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Disposition', `inline; filename="${(pl.name || 'playlist').replace(/[^a-z0-9_\-]/gi, '_')}.m3u"`);
  res.send(generateM3U(chs, BASE, pl.name));
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
  db.playlists = (db.playlists || []).map(p => { if (p.id !== req.params.id) return p; found = true; return Object.assign({}, p, req.body, { id: p.id }); });
  if (!found) return res.status(404).json({ error: 'Not found' });
  saveDB(db); res.json({ ok: true });
});
app.delete('/api/playlists/:id', (req, res) => {
  const db = loadDB(); db.playlists = (db.playlists || []).filter(p => p.id !== req.params.id); saveDB(db); res.json({ ok: true });
});

// ─── DRM Stream Endpoints (DRM streams ONLY) ──────────────────────────────────
app.get('/live/:id.mpd', async (req, res) => {
  const id  = req.params.id;
  const ch  = getChannel(id);
  if (!ch)  return res.status(404).json({ error: 'Channel not found: ' + id });
  const db  = loadDB();
  const cfg = resolveDRMConfig(id, ch, db);
  const HOST = req.protocol + '://' + req.get('host');
  try {
    const resp = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 20000);
    if (!resp.ok) return res.status(resp.status).send('Upstream error: ' + resp.status);
    const rewritten = rewriteMPD(resp.text(), id, getBaseUrl(ch.url), HOST, cfg);
    res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (e) { res.status(502).json({ error: 'MPD fetch failed', details: e.message }); }
});

app.get('/live/:id.m3u8', async (req, res) => {
  const id  = req.params.id;
  const ch  = getChannel(id);
  if (!ch)  return res.status(404).json({ error: 'Channel not found: ' + id });
  const db  = loadDB();
  const cfg = resolveDRMConfig(id, ch, db);
  const HOST = req.protocol + '://' + req.get('host');
  try {
    const resp = await safeFetch(ch.url, { headers: buildHeaders(ch, {}) }, 20000);
    if (!resp.ok) return res.status(resp.status).send('Upstream error: ' + resp.status);
    const rewritten = rewriteHLS(resp.text(), id, ch.url, HOST, cfg);
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(rewritten);
  } catch (e) { res.status(502).json({ error: 'HLS fetch failed', details: e.message }); }
});

app.get('/live/:id.ts', (req, res) => {
  const id = req.params.id;
  const ch = getChannel(id);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + id });
  streamFFmpegTS(ch, res);
});

// ─── Direct Stream Redirect (Non-DRM) ────────────────────────────────────────
// Pure 302 → zero server overhead. Player connects directly to source.
// If Cookie/UA/Referer needed → transparent pipe with injected headers.
app.get('/proxy/redirect/:id', (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch || !ch.url) return res.status(404).send('Channel not found');

  // If DRM detected, escalate to DRM endpoint
  if (isDRM(ch)) {
    const BASE = req.protocol + '://' + req.get('host');
    const st   = getStreamType(ch);
    if (st === 'dash') return res.redirect(302, `${BASE}/live/${ch.id}.mpd`);
    if (st === 'hls')  return res.redirect(302, `${BASE}/live/${ch.id}.m3u8`);
    return res.redirect(302, `${BASE}/live/${ch.id}.ts`);
  }

  if (needsHeaderPipe(ch)) {
    // Pipe with injected headers (Cookie, Referer, UA)
    pipeStream(ch.url, buildHeaders(ch, {}), res).catch(e => {
      if (!res.headersSent) res.status(502).send('Stream error: ' + e.message);
    });
  } else {
    // Pure 302 — zero server overhead
    res.redirect(302, ch.url);
  }
});

// ─── DRM Segment Proxy ────────────────────────────────────────────────────────
app.get('/proxy/:id/', async (req, res) => {
  const targetUrl = req.query.url;
  const ch = getChannel(req.params.id);
  if (!targetUrl) return res.status(400).send('Missing ?url=');
  try {
    const resp = await safeFetch(targetUrl, { headers: buildHeaders(ch || {}, {}) }, 20000);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(resp.body);
  } catch (e) { res.status(502).send('Proxy error: ' + e.message); }
});

app.get('/proxy/:id/segment', async (req, res) => {
  const ch      = getChannel(req.params.id);
  const segPath = req.query.path;
  if (!ch || !segPath) return res.status(400).send('Bad request');
  const fullUrl = segPath.startsWith('http') ? segPath : getBaseUrl(ch.url) + segPath;
  try {
    const resp = await safeFetch(fullUrl, { headers: buildHeaders(ch, {}) }, 20000);
    res.setHeader('Content-Type', resp.headers['content-type'] || 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(resp.body);
  } catch (e) { res.status(502).send('Segment error: ' + e.message); }
});

app.get('/proxy/:id/key', async (req, res) => {
  const ch     = getChannel(req.params.id);
  const keyUrl = req.query.url;
  if (!keyUrl) return res.status(400).send('Missing ?url=');
  try {
    const resp = await safeFetch(keyUrl, { headers: buildHeaders(ch || {}, {}) }, 10000);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(resp.body);
  } catch (e) { res.status(502).send('Key error: ' + e.message); }
});

/** Frontend CORS proxy — server-side fetch for source URLs */
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

// ─── License Endpoint ─────────────────────────────────────────────────────────
async function handleLicense(req, res, channelId) {
  const db  = loadDB();
  const ch  = (db.channels || []).find(c => c.id === channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found: ' + channelId });
  const cfg = resolveDRMConfig(channelId, ch, db);
  if (!cfg) return res.status(404).json({ error: 'No DRM config: ' + channelId });
  const lt = (cfg.licenseType || 'clearkey').toLowerCase();

  if (lt === 'clearkey' || lt === 'clear-key') {
    const src = cfg.licenseUrl || cfg.licenseKey || '';
    let keys  = [];
    if (src && src.includes(':') && !src.startsWith('http')) {
      keys = parseClearKeyString(src);
    } else if (cfg.keyId && (cfg.key || cfg.licenseKey)) {
      keys = [{ kty: 'oct', kid: hexToBase64url(cfg.keyId), k: hexToBase64url(cfg.key || cfg.licenseKey) }];
    } else if (src && src.startsWith('http')) {
      const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      try {
        const resp = await safeFetch(src, { method: 'POST', body: challenge, headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': nextUA() }, cfg.customHeaders || {}) }, 15000);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(resp.body);
      } catch (e) { return res.status(502).json({ error: 'ClearKey proxy error: ' + e.message }); }
    } else {
      try {
        let challenge = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : (typeof req.body === 'object' ? req.body : null);
        if (challenge && Array.isArray(challenge.kids)) {
          const pairs = parseClearKeyString(cfg.licenseKey || cfg.key || '');
          const pm = {}; pairs.forEach(p => { pm[p.kid] = p; pm[base64urlToHex(p.kid)] = p; });
          keys = challenge.kids.map(kid => pm[kid] || pm[base64urlToHex(kid)] || null).filter(Boolean);
        }
      } catch {}
      if (!keys.length) keys = parseClearKeyString(cfg.licenseKey || cfg.key || '');
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.json({ keys, type: 'temporary' });
  }

  if (lt === 'widevine') {
    const licUrl = cfg.licenseUrl || (cfg.licenseKey && cfg.licenseKey.startsWith('http') ? cfg.licenseKey : '');
    if (!licUrl) return res.status(400).json({ error: 'Widevine license URL not configured' });
    const challenge = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '', 'base64');
    try {
      const resp = await safeFetch(licUrl, { method: 'POST', body: challenge, headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'User-Agent': nextUA() }, cfg.customHeaders || {}) }, 20000);
      if (!resp.ok) return res.status(resp.status).send('Widevine license server: ' + resp.status);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    } catch (e) { return res.status(502).json({ error: 'Widevine error: ' + e.message }); }
  }

  if (lt === 'playready') {
    const licUrl = cfg.licenseUrl || '';
    if (!licUrl) return res.status(400).json({ error: 'PlayReady license URL not configured' });
    const challenge = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    try {
      const resp = await safeFetch(licUrl, { method: 'POST', body: challenge, headers: Object.assign({ 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"', 'User-Agent': nextUA() }, cfg.customHeaders || {}) }, 20000);
      res.setHeader('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(resp.body);
    } catch (e) { return res.status(502).json({ error: 'PlayReady error: ' + e.message }); }
  }

  res.status(400).json({ error: 'Unsupported DRM: ' + lt });
}

app.post('/license/:id',           (req, res) => handleLicense(req, res, req.params.id));
app.post('/proxy/drm-license/:id', (req, res) => handleLicense(req, res, req.params.id));
app.get('/license/:id',            (req, res) => handleLicense(req, res, req.params.id));

// ─── Channels CRUD ────────────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const db = loadDB(); let chs = db.channels || [];
  if (req.query.group)         chs = chs.filter(c => c.group === req.query.group);
  if (req.query.tamil === '1') chs = chs.filter(isTamil);
  if (req.query.active === '1') chs = chs.filter(c => c.enabled !== false);
  if (req.query.drm === '1')   chs = chs.filter(isDRM);
  if (req.query.direct === '1') chs = chs.filter(c => !isDRM(c));
  if (req.query.source)        chs = chs.filter(c => c.sourceId === req.query.source);
  res.json(chs);
});
app.get('/api/channels/:id',    (req, res) => { const ch = getChannel(req.params.id); if (!ch) return res.status(404).json({ error: 'Not found' }); res.json(ch); });
app.post('/api/channels',       (req, res) => { const db = loadDB(); const ch = Object.assign({}, req.body, { id: req.body.id || ('ch_' + Date.now()), enabled: true, isActive: true, isTamil: isTamil(req.body) }); db.channels = (db.channels || []).concat([ch]); saveDB(db); rebuildMap(); res.json(ch); });
app.put('/api/channels/:id',    (req, res) => { const db = loadDB(); let found = false; db.channels = (db.channels || []).map(c => { if (c.id !== req.params.id) return c; found = true; const u = Object.assign({}, c, req.body, { id: c.id }); u.isTamil = isTamil(u); return u; }); if (!found) return res.status(404).json({ error: 'Not found' }); saveDB(db); rebuildMap(); res.json({ ok: true }); });
app.patch('/api/channel/:id',   (req, res) => { const db = loadDB(); db.channels = (db.channels || []).map(c => c.id === req.params.id ? Object.assign({}, c, req.body) : c); saveDB(db); rebuildMap(); res.json({ ok: true }); });
app.delete('/api/channels/:id', (req, res) => { const db = loadDB(); db.channels = (db.channels || []).filter(c => c.id !== req.params.id); saveDB(db); rebuildMap(); res.json({ ok: true }); });

// ─── Groups CRUD ──────────────────────────────────────────────────────────────
app.get('/api/groups', (req, res) => {
  const db = loadDB(), chs = db.channels || [];
  const names = Array.from(new Set(chs.map(c => c.group || 'Uncategorized')));
  res.json(names.map(name => {
    const saved = (db.groups || []).find(g => g.name === name);
    return { name, count: chs.filter(c => (c.group || 'Uncategorized') === name).length, tamilCount: chs.filter(c => (c.group || 'Uncategorized') === name && isTamil(c)).length, drmCount: chs.filter(c => (c.group || 'Uncategorized') === name && isDRM(c)).length, isActive: saved ? saved.isActive !== false : true };
  }));
});
app.put('/api/groups/:name', (req, res) => {
  const db = loadDB(), name = decodeURIComponent(req.params.name);
  if (req.body.newName && req.body.newName !== name) db.channels = (db.channels || []).map(c => (c.group || 'Uncategorized') === name ? Object.assign({}, c, { group: req.body.newName }) : c);
  const existing = (db.groups || []).find(g => g.name === name);
  db.groups = existing ? (db.groups || []).map(g => g.name === name ? Object.assign({}, g, req.body) : g) : (db.groups || []).concat([Object.assign({ name }, req.body)]);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});
app.delete('/api/groups/:name', (req, res) => {
  const db = loadDB(), name = decodeURIComponent(req.params.name);
  db.channels = (db.channels || []).filter(c => (c.group || 'Uncategorized') !== name);
  db.groups   = (db.groups   || []).filter(g => g.name !== name);
  saveDB(db); rebuildMap(); res.json({ ok: true });
});

// ─── Sources CRUD ─────────────────────────────────────────────────────────────
app.get('/api/sources',      (_req, res) => { res.json(loadDB().sources || []); });
app.post('/api/sources',     (req, res)  => { const db = loadDB(); const src = Object.assign({}, req.body, { id: req.body.id || ('src_' + Date.now()), createdAt: new Date().toISOString() }); db.sources = (db.sources || []).concat([src]); saveDB(db); res.json(src); });
app.put('/api/sources/:id',  (req, res)  => { const db = loadDB(); db.sources = (db.sources || []).map(s => s.id === req.params.id ? Object.assign({}, s, req.body, { id: s.id }) : s); saveDB(db); res.json({ ok: true }); });
app.delete('/api/sources/:id', (req, res) => { const db = loadDB(); db.sources = (db.sources || []).filter(s => s.id !== req.params.id); saveDB(db); res.json({ ok: true }); });

// ─── DRM Proxies CRUD ────────────────────────────────────────────────────────
app.get('/api/drm',      (_req, res) => { res.json(loadDB().drmProxies || []); });
app.post('/api/drm',     (req, res)  => { const db = loadDB(), BASE = req.protocol + '://' + req.get('host'); const proxy = Object.assign({}, req.body, { id: 'drm_' + Date.now(), isActive: true, proxyUrl: `${BASE}/live/${req.body.channelId}.mpd`, licenseEndpoint: `${BASE}/license/drm_${Date.now()}`, createdAt: new Date().toISOString() }); db.drmProxies = (db.drmProxies || []).concat([proxy]); saveDB(db); res.json(proxy); });
app.put('/api/drm/:id',  (req, res)  => { const db = loadDB(); db.drmProxies = (db.drmProxies || []).map(d => d.id === req.params.id ? Object.assign({}, d, req.body, { id: d.id }) : d); saveDB(db); res.json({ ok: true }); });
app.delete('/api/drm/:id', (req, res) => { const db = loadDB(); db.drmProxies = (db.drmProxies || []).filter(d => d.id !== req.params.id); saveDB(db); res.json({ ok: true }); });

// ─── Sync ─────────────────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    if (Array.isArray(data.channels)) data.channels = data.channels.map(ch => Object.assign({}, ch, { isTamil: isTamil(ch) }));
    const ok = saveDB(Object.assign({}, EMPTY_DB, data));
    rebuildMap();
    const chs = data.channels || [];
    const multiCount = Object.values(_channelsByName).filter(arr => arr.length > 1).length;
    console.log(`[Sync] ch=${chs.length} drm=${chs.filter(isDRM).length} direct=${chs.filter(c => !isDRM(c)).length} tamil=${chs.filter(isTamil).length} multiSource=${multiCount}`);
    res.json({ ok, synced: { channels: chs.length, drmChannels: chs.filter(isDRM).length, directChannels: chs.filter(c => !isDRM(c)).length, tamilChannels: chs.filter(isTamil).length, multiSourceChannels: multiCount, playlists: (data.playlists || []).length, sources: (data.sources || []).length } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DB Export / Import ───────────────────────────────────────────────────────
app.get('/api/db/export', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="iptv-db-${Date.now()}.json"`);
  res.json(loadDB());
});
app.post('/api/db/import', (req, res) => {
  try { saveDB(req.body); rebuildMap(); res.json({ ok: true, channels: (req.body.channels || []).length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto-Refresh Sources ─────────────────────────────────────────────────────
function doAutoRefresh() {
  const db = loadDB();
  const sources = (db.sources || []).filter(s => s.autoRefresh && s.url && (s.refreshInterval || 0) > 0);
  sources.forEach(src => {
    const last = src.lastRefreshed ? new Date(src.lastRefreshed).getTime() : 0;
    if (Date.now() - last < (src.refreshInterval || 30) * 60 * 1000) return;
    console.log('[AutoRefresh]', src.name);
    safeFetch(src.url, { headers: { 'User-Agent': nextUA() } }, 25000)
      .then(resp => {
        const db2 = loadDB();
        db2.sources = (db2.sources || []).map(s => s.id !== src.id ? s : Object.assign({}, s, { lastRefreshed: new Date().toISOString(), status: resp.ok ? 'success' : 'error' }));
        saveDB(db2);
      })
      .catch(e => {
        const db2 = loadDB();
        db2.sources = (db2.sources || []).map(s => s.id !== src.id ? s : Object.assign({}, s, { status: 'error', errorMessage: e.message }));
        saveDB(db2);
      });
  });
}
setInterval(doAutoRefresh, 60 * 1000);
setTimeout(doAutoRefresh, 8000);

// ─── Keepalive for Render Free Tier ──────────────────────────────────────────
// Pings own /health every 14 minutes to prevent sleep
let _ownUrl = '';
function selfPing() {
  if (!_ownUrl) return;
  safeFetch(_ownUrl + '/health', {}, 10000)
    .then(r => console.log(`[Keepalive] ${r.status} — ${Math.floor(process.uptime())}s uptime`))
    .catch(e => console.warn('[Keepalive] Error:', e.message));
}

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/') || req.path.startsWith('/live/') || req.path.startsWith('/license/') || req.path.startsWith('/health')) {
    return res.status(404).json({ error: 'Not found: ' + req.path });
  }
  const indexFile = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  res.status(200).type('html').send(`<!DOCTYPE html><html><head><title>IPTV Manager v10</title><style>body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:2rem}a{color:#38bdf8}.ok{color:#10b981}</style></head><body><h1>🚀 IPTV Manager Server v10.0</h1><p><span class="ok">✅ RUNNING</span> | <a href="/health">/health</a> | <a href="/api/stats">/api/stats</a></p><p><a href="/api/playlist/all.m3u">All Channels M3U</a> · <a href="/api/playlist/tamil.m3u">Tamil M3U</a></p></body></html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  _ownUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🚀  IPTV Manager Server v10.0  —  Full Stack        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  🌐  URL:        ${_ownUrl}`);
  console.log(`  📺  All M3U:    ${_ownUrl}/api/playlist/all.m3u`);
  console.log(`  🇮🇳  Tamil M3U:  ${_ownUrl}/api/playlist/tamil.m3u`);
  console.log(`  🔁  Direct:     302 redirect → original URL (zero overhead)`);
  console.log(`  🔐  DRM DASH:   ${_ownUrl}/live/:id.mpd`);
  console.log(`  🔐  DRM HLS:    ${_ownUrl}/live/:id.m3u8`);
  console.log(`  🎬  DRM TS:     ${_ownUrl}/live/:id.ts [FFmpeg]`);
  console.log(`  ⚡  Best Link:  ${_ownUrl}/proxy/best/:channelName`);
  console.log(`  🏥  Health:     ${_ownUrl}/api/health/:id`);
  console.log(`  💾  DB:         ${DB_FILE}\n`);
  // Start keepalive after 30s
  setTimeout(() => {
    setInterval(selfPing, 14 * 60 * 1000);
    console.log(`  💓  Keepalive: pinging every 14min to prevent Render sleep\n`);
  }, 30000);
});
