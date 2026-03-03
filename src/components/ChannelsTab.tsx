import React, { useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { Channel, CombinedLink } from '../types';
import {
  Search, Filter, Trash2, Edit2, Save, X, ChevronDown, ChevronUp,
  Heart, Wifi, WifiOff, Loader, Activity, Zap,
  Copy, Check, GitMerge, Globe, Lock,
} from 'lucide-react';
import toast from 'react-hot-toast';

const PAGE_SIZE = 50;

// ── Routing badge ─────────────────────────────────────────────────────────────
function RouteBadge({ ch }: { ch: Channel }) {
  const hasDRM = !!(ch.isDrm || ch.licenseType);
  if (hasDRM) {
    const urlLower = (ch.url || '').toLowerCase();
    const t = urlLower.includes('.mpd') || urlLower.includes('/dash/') ? 'DASH'
            : urlLower.includes('.m3u8') || urlLower.includes('/hls/') ? 'HLS' : 'TS';
    return (
      <span className="flex items-center gap-1 text-xs bg-purple-500/10 border border-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full whitespace-nowrap">
        <Lock className="w-2.5 h-2.5" /> DRM {t}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs bg-green-500/10 border border-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full whitespace-nowrap">
      <Globe className="w-2.5 h-2.5" /> 302
    </span>
  );
}

// ── Health badge ──────────────────────────────────────────────────────────────
function HealthBadge({ ch }: { ch: Channel }) {
  if (!ch.healthStatus || ch.healthStatus === 'unknown') return null;
  if (ch.healthStatus === 'checking') return (
    <span className="flex items-center gap-1 text-xs text-yellow-400"><Loader className="w-3 h-3 animate-spin" /></span>
  );
  if (ch.healthStatus === 'ok') return (
    <span className="flex items-center gap-1 text-xs text-green-400">
      <Wifi className="w-3 h-3" />
      {ch.healthLatency ? `${ch.healthLatency}ms` : 'Live'}
    </span>
  );
  return <span className="flex items-center gap-1 text-xs text-red-400"><WifiOff className="w-3 h-3" /> Dead</span>;
}

// ── Multi-source best link panel ───────────────────────────────────────────────
function MultiSourcePanel({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const { checkCombinedLinks, getBestLink, serverUrl } = useStore();
  const base = serverUrl || window.location.origin;
  const [links, setLinks]       = useState<CombinedLink[]>([]);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied]     = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    const result = await checkCombinedLinks(ch.name);
    setLinks(result);
    setChecking(false);
  };

  const useBest = async () => {
    const result = await getBestLink(ch.name);
    if (result?.best) {
      const url = `${base}/proxy/best/${encodeURIComponent(ch.name)}`;
      navigator.clipboard.writeText(url);
      toast.success(`⚡ Best-link URL copied! Fastest: ${result.best.latency}ms`);
    } else {
      toast.error('No live links found');
    }
  };

  const copyLink = (key: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(key); setTimeout(() => setCopied(null), 2000);
    toast.success('URL copied!');
  };

  return (
    <div className="mt-3 bg-gray-900 border border-purple-500/30 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-purple-400" />
          <span className="text-white font-medium text-sm">Multi-Source Links — {ch.name}</span>
          <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full">
            {(ch.combinedLinks || []).length} sources
          </span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Best-link URL */}
      <div className="bg-gray-800 rounded-lg p-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400 mb-1">⚡ Smart Best-Link URL (auto-selects fastest)</p>
          <p className="text-blue-400 text-xs font-mono truncate">
            {base}/proxy/best/{encodeURIComponent(ch.name)}
          </p>
        </div>
        <button onClick={useBest} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium whitespace-nowrap transition-colors">
          <Zap className="w-3 h-3" /> Use Best Link
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={check} disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 border border-green-600/30 text-green-400 hover:bg-green-600/30 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
          {checking ? <Loader className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
          {checking ? 'Checking all links...' : 'Check All Links'}
        </button>
      </div>

      {/* Links list */}
      <div className="space-y-2">
        {(links.length > 0 ? links : (ch.combinedLinks || [])).map((link, i) => (
          <div key={link.channelId + i}
            className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
              link.status === 'live' ? 'bg-green-500/5 border-green-500/20' :
              link.status === 'dead' ? 'bg-red-500/5 border-red-500/20' :
              'bg-gray-800 border-gray-700'
            }`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white text-xs font-medium">{link.sourceName || link.sourceId}</span>
                {link.isDrm && <span className="text-xs bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded-full">DRM</span>}
                {link.status === 'live' && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <Wifi className="w-3 h-3" /> Live {link.latency ? `${link.latency}ms` : ''}
                  </span>
                )}
                {link.status === 'dead' && <span className="flex items-center gap-1 text-xs text-red-400"><WifiOff className="w-3 h-3" /> Dead</span>}
                {(!link.status || link.status === 'unknown') && <span className="text-xs text-gray-500">Not checked</span>}
              </div>
              <p className="text-gray-500 text-xs font-mono truncate mt-0.5">{link.url}</p>
            </div>
            <button onClick={() => copyLink(link.channelId, link.url)}
              className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors rounded">
              {copied === link.channelId ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Edit modal ────────────────────────────────────────────────────────────────
interface EditState {
  name: string; url: string; group: string; logo: string;
  userAgent: string; referer: string; cookie: string;
  licenseType: string; licenseKey: string; isDrm: boolean;
}

function EditModal({ ch, onSave, onClose }: { ch: Channel; onSave: (v: EditState) => void; onClose: () => void }) {
  const { groups } = useStore();
  const [v, setV] = useState<EditState>({
    name: ch.name, url: ch.url, group: ch.group, logo: ch.logo || '',
    userAgent: ch.userAgent || '', referer: ch.referer || '', cookie: ch.cookie || '',
    licenseType: ch.licenseType || '', licenseKey: ch.licenseKey || '', isDrm: !!(ch.isDrm || ch.licenseType),
  });
  const f = (k: keyof EditState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV(prev => ({ ...prev, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Edit Channel</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        {[
          ['Name', 'name', 'text', 'Channel name'],
          ['Stream URL', 'url', 'url', 'https://...'],
          ['Logo URL', 'logo', 'url', 'https://logo.png'],
          ['User-Agent', 'userAgent', 'text', 'Mozilla/5.0...'],
          ['Referer', 'referer', 'url', 'https://referer.com/'],
          ['Cookie', 'cookie', 'text', 'session=abc123'],
        ].map(([label, key, type]) => (
          <div key={key}>
            <label className="text-gray-400 text-sm mb-1 block">{label}</label>
            <input type={type} value={String(v[key as keyof EditState])} onChange={f(key as keyof EditState)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
              placeholder={[, , , , , , ][0] || ''} />
          </div>
        ))}
        <div>
          <label className="text-gray-400 text-sm mb-1 block">Group</label>
          <select value={v.group} onChange={f('group')}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
            {groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={v.isDrm} onChange={e => setV(prev => ({ ...prev, isDrm: e.target.checked }))}
            className="w-4 h-4 accent-purple-500" />
          <span className="text-gray-300 text-sm">DRM Protected Stream</span>
        </label>
        {v.isDrm && (
          <div className="space-y-3 p-3 bg-purple-900/20 border border-purple-500/20 rounded-lg">
            <div>
              <label className="text-gray-400 text-sm mb-1 block">License Type</label>
              <select value={v.licenseType} onChange={f('licenseType')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500">
                <option value="clearkey">ClearKey (kid:key)</option>
                <option value="widevine">Widevine</option>
                <option value="playready">PlayReady</option>
                <option value="fairplay">FairPlay</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-sm mb-1 block">License Key / URL</label>
              <input value={v.licenseKey} onChange={f('licenseKey')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                placeholder="kid:key or https://license-server.com" />
            </div>
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
          <button onClick={() => onSave(v)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
            <Save className="w-4 h-4" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ChannelsTab() {
  const {
    channels, sources, showTamilOnly, setShowTamilOnly,
    updateChannel, deleteChannel, toggleChannel, serverUrl,
    getFilteredChannels,
  } = useStore();

  const [search, setSearch]         = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [routeFilter, setRouteFilter] = useState<'all' | 'direct' | 'drm' | 'multi'>('all');
  const [page, setPage]             = useState(1);
  const [editCh, setEditCh]         = useState<Channel | null>(null);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [checking, setChecking]     = useState<Record<string, boolean>>({});
  const [batchChecking, setBatchChecking] = useState(false);
  const base = serverUrl || window.location.origin;

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return getFilteredChannels().filter(ch => {
      if (groupFilter && ch.group !== groupFilter) return false;
      if (routeFilter === 'direct' && (ch.isDrm || ch.licenseType)) return false;
      if (routeFilter === 'drm'    && !(ch.isDrm || ch.licenseType)) return false;
      if (routeFilter === 'multi'  && !ch.multiSource) return false;
      if (q && !ch.name.toLowerCase().includes(q) && !ch.group.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [channels, search, groupFilter, routeFilter, showTamilOnly, getFilteredChannels]);

  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const multiSourceCount = channels.filter(ch => ch.multiSource).length;
  const drmCount         = channels.filter(ch => ch.isDrm || ch.licenseType).length;
  const tamilCount       = channels.filter(ch => ch.isTamil).length;

  // Single channel health check
  const checkHealth = async (ch: Channel) => {
    setChecking(c => ({ ...c, [ch.id]: true }));
    updateChannel(ch.id, { healthStatus: 'checking' });
    try {
      const resp = await fetch(`${base}/api/health/${ch.id}`, { signal: AbortSignal.timeout(12000) });
      const data = await resp.json();
      updateChannel(ch.id, { healthStatus: data.ok ? 'ok' : 'error', healthLatency: data.latency });
      toast.success(data.ok ? `✅ ${ch.name}: Live (${data.latency}ms) — ${data.routing}` : `❌ ${ch.name}: Dead (${data.status})`);
    } catch {
      updateChannel(ch.id, { healthStatus: 'error' });
      toast.error('Health check failed — is server running?');
    } finally {
      setChecking(c => { const n = { ...c }; delete n[ch.id]; return n; });
    }
  };

  // Batch health check for current page
  const batchCheck = async () => {
    setBatchChecking(true);
    const ids = paged.map(ch => ch.id);
    ids.forEach(id => updateChannel(id, { healthStatus: 'checking' }));
    try {
      const resp = await fetch(`${base}/api/health/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.ok) {
        const data = await resp.json();
        Object.entries(data.results || {}).forEach(([id, r]: [string, any]) => {
          updateChannel(id, { healthStatus: r.ok ? 'ok' : 'error', healthLatency: r.latency });
        });
        const live = Object.values(data.results || {}).filter((r: any) => r.ok).length;
        toast.success(`🏥 Health: ${live}/${ids.length} live on this page`);
      }
    } catch {
      ids.forEach(id => updateChannel(id, { healthStatus: 'error' }));
      toast.error('Batch health check failed');
    } finally {
      setBatchChecking(false);
    }
  };

  const saveEdit = (v: EditState) => {
    if (!editCh) return;
    updateChannel(editCh.id, {
      name: v.name, url: v.url, group: v.group, logo: v.logo || undefined,
      userAgent: v.userAgent || undefined, referer: v.referer || undefined, cookie: v.cookie || undefined,
      licenseType: v.licenseType || undefined, licenseKey: v.licenseKey || undefined,
      isDrm: v.isDrm,
    });
    toast.success('✅ Channel updated');
    setEditCh(null);
  };

  const copyUrl = (url: string) => { navigator.clipboard.writeText(url); toast.success('URL copied!'); };

  const groupNames = [...new Set(channels.map(ch => ch.group || 'Uncategorized'))].sort();

  return (
    <div className="space-y-4">
      {editCh && <EditModal ch={editCh} onSave={saveEdit} onClose={() => setEditCh(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Channels</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            {channels.length.toLocaleString()} total ·{' '}
            <span className="text-green-400">{(channels.length - drmCount).toLocaleString()} direct</span> ·{' '}
            <span className="text-purple-400">{drmCount} DRM</span>
            {tamilCount > 0 && <span className="text-orange-400"> · {tamilCount} 🎬 Tamil</span>}
            {multiSourceCount > 0 && <span className="text-blue-400"> · {multiSourceCount} 🔀 multi-source</span>}
          </p>
        </div>
        <button onClick={batchCheck} disabled={batchChecking}
          className="flex items-center gap-2 bg-green-700/40 hover:bg-green-700/60 border border-green-600/30 text-green-400 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
          {batchChecking ? <Loader className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
          {batchChecking ? 'Checking...' : `Check Health (${paged.length})`}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search channels..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors" />
        </div>

        <select value={groupFilter} onChange={e => { setGroupFilter(e.target.value); setPage(1); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 min-w-36">
          <option value="">All Groups</option>
          {groupNames.map(g => <option key={g} value={g}>{g}</option>)}
        </select>

        {/* Route filter */}
        <div className="flex gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
          {(['all', 'direct', 'drm', 'multi'] as const).map(f => (
            <button key={f} onClick={() => { setRouteFilter(f); setPage(1); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${routeFilter === f ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              {f === 'all' ? 'All' : f === 'direct' ? '🔁 Direct' : f === 'drm' ? '🔐 DRM' : '🔀 Multi'}
            </button>
          ))}
        </div>

        {/* Tamil toggle */}
        <button onClick={() => setShowTamilOnly(!showTamilOnly)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
            showTamilOnly ? 'bg-orange-500 border-orange-400 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-orange-500 hover:text-orange-400'
          }`}>
          <Heart className={`w-3.5 h-3.5 ${showTamilOnly ? 'fill-white' : ''}`} /> Tamil
        </button>
      </div>

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-gray-500">
        <span className="flex items-center gap-1"><Globe className="w-3 h-3 text-green-400" /> 302 Direct = server sends 302 redirect, player connects to source directly (zero server load)</span>
        <span className="flex items-center gap-1"><Lock className="w-3 h-3 text-purple-400" /> DRM = routed through server proxy for decryption</span>
        <span className="flex items-center gap-1"><GitMerge className="w-3 h-3 text-blue-400" /> Multi-source = same channel in multiple sources, server picks fastest link</span>
      </div>

      {/* Channel list */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Filter className="w-14 h-14 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium text-gray-400 mb-2">No channels found</p>
          <p className="text-sm">Try adjusting your search or filters</p>
        </div>
      ) : (
        <div className="space-y-2">
          {paged.map(ch => (
            <div key={ch.id} className={`bg-gray-800 border rounded-xl transition-all ${
              ch.multiSource ? 'border-blue-700/40' :
              ch.isDrm || ch.licenseType ? 'border-purple-700/30' :
              'border-gray-700 hover:border-gray-600'
            }`}>
              {/* Main row */}
              <div className="flex items-center gap-3 p-3">
                {/* Logo */}
                <div className="w-9 h-9 rounded-lg overflow-hidden bg-gray-700 flex items-center justify-center shrink-0">
                  {ch.logo
                    ? <img src={ch.logo} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    : <span className="text-gray-500 text-xs">TV</span>}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-medium text-sm truncate">{ch.name}</span>
                    {ch.isTamil && <span className="text-xs bg-orange-500/10 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded-full">🎬</span>}
                    {ch.multiSource && (
                      <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                        <GitMerge className="w-2.5 h-2.5" /> {(ch.combinedLinks || []).length} links
                      </span>
                    )}
                    <RouteBadge ch={ch} />
                    <HealthBadge ch={ch} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-gray-500 text-xs">{ch.group}</span>
                    <span className="text-gray-700">·</span>
                    <span className="text-gray-600 text-xs font-mono truncate max-w-48">{ch.url}</span>
                    <span className="text-gray-600 text-xs">{sources.find(s => s.id === ch.sourceId)?.name || ''}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {/* Health check */}
                  <button onClick={() => checkHealth(ch)} disabled={!!checking[ch.id]}
                    title="Check stream health"
                    className="p-1.5 text-gray-400 hover:text-green-400 transition-colors rounded-lg hover:bg-gray-700 disabled:opacity-50">
                    {checking[ch.id] ? <Loader className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                  </button>

                  {/* Copy stream URL */}
                  <button onClick={() => {
                    const hasDRM = ch.isDrm || ch.licenseType;
                    const urlLower = (ch.url || '').toLowerCase();
                    const isMPD   = urlLower.includes('.mpd') || urlLower.includes('/dash/');
                    const isM3U8  = urlLower.includes('.m3u8') || urlLower.includes('/hls/');
                    const url = hasDRM
                      ? (isMPD  ? `${base}/live/${ch.id}.mpd`
                       : isM3U8 ? `${base}/live/${ch.id}.m3u8`
                                : `${base}/live/${ch.id}.ts`)
                      : `${base}/proxy/redirect/${ch.id}`;
                    copyUrl(url);
                  }} title="Copy stream URL"
                    className="p-1.5 text-gray-400 hover:text-blue-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Copy className="w-4 h-4" />
                  </button>

                  {/* Multi-source expand */}
                  {ch.multiSource && (
                    <button onClick={() => setExpanded(expanded === ch.id ? null : ch.id)}
                      title="View all source links"
                      className="p-1.5 text-blue-400 hover:text-blue-300 transition-colors rounded-lg hover:bg-gray-700">
                      <GitMerge className="w-4 h-4" />
                      {expanded === ch.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                  )}

                  {/* Enable/disable toggle */}
                  <button onClick={() => toggleChannel(ch.id)} title={ch.isActive ? 'Disable' : 'Enable'}
                    className={`w-8 h-4 rounded-full transition-colors relative ${ch.isActive ? 'bg-blue-600' : 'bg-gray-600'}`}>
                    <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${ch.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>

                  <button onClick={() => setEditCh(ch)} title="Edit channel"
                    className="p-1.5 text-gray-400 hover:text-yellow-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Edit2 className="w-4 h-4" />
                  </button>

                  <button onClick={() => { deleteChannel(ch.id); toast.success('Channel removed'); }} title="Delete channel"
                    className="p-1.5 text-gray-400 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Multi-source panel */}
              {expanded === ch.id && ch.multiSource && (
                <div className="px-3 pb-3">
                  <MultiSourcePanel ch={ch} onClose={() => setExpanded(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-gray-500 text-sm">{filtered.length.toLocaleString()} channels · Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors">
              Prev
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg text-sm disabled:opacity-40 hover:bg-gray-700 transition-colors">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// need this for the EditModal types
interface EditState {
  name: string; url: string; group: string; logo: string;
  userAgent: string; referer: string; cookie: string;
  licenseType: string; licenseKey: string; isDrm: boolean;
}
