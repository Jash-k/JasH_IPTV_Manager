/**
 * JASH ADDON — Export Panel v3
 * Download M3U + Permanent Playlist URLs (for Tivimate, OTT Navigator, VLC, etc.)
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { countExportableStreams } from '../utils/m3uExporter';
import {
  getPlaylistUrl,
  getShortPlaylistUrls,
  getGroupPlaylistUrl,
  fetchPlaylistInfo,
  PlaylistInfo,
  checkBackendHealth,
} from '../utils/backendSync';

interface Props { store: AppStore; }

export const ExportPanel: React.FC<Props> = ({ store }) => {
  const { streams, groups, downloadM3U, getM3UContent, getM3UBlobUrl, notify } = store;

  // ── Options ────────────────────────────────────────────────────────────────
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [filterGroup,     setFilterGroup]     = useState('');
  const [playlistName,    setPlaylistName]     = useState('Jash IPTV');
  const [filename,        setFilename]         = useState('jash-playlist.m3u');

  // ── Backend state ──────────────────────────────────────────────────────────
  const [backendOnline,  setBackendOnline]  = useState(false);
  const [playlistInfo,   setPlaylistInfo]   = useState<PlaylistInfo | null>(null);
  const [infoLoading,    setInfoLoading]    = useState(false);
  const [activeShortUrl, setActiveShortUrl] = useState<string>('main');

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeSection,  setActiveSection]  = useState<'url' | 'download' | 'preview'>('url');
  const [blobUrl,        setBlobUrl]        = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [copied,         setCopied]         = useState<string | null>(null);
  const [showPreview,    setShowPreview]    = useState(false);
  const [showGroupUrls,  setShowGroupUrls]  = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  const exportCount = countExportableStreams(streams, { includeDisabled, filterGroup });
  const groupNames  = [...new Set(streams.map(s => s.group))].sort();
  const shortUrls   = getShortPlaylistUrls();
  const mainUrl     = getPlaylistUrl();

  // ── Check backend on mount ─────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      const h = await checkBackendHealth();
      setBackendOnline(!!h);
    };
    check();
  }, []);

  // ── Fetch playlist info from backend ──────────────────────────────────────
  const loadPlaylistInfo = useCallback(async () => {
    setInfoLoading(true);
    const info = await fetchPlaylistInfo();
    setPlaylistInfo(info);
    setInfoLoading(false);
    if (info) setBackendOnline(true);
  }, []);

  useEffect(() => { loadPlaylistInfo(); }, [loadPlaylistInfo]);

  // ── Blob URL cleanup ──────────────────────────────────────────────────────
  useEffect(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }
  }, [includeDisabled, filterGroup, playlistName]);

  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2500);
    notify('✅ Copied to clipboard!', 'success');
  }, [notify]);

  const handleDownload = useCallback(() => {
    if (!exportCount) return;
    downloadM3U({ includeDisabled, filterGroup: filterGroup || undefined, filename, playlistName });
    notify(`⬇️ Downloading ${exportCount} streams…`, 'success');
  }, [downloadM3U, includeDisabled, filterGroup, filename, playlistName, exportCount, notify]);

  const handleGenerateBlobUrl = useCallback(() => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const url = getM3UBlobUrl({ includeDisabled, filterGroup: filterGroup || undefined });
    blobUrlRef.current = url;
    setBlobUrl(url);
  }, [getM3UBlobUrl, includeDisabled, filterGroup]);

  const handlePreview = useCallback(() => {
    const content = getM3UContent({ includeDisabled, filterGroup: filterGroup || undefined, playlistName });
    setPreviewContent(content);
    setShowPreview(true);
  }, [getM3UContent, includeDisabled, filterGroup, playlistName]);

  const urlKeys = Object.keys(shortUrls) as Array<keyof typeof shortUrls>;

  // URL to show based on selection
  const displayUrl = shortUrls[activeShortUrl as keyof typeof shortUrls] ?? mainUrl;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-emerald-900/50 to-teal-900/50 border border-emerald-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            📥
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-bold text-xl">Export & Playlist URLs</h2>
            <p className="text-emerald-300/80 text-sm">
              Permanent M3U URLs for Tivimate, OTT Navigator, VLC, Kodi · Download files · Preview
            </p>
          </div>
          <div className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold flex-shrink-0',
            backendOnline ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-gray-700/60 text-gray-400 border border-gray-600/40'
          )}>
            <span className={cn('w-2 h-2 rounded-full', backendOnline ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500')} />
            {backendOnline ? 'Backend Online' : 'Backend Offline'}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Total Streams', value: streams.length.toLocaleString(),   color: 'text-blue-400',    icon: '📺' },
            { label: 'Groups',        value: groups.length,                      color: 'text-purple-400',  icon: '📂' },
            { label: 'Will Export',   value: exportCount.toLocaleString(),       color: 'text-emerald-400', icon: '✅' },
          ].map(s => (
            <div key={s.label} className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
              <div className="text-lg mb-0.5">{s.icon}</div>
              <div className={cn('font-bold text-xl', s.color)}>{s.value}</div>
              <div className="text-gray-400 text-xs mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section Tabs ─────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        {[
          { id: 'url'      as const, icon: '🔗', label: 'Playlist URLs' },
          { id: 'download' as const, icon: '⬇️', label: 'Download File' },
          { id: 'preview'  as const, icon: '👁️', label: 'Preview M3U'  },
        ].map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex-1 justify-center',
              activeSection === s.id
                ? 'bg-emerald-600 text-white shadow-lg'
                : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
            )}
          >
            <span>{s.icon}</span>
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════
          URL SECTION — main feature
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'url' && (
        <div className="space-y-4">

          {/* ── Backend Playlist URL (Permanent) ──────────────────────── */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-white font-semibold flex items-center gap-2">
                <span>🔗</span> Permanent Playlist URL
                <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                  Live · Always Fresh
                </span>
              </h3>
              <button
                onClick={loadPlaylistInfo}
                disabled={infoLoading}
                className="text-xs text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
              >
                <span className={infoLoading ? 'animate-spin inline-block' : ''}>🔄</span>
                {infoLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>

            {!backendOnline && (
              <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4 text-yellow-300/80 text-sm space-y-2">
                <div className="font-semibold flex items-center gap-2">
                  <span>⚠️</span> Backend Not Running
                </div>
                <p className="text-xs text-yellow-200/60">
                  Permanent URLs require the backend server. Deploy to Render/Koyeb/Railway or run locally.
                  Use <strong>Download File</strong> for offline playlists.
                </p>
                <div className="bg-gray-900/60 rounded-lg p-3 text-xs font-mono space-y-1 text-gray-300">
                  <div className="text-gray-500"># Start backend locally:</div>
                  <div className="text-emerald-400">npm run build && node backend/server.js</div>
                </div>
              </div>
            )}

            {backendOnline && (
              <>
                {/* URL Variant Selector */}
                <div>
                  <div className="text-gray-400 text-xs mb-2 font-medium">
                    Choose URL (all point to the same playlist — pick the shortest for your player):
                  </div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {urlKeys.map(key => (
                      <button
                        key={key}
                        onClick={() => setActiveShortUrl(key)}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all border',
                          activeShortUrl === key
                            ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg'
                            : 'bg-gray-700 text-gray-400 border-gray-600 hover:text-white hover:bg-gray-600'
                        )}
                      >
                        {shortUrls[key].replace(/^https?:\/\/[^/]+/, '')}
                      </button>
                    ))}
                  </div>

                  {/* Main URL Display */}
                  <div className="bg-gray-900 border border-emerald-600/50 rounded-xl p-4 space-y-3">
                    {/* Big URL box */}
                    <div className="flex gap-3 items-start">
                      <div className="flex-1 min-w-0">
                        <div className="text-gray-400 text-xs mb-1 font-medium">M3U Playlist URL</div>
                        <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-3 font-mono text-emerald-300 text-sm break-all leading-relaxed">
                          {displayUrl}
                        </div>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => copy(displayUrl, 'main')}
                        className={cn(
                          'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all',
                          copied === 'main'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        )}
                      >
                        <span>{copied === 'main' ? '✅' : '📋'}</span>
                        {copied === 'main' ? 'Copied!' : 'Copy URL'}
                      </button>
                      <a
                        href={displayUrl}
                        download
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white transition-all"
                      >
                        <span>⬇️</span> Download
                      </a>
                      <a
                        href={displayUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white transition-all"
                      >
                        <span>🌐</span> Open
                      </a>
                    </div>

                    {/* Stream count */}
                    <div className="text-xs text-gray-500 flex items-center gap-4 pt-1 border-t border-gray-700/50">
                      <span>📺 {playlistInfo?.total ?? streams.filter(s => s.enabled).length} streams</span>
                      <span>📂 {playlistInfo?.groups ?? groups.length} groups</span>
                      <span className="text-emerald-400">● Updates automatically after sync</span>
                    </div>
                  </div>
                </div>

                {/* ── How to use in popular players ───────────────────── */}
                <div className="space-y-3">
                  <h4 className="text-gray-300 text-sm font-semibold flex items-center gap-2">
                    <span>📱</span> How to Add in Popular Players
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                      {
                        player : 'Tivimate',
                        icon   : '📺',
                        color  : 'border-blue-700/40 bg-blue-900/10',
                        steps  : [
                          '1. Open Tivimate → ⚙️ Settings',
                          '2. Playlists → Add Playlist',
                          '3. "Enter URL" → Paste URL',
                          '4. Set name → Save → Refresh',
                        ],
                        note: 'Best IPTV player for Android TV',
                      },
                      {
                        player : 'OTT Navigator',
                        icon   : '🧭',
                        color  : 'border-purple-700/40 bg-purple-900/10',
                        steps  : [
                          '1. Open OTT Navigator → Settings',
                          '2. Playlists → Add → M3U URL',
                          '3. Paste URL → Confirm',
                          '4. Select playlist → Done',
                        ],
                        note: 'Great for Samsung TV / Android TV',
                      },
                      {
                        player : 'GSE IPTV',
                        icon   : '📡',
                        color  : 'border-green-700/40 bg-green-900/10',
                        steps  : [
                          '1. Open GSE IPTV → + (top right)',
                          '2. Remote Playlists → Add',
                          '3. Enter name & paste URL',
                          '4. Save → Load Playlist',
                        ],
                        note: 'iOS / Android / Apple TV',
                      },
                      {
                        player : 'IPTV Smarters Pro',
                        icon   : '🎬',
                        color  : 'border-orange-700/40 bg-orange-900/10',
                        steps  : [
                          '1. Open Smarters → Add User',
                          '2. Select "M3U URL"',
                          '3. Paste playlist URL',
                          '4. Enter name → Save',
                        ],
                        note: 'Android / iOS / Web',
                      },
                      {
                        player : 'VLC Media Player',
                        icon   : '🔶',
                        color  : 'border-yellow-700/40 bg-yellow-900/10',
                        steps  : [
                          '1. Media → Open Network Stream',
                          '2. Paste URL in the box',
                          '3. Click Play',
                          '4. Browse playlist in sidebar',
                        ],
                        note: 'Windows / Mac / Linux / Android',
                      },
                      {
                        player : 'Kodi (PVR IPTV)',
                        icon   : '🎭',
                        color  : 'border-teal-700/40 bg-teal-900/10',
                        steps  : [
                          '1. Add-ons → PVR IPTV Simple Client',
                          '2. Configure → General',
                          '3. M3U URL → paste URL',
                          '4. Enable addon → OK',
                        ],
                        note: 'All platforms',
                      },
                    ].map(p => (
                      <div key={p.player} className={cn('rounded-xl border p-3.5 space-y-2', p.color)}>
                        <div className="flex items-center justify-between">
                          <div className="text-white font-semibold text-sm flex items-center gap-2">
                            <span>{p.icon}</span> {p.player}
                          </div>
                          <button
                            onClick={() => copy(displayUrl, `player-${p.player}`)}
                            className={cn(
                              'text-xs px-2.5 py-1 rounded-lg transition-all font-medium',
                              copied === `player-${p.player}`
                                ? 'bg-emerald-600 text-white'
                                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                            )}
                          >
                            {copied === `player-${p.player}` ? '✅ Copied' : '📋 Copy URL'}
                          </button>
                        </div>
                        <ol className="space-y-0.5">
                          {p.steps.map((s, i) => (
                            <li key={i} className="text-xs text-gray-300 leading-relaxed">{s}</li>
                          ))}
                        </ol>
                        <div className="text-xs text-gray-500 italic">{p.note}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Per-Group URLs ─────────────────────────────────── */}
                <div className="space-y-2">
                  <button
                    onClick={() => setShowGroupUrls(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-gray-700/50 hover:bg-gray-700 border border-gray-600/50 rounded-xl text-gray-300 text-sm font-medium transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <span>📂</span> Per-Group Playlist URLs ({groups.length} groups)
                    </span>
                    <span>{showGroupUrls ? '▲' : '▼'}</span>
                  </button>

                  {showGroupUrls && (
                    <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                      {(playlistInfo?.groupUrls ?? groups.map(g => ({
                        group: g.name,
                        url  : getGroupPlaylistUrl(g.name),
                        count: streams.filter(s => s.group === g.name && s.enabled).length,
                      }))).map(g => (
                        <div key={g.group} className="flex items-center gap-3 bg-gray-900/60 border border-gray-700/50 rounded-xl px-4 py-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-white text-sm font-medium truncate flex items-center gap-2">
                              <span>📂</span> {g.group}
                              <span className="text-gray-500 text-xs font-normal">{g.count} streams</span>
                            </div>
                            <div className="text-gray-500 font-mono text-xs truncate mt-0.5">
                              /playlist/{encodeURIComponent(g.group)}.m3u
                            </div>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              onClick={() => copy(g.url, `grp-${g.group}`)}
                              className={cn(
                                'text-xs px-3 py-1.5 rounded-lg transition-all font-medium whitespace-nowrap',
                                copied === `grp-${g.group}`
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                              )}
                            >
                              {copied === `grp-${g.group}` ? '✅' : '📋 Copy'}
                            </button>
                            <a
                              href={g.url}
                              download
                              className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-all whitespace-nowrap"
                            >
                              ⬇️
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* All short URLs reference */}
                <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 space-y-2">
                  <div className="text-gray-400 text-xs font-semibold mb-3 flex items-center gap-2">
                    <span>📎</span> All Short URL Aliases (same playlist, different URLs)
                  </div>
                  <div className="space-y-2">
                    {urlKeys.map(key => (
                      <div key={key} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 font-mono text-xs text-emerald-300 truncate">
                          {shortUrls[key]}
                        </div>
                        <button
                          onClick={() => copy(shortUrls[key], `alias-${key}`)}
                          className={cn(
                            'text-xs px-3 py-2 rounded-lg transition-all font-medium flex-shrink-0 whitespace-nowrap',
                            copied === `alias-${key}`
                              ? 'bg-emerald-600 text-white'
                              : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                          )}
                        >
                          {copied === `alias-${key}` ? '✅' : '📋'}
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-gray-600 text-xs pt-1">
                    All URLs serve the same playlist. Use the shortest one your player keyboard allows.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          DOWNLOAD SECTION
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'download' && (
        <div className="space-y-4">
          {/* Filter Options */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
            <h3 className="text-white font-semibold text-base flex items-center gap-2">
              <span>🎛️</span> Export Options
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Playlist Name</label>
                <input
                  value={playlistName}
                  onChange={e => setPlaylistName(e.target.value)}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 border border-gray-600"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Download Filename</label>
                <input
                  value={filename}
                  onChange={e => setFilename(e.target.value)}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 border border-gray-600"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block font-medium">Filter by Group</label>
                <select
                  value={filterGroup}
                  onChange={e => setFilterGroup(e.target.value)}
                  className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 border border-gray-600"
                >
                  <option value="">All Groups ({streams.filter(s => includeDisabled || s.enabled).length.toLocaleString()} streams)</option>
                  {groupNames.map(g => {
                    const cnt = countExportableStreams(streams, { includeDisabled, filterGroup: g });
                    return <option key={g} value={g}>{g} ({cnt})</option>;
                  })}
                </select>
              </div>
              <div className="flex items-center">
                <div className="bg-gray-700/50 border border-gray-600 rounded-xl p-4 w-full flex items-center justify-between">
                  <div>
                    <div className="text-white text-sm font-medium">Include Disabled</div>
                    <div className="text-gray-500 text-xs mt-0.5">Export paused streams too</div>
                  </div>
                  <button
                    onClick={() => setIncludeDisabled(v => !v)}
                    className={cn('w-11 h-6 rounded-full transition-all relative flex-shrink-0 ml-3',
                      includeDisabled ? 'bg-emerald-500' : 'bg-gray-600'
                    )}
                  >
                    <span className={cn('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all',
                      includeDisabled ? 'left-5' : 'left-0.5'
                    )} />
                  </button>
                </div>
              </div>
            </div>

            <div className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm',
              exportCount > 0 ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
            )}>
              <span>{exportCount > 0 ? '✅' : '⚠️'}</span>
              <span>{exportCount > 0 ? `${exportCount.toLocaleString()} streams ready to export` : 'No streams match filters'}</span>
            </div>
          </div>

          {/* Download button */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span>⬇️</span> Download M3U File
            </h3>
            <p className="text-gray-400 text-sm">
              Download a <code className="text-emerald-400 bg-gray-700 px-1.5 py-0.5 rounded text-xs">.m3u</code> file
              to your device. Compatible with all IPTV players.
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {['VLC', 'Kodi', 'Tivimate', 'IPTV Smarters', 'GSE IPTV', 'Perfect Player'].map(p => (
                <div key={p} className="bg-gray-700/60 rounded-lg px-2 py-1.5 text-center text-xs text-gray-400 border border-gray-600/50">{p}</div>
              ))}
            </div>
            <button
              onClick={handleDownload}
              disabled={!exportCount}
              className={cn(
                'w-full flex items-center justify-center gap-3 py-4 rounded-xl font-semibold text-base transition-all shadow-lg',
                exportCount > 0
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white active:scale-[0.98]'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              )}
            >
              <span className="text-2xl">⬇️</span>
              <div className="text-left">
                <div>Download Playlist File</div>
                <div className="text-sm opacity-75 font-normal">{filename} · {exportCount.toLocaleString()} streams</div>
              </div>
            </button>

            {/* Per-group downloads */}
            {groups.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-gray-400 text-sm font-medium flex items-center gap-2">
                  <span>📂</span> Download by Group
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                  {groups.map(g => {
                    const cnt = countExportableStreams(streams, { includeDisabled, filterGroup: g.name });
                    if (!cnt) return null;
                    return (
                      <button
                        key={g.id}
                        onClick={() => downloadM3U({
                          includeDisabled,
                          filterGroup : g.name,
                          filename    : `jash-${g.name.replace(/\s+/g, '-').toLowerCase()}.m3u`,
                          playlistName: g.name,
                        })}
                        className="flex items-center justify-between gap-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 hover:border-emerald-600/50 rounded-lg px-3 py-2.5 text-sm transition-all text-left group"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-emerald-400 group-hover:scale-110 transition-transform">📂</span>
                          <span className="text-white truncate">{g.name}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-gray-500 text-xs">{cnt}</span>
                          <span className="text-emerald-500 text-xs opacity-0 group-hover:opacity-100 transition-opacity">⬇️</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Blob URL option */}
            <div className="border-t border-gray-700/50 pt-4 space-y-3">
              <h4 className="text-gray-400 text-sm font-medium flex items-center gap-2">
                <span>🔗</span> Temporary Local URL (this browser session only)
              </h4>
              <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-xs text-yellow-300/70 flex items-start gap-2">
                <span className="flex-shrink-0">⚠️</span>
                <span>Blob URLs are temporary — only work while this tab is open. For permanent URLs use the <strong>Playlist URLs</strong> tab after deploying.</span>
              </div>
              {!blobUrl ? (
                <button
                  onClick={handleGenerateBlobUrl}
                  disabled={!exportCount}
                  className={cn(
                    'w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-all',
                    exportCount > 0
                      ? 'bg-blue-700 hover:bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  )}
                >
                  <span>🔗</span> Generate Temporary URL
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-xs text-blue-300 font-mono break-all">
                      {blobUrl}
                    </div>
                    <button
                      onClick={() => copy(blobUrl, 'blob')}
                      className={cn('px-3 py-2 rounded-lg text-xs font-medium transition-colors flex-shrink-0',
                        copied === 'blob' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
                      )}
                    >
                      {copied === 'blob' ? '✅' : '📋'}
                    </button>
                  </div>
                  <button
                    onClick={() => { if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; } setBlobUrl(null); }}
                    className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
                  >
                    ✕ Revoke URL
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          PREVIEW SECTION
      ══════════════════════════════════════════════════════════════════ */}
      {activeSection === 'preview' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span>👁️</span> M3U Content Preview
            </h3>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handlePreview}
                disabled={!exportCount}
                className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  exportCount > 0 ? 'bg-purple-600 hover:bg-purple-500 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                )}
              >
                {showPreview ? '🔄 Refresh' : '👁️ Generate Preview'}
              </button>
              {showPreview && previewContent && (
                <button
                  onClick={() => { void handleCopy(previewContent, 'preview'); }}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    copied === 'preview' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
                  )}
                >
                  {copied === 'preview' ? '✓ Copied' : '📋 Copy All'}
                </button>
              )}
            </div>
          </div>

          {!showPreview ? (
            <div className="text-center py-12 text-gray-500">
              <div className="text-4xl mb-3">📄</div>
              <div className="text-gray-400 font-medium">Click "Generate Preview" to see M3U content</div>
              <div className="text-sm mt-1">Shows first 100 lines</div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{previewContent.split('\n').length.toLocaleString()} lines · {(previewContent.length / 1024).toFixed(1)} KB</span>
                <span>{exportCount.toLocaleString()} streams</span>
              </div>
              <pre className="bg-gray-900 border border-gray-700 rounded-xl p-4 text-xs text-gray-300 overflow-auto max-h-96 font-mono leading-relaxed">
                {previewContent.split('\n').slice(0, 100).join('\n')}
                {previewContent.split('\n').length > 100 && (
                  `\n\n... and ${(previewContent.split('\n').length - 100).toLocaleString()} more lines`
                )}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ── Quick Action Bar — always visible ────────────────────────────── */}
      <div className="bg-gray-800/80 backdrop-blur border border-gray-700 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-emerald-400 text-lg">📊</span>
          <div className="min-w-0">
            <div className="text-white text-sm font-medium">{exportCount.toLocaleString()} streams ready</div>
            <div className="text-gray-500 text-xs truncate font-mono">
              {backendOnline ? `${mainUrl}` : 'Deploy backend for permanent URL'}
            </div>
          </div>
        </div>
        {backendOnline && (
          <button
            onClick={() => copy(mainUrl, 'quickbar')}
            className={cn(
              'flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all shadow flex-shrink-0',
              copied === 'quickbar'
                ? 'bg-emerald-600 text-white'
                : 'bg-emerald-700 hover:bg-emerald-600 text-white'
            )}
          >
            <span>{copied === 'quickbar' ? '✅' : '🔗'}</span>
            {copied === 'quickbar' ? 'Copied!' : 'Copy URL'}
          </button>
        )}
        <button
          onClick={handleDownload}
          disabled={!exportCount}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all shadow flex-shrink-0',
            exportCount > 0
              ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white active:scale-95'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          )}
        >
          <span>⬇️</span> Download
        </button>
      </div>
    </div>
  );

  // helper used in preview section
  async function handleCopy(text: string, key: string) {
    return copy(text, key);
  }
};
