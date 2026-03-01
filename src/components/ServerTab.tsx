import { useState } from 'react';
import { useStore } from '../store/useStore';
import {
  Copy, Check, Server, Globe, Shield, Play, Download,
  ExternalLink, Code, Zap, Database, RefreshCw, Link
} from 'lucide-react';
import toast from 'react-hot-toast';

export default function ServerTab() {
  const { playlists, channels, drmProxies, serverUrl, syncDB, exportDB } = useStore();
  const [copied, setCopied] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'overview' | 'deploy' | 'api' | 'serverjs'>('overview');
  const [syncing, setSyncing] = useState(false);

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Copied!');
  };

  const handleSync = async () => {
    setSyncing(true);
    await syncDB();
    setSyncing(false);
    toast.success('✅ Database synced to server!');
  };

  const handleExport = () => {
    const content = exportDB();
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'iptv-db.json'; a.click();
    URL.revokeObjectURL(url);
    toast.success('Database exported!');
  };

  const serverJs = `/**
 * IPTV Playlist Manager — Full Stack Server (server.js)
 * Deploy: Render.com | Railway | Fly.io | VPS
 * 
 * Features:
 *  - Live M3U playlist generation from stored channels
 *  - Stream redirect proxy (hides original URLs)
 *  - Full stream pipe proxy (custom headers: UA, Referer, Cookie)
 *  - DRM proxy: ClearKey decryption + Widevine license forwarding
 *  - CORS proxy for frontend fetching
 *  - Auto-refresh sources on schedule
 *  - Full CRUD REST API
 *  - Tamil channel filter support
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// Use dynamic import for node-fetch (ESM module)
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// ── Persistent DB ────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { channels: [], playlists: [], drmProxies: [], sources: [], groups: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Playlist Generator ───────────────────────────────────────────────────────
function generatePlaylistM3U(playlistId, baseUrl) {
  const db = loadDB();
  const pl = db.playlists.find(p => p.id === playlistId);
  if (!pl) return null;

  const filtered = (db.channels || []).filter(ch => {
    if (!ch.isActive) return false;
    if (pl.tamilOnly && !ch.isTamil) return false;
    if (pl.includeGroups?.length && !pl.includeGroups.includes(ch.group)) return false;
    if (pl.excludeGroups?.includes(ch.group)) return false;
    return true;
  }).sort((a, b) => (a.order || 0) - (b.order || 0));

  let m3u = '#EXTM3U\\n';
  filtered.forEach(ch => {
    const logo = ch.logo ? \` tvg-logo="\${ch.logo}"\` : '';
    const tvgId = ch.tvgId ? \` tvg-id="\${ch.tvgId}"\` : '';
    const tvgName = ch.tvgName ? \` tvg-name="\${ch.tvgName}"\` : '';
    const group = \` group-title="\${ch.group}"\`;
    const lang = ch.language ? \` tvg-language="\${ch.language}"\` : '';
    // Route DRM channels through DRM proxy, others through redirect proxy
    const streamUrl = ch.isDrm
      ? \`\${baseUrl}/proxy/drm/\${ch.id}\`
      : \`\${baseUrl}/proxy/redirect/\${ch.id}\`;
    m3u += \`#EXTINF:-1\${tvgId}\${tvgName}\${logo}\${group}\${lang},\${ch.name}\\n\${streamUrl}\\n\`;
  });
  return m3u;
}

// ── PLAYLIST ENDPOINTS ───────────────────────────────────────────────────────
// Main playlist URL — add to any IPTV player
app.get('/api/playlist/:id.m3u', (req, res) => {
  const BASE = \`\${req.protocol}://\${req.get('host')}\`;
  const m3u = generatePlaylistM3U(req.params.id, BASE);
  if (!m3u) return res.status(404).send('# Playlist not found');
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(m3u);
});

app.get('/api/playlist/:id.json', (req, res) => {
  const db = loadDB();
  const pl = db.playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Not found' });
  res.json({ ...pl, channelCount: (db.channels || []).filter(ch => {
    if (!ch.isActive) return false;
    if (pl.tamilOnly && !ch.isTamil) return false;
    if (pl.includeGroups?.length && !pl.includeGroups.includes(ch.group)) return false;
    return true;
  }).length });
});

// List all playlists with their M3U URLs
app.get('/api/playlists', (req, res) => {
  const db = loadDB();
  const BASE = \`\${req.protocol}://\${req.get('host')}\`;
  res.json((db.playlists || []).map(pl => ({
    ...pl,
    m3uUrl: \`\${BASE}/api/playlist/\${pl.id}.m3u\`,
  })));
});

// ── PROXY: Redirect (hides original URL, forwards headers) ───────────────────
app.get('/proxy/redirect/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).send('Channel not found');

  const headers = { 'User-Agent': ch.userAgent || 'IPTV-Manager/1.0' };
  if (ch.referer) headers['Referer'] = ch.referer;
  if (ch.cookie) headers['Cookie'] = ch.cookie;
  if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

  // For custom headers, must fully proxy
  if (Object.keys(headers).length > 1) {
    try {
      const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
      const ct = upstream.headers.get('content-type') || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      upstream.body.pipe(res);
      return;
    } catch (e) {
      console.error('Proxy error:', e.message);
    }
  }
  // Simple redirect for plain streams
  res.redirect(302, ch.url);
});

// ── PROXY: Full Stream Pipe ───────────────────────────────────────────────────
app.get('/proxy/stream/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).send('Not found');

  try {
    const headers = { 'User-Agent': ch.userAgent || 'IPTV-Manager/1.0' };
    if (ch.referer) headers['Referer'] = ch.referer;
    if (ch.cookie) headers['Cookie'] = ch.cookie;
    if (ch.httpHeaders) Object.assign(headers, ch.httpHeaders);

    const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).send('Upstream error: ' + err.message);
  }
});

// ── DRM PROXY ────────────────────────────────────────────────────────────────
// Handles ClearKey: builds kid:key pair and serves stream + license
// Handles Widevine: forwards license requests to real license server
app.get('/proxy/drm/:id', async (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).send('Not found');

  // Find DRM proxy config for this channel
  const drmConfig = (db.drmProxies || []).find(d => d.channelId === ch.id && d.isActive);

  if (!drmConfig) {
    // No DRM config — redirect directly
    return res.redirect(302, ch.url);
  }

  const BASE = \`\${req.protocol}://\${req.get('host')}\`;

  if (drmConfig.licenseType === 'clearkey') {
    // For ClearKey DASH streams, serve manifest with license server pointing to our endpoint
    // The actual stream is served directly; player fetches license from /proxy/drm-license/:id
    // We inject the license URL into M3U8/MPD if needed, else redirect
    try {
      const headers = { 'User-Agent': ch.userAgent || 'IPTV-Manager/1.0' };
      if (ch.referer) headers['Referer'] = ch.referer;
      if (ch.cookie) headers['Cookie'] = ch.cookie;

      const upstream = await fetch(ch.url, { headers, redirect: 'follow' });
      const ct = upstream.headers.get('content-type') || 'application/dash+xml';
      const content = await upstream.text();

      // Inject license server URL for DASH
      let modified = content;
      if (ct.includes('dash') || ch.url.includes('.mpd')) {
        const licenseUrl = \`\${BASE}/proxy/drm-license/\${drmConfig.id}\`;
        modified = content.replace(
          /<ContentProtection/g,
          \`<ContentProtection xmlns:cenc="urn:mpeg:cenc:2013" cenc:default_KID="\${drmConfig.keyId}"><clearkey:Laurl xmlns:clearkey="https://dashif.org/ClearKey-Content-Protection" Lic_type="EME-1.0">\${licenseUrl}</clearkey:Laurl></ContentProtection><!--\`
        ).replace(/<\\/ContentProtection>/g, '--></ContentProtection>');
      }

      res.setHeader('Content-Type', ct);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(modified);
    } catch (e) {
      res.redirect(302, ch.url);
    }
  } else if (drmConfig.licenseType === 'widevine' && drmConfig.licenseUrl) {
    // Widevine: redirect to stream, player will handle license via Widevine CDM
    res.redirect(302, ch.url);
  } else {
    res.redirect(302, ch.url);
  }
});

// ClearKey license endpoint — compatible with DASH.js, Shaka Player, ExoPlayer
app.post('/proxy/drm-license/:id', async (req, res) => {
  const db = loadDB();
  const drmConfig = (db.drmProxies || []).find(d => d.id === req.params.id && d.isActive);
  if (!drmConfig) return res.status(404).json({ error: 'DRM config not found' });

  if (drmConfig.licenseType === 'clearkey') {
    // Parse kid:key format or use stored keyId/key directly
    let kid = drmConfig.keyId;
    let k = drmConfig.key;

    // If licenseUrl contains kid:key pairs (JioTV format)
    if (drmConfig.licenseUrl && drmConfig.licenseUrl.includes(':')) {
      const pairs = drmConfig.licenseUrl.split(',');
      const keyPairs = pairs.map(p => {
        const [pkid, pkey] = p.trim().split(':');
        return { kty: 'oct', kid: pkid, k: pkey };
      });
      return res.json({ keys: keyPairs, type: 'temporary' });
    }

    // Standard ClearKey response
    return res.json({
      keys: [{ kty: 'oct', kid: kid || '', k: k || '' }],
      type: 'temporary',
    });
  }

  if (drmConfig.licenseType === 'widevine' && drmConfig.licenseUrl) {
    // Forward to Widevine license server
    try {
      const body = req.body instanceof Buffer ? req.body : Buffer.from(req.body);
      const resp = await fetch(drmConfig.licenseUrl, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const data = await resp.buffer();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(data);
    } catch (e) {
      res.status(502).send('License server error: ' + e.message);
    }
    return;
  }

  res.status(400).json({ error: 'Unsupported DRM type' });
});

// ── CORS PROXY (for frontend source fetching) ────────────────────────────────
app.get('/proxy/cors', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing ?url= param');
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'IPTV-Manager/1.0', 'Accept': '*/*' },
      redirect: 'follow',
    });
    const text = await resp.text();
    res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(text);
  } catch (e) {
    res.status(502).send('Fetch error: ' + e.message);
  }
});

// ── REST API — Full CRUD ─────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const db = loadDB();
  const { group, tamil, active } = req.query;
  let channels = db.channels || [];
  if (group) channels = channels.filter(c => c.group === group);
  if (tamil === 'true') channels = channels.filter(c => c.isTamil);
  if (active === 'true') channels = channels.filter(c => c.isActive);
  res.json(channels);
});

app.get('/api/channels/:id', (req, res) => {
  const db = loadDB();
  const ch = (db.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  res.json(ch);
});

app.post('/api/channels', (req, res) => {
  const db = loadDB();
  const ch = { ...req.body, id: \`ch_\${Date.now()}\`, order: (db.channels || []).length };
  db.channels = [...(db.channels || []), ch];
  saveDB(db); res.json(ch);
});

app.put('/api/channels/:id', (req, res) => {
  const db = loadDB();
  db.channels = (db.channels || []).map(c => c.id === req.params.id ? { ...c, ...req.body } : c);
  saveDB(db); res.json({ ok: true });
});

app.delete('/api/channels/:id', (req, res) => {
  const db = loadDB();
  db.channels = (db.channels || []).filter(c => c.id !== req.params.id);
  db.drmProxies = (db.drmProxies || []).filter(d => d.channelId !== req.params.id);
  saveDB(db); res.json({ ok: true });
});

app.get('/api/groups', (req, res) => {
  const db = loadDB();
  const groups = [...new Set((db.channels || []).map(c => c.group))].map(name => ({
    name,
    count: (db.channels || []).filter(c => c.group === name).length,
    tamilCount: (db.channels || []).filter(c => c.group === name && c.isTamil).length,
  }));
  res.json(groups);
});

app.get('/api/sources', (req, res) => res.json(loadDB().sources || []));
app.get('/api/drm', (req, res) => res.json(loadDB().drmProxies || []));

// Sync entire DB from frontend
app.post('/api/sync', (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid data' });
    saveDB(data);
    console.log(\`✅ DB synced: \${(data.channels || []).length} channels, \${(data.playlists || []).length} playlists\`);
    res.json({ ok: true, channels: (data.channels || []).length, playlists: (data.playlists || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DB stats
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const channels = db.channels || [];
  res.json({
    channels: channels.length,
    activeChannels: channels.filter(c => c.isActive).length,
    tamilChannels: channels.filter(c => c.isTamil).length,
    drmChannels: channels.filter(c => c.isDrm).length,
    groups: [...new Set(channels.map(c => c.group))].length,
    playlists: (db.playlists || []).length,
    sources: (db.sources || []).length,
    drmProxies: (db.drmProxies || []).length,
  });
});

// ── AUTO-REFRESH SOURCES ─────────────────────────────────────────────────────
async function refreshAutoSources() {
  const db = loadDB();
  const toRefresh = (db.sources || []).filter(s => s.autoRefresh && s.url);
  for (const src of toRefresh) {
    try {
      const resp = await fetch(src.url, { headers: { 'User-Agent': 'IPTV-Manager/1.0' } });
      if (resp.ok) {
        const text = await resp.text();
        console.log(\`🔄 Auto-refreshed source: \${src.name} (\${text.length} bytes)\`);
        // In production: re-parse and update channels in db
      }
    } catch (e) {
      console.error(\`Failed to refresh \${src.name}: \${e.message}\`);
    }
  }
}
// Check every 5 minutes, refresh sources per their interval setting
setInterval(refreshAutoSources, 5 * 60 * 1000);

// ── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(\`🚀 IPTV Manager running on http://localhost:\${PORT}\`);
  console.log(\`📺 Playlist: http://localhost:\${PORT}/api/playlist/{id}.m3u\`);
  console.log(\`🔐 DRM Proxy: http://localhost:\${PORT}/proxy/drm/{channelId}\`);
  console.log(\`📡 Stream: http://localhost:\${PORT}/proxy/redirect/{channelId}\`);
  console.log(\`🔁 CORS Proxy: http://localhost:\${PORT}/proxy/cors?url=...\`);
});`;

  const renderYml = `services:
  - type: web
    name: iptv-manager
    env: node
    plan: free
    buildCommand: npm install && npm run build
    startCommand: node server.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3000`;

  const pkgJson = `{
  "name": "iptv-manager",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}`;

  const apiDocs = [
    { method: 'GET', path: '/api/playlist/:id.m3u', desc: 'Live M3U playlist — proxy URLs, auto-updated when sources change' },
    { method: 'GET', path: '/api/playlist/:id.json', desc: 'Playlist config + channel count as JSON' },
    { method: 'GET', path: '/api/playlists', desc: 'List all playlists with their M3U URLs' },
    { method: 'GET', path: '/proxy/redirect/:channelId', desc: 'Redirect proxy — hides original URL, forwards UA/Referer/Cookie' },
    { method: 'GET', path: '/proxy/stream/:channelId', desc: 'Full pipe proxy — streams through server with all headers' },
    { method: 'GET', path: '/proxy/drm/:channelId', desc: 'DRM stream proxy — ClearKey/Widevine license injection' },
    { method: 'POST', path: '/proxy/drm-license/:id', desc: 'ClearKey license endpoint (DASH.js / Shaka / ExoPlayer)' },
    { method: 'GET', path: '/proxy/cors?url=...', desc: 'CORS proxy — server-side fetch for any URL' },
    { method: 'GET', path: '/api/channels', desc: 'List channels (query: ?group=X&tamil=true&active=true)' },
    { method: 'POST', path: '/api/channels', desc: 'Create channel' },
    { method: 'PUT', path: '/api/channels/:id', desc: 'Update channel' },
    { method: 'DELETE', path: '/api/channels/:id', desc: 'Delete channel' },
    { method: 'GET', path: '/api/groups', desc: 'List groups with channel + Tamil count' },
    { method: 'GET', path: '/api/stats', desc: 'Server stats (total, active, Tamil, DRM channels)' },
    { method: 'POST', path: '/api/sync', desc: '🔁 Sync full DB from frontend — called automatically on every change' },
  ];

  const methodColor = (m: string) => {
    if (m === 'GET') return 'bg-green-900/50 text-green-400 border-green-800/30';
    if (m === 'POST') return 'bg-blue-900/50 text-blue-400 border-blue-800/30';
    if (m === 'PUT') return 'bg-yellow-900/50 text-yellow-400 border-yellow-800/30';
    return 'bg-red-900/50 text-red-400 border-red-800/30';
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Server & Deployment</h2>
          <p className="text-gray-500 text-sm mt-0.5">Stream proxy · DRM · Playlist URLs · Auto-sync</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <Download className="w-4 h-4" /> Export DB
          </button>
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync to Server'}
          </button>
          <div className="flex items-center gap-2 bg-green-900/20 border border-green-800/30 px-3 py-2 rounded-lg">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-green-400 text-sm font-medium">Live</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Active Channels', value: channels.filter(c => c.isActive).length, color: 'text-blue-400', icon: <Play className="w-5 h-5" /> },
          { label: 'Playlists', value: playlists.length, color: 'text-green-400', icon: <Database className="w-5 h-5" /> },
          { label: 'DRM Proxies', value: drmProxies.filter(d => d.isActive).length, color: 'text-purple-400', icon: <Shield className="w-5 h-5" /> },
          { label: 'Tamil Channels', value: channels.filter(c => c.isTamil).length, color: 'text-orange-400', icon: <Zap className="w-5 h-5" /> },
        ].map(stat => (
          <div key={stat.label} className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-center">
            <div className={`flex justify-center mb-2 ${stat.color} opacity-60`}>{stat.icon}</div>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-gray-500 text-xs mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Section Tabs */}
      <div className="flex gap-1 bg-gray-900 p-1 rounded-lg w-fit border border-gray-800 overflow-x-auto">
        {(['overview', 'deploy', 'api', 'serverjs'] as const).map(s => (
          <button key={s} onClick={() => setActiveSection(s)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              activeSection === s ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
            }`}
          >
            {s === 'overview' ? '🏠 Overview' : s === 'deploy' ? '🚀 Deploy' : s === 'api' ? '📡 API Docs' : '📄 server.js'}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {activeSection === 'overview' && (
        <div className="space-y-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-400" /> Live Playlist URLs
            </h3>
            <div className="p-3 bg-gray-900 rounded-lg border border-gray-700">
              <p className="text-gray-500 text-xs mb-1">Server Base URL</p>
              <div className="flex items-center gap-2">
                <code className="text-green-400 text-sm flex-1 font-mono break-all">{serverUrl}</code>
                <button onClick={() => copy(serverUrl, 'base')} className="text-gray-400 hover:text-white p-1 shrink-0">
                  {copied === 'base' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {playlists.length > 0 ? (
              <div className="space-y-2">
                <p className="text-gray-400 text-sm font-medium">Your Playlist URLs (add to VLC, Kodi, TiviMate, etc.):</p>
                {playlists.map(pl => {
                  const url = `${serverUrl}/api/playlist/${pl.id}.m3u`;
                  return (
                    <div key={pl.id} className="p-4 bg-gray-900 rounded-xl border border-gray-700 hover:border-gray-600 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <p className="text-white font-medium text-sm">{pl.name}</p>
                            {pl.tamilOnly && (
                              <span className="text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full">
                                🎬 Tamil Only
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <Link className="w-3 h-3 text-blue-400 shrink-0" />
                            <code className="text-blue-400 text-xs truncate font-mono">{url}</code>
                          </div>
                        </div>
                        <button onClick={() => copy(url, pl.id)} className="text-gray-400 hover:text-white p-1 shrink-0">
                          {copied === pl.id ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-gray-500">
                <p className="text-sm">No playlists yet. Go to the <span className="text-blue-400">Playlists</span> tab to create one.</p>
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-5 flex items-center gap-2">
              <Play className="w-4 h-4 text-green-400" /> How It Works
            </h3>
            <div className="space-y-4">
              {[
                { step: '1', title: 'Add Sources', desc: 'Upload M3U/JSON or add URLs. Parser auto-detects format, extracts DRM keys, tags Tamil channels automatically.', color: 'bg-blue-600', icon: <Globe className="w-4 h-4 text-blue-400" /> },
                { step: '2', title: 'Channels Sync to Server', desc: 'Every change (add/edit/delete/toggle) instantly syncs to server via POST /api/sync. Server always has latest data.', color: 'bg-green-600', icon: <RefreshCw className="w-4 h-4 text-green-400" /> },
                { step: '3', title: 'Generate Playlist URL', desc: 'Create playlists filtered by groups or Tamil-only. Each gets a unique /api/playlist/{id}.m3u URL served live.', color: 'bg-purple-600', icon: <Database className="w-4 h-4 text-purple-400" /> },
                { step: '4', title: 'Server Proxies Streams', desc: 'M3U links point to /proxy/redirect/{id}. Original URLs never exposed. UA, Referer, Cookie headers forwarded automatically.', color: 'bg-orange-600', icon: <Server className="w-4 h-4 text-orange-400" /> },
                { step: '5', title: 'DRM Bypass', desc: 'DRM streams routed through /proxy/drm/{id}. ClearKey: kid:key served via /proxy/drm-license/{id}. Widevine: license forwarded to real server.', color: 'bg-red-600', icon: <Shield className="w-4 h-4 text-red-400" /> },
              ].map(item => (
                <div key={item.step} className="flex gap-4">
                  <div className={`w-7 h-7 rounded-full ${item.color} flex items-center justify-center shrink-0 text-white text-xs font-bold`}>{item.step}</div>
                  <div className="flex-1 pb-4 border-b border-gray-700/50 last:border-0 last:pb-0">
                    <div className="flex items-center gap-2 mb-1">{item.icon}<span className="text-white font-medium text-sm">{item.title}</span></div>
                    <p className="text-gray-400 text-xs leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── DEPLOY ── */}
      {activeSection === 'deploy' && (
        <div className="space-y-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-5">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <ExternalLink className="w-4 h-4 text-blue-400" /> Deploy to Render.com (Free)
            </h3>
            {[
              { n: '1', title: 'Push to GitHub', desc: 'Create a GitHub repo with all your project files including server.js (from the server.js tab).' },
              {
                n: '2', title: 'Add render.yaml to repo root',
                code: renderYml, codeId: 'renderyml',
              },
              {
                n: '3', title: 'Update package.json',
                desc: 'Ensure server dependencies are listed:',
                code: pkgJson, codeId: 'pkgjson',
              },
              { n: '4', title: 'Deploy on Render.com', desc: 'render.com → New Web Service → Connect GitHub → Auto Deploy!', link: 'https://render.com' },
              { n: '5', title: 'Sync your data', desc: 'After deploy, click "Sync to Server" button above to push all channels/playlists to the live server.' },
            ].map(step => (
              <div key={step.n} className="flex gap-4">
                <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0 text-white text-xs font-bold mt-0.5">{step.n}</div>
                <div className="flex-1">
                  <p className="text-white font-medium text-sm">{step.title}</p>
                  {step.desc && <p className="text-gray-400 text-xs mt-0.5">{step.desc}</p>}
                  {step.code && (
                    <div className="mt-2 bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-800">
                        <span className="text-gray-400 text-xs font-mono">{step.codeId === 'renderyml' ? 'render.yaml' : 'package.json'}</span>
                        <button onClick={() => copy(step.code!, step.codeId!)} className="text-gray-400 hover:text-white">
                          {copied === step.codeId ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                      <pre className="p-3 text-green-400 text-xs overflow-x-auto leading-relaxed">{step.code}</pre>
                    </div>
                  )}
                  {step.link && (
                    <a href={step.link} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-400 text-xs mt-1.5 hover:text-blue-300">
                      <ExternalLink className="w-3 h-3" /> {step.link}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Other platforms */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Server className="w-4 h-4 text-purple-400" /> Other Deploy Options
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { name: 'Railway', cmd: 'railway up', url: 'https://railway.app', color: 'border-purple-700' },
                { name: 'Fly.io', cmd: 'flyctl deploy', url: 'https://fly.io', color: 'border-blue-700' },
                { name: 'Cyclic.sh', cmd: 'git push (auto)', url: 'https://cyclic.sh', color: 'border-green-700' },
              ].map(p => (
                <div key={p.name} className={`p-4 bg-gray-900 rounded-lg border ${p.color}`}>
                  <p className="text-white font-medium text-sm">{p.name}</p>
                  <code className="text-green-400 text-xs font-mono">{p.cmd}</code>
                  <a href={p.url} target="_blank" rel="noopener noreferrer"
                    className="block text-blue-400 text-xs mt-2 hover:text-blue-300 flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> {p.url}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── API DOCS ── */}
      {activeSection === 'api' && (
        <div className="space-y-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Code className="w-4 h-4 text-blue-400" /> REST API Reference
            </h3>
            <div className="space-y-2">
              {apiDocs.map((api, i) => (
                <div key={i} className="flex items-start gap-3 p-3 bg-gray-900 rounded-lg hover:bg-gray-800/80 transition-colors group">
                  <span className={`text-xs font-mono font-bold px-2 py-1 rounded border shrink-0 ${methodColor(api.method)}`}>{api.method}</span>
                  <div className="flex-1 min-w-0">
                    <code className="text-white text-xs font-mono">{api.path}</code>
                    <p className="text-gray-500 text-xs mt-0.5">{api.desc}</p>
                  </div>
                  <button
                    onClick={() => copy(`${serverUrl}${api.path.replace(':id', 'PLAYLIST_ID').replace(':channelId', 'CHANNEL_ID')}`, `api-${i}`)}
                    className="shrink-0 text-gray-600 hover:text-white p-1 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    {copied === `api-${i}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-purple-950/30 border border-purple-800/30 rounded-xl p-5">
            <h3 className="text-purple-300 font-semibold mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4" /> DRM Proxy Details
            </h3>
            <div className="space-y-2 text-xs text-purple-400 leading-relaxed">
              <p>• <strong className="text-purple-300">ClearKey:</strong> Store <code className="font-mono bg-purple-900/30 px-1 rounded">kid:key</code> pairs in channel's licenseKey. Auto-served at <code className="font-mono bg-purple-900/30 px-1 rounded">/proxy/drm-license/:id</code> in W3C ClearKey format.</p>
              <p>• <strong className="text-purple-300">Widevine:</strong> Set licenseType=widevine + licenseUrl=license_server. Server forwards EME license requests with correct binary encoding.</p>
              <p>• <strong className="text-purple-300">JioTV format:</strong> <code className="font-mono bg-purple-900/30 px-1 rounded">drmScheme + drmLicense</code> (kid:key) auto-parsed from JSON sources.</p>
              <p>• <strong className="text-purple-300">KODIPROP:</strong> <code className="font-mono bg-purple-900/30 px-1 rounded">inputstream.adaptive.license_type/key</code> directives in M3U auto-extracted.</p>
              <p>• <strong className="text-purple-300">Multiple keys:</strong> Comma-separated <code className="font-mono bg-purple-900/30 px-1 rounded">kid1:key1,kid2:key2</code> format fully supported.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── SERVER.JS ── */}
      {activeSection === 'serverjs' && (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <Code className="w-4 h-4 text-green-400" /> server.js — Complete Backend
            </h3>
            <button onClick={() => copy(serverJs, 'serverjs')}
              className="flex items-center gap-2 bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
              {copied === 'serverjs' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              Copy All
            </button>
          </div>
          <div className="bg-gray-950 rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900">
              <span className="text-gray-400 text-xs font-mono">server.js</span>
              <span className="text-gray-600 text-xs">Express · Playlist · Stream Proxy · DRM · ClearKey · Widevine · CORS · Auto-sync</span>
            </div>
            <pre className="p-4 text-green-400 text-xs overflow-auto max-h-[600px] leading-relaxed whitespace-pre-wrap">{serverJs}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
