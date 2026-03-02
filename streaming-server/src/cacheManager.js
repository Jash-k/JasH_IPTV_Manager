'use strict';
/**
 * streaming-server/src/cacheManager.js
 *
 * In-memory + disk cache manager for:
 *   - Active transcoding sessions
 *   - HLS segment file tracking
 *   - DRM key caching
 *   - Stream metadata
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const cfg    = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
//  Session Store  (in-memory)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StreamSession
 * @property {string}  id           - Unique session ID
 * @property {string}  channelId    - Channel ID from main server
 * @property {string}  channelName  - Display name
 * @property {string}  sourceUrl    - Original stream URL
 * @property {string}  outputDir    - HLS output directory
 * @property {string}  playlistPath - Path to master.m3u8
 * @property {string}  playlistUrl  - Public URL to master.m3u8
 * @property {string}  status       - 'starting'|'running'|'error'|'stopped'
 * @property {number}  startedAt    - Unix timestamp
 * @property {number}  lastAccess   - Unix timestamp
 * @property {number}  viewers      - Active viewer count
 * @property {Object}  channel      - Full channel object from main server
 * @property {Object}  drmConfig    - DRM configuration
 * @property {string}  ffmpegPid    - FFmpeg process ID
 * @property {Object}  metrics      - Streaming metrics
 */

/** @type {Map<string, StreamSession>} */
const sessions = new Map();

/** @type {Map<string, string>} — channelId → sessionId */
const channelToSession = new Map();

/** @type {Map<string, {key: Buffer, iv: Buffer, created: number}>} — DRM key cache */
const keyCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
//  Session Management
// ─────────────────────────────────────────────────────────────────────────────

function createSession(channelId, channel, drmConfig) {
  const id        = 'sess_' + crypto.randomBytes(8).toString('hex');
  const outputDir = path.join(cfg.OUTPUT_DIR, id);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const session = {
    id,
    channelId,
    channelName:  channel.name || channelId,
    sourceUrl:    channel.url,
    outputDir,
    playlistPath: path.join(outputDir, 'master.m3u8'),
    playlistUrl:  `${cfg.BASE_URL}/stream/${id}/master.m3u8`,
    status:       'starting',
    startedAt:    Date.now(),
    lastAccess:   Date.now(),
    viewers:      0,
    channel,
    drmConfig:    drmConfig || null,
    ffmpegPid:    null,
    metrics: {
      segmentsGenerated: 0,
      bytesServed:       0,
      errors:            0,
      uptime:            0,
    },
  };

  sessions.set(id, session);
  channelToSession.set(channelId, id);

  console.log(`[Cache] Session created: ${id} for channel: ${channel.name}`);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function getSessionByChannel(channelId) {
  const sid = channelToSession.get(channelId);
  return sid ? sessions.get(sid) || null : null;
}

function updateSession(sessionId, updates) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  Object.assign(s, updates, { lastAccess: Date.now() });
  return true;
}

function touchSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { s.lastAccess = Date.now(); s.viewers = Math.max(0, (s.viewers||0)); }
}

function addViewer(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.viewers = (s.viewers || 0) + 1;
}

function removeViewer(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.viewers = Math.max(0, (s.viewers || 0) - 1);
}

function deleteSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;

  // Remove channel mapping
  channelToSession.delete(s.channelId);

  // Clean output directory
  try {
    if (fs.existsSync(s.outputDir)) {
      fs.rmSync(s.outputDir, { recursive: true, force: true });
    }
  } catch(e) { console.error('[Cache] Dir cleanup error:', e.message); }

  sessions.delete(sessionId);
  console.log(`[Cache] Session deleted: ${sessionId}`);
  return true;
}

function getAllSessions() {
  return Array.from(sessions.values());
}

function getActiveSessions() {
  return Array.from(sessions.values()).filter(s => s.status === 'running' || s.status === 'starting');
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRM Key Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store AES key for a session
 * @param {string} sessionId
 * @param {Buffer} key  16-byte AES key
 * @param {Buffer} iv   16-byte IV (optional)
 */
function storeKey(sessionId, key, iv) {
  keyCache.set(sessionId, {
    key:     Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex'),
    iv:      iv ? (Buffer.isBuffer(iv) ? iv : Buffer.from(iv, 'hex')) : crypto.randomBytes(16),
    created: Date.now(),
  });
}

function getKey(sessionId) {
  return keyCache.get(sessionId) || null;
}

function deleteKey(sessionId) {
  keyCache.delete(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Disk segment tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all .ts segment files in a session output dir
 */
function getSegments(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !fs.existsSync(s.outputDir)) return [];
  return fs.readdirSync(s.outputDir)
    .filter(f => f.endsWith('.ts') || f.endsWith('.m4s') || f.endsWith('.aac'))
    .map(f => ({
      file: f,
      fullPath: path.join(s.outputDir, f),
      size: (() => { try { return fs.statSync(path.join(s.outputDir, f)).size; } catch { return 0; } })(),
    }));
}

/**
 * Calculate total disk usage for all sessions (bytes)
 */
function getTotalDiskUsage() {
  let total = 0;
  for (const s of sessions.values()) {
    if (!fs.existsSync(s.outputDir)) continue;
    try {
      fs.readdirSync(s.outputDir).forEach(f => {
        try { total += fs.statSync(path.join(s.outputDir, f)).size; } catch {}
      });
    } catch {}
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auto-cleanup
// ─────────────────────────────────────────────────────────────────────────────

function cleanup() {
  const now     = Date.now();
  const ttlMs   = cfg.SESSION_TTL * 1000;
  const cleaned = [];

  for (const [id, s] of sessions.entries()) {
    const idle = now - s.lastAccess;
    // Clean up stopped/errored sessions after 5 min, idle sessions after SESSION_TTL
    const shouldClean =
      (s.status === 'stopped' && idle > 5 * 60 * 1000) ||
      (s.status === 'error'   && idle > 5 * 60 * 1000) ||
      (s.viewers === 0        && idle > ttlMs);

    if (shouldClean) {
      cleaned.push(id);
      deleteSession(id);
      deleteKey(id);
    }
  }

  // Clean orphaned output dirs
  if (fs.existsSync(cfg.OUTPUT_DIR)) {
    const activeDirs = new Set(Array.from(sessions.values()).map(s => s.id));
    try {
      fs.readdirSync(cfg.OUTPUT_DIR).forEach(dir => {
        if (!activeDirs.has(dir)) {
          try {
            fs.rmSync(path.join(cfg.OUTPUT_DIR, dir), { recursive: true, force: true });
          } catch {}
        }
      });
    } catch {}
  }

  if (cleaned.length > 0) {
    console.log(`[Cache] Cleaned ${cleaned.length} sessions: ${cleaned.join(', ')}`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanup, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
//  Stats
// ─────────────────────────────────────────────────────────────────────────────

function getStats() {
  const all     = Array.from(sessions.values());
  const active  = all.filter(s => s.status === 'running');
  const diskMB  = Math.round(getTotalDiskUsage() / 1024 / 1024);

  return {
    totalSessions:  all.length,
    activeSessions: active.length,
    totalViewers:   all.reduce((a, s) => a + (s.viewers||0), 0),
    diskUsageMB:    diskMB,
    keysCached:     keyCache.size,
    memoryMB:       Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

module.exports = {
  createSession,
  getSession,
  getSessionByChannel,
  updateSession,
  touchSession,
  addViewer,
  removeViewer,
  deleteSession,
  getAllSessions,
  getActiveSessions,
  storeKey,
  getKey,
  deleteKey,
  getSegments,
  getTotalDiskUsage,
  getStats,
  cleanup,
};
