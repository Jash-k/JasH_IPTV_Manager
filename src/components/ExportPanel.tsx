import { useState, useCallback, useEffect, useRef } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { countExportableStreams } from '../utils/m3uExporter';

interface Props {
  store: AppStore;
}

export const ExportPanel: React.FC<Props> = ({ store }) => {
  const { streams, groups, downloadM3U, getM3UContent, getM3UBlobUrl, notify } = store;

  // Options
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [filterGroup, setFilterGroup] = useState('');
  const [playlistName, setPlaylistName] = useState('Jash IPTV');
  const [filename, setFilename] = useState('jash-playlist.m3u');

  // UI state
  const [activeSection, setActiveSection] = useState<'download' | 'url' | 'preview'>('download');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  const exportCount = countExportableStreams(streams, { includeDisabled, filterGroup });
  const groupNames = [...new Set(streams.map(s => s.group))].sort();

  // Clean up old blob URL on option change
  useEffect(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
    }
  }, [includeDisabled, filterGroup, playlistName]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const handleGenerateBlobUrl = useCallback(() => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const url = getM3UBlobUrl({ includeDisabled, filterGroup: filterGroup || undefined });
    blobUrlRef.current = url;
    setBlobUrl(url);
  }, [getM3UBlobUrl, includeDisabled, filterGroup]);

  const handlePreview = useCallback(() => {
    const content = getM3UContent({
      includeDisabled,
      filterGroup: filterGroup || undefined,
      playlistName,
    });
    setPreviewContent(content);
    setShowPreview(true);
  }, [getM3UContent, includeDisabled, filterGroup, playlistName]);

  const handleCopy = useCallback(async (text: string, key: string) => {
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
    notify('Copied to clipboard!', 'success');
  }, [notify]);

  const handleDownload = useCallback(() => {
    if (!exportCount) return;
    downloadM3U({
      includeDisabled,
      filterGroup: filterGroup || undefined,
      filename,
      playlistName,
    });
  }, [downloadM3U, includeDisabled, filterGroup, filename, playlistName, exportCount]);

  const sections = [
    { id: 'download' as const, icon: '⬇️', label: 'Download File' },
    { id: 'url' as const, icon: '🔗', label: 'Playlist URL' },
    { id: 'preview' as const, icon: '👁️', label: 'Preview M3U' },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-900/50 to-teal-900/50 border border-emerald-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            📥
          </div>
          <div>
            <h2 className="text-white font-bold text-xl">Export & Download Playlist</h2>
            <p className="text-emerald-300/80 text-sm">Download your curated M3U playlist or get a URL for other players</p>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <div className="text-emerald-400 font-bold text-xl">{exportCount.toLocaleString()}</div>
            <div className="text-gray-400 text-xs mt-0.5">Will Export</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <div className="text-blue-400 font-bold text-xl">{streams.length.toLocaleString()}</div>
            <div className="text-gray-400 text-xs mt-0.5">Total Streams</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <div className="text-purple-400 font-bold text-xl">{groups.length}</div>
            <div className="text-gray-400 text-xs mt-0.5">Groups</div>
          </div>
        </div>
      </div>

      {/* Filter Options */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold text-base flex items-center gap-2">
          <span>🎛️</span> Export Options
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Playlist Name */}
          <div>
            <label className="text-gray-400 text-xs mb-1.5 block font-medium">Playlist Name</label>
            <input
              value={playlistName}
              onChange={e => setPlaylistName(e.target.value)}
              placeholder="My IPTV Playlist"
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 border border-gray-600"
            />
          </div>

          {/* Filename */}
          <div>
            <label className="text-gray-400 text-xs mb-1.5 block font-medium">Download Filename</label>
            <input
              value={filename}
              onChange={e => setFilename(e.target.value)}
              placeholder="my-playlist.m3u"
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 border border-gray-600"
            />
          </div>

          {/* Filter by Group */}
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

          {/* Include Disabled */}
          <div className="flex items-center">
            <div className="bg-gray-700/50 border border-gray-600 rounded-xl p-4 w-full flex items-center justify-between">
              <div>
                <div className="text-white text-sm font-medium">Include Disabled Streams</div>
                <div className="text-gray-500 text-xs mt-0.5">Export paused/hidden streams too</div>
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

        {/* Export count indicator */}
        <div className={cn(
          'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm',
          exportCount > 0 ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
        )}>
          <span>{exportCount > 0 ? '✅' : '⚠️'}</span>
          <span>
            {exportCount > 0
              ? `${exportCount.toLocaleString()} streams ready to export`
              : 'No streams match current filters'
            }
          </span>
        </div>
      </div>

      {/* Section Tabs */}
      <div className="flex gap-2">
        {sections.map(s => (
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

      {/* ── Download Section ──────────────────────────────── */}
      {activeSection === 'download' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <span>⬇️</span> Download M3U File
          </h3>
          <p className="text-gray-400 text-sm">
            Download your playlist as a standard <code className="text-emerald-400 bg-gray-700 px-1.5 py-0.5 rounded text-xs">.m3u</code> file.
            Compatible with VLC, Kodi, Tivimate, IPTV Smarters, GSE IPTV, and any M3U-compatible player.
          </p>

          {/* Compatible Players */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {['VLC', 'Kodi', 'Tivimate', 'IPTV Smarters', 'GSE IPTV', 'Perfect Player'].map(p => (
              <div key={p} className="bg-gray-700/60 rounded-lg px-2 py-1.5 text-center text-xs text-gray-400 border border-gray-600/50">
                {p}
              </div>
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
              <div>Download Playlist</div>
              <div className="text-sm opacity-75 font-normal">{filename} · {exportCount.toLocaleString()} streams</div>
            </div>
          </button>

          {/* Per-Group Downloads */}
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
                        filterGroup: g.name,
                        filename: `jash-${g.name.replace(/\s+/g, '-').toLowerCase()}.m3u`,
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
        </div>
      )}

      {/* ── URL Section ───────────────────────────────────── */}
      {activeSection === 'url' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <span>🔗</span> Playlist URL
          </h3>
          <p className="text-gray-400 text-sm">
            Generate a temporary local URL for your playlist. Use this URL in players that accept an M3U link directly.
            The URL is valid as long as this tab is open.
          </p>

          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-4 py-3 text-xs text-yellow-300/80 flex items-start gap-2">
            <span className="text-base flex-shrink-0">⚠️</span>
            <span>
              Blob URLs are temporary and only work in the same browser session.
              For permanent URLs, deploy the addon server and use the manifest URL from the <strong>Install</strong> tab.
            </span>
          </div>

          {!blobUrl ? (
            <button
              onClick={handleGenerateBlobUrl}
              disabled={!exportCount}
              className={cn(
                'w-full flex items-center justify-center gap-3 py-4 rounded-xl font-semibold text-base transition-all shadow-lg',
                exportCount > 0
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white active:scale-[0.98]'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              )}
            >
              <span className="text-2xl">🔗</span>
              <div className="text-left">
                <div>Generate Playlist URL</div>
                <div className="text-sm opacity-75 font-normal">{exportCount.toLocaleString()} streams</div>
              </div>
            </button>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-gray-400 text-xs font-medium">Playlist Blob URL</label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-3 text-xs text-blue-300 font-mono break-all overflow-auto max-h-20">
                    {blobUrl}
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleCopy(blobUrl, 'bloburl')}
                      className={cn(
                        'px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap',
                        copied === 'bloburl' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
                      )}
                    >
                      {copied === 'bloburl' ? '✓ Copied' : '📋 Copy'}
                    </button>
                    <a
                      href={blobUrl}
                      download={filename}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white transition-colors text-center"
                    >
                      ⬇️ Save
                    </a>
                  </div>
                </div>
              </div>

              {/* How to use */}
              <div className="space-y-2">
                <h4 className="text-gray-400 text-sm font-medium">How to use in players:</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {[
                    { player: 'VLC', steps: 'Media → Open Network Stream → Paste URL' },
                    { player: 'Kodi', steps: 'Add-ons → PVR IPTV → M3U Playlist URL → Paste' },
                    { player: 'Tivimate', steps: 'Add Playlist → Enter URL → Paste URL' },
                    { player: 'IPTV Smarters', steps: 'Add User → M3U URL → Paste URL' },
                  ].map(item => (
                    <div key={item.player} className="bg-gray-700/50 border border-gray-600/50 rounded-lg p-3">
                      <div className="text-white font-medium mb-1">{item.player}</div>
                      <div className="text-gray-400">{item.steps}</div>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={() => {
                  if (blobUrlRef.current) {
                    URL.revokeObjectURL(blobUrlRef.current);
                    blobUrlRef.current = null;
                  }
                  setBlobUrl(null);
                }}
                className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
              >
                ✕ Revoke URL
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Preview Section ───────────────────────────────── */}
      {activeSection === 'preview' && (
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold flex items-center gap-2">
              <span>👁️</span> M3U Content Preview
            </h3>
            <div className="flex gap-2">
              <button
                onClick={handlePreview}
                disabled={!exportCount}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  exportCount > 0 ? 'bg-purple-600 hover:bg-purple-500 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                )}
              >
                {showPreview ? '🔄 Refresh' : '👁️ Generate Preview'}
              </button>
              {showPreview && previewContent && (
                <button
                  onClick={() => handleCopy(previewContent, 'preview')}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
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
              <div className="text-sm mt-1">Preview shows first 100 lines</div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{previewContent.split('\n').length.toLocaleString()} lines · {(previewContent.length / 1024).toFixed(1)} KB</span>
                <span>{exportCount.toLocaleString()} streams</span>
              </div>
              <pre className="bg-gray-900 border border-gray-700 rounded-xl p-4 text-xs text-gray-300 overflow-auto max-h-96 font-mono leading-relaxed scrollbar-thin">
                {previewContent.split('\n').slice(0, 100).join('\n')}
                {previewContent.split('\n').length > 100 && (
                  `\n\n... and ${(previewContent.split('\n').length - 100).toLocaleString()} more lines`
                )}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Quick Download Bar — always visible */}
      <div className="bg-gray-800/80 backdrop-blur border border-gray-700 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-emerald-400 text-lg">📊</span>
          <div className="min-w-0">
            <div className="text-white text-sm font-medium">{exportCount.toLocaleString()} streams ready</div>
            <div className="text-gray-500 text-xs truncate">
              {filterGroup ? `Group: ${filterGroup}` : 'All groups'} · {includeDisabled ? 'incl. disabled' : 'enabled only'}
            </div>
          </div>
        </div>
        <button
          onClick={handleDownload}
          disabled={!exportCount}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-lg flex-shrink-0',
            exportCount > 0
              ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white active:scale-95'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          )}
        >
          <span>⬇️</span> Download M3U
        </button>
        <button
          onClick={handlePreview}
          disabled={!exportCount}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-all flex-shrink-0',
            exportCount > 0 ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          )}
          title="Preview M3U"
        >
          <span>👁️</span>
          <span className="hidden sm:inline">Preview</span>
        </button>
      </div>
    </div>
  );
};
