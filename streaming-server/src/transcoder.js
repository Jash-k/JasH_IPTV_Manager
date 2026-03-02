'use strict';
/**
 * streaming-server/src/transcoder.js
 *
 * FFmpeg-based transcoder + HLS packager
 *
 * Features:
 *   - Live HLS output (segments written to disk, served via HTTP)
 *   - Stream copy (no transcoding) for compatible streams — lowest CPU
 *   - DRM decryption via FFmpeg -decryption_key (ClearKey/AES-128)
 *   - AES-128 re-encryption for HLS output
 *   - Hardware acceleration support (VAAPI/NVENC/VideoToolbox)
 *   - Auto-restart on stream error
 *   - Multi-quality ladder (optional)
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const cfg        = require('../config');
const cache      = require('./cacheManager');
const drm        = require('./drmHandler');

// ─────────────────────────────────────────────────────────────────────────────
//  FFmpeg argument builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build FFmpeg input arguments for a channel
 * Handles headers, cookies, timeouts, protocol whitelist
 */
function buildInputArgs(channel, drmResolution) {
  const args = [];

  // Use DRM-resolved ffmpeg options if available
  if (drmResolution && drmResolution.ffmpegInputOpts && drmResolution.ffmpegInputOpts.length > 0) {
    args.push(...drmResolution.ffmpegInputOpts);
  } else {
    // Build from channel info
    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data');

    const ua = channel.userAgent || drm.nextUA();
    args.push('-user_agent', ua);

    const extraHeaders = [];
    if (channel.referer)    extraHeaders.push(`Referer: ${channel.referer}`);
    if (channel.cookie)     extraHeaders.push(`Cookie: ${channel.cookie}`);
    if (channel.httpHeaders) {
      Object.entries(channel.httpHeaders).forEach(([k,v]) => {
        extraHeaders.push(`${k}: ${v}`);
      });
    }
    if (extraHeaders.length > 0) {
      args.push('-headers', extraHeaders.map(h => h+'\r\n').join(''));
    }
  }

  // Reconnect options for live streams
  args.push(
    '-reconnect',           '1',
    '-reconnect_streamed',  '1',
    '-reconnect_delay_max', '5',
    '-timeout',             '10000000', // microseconds = 10s
  );

  // Input URL
  const inputUrl = (drmResolution && drmResolution.streamUrl) || channel.url;
  args.push('-i', inputUrl);

  return args;
}

/**
 * Build FFmpeg video encoding args
 * Uses 'copy' by default (stream copy = no re-encode, lowest CPU)
 */
function buildVideoArgs(channel) {
  const codec = cfg.VIDEO_CODEC || 'copy';

  if (codec === 'copy') return ['-c:v', 'copy'];

  const args = ['-c:v', codec];

  // Hardware acceleration
  if (cfg.HW_ACCEL === 'vaapi')         args.unshift('-vaapi_device', '/dev/dri/renderD128');
  if (cfg.HW_ACCEL === 'nvenc')         args[1] = 'h264_nvenc';
  if (cfg.HW_ACCEL === 'videotoolbox')  args[1] = 'h264_videotoolbox';

  if (codec !== 'copy') {
    args.push(
      '-preset',  cfg.VIDEO_PRESET || 'veryfast',
      '-b:v',     cfg.VIDEO_BITRATE || '2500k',
      '-maxrate', cfg.VIDEO_BITRATE || '2500k',
      '-bufsize',  '5000k',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'main',
    );
  }

  return args;
}

/**
 * Build FFmpeg audio encoding args
 */
function buildAudioArgs() {
  const codec = cfg.AUDIO_CODEC || 'copy';
  if (codec === 'copy') return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-b:a', cfg.AUDIO_BITRATE || '128k', '-ac', '2'];
}

/**
 * Build HLS output args
 * @param {string}  outputDir      - where to write segments
 * @param {string}  keyInfoFile    - path to enc.keyinfo (AES-128 encryption)
 * @param {boolean} encrypt        - whether to AES-128 encrypt output
 */
function buildHLSArgs(outputDir, keyInfoFile, encrypt) {
  const segTime  = cfg.HLS_SEGMENT_TIME || 4;
  const listSize = cfg.HLS_LIST_SIZE    || 6;
  const m3u8Path = path.join(outputDir, 'master.m3u8');
  const segPath  = path.join(outputDir, 'seg%05d.ts');

  const args = [
    '-f',              'hls',
    '-hls_time',       String(segTime),
    '-hls_list_size',  String(listSize),
    '-hls_flags',      'delete_segments+append_list+program_date_time',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segPath,
  ];

  // AES-128 encryption
  if (encrypt && keyInfoFile && fs.existsSync(keyInfoFile)) {
    args.push('-hls_key_info_file', keyInfoFile);
  }

  // Metadata
  args.push(
    '-map', '0:v?',  // optional video
    '-map', '0:a?',  // optional audio
    m3u8Path,
  );

  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session starter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a transcoding session for a channel
 *
 * @param {string} channelId
 * @param {Object} channel      - Full channel object
 * @param {Object} drmCfg       - DRM config (may be null)
 * @param {Object} options
 * @param {boolean} options.encrypt  - AES-128 encrypt HLS output
 * @param {string}  options.keyUrl   - URL where keys will be served (for keyinfo)
 * @returns {Promise<StreamSession>}
 */
async function startSession(channelId, channel, drmCfg, options) {
  options = options || {};

  // Check if already running
  const existing = cache.getSessionByChannel(channelId);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    cache.touchSession(existing.id);
    return existing;
  }

  // Ensure output dir exists
  if (!fs.existsSync(cfg.OUTPUT_DIR)) {
    fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });
  }

  // Create session
  const session = cache.createSession(channelId, channel, drmCfg);

  try {
    // Resolve DRM
    let drmResolution = null;
    const hasDRM = !!(drmCfg || channel.licenseType || channel.licenseKey);

    if (hasDRM) {
      console.log(`[Transcoder] Resolving DRM for: ${channel.name} (${session.id})`);
      const isJioTV = channel.cookie && channel.licenseKey && !channel.licenseKey.startsWith('http');
      drmResolution = isJioTV
        ? await drm.resolveJioTVStream(channel)
        : await drm.resolveDRM(channel, drmCfg);
      console.log(`[Transcoder] DRM resolved: type=${drmResolution.drmType} keys=${drmResolution.clearKeys.length} decrypt=${drmResolution.needsDecrypt}`);
    }

    // Setup AES-128 key for output encryption
    let keyInfoFile = null;
    if (options.encrypt && options.keyUrl) {
      const aesKey = drm.generateAESKey();
      drm.writeKeyFile(session.id, aesKey);
      keyInfoFile = drm.writeKeyInfoFile(session.id, options.keyUrl);
    }

    // Build FFmpeg command
    const ffArgs = buildFFmpegArgs(channel, drmResolution, session.outputDir, keyInfoFile, options.encrypt);

    console.log(`[Transcoder] Starting FFmpeg for: ${channel.name}`);
    console.log(`[Transcoder] FFmpeg args: ffmpeg ${ffArgs.slice(0,12).join(' ')} ...`);

    // Spawn FFmpeg
    const ffProc = spawn(cfg.FFMPEG_PATH || 'ffmpeg', ffArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    cache.updateSession(session.id, {
      ffmpegPid: ffProc.pid,
      status:    'starting',
      drmResolution,
    });

    // Log stderr (FFmpeg output)
    let stderrBuf = '';
    ffProc.stderr.on('data', chunk => {
      const line = chunk.toString();
      stderrBuf += line;
      // Log progress lines
      if (line.includes('frame=') || line.includes('fps=') || line.includes('time=')) {
        const s = cache.getSession(session.id);
        if (s) {
          if (s.status === 'starting') cache.updateSession(session.id, { status: 'running' });
          // Update metrics
          const fpsMatch   = line.match(/fps=\s*(\d+)/);
          const bitrateM   = line.match(/bitrate=\s*([\d.]+)/);
          const timeMatch  = line.match(/time=([\d:]+)/);
          if (s.metrics) {
            if (fpsMatch)  s.metrics.fps     = parseInt(fpsMatch[1]);
            if (bitrateM)  s.metrics.bitrate = bitrateM[1] + 'kbits/s';
            if (timeMatch) s.metrics.elapsed = timeMatch[1];
          }
        }
      }
      if (line.toLowerCase().includes('error') || line.toLowerCase().includes('invalid')) {
        process.stdout.write(`[FFmpeg ERR] ${line}`);
      }
    });

    ffProc.stdout.on('data', chunk => {
      // Some info goes to stdout
    });

    ffProc.on('error', err => {
      console.error(`[Transcoder] FFmpeg spawn error [${session.id}]:`, err.message);
      cache.updateSession(session.id, { status: 'error', error: err.message });
    });

    ffProc.on('close', code => {
      const s = cache.getSession(session.id);
      if (!s) return;
      console.log(`[Transcoder] FFmpeg exited (${code}) for: ${channel.name} [${session.id}]`);

      if (code !== 0 && s.status !== 'stopped') {
        cache.updateSession(session.id, { status: 'error', exitCode: code });

        // Auto-restart after 5s if not manually stopped
        setTimeout(() => {
          const current = cache.getSession(session.id);
          if (current && current.status === 'error' && current.viewers > 0) {
            console.log(`[Transcoder] Auto-restarting: ${channel.name}`);
            startSession(channelId, channel, drmCfg, options).catch(e => {
              console.error('[Transcoder] Restart failed:', e.message);
            });
          }
        }, 5000);
      } else {
        cache.updateSession(session.id, { status: 'stopped', exitCode: code });
      }
    });

    // Wait for first segment to appear (up to 30s)
    await waitForFirstSegment(session.id, session.outputDir, 30000);

    return cache.getSession(session.id);

  } catch(e) {
    console.error(`[Transcoder] Start error [${session.id}]:`, e.message);
    cache.updateSession(session.id, { status: 'error', error: e.message });
    throw e;
  }
}

/**
 * Build the complete FFmpeg argument array
 */
function buildFFmpegArgs(channel, drmResolution, outputDir, keyInfoFile, encrypt) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
  ];

  // Hardware decode hint
  if (cfg.HW_ACCEL === 'vaapi')  args.push('-hwaccel', 'vaapi');
  if (cfg.HW_ACCEL === 'nvenc')  args.push('-hwaccel', 'cuda');

  // Input args (includes DRM decryption key if ClearKey)
  args.push(...buildInputArgs(channel, drmResolution));

  // Video + audio codec
  args.push(...buildVideoArgs(channel));
  args.push(...buildAudioArgs());

  // HLS output
  args.push(...buildHLSArgs(outputDir, keyInfoFile, encrypt));

  return args;
}

/**
 * Wait for the first .ts segment file to appear in outputDir
 */
function waitForFirstSegment(sessionId, outputDir, timeoutMs) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const check   = setInterval(() => {
      // Check for first segment OR status change to running
      const s = cache.getSession(sessionId);
      if (!s || s.status === 'error' || s.status === 'stopped') {
        clearInterval(check);
        resolve(false);
        return;
      }

      const hasM3U8  = fs.existsSync(path.join(outputDir, 'master.m3u8'));
      const hasSeg   = fs.existsSync(outputDir) &&
        fs.readdirSync(outputDir).some(f => f.endsWith('.ts'));

      if (hasM3U8 || hasSeg) {
        cache.updateSession(sessionId, { status: 'running' });
        clearInterval(check);
        resolve(true);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        // Don't error — FFmpeg might still be buffering
        resolve(false);
      }
    }, 500);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Session control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stop a transcoding session (kill FFmpeg, clean up)
 */
function stopSession(sessionId) {
  const s = cache.getSession(sessionId);
  if (!s) return false;

  cache.updateSession(sessionId, { status: 'stopped' });

  // Kill FFmpeg process
  if (s.ffmpegPid) {
    try { process.kill(s.ffmpegPid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(s.ffmpegPid, 'SIGKILL'); } catch {}
    }, 3000);
  }

  console.log(`[Transcoder] Stopped session: ${sessionId}`);
  return true;
}

/**
 * Stop all active sessions
 */
function stopAllSessions() {
  const active = cache.getActiveSessions();
  active.forEach(s => stopSession(s.id));
  console.log(`[Transcoder] Stopped ${active.length} sessions`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Direct pipe mode (for non-DRM streams)
//  Instead of transcoding, we just redirect to the original URL
//  with proper headers — much more efficient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For non-DRM streams that just need header injection/redirect
 * Returns the proxied URL directly (no FFmpeg needed)
 */
function getDirectProxyUrl(channel, baseUrl) {
  // These are served directly by the main server's /proxy/redirect/:id
  return `${baseUrl}/proxy/redirect/${channel.id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  FFmpeg availability check
// ─────────────────────────────────────────────────────────────────────────────

async function checkFFmpeg() {
  return new Promise((resolve) => {
    const proc = spawn(cfg.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      const match = out.match(/ffmpeg version ([^\s]+)/);
      resolve({
        available: code === 0,
        version:   match ? match[1] : 'unknown',
        output:    out.substring(0, 200),
      });
    });
    proc.on('error', () => resolve({ available: false, version: null, output: 'not found' }));
  });
}

module.exports = {
  startSession,
  stopSession,
  stopAllSessions,
  getDirectProxyUrl,
  buildFFmpegArgs,
  checkFFmpeg,
};
