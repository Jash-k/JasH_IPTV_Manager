import { useState, useRef, useCallback } from 'react';
import { AppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import {
  resolveStream,
  batchResolveStreams,
  clearStreamCache,
  getStreamCacheSize,
  generateAddonServerCode,
  generatePackageJson,
  generateReadme,
  ExtractResult,
} from '../utils/streamExtractor';

interface Props { store: AppStore; }

interface ResolvedStream {
  streamId: string;
  name: string;
  originalUrl: string;
  result: ExtractResult;
}

export const StreamHandlerTab: React.FC<Props> = ({ store }) => {
  const { streams, settings, groups, notify } = store;

  // ── Single URL Test ─────────────────────────────────────────────────────────
  const [testUrl, setTestUrl]     = useState('');
  const [testResult, setTestResult] = useState<ExtractResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // ── Batch Resolver ──────────────────────────────────────────────────────────
  const [batchRunning, setBatchRunning]   = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchTotal, setBatchTotal]       = useState(0);
  const [resolvedStreams, setResolvedStreams] = useState<ResolvedStream[]>([]);
  const [batchFilter, setBatchFilter]     = useState<'all' | 'master' | 'media' | 'direct' | 'fallback'>('all');
  const abortRef = useRef<AbortController | null>(null);

  // ── Server Code Generator ───────────────────────────────────────────────────
  const [serverCodeView, setServerCodeView] = useState<'server' | 'package' | 'readme' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Test single URL
  // ─────────────────────────────────────────────────────────────────────────────
  const handleTestUrl = useCallback(async () => {
    if (!testUrl.trim()) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await resolveStream(testUrl.trim());
      setTestResult(result);
    } finally {
      setTestLoading(false);
    }
  }, [testUrl]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Batch resolve all HLS streams
  // ─────────────────────────────────────────────────────────────────────────────
  const handleBatchResolve = useCallback(async () => {
    const hlsStreams = streams.filter(s =>
      s.enabled && (
        s.url.endsWith('.m3u8') || s.url.includes('.m3u8?') ||
        s.url.includes('/playlist') || s.url.includes('play.m3u8')
      )
    );

    if (!hlsStreams.length) {
      notify('No HLS (.m3u8) streams found in your enabled streams', 'info');
      return;
    }

    abortRef.current = new AbortController();
    setBatchRunning(true);
    setBatchProgress(0);
    setBatchTotal(hlsStreams.length);
    setResolvedStreams([]);

    const urls = hlsStreams.map(s => s.url);
    const newResolved: ResolvedStream[] = [];

    await batchResolveStreams(
      urls,
      (url, result, idx) => {
        const stream = hlsStreams.find(s => s.url === url);
        if (stream) {
          const resolved: ResolvedStream = {
            streamId   : stream.id,
            name       : stream.name,
            originalUrl: url,
            result,
          };
          newResolved.push(resolved);
          setResolvedStreams([...newResolved]);
        }
        setBatchProgress(idx);
      },
      5,
      abortRef.current.signal
    );

    setBatchRunning(false);
    notify(`Resolved ${newResolved.length} HLS streams`, 'success');
  }, [streams, notify]);

  const stopBatch = () => {
    abortRef.current?.abort();
    setBatchRunning(false);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Copy text
  // ─────────────────────────────────────────────────────────────────────────────
  const handleCopy = useCallback(async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
    notify('Copied!', 'success');
  }, [notify]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Download server code bundle
  // ─────────────────────────────────────────────────────────────────────────────
  const downloadFile = (content: string, filename: string, mime = 'text/plain') => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  const serverCode   = generateAddonServerCode({ addonId: settings.addonId, addonName: settings.addonName, streams, groups });
  const packageJson  = generatePackageJson(settings.addonName, settings.addonId, streams.filter(s => s.enabled).length);
  const readmeText   = generateReadme(settings.addonName, streams.filter(s => s.enabled).length, groups.length);

  // ─────────────────────────────────────────────────────────────────────────────
  // Filtered batch results
  // ─────────────────────────────────────────────────────────────────────────────
  const filteredResolved = batchFilter === 'all'
    ? resolvedStreams
    : resolvedStreams.filter(r => r.result.type === batchFilter);

  const batchPct = batchTotal > 0 ? Math.round((batchProgress / batchTotal) * 100) : 0;
  const masterCount  = resolvedStreams.filter(r => r.result.type === 'master').length;
  const mediaCount   = resolvedStreams.filter(r => r.result.type === 'media').length;
  const directCount  = resolvedStreams.filter(r => r.result.type === 'direct').length;
  const fallbackCount = resolvedStreams.filter(r => r.result.type === 'fallback').length;
  const cacheSize = getStreamCacheSize();

  const typeColors: Record<string, string> = {
    master  : 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    media   : 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    direct  : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    fallback: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  };

  const typeIcons: Record<string, string> = {
    master  : '🌐',
    media   : '🎬',
    direct  : '✅',
    fallback: '⚠️',
  };

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-blue-900/50 to-indigo-900/50 border border-blue-700/40 rounded-2xl p-5">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-2xl shadow-lg flex-shrink-0">
            🧩
          </div>
          <div>
            <h2 className="text-white font-bold text-xl">Stream Handler &amp; Extractor</h2>
            <p className="text-blue-300/80 text-sm">
              Samsung Tizen-optimized HLS extraction · resolves master → variant → segment URLs
            </p>
          </div>
        </div>
        <div className="bg-blue-950/50 border border-blue-700/30 rounded-xl px-4 py-3 text-xs text-blue-200/80 space-y-1">
          <div className="font-semibold text-blue-300 mb-1">How it works:</div>
          <div>1️⃣ Fetches the M3U8 playlist from the stream URL (with Tizen User-Agent)</div>
          <div>2️⃣ Detects master vs. media playlist</div>
          <div>3️⃣ For master playlists: picks <strong>middle-quality variant</strong> (Samsung stability sweet spot)</div>
          <div>4️⃣ For media playlists: extracts the first <code className="bg-blue-900/60 px-1 rounded">.ts/.m4s</code> segment URL</div>
          <div>5️⃣ Returns the resolved URL to Stremio — fixes HLS segment issues on Samsung Tizen</div>
        </div>
      </div>

      {/* ── Single URL Tester ──────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🔬</span> Test Stream URL
        </h3>

        <div className="flex gap-3">
          <input
            value={testUrl}
            onChange={e => setTestUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTestUrl()}
            placeholder="https://example.com/stream/play.m3u8"
            className="flex-1 bg-gray-700 text-white rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 border border-gray-600"
          />
          <button
            onClick={handleTestUrl}
            disabled={testLoading || !testUrl.trim()}
            className={cn(
              'px-5 py-3 rounded-xl font-semibold text-sm transition-all flex-shrink-0 flex items-center gap-2',
              testLoading || !testUrl.trim()
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg'
            )}
          >
            {testLoading ? <span className="animate-spin inline-block">⏳</span> : '🔬'}
            <span>{testLoading ? 'Resolving...' : 'Resolve'}</span>
          </button>
        </div>

        {/* Quick test examples */}
        <div className="flex flex-wrap gap-2">
          <span className="text-gray-500 text-xs self-center">Try:</span>
          {[
            'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
            'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
          ].map(url => (
            <button
              key={url}
              onClick={() => setTestUrl(url)}
              className="text-xs text-blue-400 hover:text-blue-300 bg-blue-900/20 hover:bg-blue-900/40 border border-blue-700/30 px-2 py-1 rounded-lg transition-colors font-mono truncate max-w-[250px]"
            >
              {url.replace('https://', '').slice(0, 45)}…
            </button>
          ))}
        </div>

        {/* Result */}
        {testResult && (
          <div className={cn(
            'rounded-xl border p-4 space-y-3',
            testResult.type === 'fallback'
              ? 'bg-orange-900/20 border-orange-700/40'
              : 'bg-emerald-900/20 border-emerald-700/40'
          )}>
            {/* Type badge */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className={cn('text-xs px-2.5 py-1 rounded-full border font-semibold', typeColors[testResult.type])}>
                {typeIcons[testResult.type]} {testResult.type.toUpperCase()} PLAYLIST
              </span>
              {testResult.isCached && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                  ⚡ Cached
                </span>
              )}
              {testResult.responseTimeMs !== undefined && (
                <span className="text-xs text-gray-400">{testResult.responseTimeMs}ms</span>
              )}
              {testResult.variantsFound !== undefined && (
                <span className="text-xs text-gray-400">
                  {testResult.variantsFound} variants · selected #{(testResult.selectedIndex ?? 0) + 1} (middle)
                </span>
              )}
            </div>

            {/* Resolution / Bandwidth */}
            {(testResult.resolution || testResult.bandwidth) && (
              <div className="flex gap-4 text-sm">
                {testResult.resolution && (
                  <span className="text-white">📐 {testResult.resolution}</span>
                )}
                {testResult.bandwidth && (
                  <span className="text-white">📶 {(testResult.bandwidth / 1000).toFixed(0)} kbps</span>
                )}
              </div>
            )}

            {/* Error */}
            {testResult.error && (
              <div className="text-orange-300 text-sm flex items-start gap-2">
                <span>⚠️</span> <span>{testResult.error}</span>
              </div>
            )}

            {/* Resolved URL */}
            <div className="space-y-1">
              <div className="text-gray-400 text-xs font-medium">Resolved URL:</div>
              <div className="flex gap-2">
                <div className="flex-1 bg-gray-900/80 border border-gray-600 rounded-lg px-3 py-2 text-xs text-emerald-300 font-mono break-all">
                  {testResult.url}
                </div>
                <button
                  onClick={() => handleCopy(testResult.url, 'testurl')}
                  className={cn(
                    'px-3 py-2 rounded-lg text-xs font-medium transition-colors flex-shrink-0',
                    copied === 'testurl' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
                  )}
                >
                  {copied === 'testurl' ? '✓' : '📋'}
                </button>
              </div>
            </div>

            {/* Raw content preview */}
            {testResult.rawContent && (
              <details className="text-xs">
                <summary className="text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">
                  📄 Raw M3U8 preview
                </summary>
                <pre className="mt-2 bg-gray-900 border border-gray-700 rounded-lg p-3 text-gray-400 overflow-x-auto max-h-40 font-mono">
                  {testResult.rawContent}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ── Batch HLS Resolver ─────────────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <span>⚡</span> Batch HLS Stream Resolver
          </h3>
          {cacheSize > 0 && (
            <button
              onClick={() => { clearStreamCache(); notify('Stream cache cleared', 'info'); }}
              className="text-xs text-gray-500 hover:text-red-400 transition-colors"
            >
              🗑 Clear cache ({cacheSize})
            </button>
          )}
        </div>

        <p className="text-gray-400 text-sm">
          Resolves all HLS streams in your library using the Samsung Tizen extraction algorithm.
          Finds real segment URLs from master playlists.
        </p>

        {/* Stats row */}
        {resolvedStreams.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Master',   count: masterCount,   type: 'master'   as const },
              { label: 'Media',    count: mediaCount,    type: 'media'    as const },
              { label: 'Direct',   count: directCount,   type: 'direct'   as const },
              { label: 'Fallback', count: fallbackCount, type: 'fallback' as const },
            ].map(s => (
              <button
                key={s.type}
                onClick={() => setBatchFilter(f => f === s.type ? 'all' : s.type)}
                className={cn(
                  'rounded-xl p-3 text-center border transition-all',
                  typeColors[s.type],
                  batchFilter === s.type && 'ring-2 ring-white/20'
                )}
              >
                <div className="text-lg font-bold">{s.count}</div>
                <div className="text-xs opacity-80">{s.label}</div>
              </button>
            ))}
          </div>
        )}

        {/* Progress */}
        {batchRunning && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-300">Resolving streams... ({batchProgress}/{batchTotal})</span>
              <span className="text-blue-400 font-bold">{batchPct}%</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all"
                style={{ width: `${batchPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap gap-3">
          {!batchRunning ? (
            <>
              <button
                onClick={handleBatchResolve}
                className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg"
              >
                <span>⚡</span>
                Resolve HLS Streams ({streams.filter(s => s.enabled && s.url.includes('m3u8')).length})
              </button>
              {resolvedStreams.length > 0 && (
                <button
                  onClick={() => setResolvedStreams([])}
                  className="px-4 py-3 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-xl text-sm transition-colors"
                >
                  🗑 Clear Results
                </button>
              )}
            </>
          ) : (
            <button
              onClick={stopBatch}
              className="flex items-center gap-2 px-5 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-medium text-sm transition-colors animate-pulse"
            >
              <span>⏹</span> Stop
            </button>
          )}
        </div>

        {/* Results list */}
        {filteredResolved.length > 0 && (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {filteredResolved.map((item) => (
              <div
                key={item.streamId}
                className={cn(
                  'bg-gray-900/60 rounded-lg px-4 py-3 border space-y-1.5',
                  item.result.type === 'fallback' ? 'border-orange-700/30' : 'border-gray-700/50'
                )}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border', typeColors[item.result.type])}>
                    {typeIcons[item.result.type]} {item.result.type}
                  </span>
                  <span className="text-white text-sm font-medium truncate">{item.name}</span>
                  {item.result.resolution && (
                    <span className="text-gray-500 text-xs">{item.result.resolution}</span>
                  )}
                  {item.result.responseTimeMs !== undefined && (
                    <span className="text-gray-600 text-xs">{item.result.responseTimeMs}ms</span>
                  )}
                </div>
                <div className="flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500 truncate">Original: {item.originalUrl}</div>
                    <div className={cn('text-xs truncate', item.result.type === 'fallback' ? 'text-orange-300' : 'text-emerald-300')}>
                      Resolved: {item.result.url}
                    </div>
                  </div>
                  <button
                    onClick={() => handleCopy(item.result.url, `res_${item.streamId}`)}
                    className={cn(
                      'text-xs px-2 py-1 rounded-lg flex-shrink-0 transition-colors',
                      copied === `res_${item.streamId}` ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    )}
                  >
                    {copied === `res_${item.streamId}` ? '✓' : '📋'}
                  </button>
                </div>
                {item.result.error && (
                  <div className="text-orange-400 text-xs">{item.result.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Addon Server Code Generator ────────────────────────────────────── */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
        <h3 className="text-white font-semibold flex items-center gap-2">
          <span>🖥️</span> Addon Server Code Generator
        </h3>
        <p className="text-gray-400 text-sm">
          Generate a complete, deployment-ready Node.js Stremio addon server with the Samsung Tizen
          HLS extraction handler built in. Download and run with <code className="text-blue-300 bg-gray-700 px-1.5 py-0.5 rounded text-xs">npm start</code>.
        </p>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Enabled Streams', value: streams.filter(s => s.enabled).length.toLocaleString(), icon: '📺' },
            { label: 'Groups / Catalogs', value: groups.length, icon: '📂' },
            { label: 'Addon Name', value: settings.addonName, icon: '🏷️' },
          ].map(s => (
            <div key={s.label} className="bg-gray-700/50 border border-gray-600/50 rounded-xl p-3 text-center">
              <div className="text-xl mb-1">{s.icon}</div>
              <div className="text-white font-bold text-sm truncate">{s.value}</div>
              <div className="text-gray-500 text-xs mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Code file selector */}
        <div className="flex gap-2">
          {[
            { id: 'server'  as const, label: 'server.js',     icon: '📄', desc: 'Main addon server' },
            { id: 'package' as const, label: 'package.json',  icon: '📦', desc: 'NPM config' },
            { id: 'readme'  as const, label: 'README.md',     icon: '📖', desc: 'Docs' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setServerCodeView(serverCodeView === f.id ? null : f.id)}
              className={cn(
                'flex-1 flex flex-col items-center gap-1 px-3 py-3 rounded-xl text-sm font-medium transition-all border',
                serverCodeView === f.id
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-gray-700 border-gray-600 text-gray-400 hover:text-white hover:border-gray-500'
              )}
            >
              <span className="text-xl">{f.icon}</span>
              <span className="text-xs font-mono">{f.label}</span>
              <span className="text-xs opacity-60 hidden sm:block">{f.desc}</span>
            </button>
          ))}
        </div>

        {/* Code preview */}
        {serverCodeView && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-xs font-mono">
                {serverCodeView === 'server' ? 'server.js' : serverCodeView === 'package' ? 'package.json' : 'README.md'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(
                    serverCodeView === 'server' ? serverCode : serverCodeView === 'package' ? packageJson : readmeText,
                    'servercode'
                  )}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    copied === 'servercode' ? 'bg-emerald-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'
                  )}
                >
                  {copied === 'servercode' ? '✓ Copied' : '📋 Copy'}
                </button>
                <button
                  onClick={() => downloadFile(
                    serverCodeView === 'server' ? serverCode : serverCodeView === 'package' ? packageJson : readmeText,
                    serverCodeView === 'server' ? 'server.js' : serverCodeView === 'package' ? 'package.json' : 'README.md',
                    serverCodeView === 'package' ? 'application/json' : 'text/plain'
                  )}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-700 hover:bg-indigo-600 text-white transition-colors"
                >
                  ⬇️ Download
                </button>
              </div>
            </div>
            <pre className="bg-gray-950 border border-gray-700 rounded-xl p-4 text-xs text-gray-300 overflow-auto max-h-80 font-mono leading-relaxed">
              {(serverCodeView === 'server' ? serverCode : serverCodeView === 'package' ? packageJson : readmeText).slice(0, 3000)}
              {serverCode.length > 3000 && serverCodeView === 'server' && (
                `\n\n... (${(serverCode.length / 1024).toFixed(0)} KB total — download to see full file)`
              )}
            </pre>
          </div>
        )}

        {/* Download all buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            onClick={() => downloadFile(serverCode, 'server.js')}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg"
          >
            <span>⬇️</span>
            <div className="text-left">
              <div className="font-semibold">server.js</div>
              <div className="text-xs opacity-75">Main addon server</div>
            </div>
          </button>
          <button
            onClick={() => downloadFile(packageJson, 'package.json', 'application/json')}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg"
          >
            <span>📦</span>
            <div className="text-left">
              <div className="font-semibold">package.json</div>
              <div className="text-xs opacity-75">NPM dependencies</div>
            </div>
          </button>
          <button
            onClick={() => downloadFile(readmeText, 'README.md')}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-500 hover:to-teal-500 text-white rounded-xl font-medium text-sm transition-all shadow-lg"
          >
            <span>📖</span>
            <div className="text-left">
              <div className="font-semibold">README.md</div>
              <div className="text-xs opacity-75">Setup guide</div>
            </div>
          </button>
        </div>

        {/* Deployment guide */}
        <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-4 space-y-3">
          <h4 className="text-white font-medium text-sm flex items-center gap-2">🚀 Deploy &amp; Install</h4>
          <div className="space-y-2 text-xs text-gray-400 font-mono">
            {[
              { step: '1', cmd: 'npm install', comment: '# install stremio-addon-sdk' },
              { step: '2', cmd: 'npm start',   comment: '# starts on port 7000' },
              { step: '3', cmd: '# Open Stremio → Settings → Addons → Install from URL', comment: '' },
              { step: '4', cmd: 'stremio://localhost:7000/manifest.json', comment: '# paste this URL' },
            ].map(item => (
              <div key={item.step} className="flex gap-3">
                <span className="text-indigo-400 flex-shrink-0">#{item.step}</span>
                <div>
                  <span className="text-emerald-300">{item.cmd}</span>
                  {item.comment && <span className="text-gray-600 ml-2">{item.comment}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Samsung Tizen note */}
        <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
          <h4 className="text-yellow-300 font-medium text-sm mb-2 flex items-center gap-2">
            📺 Samsung Tizen HLS Fix
          </h4>
          <p className="text-yellow-200/70 text-xs leading-relaxed">
            The generated <code className="bg-yellow-900/50 px-1 rounded">server.js</code> includes the{' '}
            <code className="bg-yellow-900/50 px-1 rounded">extractRealStreamUrl()</code> function that solves
            HLS segment playback issues on Samsung Stremio. It fetches the M3U8 playlist server-side,
            selects the <strong>middle quality variant</strong> (not highest — Samsung TVs can buffer at
            max bitrate), and returns the resolved segment URL directly to Stremio, bypassing the
            HLS handling that fails on Tizen OS.
          </p>
        </div>
      </div>
    </div>
  );
};
