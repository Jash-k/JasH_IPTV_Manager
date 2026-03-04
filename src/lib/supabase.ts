/**
 * Supabase persistence layer
 * Replaces localStorage (which overflows with large IPTV playlists)
 *
 * Table schema (run in Supabase SQL editor):
 *
 * CREATE TABLE IF NOT EXISTS iptv_store (
 *   key        TEXT PRIMARY KEY,
 *   value      JSONB NOT NULL,
 *   updated_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * ALTER TABLE iptv_store ENABLE ROW LEVEL SECURITY;
 * CREATE POLICY "allow_all" ON iptv_store FOR ALL USING (true) WITH CHECK (true);
 */

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// ─── Low-level REST helpers (no SDK needed — plain fetch) ─────────────────────
function headers() {
  return {
    'Content-Type' : 'application/json',
    'apikey'       : SUPABASE_ANON_KEY!,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY!}`,
    'Prefer'       : 'return=minimal',
  };
}

function rowUrl(key: string) {
  return `${SUPABASE_URL}/rest/v1/iptv_store?key=eq.${encodeURIComponent(key)}`;
}

async function sbGet(key: string): Promise<unknown | null> {
  if (!SUPABASE_ENABLED) return null;
  try {
    const res = await fetch(rowUrl(key), {
      headers: { ...headers(), 'Prefer': 'return=representation' },
      signal : AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ value: unknown }>;
    return rows?.[0]?.value ?? null;
  } catch { return null; }
}

async function sbSet(key: string, value: unknown): Promise<void> {
  if (!SUPABASE_ENABLED) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/iptv_store`, {
      method : 'POST',
      headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
      body   : JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      signal : AbortSignal.timeout(15000),
    });
  } catch { /* silent */ }
}

// ─── Chunked storage (Supabase JSONB can handle large objects fine) ───────────

// Chunk large arrays to avoid hitting Supabase's 1MB per-row limit
const CHUNK_SIZE = 2000; // channels per chunk

async function sbSetChunked(baseKey: string, items: unknown[]): Promise<void> {
  if (!SUPABASE_ENABLED) return;
  if (!Array.isArray(items) || items.length === 0) {
    await sbSet(baseKey, []);
    await sbSet(`${baseKey}__chunks`, 0);
    return;
  }

  const totalChunks = Math.ceil(items.length / CHUNK_SIZE);
  // Save each chunk
  const saves = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = items.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    saves.push(sbSet(`${baseKey}__chunk_${i}`, chunk));
  }
  saves.push(sbSet(`${baseKey}__chunks`, totalChunks));
  await Promise.all(saves);
}

async function sbGetChunked(baseKey: string): Promise<unknown[]> {
  if (!SUPABASE_ENABLED) return [];
  const totalChunks = (await sbGet(`${baseKey}__chunks`)) as number | null;
  if (!totalChunks || totalChunks === 0) {
    // Try non-chunked fallback
    const single = await sbGet(baseKey);
    return Array.isArray(single) ? single : [];
  }
  const chunks = await Promise.all(
    Array.from({ length: totalChunks }, (_, i) => sbGet(`${baseKey}__chunk_${i}`))
  );
  return chunks.flatMap(c => (Array.isArray(c) ? c : []));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PersistedState {
  channels      : unknown[];
  sources       : unknown[];
  groups        : unknown[];
  playlists     : unknown[];
  modifications?: unknown;
  serverUrl     : string;
  apiKey        : string;
  savedAt       : number;
}

const META_KEY     = 'iptv_meta';
const CHANNELS_KEY = 'iptv_channels';
const SOURCES_KEY  = 'iptv_sources';
const GROUPS_KEY   = 'iptv_groups';
const PLAYLISTS_KEY = 'iptv_playlists';

/**
 * Save all state to Supabase (channels chunked, rest as single rows)
 */
export async function saveToSupabase(state: PersistedState): Promise<void> {
  if (!SUPABASE_ENABLED) return;
  try {
    await Promise.all([
      sbSetChunked(CHANNELS_KEY, state.channels),
      sbSet(SOURCES_KEY,    state.sources),
      sbSet(GROUPS_KEY,     state.groups),
      sbSet(PLAYLISTS_KEY,  state.playlists),
      sbSet('iptv_mods',    state.modifications || {}),
      sbSet(META_KEY, {
        serverUrl: state.serverUrl,
        apiKey   : state.apiKey,
        savedAt  : state.savedAt,
        count    : state.channels.length,
      }),
    ]);
  } catch (e) {
    console.warn('[Supabase] save failed:', e);
  }
}

/**
 * Load all state from Supabase
 */
export async function loadFromSupabase(): Promise<PersistedState | null> {
  if (!SUPABASE_ENABLED) return null;
  try {
    const [channels, sources, groups, playlists, modifications, meta] = await Promise.all([
      sbGetChunked(CHANNELS_KEY),
      sbGet(SOURCES_KEY),
      sbGet(GROUPS_KEY),
      sbGet(PLAYLISTS_KEY),
      sbGet('iptv_mods'),
      sbGet(META_KEY),
    ]);

    const m = (meta as Record<string, unknown> | null) || {};

    return {
      channels      : Array.isArray(channels)  ? channels  : [],
      sources       : Array.isArray(sources)   ? sources   : [],
      groups        : Array.isArray(groups)    ? groups    : [],
      playlists     : Array.isArray(playlists) ? playlists : [],
      modifications : modifications || {},
      serverUrl     : (m.serverUrl as string)  || '',
      apiKey        : (m.apiKey    as string)  || 'iptv-secret',
      savedAt       : (m.savedAt   as number)  || 0,
    };
  } catch (e) {
    console.warn('[Supabase] load failed:', e);
    return null;
  }
}

/**
 * Check if Supabase is reachable
 */
export async function checkSupabase(): Promise<boolean> {
  if (!SUPABASE_ENABLED) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/iptv_store?limit=1`, {
      headers: headers(),
      signal : AbortSignal.timeout(5000),
    });
    return res.ok || res.status === 406; // 406 = empty but reachable
  } catch { return false; }
}
