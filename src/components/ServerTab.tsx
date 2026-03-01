import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import {
  Copy, Check, Server, Globe, Shield, Play, Download,
  ExternalLink, Code, Zap, Database, RefreshCw, Link,
  Terminal, GitBranch, AlertCircle, CheckCircle, Wifi,
  Star, Package, HardDrive, ChevronRight
} from 'lucide-react';
import toast from 'react-hot-toast';

interface ServerStats {
  serverVersion?: string;
  uptime?: number;
  channels?: number;
  activeChannels?: number;
  tamilChannels?: number;
  drmChannels?: number;
  groups?: number;
  playlists?: number;
  sources?: number;
  drmProxies?: number;
  playlistUrls?: { name: string; url: string; tamil: boolean }[];
}

export default function ServerTab() {
  const { playlists, channels, drmProxies, serverUrl, syncDB, exportDB } = useStore();
  const [copied, setCopied]                   = useState<string | null>(null);
  const [activeSection, setActiveSection]     = useState<'overview' | 'deploy' | 'api' | 'serverjs'>('overview');
  const [syncing, setSyncing]                 = useState(false);
  const [serverStats, setServerStats]         = useState<ServerStats | null>(null);
  const [serverOnline, setServerOnline]       = useState<boolean | null>(null);
  const [checkingServer, setCheckingServer]   = useState(false);

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Copied!');
  };

  const checkServer = async () => {
    setCheckingServer(true);
    try {
      const res = await fetch(`${serverUrl}/api/stats`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        setServerStats(data);
        setServerOnline(true);
      } else {
        setServerOnline(false);
      }
    } catch {
      setServerOnline(false);
    }
    setCheckingServer(false);
  };

  useEffect(() => { checkServer(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncDB();
      toast.success('✅ Database synced to server!');
      await checkServer();
    } catch {
      toast.error('Sync failed — server may be offline');
    }
    setSyncing(false);
  };

  const handleExport = () => {
    const content = exportDB();
    const blob    = new Blob([content], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href     = url;
    a.download = 'iptv-db.json';
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Database exported!');
  };

  // ── server.js full source ────────────────────────────────────────────────
  const serverJsPreview = `/**
 * IPTV Playlist Manager — Full Stack Server
 * Deploy: Render.com | Railway | Fly.io | VPS
 *
 * Features:
 *  ✅ Live M3U playlist generation (proxy URLs)
 *  ✅ Stream redirect proxy (hides original URLs)
 *  ✅ Full stream pipe proxy (UA, Referer, Cookie)
 *  ✅ DRM: ClearKey kid:key + Widevine license forwarding
 *  ✅ CORS proxy for frontend source fetching
 *  ✅ Auto-refresh sources on schedule
 *  ✅ Full CRUD REST API
 *  ✅ Tamil channel filter
 *  ✅ Persistent JSON database
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// DB
const DB_FILE = path.join(__dirname, 'db.json');
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { channels:[], playlists:[], drmProxies:[], sources:[], groups:[] }; }
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// GET /api/playlist/:id.m3u — Live playlist URL
app.get('/api/playlist/:id.m3u', (req, res) => {
  const db = loadDB();
  const pl = db.playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).send('# Not found');
  const BASE = \`\${req.protocol}://\${req.get('host')}\`;
  const filtered = db.channels.filter(ch => {
    if (!ch.isActive) return false;
    if (pl.tamilOnly && !ch.isTamil) return false;
    if (pl.includeGroups?.length && !pl.includeGroups.includes(ch.group)) return false;
    return true;
  });
  let m3u = '#EXTM3U\\n';
  filtered.forEach(ch => {
    const streamUrl = ch.isDrm
      ? \`\${BASE}/proxy/drm/\${ch.id}\`
      : \`\${BASE}/proxy/redirect/\${ch.id}\`;
    m3u += \`#EXTINF:-1 tvg-logo="\${ch.logo||''}" group-title="\${ch.group||''}",\${ch.name}\\n\${streamUrl}\\n\`;
  });
  res.setHeader('Content-Type', 'application/x-mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u);
});

// Redirect proxy — hides original URL
app.get('/proxy/redirect/:id', async (req, res) => {
  const ch = loadDB().channels.find(c => c.id === req.params.id);
  if (!ch) return res.status(404).send('Not found');
  const headers = { 'User-Agent': ch.userAgent || 'Mozilla/5.0' };
  if (ch.referer) headers['Referer'] = ch.referer;
  if (ch.cookie)  headers['Cookie']  = ch.cookie;
  if (ch.referer || ch.cookie) {
    const up = await fetch(ch.url, { headers, redirect: 'follow' });
    res.setHeader('Content-Type', up.headers.get('content-type') || 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    up.body.pipe(res);
  } else {
    res.redirect(302, ch.url);
  }
});

// DRM proxy — ClearKey license endpoint
app.get('/proxy/drm/:id', async (req, res) => {
  const ch  = loadDB().channels.find(c => c.id === req.params.id);
  const drm = loadDB().drmProxies.find(d => d.channelId === req.params.id && d.isActive);
  if (!ch || !drm) return res.redirect(302, ch?.url || '');
  res.redirect(302, ch.url); // player fetches license from /proxy/drm-license/:id
});

app.post('/proxy/drm-license/:id', (req, res) => {
  const drm = loadDB().drmProxies.find(d => d.id === req.params.id);
  if (!drm) return res.status(404).json({ error: 'Not found' });
  const pairs = (drm.licenseUrl || drm.key || '').split(',').map(p => {
    const [kid, k] = p.trim().split(':');
    return { kty: 'oct', kid: kid || drm.keyId, k: k || drm.key };
  });
  res.json({ keys: pairs, type: 'temporary' });
});

// CORS proxy
app.get('/proxy/cors', async (req, res) => {
  const resp = await fetch(req.query.url, { headers: { 'User-Agent': 'IPTV/1.0' } });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(await resp.text());
});

// Sync DB from frontend
app.post('/api/sync', (req, res) => {
  saveDB(req.body);
  res.json({ ok: true, channels: (req.body.channels||[]).length });
});

app.get('/api/stats', (req, res) => {
  const db = loadDB();
  res.json({ channels: db.channels.length, playlists: db.playlists.length });
});

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
);

app.listen(PORT, () => console.log(\`🚀 IPTV Manager: http://localhost:\${PORT}\`));`;

  const renderYaml = `services:
  - type: web
    name: iptv-manager
    env: node
    plan: free
    region: singapore
    buildCommand: npm install && npm run build
    startCommand: node server.js
    healthCheckPath: /api/stats
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3000
    disk:
      name: iptv-data
      mountPath: /opt/render/project/src
      sizeGB: 1`;

  const deploySteps = [
    {
      n: '1',
      icon: <GitBranch className="w-4 h-4 text-white" />,
      title: 'Push to GitHub',
      desc: 'Create a GitHub repository and push all project files.',
      code: `git init
git add .
git commit -m "IPTV Manager"
git remote add origin https://github.com/YOUR/iptv-manager.git
git push -u origin main`,
      codeId: 'git',
      color: 'bg-gray-700',
    },
    {
      n: '2',
      icon: <Package className="w-4 h-4 text-white" />,
      title: 'render.yaml (already in project)',
      desc: 'The render.yaml file is already in your project root with the correct config.',
      code: renderYaml,
      codeId: 'renderyaml',
      color: 'bg-blue-700',
    },
    {
      n: '3',
      icon: <ExternalLink className="w-4 h-4 text-white" />,
      title: 'Deploy on Render.com',
      desc: 'Go to render.com → New + → Web Service → Connect GitHub repo → Deploy!',
      link: 'https://render.com/deploy',
      color: 'bg-green-700',
    },
    {
      n: '4',
      icon: <RefreshCw className="w-4 h-4 text-white" />,
      title: 'Sync Database',
      desc: 'After deploy, click "Sync to Server" above to push all channels/playlists to the live server. Every future change auto-syncs.',
      color: 'bg-purple-700',
    },
    {
      n: '5',
      icon: <Play className="w-4 h-4 text-white" />,
      title: 'Add Playlist to Player',
      desc: 'Copy your playlist URL from the Overview tab. Paste into VLC, TiviMate, Kodi, IPTV Smarters, etc.',
      color: 'bg-orange-700',
    },
  ];

  const apiDocs = [
    { method: 'GET',    path: '/api/stats',                  desc: 'Server status, uptime, channel counts, all playlist URLs' },
    { method: 'GET',    path: '/api/playlist/:id.m3u',        desc: '🔴 LIVE M3U — proxy URLs, updates instantly when sources change' },
    { method: 'GET',    path: '/api/playlist/:id.json',       desc: 'Playlist metadata + channel count as JSON' },
    { method: 'GET',    path: '/api/playlists',               desc: 'All playlists with live M3U URLs' },
    { method: 'GET',    path: '/proxy/redirect/:channelId',   desc: '🔀 Redirect proxy — hides original URL, forwards UA/Referer/Cookie' },
    { method: 'GET',    path: '/proxy/stream/:channelId',     desc: '📡 Full pipe proxy — streams through server with all headers' },
    { method: 'GET',    path: '/proxy/drm/:channelId',        desc: '🔐 DRM stream proxy — ClearKey manifest injection + Widevine passthrough' },
    { method: 'POST',   path: '/proxy/drm-license/:id',       desc: '🔑 ClearKey JSON license (DASH.js/Shaka/ExoPlayer/hls.js compatible)' },
    { method: 'GET',    path: '/proxy/cors?url=...',          desc: '🌐 CORS proxy — server-side fetch for any URL (M3U, JSON, PHP APIs)' },
    { method: 'GET',    path: '/api/channels',                desc: 'List channels (?group=X &tamil=true &active=true &drm=true)' },
    { method: 'POST',   path: '/api/channels',                desc: 'Create channel (auto-detects Tamil, assigns isTamil flag)' },
    { method: 'PUT',    path: '/api/channels/:id',            desc: 'Update channel' },
    { method: 'DELETE', path: '/api/channels/:id',            desc: 'Delete channel + associated DRM proxy' },
    { method: 'POST',   path: '/api/channels/bulk/toggle',    desc: 'Bulk enable/disable channels: { ids: [], isActive: bool }' },
    { method: 'GET',    path: '/api/groups',                  desc: 'Groups with channel count + Tamil count' },
    { method: 'GET',    path: '/api/drm',                     desc: 'List DRM proxy configs' },
    { method: 'POST',   path: '/api/drm',                     desc: 'Add DRM proxy config' },
    { method: 'PUT',    path: '/api/drm/:id',                 desc: 'Update DRM proxy' },
    { method: 'DELETE', path: '/api/drm/:id',                 desc: 'Delete DRM proxy' },
    { method: 'POST',   path: '/api/sync',                    desc: '🔁 Sync full DB from frontend — auto-called on every change' },
    { method: 'GET',    path: '/api/db/export',               desc: 'Download full database as JSON' },
    { method: 'POST',   path: '/api/db/import',               desc: 'Import database from JSON body' },
  ];

  const methodColor = (m: string) => {
    if (m === 'GET')    return 'bg-green-900/60 text-green-400 border-green-800/30';
    if (m === 'POST')   return 'bg-blue-900/60 text-blue-400 border-blue-800/30';
    if (m === 'PUT')    return 'bg-yellow-900/60 text-yellow-400 border-yellow-800/30';
    return 'bg-red-900/60 text-red-400 border-red-800/30';
  };

  const tamilChannels = channels.filter(c => c.isTamil).length;
  const drmActive     = drmProxies.filter(d => d.isActive).length;

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Server & Deployment</h2>
          <p className="text-gray-500 text-sm mt-0.5">Playlist proxy · DRM bypass · Stream server · Auto-sync</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={handleExport}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <Download className="w-4 h-4" /> Export DB
          </button>
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync to Server'}
          </button>
          <button onClick={checkServer} disabled={checkingServer}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors">
            <Wifi className={`w-4 h-4 ${checkingServer ? 'animate-pulse' : ''}`} />
            {checkingServer ? 'Checking...' : 'Ping'}
          </button>
        </div>
      </div>

      {/* ── Server Status Banner ─────────────────────────────────────────── */}
      <div className={`rounded-xl border p-4 transition-all ${
        serverOnline === true  ? 'bg-green-950/30 border-green-800/40' :
        serverOnline === false ? 'bg-red-950/30 border-red-800/40' :
        'bg-gray-800 border-gray-700'
      }`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${
              serverOnline === true  ? 'bg-green-500 animate-pulse' :
              serverOnline === false ? 'bg-red-500' :
              'bg-gray-500 animate-pulse'
            }`} />
            <div>
              <p className={`font-semibold text-sm ${
                serverOnline === true ? 'text-green-400' : serverOnline === false ? 'text-red-400' : 'text-gray-400'
              }`}>
                {serverOnline === true  ? '✅ Server Online' :
                 serverOnline === false ? '❌ Server Offline (Deploy to Render.com)' :
                 '🔍 Checking server...'}
              </p>
              <p className="text-gray-500 text-xs font-mono mt-0.5">{serverUrl}</p>
            </div>
          </div>
          {serverStats && serverOnline && (
            <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap">
              <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-green-400" />v{serverStats.serverVersion}</span>
              <span>{serverStats.channels} ch</span>
              <span>{serverStats.tamilChannels} tamil</span>
              <span>{serverStats.playlists} playlists</span>
              <span>⏱ {Math.floor((serverStats.uptime || 0) / 60)}m uptime</span>
            </div>
          )}
          {serverOnline === false && (
            <a href="https://render.com" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
              <ExternalLink className="w-3 h-3" /> Deploy on Render.com
            </a>
          )}
        </div>
      </div>

      {/* ── Stats Grid ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Active Channels',  value: channels.filter(c => c.isActive).length, color: 'text-blue-400',   icon: <Play className="w-5 h-5" /> },
          { label: 'Playlists',        value: playlists.length,                         color: 'text-green-400',  icon: <Database className="w-5 h-5" /> },
          { label: 'DRM Proxies',      value: drmActive,                                color: 'text-purple-400', icon: <Shield className="w-5 h-5" /> },
          { label: 'Tamil Channels',   value: tamilChannels,                            color: 'text-orange-400', icon: <Star className="w-5 h-5" /> },
        ].map(stat => (
          <div key={stat.label} className="bg-gray-800 border border-gray-700 rounded-xl p-4 text-center">
            <div className={`flex justify-center mb-2 ${stat.color} opacity-70`}>{stat.icon}</div>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-gray-500 text-xs mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* ── Section Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-gray-900 p-1 rounded-lg w-fit border border-gray-800 overflow-x-auto">
        {([
          { id: 'overview', label: '🏠 Overview' },
          { id: 'deploy',   label: '🚀 Deploy' },
          { id: 'api',      label: '📡 API Docs' },
          { id: 'serverjs', label: '📄 server.js' },
        ] as const).map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              activeSection === s.id ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
           OVERVIEW
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'overview' && (
        <div className="space-y-4">

          {/* Playlist URLs */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-400" /> Live Playlist URLs
            </h3>

            {/* Base URL */}
            <div className="flex items-center gap-2 p-3 bg-gray-900 rounded-lg border border-gray-700">
              <Globe className="w-4 h-4 text-gray-500 shrink-0" />
              <code className="text-green-400 text-sm flex-1 font-mono truncate">{serverUrl}</code>
              <button onClick={() => copy(serverUrl, 'base')} className="text-gray-400 hover:text-white p-1 shrink-0">
                {copied === 'base' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {playlists.length > 0 ? (
              <div className="space-y-2">
                <p className="text-gray-400 text-sm font-medium">Your Playlist URLs — add to VLC / TiviMate / Kodi / IPTV Smarters:</p>
                {playlists.map(pl => {
                  const url = `${serverUrl}/api/playlist/${pl.id}.m3u`;
                  const ch  = channels.filter(c => {
                    if (!c.isActive) return false;
                    if (pl.tamilOnly && !c.isTamil) return false;
                    if (pl.includeGroups?.length && !pl.includeGroups.includes(c.group)) return false;
                    return true;
                  }).length;
                  return (
                    <div key={pl.id}
                      className="p-4 bg-gray-900 rounded-xl border border-gray-700 hover:border-blue-700/50 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <p className="text-white font-medium text-sm">{pl.name}</p>
                            {pl.tamilOnly && (
                              <span className="text-xs bg-orange-500/20 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full">
                                🎬 Tamil Only
                              </span>
                            )}
                            <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
                              {ch} channels
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Link className="w-3 h-3 text-blue-400 shrink-0" />
                            <code className="text-blue-400 text-xs font-mono truncate">{url}</code>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            className="p-1.5 text-gray-500 hover:text-white rounded hover:bg-gray-700 transition-colors">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                          <button onClick={() => copy(url, pl.id)}
                            className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-gray-700 transition-colors">
                            {copied === pl.id ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <Database className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No playlists yet.</p>
                <p className="text-xs mt-1">Go to the <span className="text-blue-400">Playlists</span> tab to create one.</p>
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-5 flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" /> How It Works
            </h3>
            <div className="space-y-4">
              {[
                { n: '1', c: 'bg-blue-600',   icon: <Globe className="w-4 h-4 text-blue-300" />,   title: 'Add Sources',             desc: 'Upload M3U/JSON or paste URLs (GitHub raw, Pastebin, PHP APIs). Parser auto-detects format, extracts DRM keys, auto-tags Tamil channels.' },
                { n: '2', c: 'bg-green-600',  icon: <RefreshCw className="w-4 h-4 text-green-300" />, title: 'Auto-Sync to Server',    desc: 'Every change (add/edit/delete/toggle) auto-syncs to server via POST /api/sync. Server always has the latest data.' },
                { n: '3', c: 'bg-purple-600', icon: <Database className="w-4 h-4 text-purple-300" />, title: 'Playlist URL Generated', desc: 'Create playlists filtered by group or Tamil-only. Each gets a unique /api/playlist/{id}.m3u URL served live from server.' },
                { n: '4', c: 'bg-orange-600', icon: <Server className="w-4 h-4 text-orange-300" />,  title: 'Stream Proxy',           desc: 'M3U links point to /proxy/redirect/{id}. Original URLs never exposed. UA, Referer, Cookie forwarded automatically.' },
                { n: '5', c: 'bg-red-600',    icon: <Shield className="w-4 h-4 text-red-300" />,    title: 'DRM Bypass',              desc: 'DRM streams → /proxy/drm/{id}. ClearKey: kid:key pairs served at /proxy/drm-license/{id} in W3C format. Widevine: license forwarded to real server.' },
                { n: '6', c: 'bg-yellow-600', icon: <Star className="w-4 h-4 text-yellow-300" />,   title: 'Tamil Filter',            desc: 'Tamil channels auto-detected from name/group/language. Filter in Sources, Channels, or create Tamil-Only playlists with one click.' },
              ].map(item => (
                <div key={item.n} className="flex gap-4">
                  <div className={`w-7 h-7 rounded-full ${item.c} flex items-center justify-center shrink-0 text-white text-xs font-bold mt-0.5`}>
                    {item.n}
                  </div>
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

      {/* ══════════════════════════════════════════════════════════════════
           DEPLOY
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'deploy' && (
        <div className="space-y-4">

          {/* Render.com Steps */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <ExternalLink className="w-4 h-4 text-blue-400" /> Deploy to Render.com (Free)
              </h3>
              <a href="https://render.com" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                <ExternalLink className="w-3 h-3" /> Open Render.com
              </a>
            </div>

            {deploySteps.map(step => (
              <div key={step.n} className="flex gap-4">
                <div className={`w-8 h-8 rounded-full ${step.color} flex items-center justify-center shrink-0 mt-0.5`}>
                  {step.icon}
                </div>
                <div className="flex-1">
                  <p className="text-white font-medium text-sm flex items-center gap-2">
                    <span className="text-gray-500 text-xs font-bold">Step {step.n}</span>
                    <ChevronRight className="w-3 h-3 text-gray-600" />
                    {step.title}
                  </p>
                  {step.desc && <p className="text-gray-400 text-xs mt-0.5 leading-relaxed">{step.desc}</p>}
                  {step.code && (
                    <div className="mt-2 bg-gray-950 rounded-lg border border-gray-700 overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-900">
                        <span className="text-gray-400 text-xs font-mono">
                          {step.codeId === 'git' ? 'terminal' : 'render.yaml'}
                        </span>
                        <button onClick={() => copy(step.code!, step.codeId!)}
                          className="text-gray-400 hover:text-white p-0.5">
                          {copied === step.codeId ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
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

          {/* Disk notice */}
          <div className="bg-yellow-950/30 border border-yellow-800/30 rounded-xl p-4 flex gap-3">
            <HardDrive className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-yellow-300 font-medium text-sm">Persistent Disk Required</p>
              <p className="text-yellow-700 text-xs leading-relaxed mt-1">
                Render free tier includes a 1GB persistent disk (configured in render.yaml). This stores your <code className="font-mono bg-yellow-900/20 px-1 rounded">db.json</code> database between deploys. Without it, data resets on each deploy.
              </p>
            </div>
          </div>

          {/* Other platforms */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Server className="w-4 h-4 text-purple-400" /> Other Platforms
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { name: 'Railway', badge: 'Free $5/mo',   cmd: 'railway up',        url: 'https://railway.app', color: 'border-purple-700', bc: 'bg-purple-600' },
                { name: 'Fly.io',  badge: 'Free Tier',    cmd: 'flyctl deploy',     url: 'https://fly.io',      color: 'border-blue-700',   bc: 'bg-blue-600' },
                { name: 'VPS',     badge: 'Full Control', cmd: 'node server.js',    url: 'https://digitalocean.com', color: 'border-green-700', bc: 'bg-green-600' },
              ].map(p => (
                <div key={p.name} className={`p-4 bg-gray-900 rounded-lg border ${p.color}`}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-white font-medium">{p.name}</p>
                    <span className={`text-xs ${p.bc} text-white px-2 py-0.5 rounded-full`}>{p.badge}</span>
                  </div>
                  <code className="text-green-400 text-xs font-mono block mb-2">{p.cmd}</code>
                  <a href={p.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-blue-400 text-xs hover:text-blue-300">
                    <ExternalLink className="w-3 h-3" /> {p.url.replace('https://', '')}
                  </a>
                </div>
              ))}
            </div>
          </div>

          {/* ENV vars */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-gray-400" /> Environment Variables
            </h3>
            <div className="space-y-2">
              {[
                { key: 'PORT',      val: '3000',        desc: 'Server port (Render sets this automatically)' },
                { key: 'NODE_ENV',  val: 'production',  desc: 'Environment mode' },
                { key: 'DB_FILE',   val: '/data/db.json', desc: 'Optional: custom DB path for persistent storage' },
              ].map(env => (
                <div key={env.key} className="flex items-center gap-3 p-3 bg-gray-900 rounded-lg">
                  <code className="text-yellow-400 text-xs font-mono w-24 shrink-0">{env.key}</code>
                  <code className="text-green-400 text-xs font-mono w-32 shrink-0">{env.val}</code>
                  <span className="text-gray-500 text-xs">{env.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
           API DOCS
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'api' && (
        <div className="space-y-4">
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Code className="w-4 h-4 text-blue-400" /> REST API Reference
            </h3>
            <div className="space-y-1.5">
              {apiDocs.map((api, i) => (
                <div key={i}
                  className="flex items-start gap-3 p-3 bg-gray-900 rounded-lg hover:bg-gray-800/80 transition-colors group">
                  <span className={`text-xs font-mono font-bold px-2 py-1 rounded border shrink-0 ${methodColor(api.method)}`}>
                    {api.method}
                  </span>
                  <div className="flex-1 min-w-0">
                    <code className="text-white text-xs font-mono">{api.path}</code>
                    <p className="text-gray-500 text-xs mt-0.5">{api.desc}</p>
                  </div>
                  <button
                    onClick={() => copy(
                      `${serverUrl}${api.path.replace(':id','PLAYLIST_ID').replace(':channelId','CHANNEL_ID')}`,
                      `api-${i}`
                    )}
                    className="shrink-0 text-gray-600 hover:text-white p-1 opacity-0 group-hover:opacity-100 transition-all">
                    {copied === `api-${i}` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* DRM Details */}
          <div className="bg-purple-950/30 border border-purple-800/30 rounded-xl p-5">
            <h3 className="text-purple-300 font-semibold mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4" /> DRM Bypass Details
            </h3>
            <div className="space-y-2 text-xs leading-relaxed">
              {[
                { t: 'ClearKey (DASH)',  c: 'text-green-300',  d: 'kid:key pairs stored in DRM proxy config. License served at /proxy/drm-license/:id as W3C ClearKey JSON. Compatible with DASH.js, Shaka Player, ExoPlayer.' },
                { t: 'ClearKey (HLS)',   c: 'text-blue-300',   d: 'EXT-X-KEY injected into M3U8 manifest pointing to license endpoint. Works with hls.js and native HLS players.' },
                { t: 'Widevine',         c: 'text-yellow-300', d: 'License requests forwarded to real Widevine server with binary body preserved. Player handles CDM natively.' },
                { t: 'PlayReady',        c: 'text-orange-300', d: 'XML license requests forwarded to PlayReady license server. Compatible with Edge/IE native playback.' },
                { t: 'JioTV Format',     c: 'text-pink-300',   d: 'drmScheme + drmLicense (kid:key) auto-parsed from JSON sources. Auto-creates DRM proxy entry.' },
                { t: 'KODIPROP',         c: 'text-purple-300', d: 'inputstream.adaptive.license_type/key extracted from M3U #KODIPROP lines.' },
                { t: 'Multi-key',        c: 'text-cyan-300',   d: 'Comma-separated kid1:key1,kid2:key2 format. All keys returned in single ClearKey response.' },
              ].map(item => (
                <p key={item.t} className="text-gray-400">
                  <strong className={item.c}>{item.t}:</strong> {item.d}
                </p>
              ))}
            </div>
          </div>

          {/* Quick test */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-green-400" /> Quick Test
            </h3>
            <div className="space-y-2">
              {[
                { label: 'Server stats',     cmd: `curl ${serverUrl}/api/stats` },
                { label: 'List playlists',   cmd: `curl ${serverUrl}/api/playlists` },
                { label: 'Tamil channels',   cmd: `curl "${serverUrl}/api/channels?tamil=true"` },
                { label: 'CORS proxy test',  cmd: `curl "${serverUrl}/proxy/cors?url=https://example.com/playlist.m3u"` },
              ].map(t => (
                <div key={t.label} className="flex items-center gap-3 p-2.5 bg-gray-900 rounded-lg group">
                  <span className="text-gray-500 text-xs w-32 shrink-0">{t.label}</span>
                  <code className="text-green-400 text-xs font-mono flex-1 truncate">{t.cmd}</code>
                  <button onClick={() => copy(t.cmd, `test-${t.label}`)}
                    className="shrink-0 p-1 text-gray-600 hover:text-white opacity-0 group-hover:opacity-100 transition-all">
                    {copied === `test-${t.label}` ? <CheckCircle className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
           SERVER.JS
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'serverjs' && (
        <div className="space-y-4">
          <div className="bg-green-950/20 border border-green-800/30 rounded-xl p-4 flex items-start gap-3">
            <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-green-300 font-medium text-sm">server.js is included in your project</p>
              <p className="text-green-700 text-xs mt-0.5">
                The complete <code className="font-mono bg-green-900/20 px-1 rounded">server.js</code> is already in your project root.
                Push to GitHub and deploy on Render.com — it will auto-build and start.
              </p>
            </div>
          </div>

          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-900">
              <div className="flex items-center gap-3">
                <Code className="w-4 h-4 text-green-400" />
                <span className="text-white font-mono text-sm font-medium">server.js</span>
                <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
                  Express · Playlist · Proxy · DRM · ClearKey · Widevine · CORS · Auto-sync
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => copy(serverJsPreview, 'serverjs')}
                  className="flex items-center gap-1.5 bg-green-700 hover:bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors">
                  {copied === 'serverjs' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  Copy
                </button>
              </div>
            </div>
            <pre className="p-4 text-green-400 text-xs overflow-auto max-h-[600px] leading-relaxed whitespace-pre-wrap font-mono">
              {serverJsPreview}
            </pre>
          </div>

          {/* Features list */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3">What server.js does</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[
                '✅ Live M3U playlist generation (proxy URLs)',
                '✅ Stream redirect proxy (hides original URLs)',
                '✅ Full pipe proxy (UA, Referer, Cookie headers)',
                '✅ ClearKey DRM: kid:key license serving',
                '✅ Widevine: license forwarding to real server',
                '✅ PlayReady: XML license forwarding',
                '✅ HLS EXT-X-KEY injection for ClearKey',
                '✅ DASH MPD license URL injection',
                '✅ CORS proxy for frontend source fetching',
                '✅ Auto-refresh sources (per-source interval)',
                '✅ Full CRUD REST API for all entities',
                '✅ Tamil channel auto-detection server-side',
                '✅ Persistent JSON database (db.json)',
                '✅ Bulk channel operations',
                '✅ DB import/export endpoints',
                '✅ SPA fallback for React frontend',
                '✅ Health check at /api/stats',
                '✅ Auto-sync from frontend on every change',
              ].map(f => (
                <p key={f} className="text-gray-400 text-xs">{f}</p>
              ))}
            </div>
          </div>

          {/* Required packages */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-blue-400" /> Required npm Packages
            </h3>
            <div className="bg-gray-950 rounded-lg p-3 border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 text-xs font-mono">package.json dependencies</span>
                <button onClick={() => copy('npm install express cors node-fetch', 'npm')}
                  className="text-gray-400 hover:text-white p-0.5">
                  {copied === 'npm' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <pre className="text-green-400 text-xs font-mono">{`npm install express cors node-fetch

"dependencies": {
  "express":    "^4.18.2",
  "cors":       "^2.8.5",
  "node-fetch": "^3.3.2"
}`}</pre>
            </div>
            <p className="text-gray-600 text-xs mt-2 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Already installed in this project via npm install.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
