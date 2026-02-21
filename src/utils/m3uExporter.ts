import { Stream } from '../types';

/**
 * Generate a valid M3U playlist string from an array of streams.
 * Only includes enabled streams by default (pass includeDisabled to override).
 */
export function generateM3U(
  streams: Stream[],
  options: {
    includeDisabled?: boolean;
    filterGroup?: string;
    sortByGroup?: boolean;
    playlistName?: string;
  } = {}
): string {
  const {
    includeDisabled = false,
    filterGroup,
    sortByGroup = true,
    playlistName = 'Jash IPTV Playlist',
  } = options;

  let filtered = streams.filter(s => includeDisabled || s.enabled);

  if (filterGroup) {
    filtered = filtered.filter(s => s.group === filterGroup);
  }

  if (sortByGroup) {
    filtered = [...filtered].sort((a, b) => {
      const gc = a.group.localeCompare(b.group);
      if (gc !== 0) return gc;
      return a.name.localeCompare(b.name);
    });
  }

  const lines: string[] = [`#EXTM3U x-tvg-url="" playlist-type="vod" x-playlist-name="${playlistName}"`];

  for (const stream of filtered) {
    const parts: string[] = ['#EXTINF:-1'];

    if (stream.tvgId) parts.push(`tvg-id="${stream.tvgId}"`);
    parts.push(`tvg-name="${escapeAttr(stream.tvgName || stream.name)}"`);
    if (stream.logo) parts.push(`tvg-logo="${escapeAttr(stream.logo)}"`);
    parts.push(`group-title="${escapeAttr(stream.group)}"`);

    lines.push(`${parts.join(' ')},${stream.name}`);
    lines.push(stream.url);
  }

  return lines.join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
}

/**
 * Trigger a browser download of the M3U content as a .m3u file.
 */
export function downloadM3UFile(
  streams: Stream[],
  filename = 'jash-playlist.m3u',
  options: Parameters<typeof generateM3U>[1] = {}
): void {
  const content = generateM3U(streams, options);
  const blob = new Blob([content], { type: 'application/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Generate a data: URI for the M3U playlist (usable as a URL in other players).
 * Note: data URIs have size limits. For large playlists use downloadM3UFile instead.
 */
export function generateM3UDataUrl(
  streams: Stream[],
  options: Parameters<typeof generateM3U>[1] = {}
): string {
  const content = generateM3U(streams, options);
  const encoded = encodeURIComponent(content);
  return `data:application/x-mpegurl;charset=utf-8,${encoded}`;
}

/**
 * Generate a Blob URL for the M3U playlist.
 * Must be revoked by caller when no longer needed.
 */
export function generateM3UBlobUrl(
  streams: Stream[],
  options: Parameters<typeof generateM3U>[1] = {}
): string {
  const content = generateM3U(streams, options);
  const blob = new Blob([content], { type: 'application/x-mpegurl' });
  return URL.createObjectURL(blob);
}

/**
 * Count how many streams will be included.
 */
export function countExportableStreams(
  streams: Stream[],
  options: { includeDisabled?: boolean; filterGroup?: string } = {}
): number {
  const { includeDisabled = false, filterGroup } = options;
  let filtered = streams.filter(s => includeDisabled || s.enabled);
  if (filterGroup) filtered = filtered.filter(s => s.group === filterGroup);
  return filtered.length;
}
