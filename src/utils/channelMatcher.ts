/**
 * JASH ADDON — Precise Channel Name Matcher v3
 *
 * CORRECT behavior:
 *   Pattern "Sun TV" → matches:
 *     ✅ "Sun TV", "Sun TV HD", "Sun TV 4K", "SunTV VIP", "SUN TV USA", "[HD] Sun TV"
 *     ❌ "Sunshine TV" — different brand
 *     ❌ "Sony TV"     — different brand
 *
 *   Pattern "Zee Tamil" → matches:
 *     ✅ "Zee Tamil", "Zee Tamil HD", "Zee Tamil 4K"
 *     ❌ "Zee Marathi" — "Marathi" ≠ "Tamil"
 *     ❌ "Zee Kannada" — "Kannada" ≠ "Tamil"
 *     ❌ "Zee Hindi"   — "Hindi" ≠ "Tamil"
 *
 * KEY PRINCIPLE: Only strip QUALITY suffixes (HD, 4K, SD, VIP, USA, UK, BACKUP etc.)
 * NEVER strip language/brand words like "Tamil", "Zee", "Star", "Sony".
 * 'tv' is also NOT stripped — it is a meaningful part of channel names.
 */

// ─── Quality/delivery tokens to strip ────────────────────────────────────────
const STRIP_WORDS = new Set([
  'hd', 'sd', 'fhd', 'uhd', '4k', '2k', '8k',
  'vip', 'plus', 'premium', 'backup', 'mirror', 'alt', 'alternate',
  'usa', 'uk', 'us', 'ca', 'au', 'in',
  'live', 'stream', 'online', 'channel',
  '1080p', '720p', '480p', '360p',
  // NOTE: 'tv' is intentionally excluded — it is part of brand names
]);

function stripSuffixes(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')  // remove [HD], (4K), {backup}
    .replace(/[-_\/\\|:]+/g, ' ')                  // collapse separators
    .split(/\s+/)
    .filter(w => w.length > 0 && !STRIP_WORDS.has(w))
    .join(' ')
    .trim();
}

function normalize(s: string): string {
  return stripSuffixes(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coreTokens(s: string): string[] {
  return normalize(s).split(' ').filter(t => t.length >= 1);
}

/**
 * Liberal (but precise) channel match.
 *
 * Rules:
 * 1. Normalize both strings (strip quality suffixes, keep language/brand words)
 * 2. ALL pattern tokens must appear as WHOLE WORDS in the channel name
 * 3. Secondary check handles concatenated brands like "SunTV" vs "Sun TV"
 */
export function channelMatches(channelName: string, pattern: string): boolean {
  const patternTokens = coreTokens(pattern);
  if (patternTokens.length === 0) return false;

  const channelNorm  = normalize(channelName);
  const channelWords = channelNorm.split(' ');

  // Primary: whole-word match for every pattern token
  if (patternTokens.every(token => channelWords.some(w => w === token))) return true;

  // Secondary: handle concatenated brand names e.g. "SunTV" vs pattern "Sun TV"
  const patNorm    = normalize(pattern);
  const patNoSpace = patNorm.replace(/\s+/g, '');
  const chanNoSpace = channelNorm.replace(/\s+/g, '');

  if (patternTokens.length <= 2 && patNoSpace.length >= 3) {
    if (chanNoSpace === patNoSpace || chanNoSpace.startsWith(patNoSpace)) return true;
  }

  return false;
}

/** Check if a name matches ANY pattern in a list. Returns matched pattern or null. */
export function matchesAnyPattern(channelName: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (pattern.trim() && channelMatches(channelName, pattern.trim())) {
      return pattern.trim();
    }
  }
  return null;
}

/** Filter stream objects by a list of channel patterns. */
export function filterStreamsByModel<T extends { name: string }>(
  streams: T[],
  patterns: string[]
): { matched: T[]; unmatched: T[]; matchMap: Map<T, string> } {
  const matched: T[]            = [];
  const unmatched: T[]          = [];
  const matchMap: Map<T, string> = new Map();

  for (const stream of streams) {
    const hit = matchesAnyPattern(stream.name, patterns);
    if (hit !== null) {
      matched.push(stream);
      matchMap.set(stream, hit);
    } else {
      unmatched.push(stream);
    }
  }
  return { matched, unmatched, matchMap };
}

/** Preview: for each pattern, count how many streams match. */
export function previewModelMatch<T extends { name: string }>(
  streams: T[],
  patterns: string[]
): Array<{ pattern: string; matchCount: number; examples: string[] }> {
  return patterns
    .filter(p => p.trim())
    .map(pattern => {
      const matches = streams.filter(s => channelMatches(s.name, pattern.trim()));
      return {
        pattern   : pattern.trim(),
        matchCount: matches.length,
        examples  : matches.slice(0, 5).map(s => s.name),
      };
    });
}

// ─── Built-in Models ─────────────────────────────────────────────────────────

export const BUILT_IN_MODELS = [
  {
    id              : 'builtin_tamil',
    name            : '📺 Tamil Channels (Default)',
    isBuiltIn       : true,
    singleGroup     : true,
    defaultGroupName: 'Tamil',
    channels        : [
      'Sun TV',
      'Star Vijay',
      'Zee Tamil',
      'Colors Tamil',
      'Jaya TV',
      'Kalaignar TV',
      'Raj TV',
      'Polimer TV',
      'Mega TV',
      'Makkal TV',
      'Puthuyugam TV',
      'Vendhar TV',
      'Thanthi TV',
      'Thanthi One',
      'KTV',
      'J Movies',
      'Puthiya Thalaimurai',
      'News7 Tamil',
      'Polimer News',
      'Seithigal TV',
      'Isai Aruvi',
      'Sirippoli TV',
      'Star Sports Tamil',
      'Sony Ten Tamil',
    ],
  },
  {
    id              : 'builtin_sports',
    name            : '⚽ Sports Channels',
    isBuiltIn       : true,
    singleGroup     : true,
    defaultGroupName: 'Sports',
    channels        : [
      'Star Sports',
      'Sony Sports',
      'Sony Ten',
      'ESPN',
      'Sky Sports',
      'BT Sport',
      'beIN Sports',
      'Eurosport',
      'DAZN',
      'Fox Sports',
      'NBC Sports',
      'TNT Sports',
    ],
  },
  {
    id              : 'builtin_news',
    name            : '📰 News Channels',
    isBuiltIn       : true,
    singleGroup     : true,
    defaultGroupName: 'News',
    channels        : [
      'CNN',
      'BBC News',
      'Al Jazeera',
      'NDTV',
      'Times Now',
      'Republic TV',
      'India Today',
      'Aaj Tak',
      'News18',
      'DD News',
      'Sky News',
      'Fox News',
      'CNBC',
      'Bloomberg',
    ],
  },
] as const;

// ─── Channel key normalization (for auto-combine) ─────────────────────────────

/**
 * normalizeChannelKey — normalize a channel name for grouping purposes.
 * Language words are preserved: "Zee Tamil" ≠ "Zee Marathi".
 * Only quality suffixes (HD/4K/SD/VIP etc.) are stripped.
 */
export function normalizeChannelKey(name: string): string {
  return normalize(name);
}

/**
 * groupStreamsByChannel — groups streams by normalized channel name.
 * Only includes channels with streams from ≥ minSources different sourceIds.
 * Used by SourcesTab "Combine" button and backend auto-combine.
 */
export function groupStreamsByChannel<T extends { name: string; sourceId: string; url: string }>(
  streams: T[],
  minSources = 2
): Map<string, { name: string; streams: T[] }> {
  const map = new Map<string, { name: string; streams: T[]; sourceIds: Set<string> }>();

  for (const s of streams) {
    const key = normalizeChannelKey(s.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { name: s.name, streams: [], sourceIds: new Set() });
    const entry = map.get(key)!;
    entry.streams.push(s);
    entry.sourceIds.add(s.sourceId);
    // Use the shortest name as representative (e.g. "Sun TV" over "Sun TV HD")
    if (s.name.length < entry.name.length) entry.name = s.name;
  }

  const result = new Map<string, { name: string; streams: T[] }>();
  for (const [key, val] of map) {
    if (val.sourceIds.size >= minSources) {
      result.set(key, { name: val.name, streams: val.streams });
    }
  }
  return result;
}

/** @deprecated use groupStreamsByChannel */
export function autoGroupByChannel<T extends { name: string; sourceId: string; url: string }>(
  streams: T[],
  minSourceCount = 2
): Map<string, { name: string; streams: T[] }> {
  return groupStreamsByChannel(streams, minSourceCount);
}
