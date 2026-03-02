/**
 * Robust URL fetcher — server-side CORS proxy first, then fallbacks
 * Handles: M3U, JSON, PHP endpoints, raw.githubusercontent.com, etc.
 */

const CORS_PROXIES = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy?quest=',
  'https://thingproxy.freeboard.io/fetch/',
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getServerCorsProxy(): string {
  try {
    const origin = window.location.origin;
    // Don't use server proxy if we're on localhost dev (vite) without server
    if (origin.includes('localhost:517') || origin.includes('localhost:3001') || origin.includes('localhost:4173')) {
      return '';
    }
    return `${origin}/proxy/cors?url=`;
  } catch {
    return '';
  }
}

function isRawGithub(url: string): boolean {
  return url.includes('raw.githubusercontent.com') ||
    url.includes('gist.githubusercontent.com') ||
    url.includes('raw.github.com');
}

function isGithubOrPublic(url: string): boolean {
  return isRawGithub(url) ||
    url.includes('pastebin.com/raw') ||
    url.includes('paste.ee/r') ||
    url.includes('gitlab.com') && url.includes('/-/raw/');
}

async function tryFetch(fetchUrl: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(fetchUrl, {
      signal: ctrl.signal,
      headers: {
        'Accept': '*/*',
        'User-Agent': BROWSER_UA,
        'Cache-Control': 'no-cache',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function unwrapAllOrigins(text: string): string {
  try {
    const j = JSON.parse(text) as { contents?: string };
    return j.contents || text;
  } catch {
    return text;
  }
}

/**
 * Fetch any URL reliably:
 * 1. Our server /proxy/cors (deployed) — best 403 bypass with rotating UAs
 * 2. Direct fetch (works for CORS-enabled servers like raw.github.com)
 * 3. Public CORS proxies as final fallback
 */
export async function fetchUrl(targetUrl: string): Promise<string> {
  const errors: string[] = [];

  // ── 1. Server CORS proxy (best option — server-side, 403 bypass) ──────────
  const serverProxy = getServerCorsProxy();
  if (serverProxy) {
    const text = await tryFetch(`${serverProxy}${encodeURIComponent(targetUrl)}`, 25000);
    if (text && text.length > 10) {
      console.log(`[fetch] ✓ server proxy: ${targetUrl.substring(0, 60)}`);
      return text;
    }
    errors.push('server-proxy: empty or failed');
  }

  // ── 2. Direct fetch — works for raw.github.com, pastebin, etc. ───────────
  // Raw GitHub always has CORS headers, so try direct first after server proxy
  if (isGithubOrPublic(targetUrl)) {
    const text = await tryFetch(targetUrl, 15000);
    if (text && text.length > 10) {
      console.log(`[fetch] ✓ direct: ${targetUrl.substring(0, 60)}`);
      return text;
    }
    errors.push('direct: failed');
  }

  // ── 3. corsproxy.io ───────────────────────────────────────────────────────
  {
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
    const text = await tryFetch(proxyUrl, 20000);
    if (text && text.length > 10) {
      console.log(`[fetch] ✓ corsproxy.io: ${targetUrl.substring(0, 60)}`);
      return text;
    }
    errors.push('corsproxy.io: failed');
  }

  // ── 4. allorigins ─────────────────────────────────────────────────────────
  {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
    const text = await tryFetch(proxyUrl, 20000);
    if (text && text.length > 10) {
      const unwrapped = unwrapAllOrigins(text);
      console.log(`[fetch] ✓ allorigins: ${targetUrl.substring(0, 60)}`);
      return unwrapped;
    }
    errors.push('allorigins: failed');
  }

  // ── 5. Direct (last resort for non-Github URLs) ───────────────────────────
  if (!isGithubOrPublic(targetUrl)) {
    const text = await tryFetch(targetUrl, 15000);
    if (text && text.length > 10) {
      console.log(`[fetch] ✓ direct (last resort): ${targetUrl.substring(0, 60)}`);
      return text;
    }
    errors.push('direct: failed');
  }

  // ── 6. Remaining public proxies ───────────────────────────────────────────
  for (const proxy of CORS_PROXIES.slice(1)) {
    const proxyUrl = proxy.endsWith('=')
      ? `${proxy}${encodeURIComponent(targetUrl)}`
      : `${proxy}${targetUrl}`;
    const text = await tryFetch(proxyUrl, 20000);
    if (text && text.length > 10) {
      console.log(`[fetch] ✓ proxy ${proxy.substring(8, 30)}: ${targetUrl.substring(0, 40)}`);
      return unwrapAllOrigins(text);
    }
    errors.push(`${proxy.substring(8, 30)}: failed`);
  }

  throw new Error(
    `Failed to fetch "${targetUrl.substring(0, 80)}"\n` +
    `Tried ${errors.length} methods:\n` +
    errors.map(e => `  • ${e}`).join('\n')
  );
}
