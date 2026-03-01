'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MPD → HLS Converter — Node.js port of mediaflow-proxy              ║
 * ║                                                                      ║
 * ║  Converts MPEG-DASH manifests to HLS playlists so that              ║
 * ║  ANY player (TiviMate, OTT Navigator, VLC, Kodi, Stremio) can       ║
 * ║  play DASH streams WITHOUT native DASH support.                     ║
 * ║                                                                      ║
 * ║  Also injects decrypted segment serving so ClearKey DRM streams     ║
 * ║  play transparently without the player needing EME support.         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

// ─── MPD XML Helpers ──────────────────────────────────────────────────────────
function attrVal(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}
function innerXml(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const m  = re.exec(xml);
  return m ? m[0] : null;
}
function allTags(xml, tag) {
  const re  = new RegExp(`<${tag}([^>]*)(?:\\/|>[\\s\\S]*?<\\/${tag})>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}
function tagAttr(tagStr, name) { return attrVal(tagStr, name); }

// ─── URL Resolution ───────────────────────────────────────────────────────────
function resolveUrl(base, relative) {
  if (!relative) return base;
  if (/^https?:\/\//i.test(relative)) return relative;
  try {
    return new URL(relative, base).href;
  } catch {
    const dir = base.substring(0, base.lastIndexOf('/') + 1);
    return dir + relative;
  }
}

// ─── Time Conversion ──────────────────────────────────────────────────────────
function ptToSeconds(pt) {
  if (!pt) return 0;
  const m = pt.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return 0;
  return (parseFloat(m[1] || 0) * 3600) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0);
}

// ─── Template Expansion ───────────────────────────────────────────────────────
function expandTemplate(tmpl, vars) {
  return tmpl
    .replace(/\$RepresentationID\$/g, vars.RepresentationID || '')
    .replace(/\$Bandwidth\$/g, vars.Bandwidth || '')
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, w) => w ? String(vars.Number || 0).padStart(parseInt(w), '0') : String(vars.Number || 0))
    .replace(/\$Time\$/g, vars.Time || '')
    .replace(/\$\$/g, '$');
}

// ─── Parse Representations from AdaptationSet ─────────────────────────────────
function parseAdaptationSets(mpdXml, mpdUrl) {
  const periods = allTags(mpdXml, 'Period');
  const adaptSets = [];

  for (const period of periods) {
    for (const adaptSet of allTags(period, 'AdaptationSet')) {
      const mimeType    = attrVal(adaptSet, 'mimeType')    || '';
      const contentType = attrVal(adaptSet, 'contentType') || '';
      const lang        = attrVal(adaptSet, 'lang')        || 'und';
      const isVideo     = mimeType.includes('video') || contentType === 'video';
      const isAudio     = mimeType.includes('audio') || contentType === 'audio';
      if (!isVideo && !isAudio) continue;

      // Find SegmentTemplate at AdaptationSet level
      let adaptTemplate = null;
      const stMatch = adaptSet.match(/<SegmentTemplate([^>]*)>/);
      if (stMatch) adaptTemplate = stMatch[0];

      for (const rep of allTags(adaptSet, 'Representation')) {
        const repId     = attrVal(rep, 'id')        || `rep_${adaptSets.length}`;
        const bandwidth = parseInt(attrVal(rep, 'bandwidth') || '0', 10);
        const codecs    = attrVal(rep, 'codecs')    || (isVideo ? 'avc1' : 'mp4a.40.2');
        const width     = parseInt(attrVal(rep, 'width')  || '0', 10);
        const height    = parseInt(attrVal(rep, 'height') || '0', 10);
        const frameRate = parseFloat(attrVal(rep, 'frameRate') || '25');
        const repMime   = attrVal(rep, 'mimeType')  || mimeType;

        // SegmentTemplate — prefer Representation-level, fallback to AdaptationSet
        let stTag = null;
        const repStMatch = rep.match(/<SegmentTemplate([^>]*)>/);
        if (repStMatch) stTag = repStMatch[0];
        else if (adaptTemplate) stTag = adaptTemplate;

        // SegmentList
        let segList = null;
        const slMatch = adaptSet.match(/<SegmentList([^>]*)>([\s\S]*?)<\/SegmentList>/i) ||
                        rep.match(/<SegmentList([^>]*)>([\s\S]*?)<\/SegmentList>/i);
        if (slMatch) segList = slMatch[0];

        // BaseURL
        let baseUrl = mpdUrl;
        const buMatch = rep.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i) ||
                        adaptSet.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i) ||
                        mpdXml.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
        if (buMatch) baseUrl = resolveUrl(mpdUrl, buMatch[1].trim());

        // SegmentBase (SegmentBase@indexRange)
        let segBase = null;
        const sbMatch = rep.match(/<SegmentBase([^>]*)>/);
        if (sbMatch) segBase = sbMatch[0];

        let segments = [];
        let initUrl  = null;
        let startNumber = 1;
        let timescale   = 1;
        let duration    = 0;

        if (stTag) {
          // ── SegmentTemplate ────────────────────────────────────────────
          const initTmpl   = attrVal(stTag, 'initialization') || attrVal(stTag, 'initialization');
          const mediaTmpl  = attrVal(stTag, 'media');
          timescale        = parseInt(attrVal(stTag, 'timescale') || '1', 10);
          startNumber      = parseInt(attrVal(stTag, 'startNumber') || '1', 10);
          duration         = parseInt(attrVal(stTag, 'duration') || '0', 10);

          const vars = { RepresentationID: repId, Bandwidth: String(bandwidth) };

          if (initTmpl) {
            initUrl = resolveUrl(baseUrl, expandTemplate(initTmpl, { ...vars, Number: startNumber }));
          }

          // SegmentTimeline
          const stlMatch = stTag.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/i) ||
                           adaptSet.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/i);

          if (stlMatch) {
            const sEntries = allTags(stlMatch[1] || stlMatch[0], 'S');
            let t = 0;
            let num = startNumber;
            for (const sTag of sEntries) {
              const startT = attrVal(sTag, 't');
              const d      = parseInt(attrVal(sTag, 'd') || '0', 10);
              const r      = parseInt(attrVal(sTag, 'r') || '0', 10);
              if (startT !== null) t = parseInt(startT, 10);
              for (let i = 0; i <= r; i++) {
                const segUrl = resolveUrl(baseUrl, expandTemplate(mediaTmpl || '', { ...vars, Number: num, Time: String(t) }));
                segments.push({ url: segUrl, duration: d / timescale, number: num, time: t });
                t   += d;
                num += 1;
              }
            }
          } else if (duration > 0) {
            // Duration-based template (for live/simple VoD)
            const segDurationSec = duration / timescale;
            // Generate up to 20 segments for live preview
            const totalSec = 20 * segDurationSec;
            let num = startNumber;
            for (let t2 = 0; t2 < totalSec; t2 += segDurationSec) {
              const segUrl = resolveUrl(baseUrl, expandTemplate(mediaTmpl || '', { ...vars, Number: num, Time: String(Math.floor(t2 * timescale)) }));
              segments.push({ url: segUrl, duration: segDurationSec, number: num });
              num++;
            }
          }

        } else if (segList) {
          // ── SegmentList ────────────────────────────────────────────────
          const initMatch = segList.match(/<Initialization[^>]+sourceURL="([^"]+)"/i);
          if (initMatch) initUrl = resolveUrl(baseUrl, initMatch[1]);

          for (const su of allTags(segList, 'SegmentURL')) {
            const media = attrVal(su, 'media');
            if (media) segments.push({ url: resolveUrl(baseUrl, media), duration: 4 });
          }

        } else if (segBase) {
          // ── SegmentBase (single file with byte ranges) ─────────────────
          const initRange = attrVal(segBase, 'initialization')  || attrVal(segBase, 'indexRange');
          initUrl  = baseUrl;
          segments = [{ url: baseUrl, duration: 0, initRange }];
        } else {
          // Fallback: direct URL
          segments = [{ url: baseUrl, duration: 4 }];
        }

        if (segments.length === 0) continue;
        if (!initUrl) initUrl = segments[0].url;

        adaptSets.push({
          id: repId, isVideo, isAudio, bandwidth, codecs, width, height, frameRate,
          lang, mimeType: repMime, initUrl, segments, timescale,
        });
      }
    }
  }
  return adaptSets;
}

// ─── Build HLS Master Playlist ────────────────────────────────────────────────
/**
 * Convert MPD to HLS master playlist.
 * Each Representation becomes a variant stream.
 * Segments are routed through our proxy endpoint.
 *
 * @param {string}  mpdXml     Raw MPD XML text
 * @param {string}  mpdUrl     Original MPD URL (for resolving relative paths)
 * @param {string}  proxyBase  Our server's base URL (e.g. https://server.com)
 * @param {string}  channelId  Opaque channel identifier (for proxy routes)
 * @param {string}  keyId      ClearKey KID (hex) — empty if no DRM
 * @param {string}  key        ClearKey key (hex) — empty if no DRM
 * @returns {{ master: string, profiles: object[] }}
 */
function buildHlsMaster(mpdXml, mpdUrl, proxyBase, channelId, keyId, key) {
  const profiles = parseAdaptationSets(mpdXml, mpdUrl);
  const videos   = profiles.filter(p => p.isVideo).sort((a, b) => b.bandwidth - a.bandwidth);
  const audios   = profiles.filter(p => p.isAudio);
  const hasDRM   = !!(keyId && key);

  const lines = ['#EXTM3U', '#EXT-X-VERSION:6'];

  // Audio groups
  const audioGroups = [];
  for (let i = 0; i < audios.length; i++) {
    const a = audios[i];
    const playlistUrl = `${proxyBase}/proxy/playlist/${channelId}/${a.id}.m3u8` +
      (hasDRM ? `?key_id=${keyId}&key=${key}` : '');
    const isDefault = i === 0 ? 'YES' : 'NO';
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio ${a.lang} (${a.bandwidth})",` +
      `DEFAULT=${isDefault},AUTOSELECT=YES,LANGUAGE="${a.lang}",URI="${playlistUrl}"`
    );
    audioGroups.push(playlistUrl);
  }

  // Video variants
  for (const v of videos) {
    const playlistUrl = `${proxyBase}/proxy/playlist/${channelId}/${v.id}.m3u8` +
      (hasDRM ? `?key_id=${keyId}&key=${key}` : '');
    const audioAttr   = audios.length > 0 ? ',AUDIO="audio"' : '';
    const audioCodec  = audios.length > 0 ? (',' + audios[0].codecs) : '';
    const resolution  = v.width && v.height ? `,RESOLUTION=${v.width}x${v.height}` : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth}${resolution},CODECS="${v.codecs}${audioCodec}",FRAME-RATE=${v.frameRate}${audioAttr}`);
    lines.push(playlistUrl);
  }

  // Fallback: if no video but audio
  if (videos.length === 0 && audios.length > 0) {
    const a = audios[0];
    const playlistUrl = `${proxyBase}/proxy/playlist/${channelId}/${a.id}.m3u8` +
      (hasDRM ? `?key_id=${keyId}&key=${key}` : '');
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${a.bandwidth},CODECS="${a.codecs}"`);
    lines.push(playlistUrl);
  }

  return { master: lines.join('\n'), profiles };
}

// ─── Build HLS Media Playlist ─────────────────────────────────────────────────
/**
 * Build an HLS media playlist for a single representation.
 *
 * @param {object}  profile    Parsed profile from parseAdaptationSets
 * @param {string}  proxyBase  Our server's base URL
 * @param {string}  channelId  Opaque channel identifier
 * @param {string}  keyId      ClearKey KID hex — empty if no DRM
 * @param {string}  key        ClearKey key hex — empty if no DRM
 * @param {boolean} isLive     Whether this is a live stream
 * @returns {string}           HLS playlist text
 */
function buildHlsMediaPlaylist(profile, proxyBase, channelId, keyId, key, isLive = true) {
  const hasDRM    = !!(keyId && key);
  const segments  = profile.segments;
  const targetDur = segments.length > 0
    ? Math.ceil(Math.max(...segments.map(s => s.duration || 4))) + 1
    : 10;

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${targetDur}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.number || 1}`,
  ];

  if (!isLive) lines.push('#EXT-X-PLAYLIST-TYPE:VOD');

  // EXT-X-MAP — init segment
  if (profile.initUrl) {
    const initProxy = `${proxyBase}/proxy/init/${channelId}?` +
      `u=${encodeURIComponent(profile.initUrl)}` +
      (hasDRM ? `&key_id=${keyId}&key=${key}` : '');
    lines.push(`#EXT-X-MAP:URI="${initProxy}"`);
  }

  // Segments
  for (const seg of segments) {
    const dur = (seg.duration || 4).toFixed(3);
    const segProxy = `${proxyBase}/proxy/seg/${channelId}?` +
      `u=${encodeURIComponent(seg.url)}` +
      `&init=${encodeURIComponent(profile.initUrl || '')}` +
      (hasDRM ? `&key_id=${keyId}&key=${key}` : '');
    lines.push(`#EXTINF:${dur},`);
    lines.push(segProxy);
  }

  if (!isLive) lines.push('#EXT-X-ENDLIST');

  return lines.join('\n');
}

// ─── Parse MPD + Store Profiles ───────────────────────────────────────────────
/**
 * Full MPD parse. Returns profiles keyed by repId.
 */
function parseMPD(mpdXml, mpdUrl) {
  const isLive = mpdXml.includes('type="dynamic"') || mpdXml.includes("type='dynamic'");
  const profiles = parseAdaptationSets(mpdXml, mpdUrl);
  return { profiles, isLive, mpdUrl };
}

module.exports = { parseMPD, buildHlsMaster, buildHlsMediaPlaylist, parseAdaptationSets };
