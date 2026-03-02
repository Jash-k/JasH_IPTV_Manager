'use strict';
/**
 * streaming-server/config.js
 * Central config for the DRM Streaming Server
 */

const path = require('path');
const os   = require('os');

module.exports = {
  // ── Server ─────────────────────────────────────────────────────────────────
  PORT:        parseInt(process.env.STREAM_PORT || '10001', 10),
  HOST:        process.env.HOST || '0.0.0.0',
  BASE_URL:    process.env.STREAM_BASE_URL || `http://localhost:${process.env.STREAM_PORT || '10001'}`,
  MAIN_SERVER: process.env.MAIN_SERVER_URL || 'http://localhost:10000',

  // ── FFmpeg ─────────────────────────────────────────────────────────────────
  FFMPEG_PATH:  process.env.FFMPEG_PATH  || 'ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',

  // ── HLS Output ─────────────────────────────────────────────────────────────
  OUTPUT_DIR:      process.env.OUTPUT_DIR || path.join(__dirname, 'output'),
  HLS_SEGMENT_TIME: parseInt(process.env.HLS_SEGMENT_TIME || '4', 10),   // seconds
  HLS_LIST_SIZE:    parseInt(process.env.HLS_LIST_SIZE    || '6', 10),   // segments in playlist
  HLS_DELETE_THRESHOLD: parseInt(process.env.HLS_DELETE_THRESHOLD || '12', 10), // delete after N segments

  // ── Transcoding ────────────────────────────────────────────────────────────
  VIDEO_CODEC:   process.env.VIDEO_CODEC   || 'copy',   // 'copy' | 'libx264' | 'h264_nvenc'
  AUDIO_CODEC:   process.env.AUDIO_CODEC   || 'copy',   // 'copy' | 'aac'
  VIDEO_BITRATE: process.env.VIDEO_BITRATE || '2500k',
  AUDIO_BITRATE: process.env.AUDIO_BITRATE || '128k',
  VIDEO_PRESET:  process.env.VIDEO_PRESET  || 'veryfast',
  // Hardware acceleration: 'none' | 'vaapi' | 'nvenc' | 'videotoolbox'
  HW_ACCEL:      process.env.HW_ACCEL      || 'none',

  // ── DRM ────────────────────────────────────────────────────────────────────
  // AES-128 key for HLS encryption (16 bytes hex or auto-generated)
  AES_KEY_HEX:     process.env.AES_KEY_HEX     || '',
  // Shaka Packager binary path (optional — for DASH+Widevine packaging)
  SHAKA_PACKAGER:  process.env.SHAKA_PACKAGER   || 'packager',
  // Widevine server for real CDM (optional, requires license)
  WIDEVINE_SERVER: process.env.WIDEVINE_SERVER   || '',
  // ClearKey default: inline kid:key pairs (comma separated)
  CLEARKEY_PAIRS:  process.env.CLEARKEY_PAIRS    || '',

  // ── Cache ──────────────────────────────────────────────────────────────────
  SEGMENT_TTL:    parseInt(process.env.SEGMENT_TTL    || '300',  10), // seconds
  SESSION_TTL:    parseInt(process.env.SESSION_TTL    || '3600', 10), // seconds (1 hour)
  CACHE_MAX_SIZE: parseInt(process.env.CACHE_MAX_SIZE || '500',  10), // MB

  // ── Logging ────────────────────────────────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // ── System ─────────────────────────────────────────────────────────────────
  CPUS:      os.cpus().length,
  TMP_DIR:   os.tmpdir(),
};
