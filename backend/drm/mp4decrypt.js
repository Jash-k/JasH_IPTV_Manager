'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MP4 CENC Decrypter — Node.js port of mediaflow-proxy/decrypter.py  ║
 * ║                                                                      ║
 * ║  Supports:                                                           ║
 * ║    • cenc  — AES-128-CTR (full sample)                              ║
 * ║    • cens  — AES-128-CTR (pattern)                                  ║
 * ║    • cbc1  — AES-128-CBC (full sample)                              ║
 * ║    • cbcs  — AES-128-CBC (pattern, constant IV)                     ║
 * ║    • Multi-track segments (video + audio)                           ║
 * ║    • Sub-sample encryption                                          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const crypto = require('crypto');

// ─── MP4 Atom ─────────────────────────────────────────────────────────────────
class MP4Atom {
  constructor(type, size, data) {
    this.type = type;   // Buffer (4 bytes)
    this.size = size;   // number
    this.data = data;   // Buffer
  }
  pack() {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(this.size, 0);
    this.type.copy(hdr, 4);
    return Buffer.concat([hdr, this.data]);
  }
  typeStr() { return this.type.toString('ascii'); }
}

// ─── MP4 Parser ───────────────────────────────────────────────────────────────
class MP4Parser {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  readAtom() {
    const pos = this.pos;
    if (pos + 8 > this.buf.length) return null;
    let size = this.buf.readUInt32BE(pos);
    const type = this.buf.slice(pos + 4, pos + 8);
    let hdrSize = 8;
    if (size === 1) {
      if (pos + 16 > this.buf.length) return null;
      // 64-bit size — read as two 32-bit halves (JS safe for our sizes)
      const hi = this.buf.readUInt32BE(pos + 8);
      const lo = this.buf.readUInt32BE(pos + 12);
      size = hi * 0x100000000 + lo;
      hdrSize = 16;
    }
    if (size < hdrSize || pos + size > this.buf.length) return null;
    const data = this.buf.slice(pos + hdrSize, pos + size);
    this.pos = pos + size;
    return new MP4Atom(type, size, data);
  }
  listAtoms() {
    const saved = this.pos;
    this.pos = 0;
    const atoms = [];
    let a;
    while ((a = this.readAtom()) !== null) atoms.push(a);
    this.pos = saved;
    return atoms;
  }
}

// ─── AES Helpers ──────────────────────────────────────────────────────────────
function aesCtrDecrypt(key, ivBuf, data) {
  // Pad IV to 16 bytes
  const iv = Buffer.alloc(16);
  ivBuf.copy(iv, 0, 0, Math.min(ivBuf.length, 16));
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function aesCbcDecrypt(key, ivBuf, data) {
  const iv = Buffer.alloc(16);
  ivBuf.copy(iv, 0, 0, Math.min(ivBuf.length, 16));
  // Only decrypt complete blocks
  const blockSize = 16;
  const completeLen = Math.floor(data.length / blockSize) * blockSize;
  if (completeLen === 0) return data;
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(data.slice(0, completeLen)), decipher.final()]);
  if (completeLen < data.length) {
    return Buffer.concat([decrypted, data.slice(completeLen)]);
  }
  return decrypted;
}

// ─── CBCS Pattern Decryption ──────────────────────────────────────────────────
function decryptCBCSPattern(data, key, ivBuf, cryptBlocks, skipBlocks) {
  if (!data || data.length === 0) return data;
  const BLOCK = 16;
  const iv = Buffer.alloc(16);
  ivBuf.copy(iv, 0, 0, Math.min(ivBuf.length, 16));

  // crypt=0, skip=0 → full CBC
  if (cryptBlocks === 0 && skipBlocks === 0) {
    return aesCbcDecrypt(key, iv, data);
  }
  // crypt=0 → no encryption
  if (cryptBlocks === 0) return data;
  // skip=0 → full pattern CBC
  if (skipBlocks === 0) {
    return aesCbcDecrypt(key, iv, data);
  }

  const cryptBytes = cryptBlocks * BLOCK;
  const skipBytes  = skipBlocks  * BLOCK;

  // Collect all encrypted blocks and their positions
  const encryptedChunks = [];
  const positions       = [];
  let pos = 0;

  while (pos < data.length) {
    // Encrypt portion
    const available = data.length - pos;
    if (available >= cryptBytes) {
      encryptedChunks.push(data.slice(pos, pos + cryptBytes));
      positions.push({ pos, len: cryptBytes });
      pos += cryptBytes;
    } else {
      const complete = Math.floor(available / BLOCK) * BLOCK;
      if (complete > 0) {
        encryptedChunks.push(data.slice(pos, pos + complete));
        positions.push({ pos, len: complete });
        pos += complete;
      }
      break;
    }
    // Skip portion
    pos += skipBytes;
  }

  if (encryptedChunks.length === 0) return data;

  // Decrypt all encrypted blocks as a continuous CBC stream
  const combined = Buffer.concat(encryptedChunks);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(combined), decipher.final()]);

  // Reconstruct output
  const result = Buffer.from(data);
  let decPos = 0;
  for (const { pos: p, len } of positions) {
    decrypted.copy(result, p, decPos, decPos + len);
    decPos += len;
  }
  return result;
}

// ─── Main Decrypter ───────────────────────────────────────────────────────────
class MP4Decrypter {
  constructor(keyMap) {
    // keyMap: { hex_kid_string: hex_key_string } or Map<Buffer, Buffer>
    this.keyMap = keyMap instanceof Map ? keyMap : (() => {
      const m = new Map();
      for (const [k, v] of Object.entries(keyMap)) {
        m.set(Buffer.from(k.replace(/-/g,''), 'hex'), Buffer.from(v.replace(/-/g,''), 'hex'));
      }
      return m;
    })();

    this.encryptionScheme  = 'cenc';
    this.defaultIVSize     = 8;
    this.cryptByteBlock    = 1;
    this.skipByteBlock     = 9;
    this.constantIV        = null;
    this.extractedKids     = new Map(); // track_id → kid Buffer
    this.trackEncSettings  = new Map(); // track_id → {crypt, skip, iv_size, constant_iv, kid}
    this.currentTrackId    = 0;

    // Per-moof state (reset each moof)
    this.trackInfos            = [];
    this.totalEncryptionOverhead = 0;
    this.trunSampleSizes       = [];
    this.currentSampleInfo     = [];
    this.defaultSampleSize     = 0;
    this.currentKey            = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  decryptSegment(combined, includeInit = true) {
    const parser = new MP4Parser(combined);
    const atoms  = parser.listAtoms();
    const processed = new Map();

    // Process in order: moov, moof, sidx, mdat
    for (const t of ['moov','moof','sidx','mdat']) {
      const a = atoms.find(x => x.typeStr() === t);
      if (a) processed.set(t, this._processAtom(a));
    }

    const initTypes = new Set(['ftyp','moov']);
    const result = [];
    for (const a of atoms) {
      if (!includeInit && initTypes.has(a.typeStr())) continue;
      const p = processed.get(a.typeStr());
      result.push(p ? p.pack() : a.pack());
    }
    return Buffer.concat(result);
  }

  processInitOnly(initSegment) {
    const parser = new MP4Parser(initSegment);
    const atoms  = parser.listAtoms();
    const processed = new Map();
    const moov = atoms.find(a => a.typeStr() === 'moov');
    if (moov) processed.set('moov', this._processMoov(moov));
    const result = [];
    for (const a of atoms) {
      const p = processed.get(a.typeStr());
      result.push(p ? p.pack() : a.pack());
    }
    return Buffer.concat(result);
  }

  // ── Atom Processing ────────────────────────────────────────────────────────
  _processAtom(a) {
    switch (a.typeStr()) {
      case 'moov': return this._processMoov(a);
      case 'moof': return this._processMoof(a);
      case 'sidx': return this._processSidx(a);
      case 'mdat': return this._decryptMdat(a);
      default:     return a;
    }
  }

  _processMoov(moov) {
    const p = new MP4Parser(moov.data);
    const parts = [];
    let a;
    while ((a = p.readAtom())) {
      if (a.typeStr() === 'trak') parts.push(this._processTrak(a).pack());
      else if (a.typeStr() !== 'pssh') parts.push(a.pack()); // strip pssh
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(moov.type, data.length + 8, data);
  }

  _processTrak(trak) {
    const p = new MP4Parser(trak.data);
    const all = p.listAtoms();

    // Find track_id from tkhd
    const tkhd = all.find(a => a.typeStr() === 'tkhd');
    if (tkhd) {
      const version = tkhd.data[0];
      const offset  = version === 0 ? 12 : 20;
      this.currentTrackId = tkhd.data.readUInt32BE(offset);
    }

    const parts = [];
    for (const a of all) {
      if (a.typeStr() === 'mdia') parts.push(this._processMdia(a).pack());
      else parts.push(a.pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(trak.type, data.length + 8, data);
  }

  _processMdia(mdia) {
    const p = new MP4Parser(mdia.data);
    const parts = [];
    let a;
    while ((a = p.readAtom())) {
      if (a.typeStr() === 'minf') parts.push(this._processMinf(a).pack());
      else parts.push(a.pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(mdia.type, data.length + 8, data);
  }

  _processMinf(minf) {
    const p = new MP4Parser(minf.data);
    const parts = [];
    let a;
    while ((a = p.readAtom())) {
      if (a.typeStr() === 'stbl') parts.push(this._processStbl(a).pack());
      else parts.push(a.pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(minf.type, data.length + 8, data);
  }

  _processStbl(stbl) {
    const p = new MP4Parser(stbl.data);
    const parts = [];
    let a;
    while ((a = p.readAtom())) {
      if (a.typeStr() === 'stsd') parts.push(this._processStsd(a).pack());
      else parts.push(a.pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(stbl.type, data.length + 8, data);
  }

  _processStsd(stsd) {
    const entryCount = stsd.data.readUInt32BE(4);
    const header     = stsd.data.slice(0, 8);
    const parts      = [header];
    const p          = new MP4Parser(stsd.data.slice(8));
    for (let i = 0; i < entryCount; i++) {
      const entry = p.readAtom();
      if (!entry) break;
      parts.push(this._processSampleEntry(entry).pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(stsd.type, data.length + 8, data);
  }

  _processSampleEntry(entry) {
    const t = entry.typeStr();
    let fixedSize = 16;
    if (['mp4a','enca'].includes(t))                            fixedSize = 28;
    if (['mp4v','encv','avc1','hev1','hvc1'].includes(t))      fixedSize = 78;

    const fixed  = entry.data.slice(0, fixedSize);
    const rest   = new MP4Parser(entry.data.slice(fixedSize));
    const parts  = [fixed];
    let codecFmt = null;
    let a;

    while ((a = rest.readAtom())) {
      if (a.typeStr() === 'sinf') {
        codecFmt = this._extractCodecFormat(a);
        // drop sinf
      } else {
        parts.push(a.pack());
      }
    }

    const data    = Buffer.concat(parts);
    const newType = codecFmt || entry.type;
    return new MP4Atom(newType, data.length + 8, data);
  }

  _extractCodecFormat(sinf) {
    const p = new MP4Parser(sinf.data);
    let codecFmt = null;
    let a;
    while ((a = p.readAtom())) {
      if (a.typeStr() === 'frma') {
        codecFmt = a.data.slice(0, 4); // 4-byte codec type
      } else if (a.typeStr() === 'schm') {
        this._parseSchm(a);
      } else if (a.typeStr() === 'schi') {
        const sp = new MP4Parser(a.data);
        let sa;
        while ((sa = sp.readAtom())) {
          if (sa.typeStr() === 'tenc') this._parseTenc(sa);
        }
      }
    }
    return codecFmt;
  }

  _parseSchm(schm) {
    if (schm.data.length < 8) return;
    const st = schm.data.slice(4, 8).toString('ascii');
    if (['cenc','cens','cbc1','cbcs'].includes(st)) this.encryptionScheme = st;
  }

  _parseTenc(tenc) {
    const data    = tenc.data;
    const version = data[0];
    const settings = { cryptByteBlock: 1, skipByteBlock: 9, constantIV: null, ivSize: 8, kid: null };

    if (version > 0 && data.length >= 6) {
      const pat = data[5];
      settings.cryptByteBlock = (pat >> 4) & 0x0F;
      settings.skipByteBlock  = pat & 0x0F;
      this.cryptByteBlock = settings.cryptByteBlock;
      this.skipByteBlock  = settings.skipByteBlock;
    }

    if (data.length >= 24) {
      const kid = data.slice(8, 24);
      settings.kid = kid;
      if (this.currentTrackId > 0) this.extractedKids.set(this.currentTrackId, kid);
    }

    if (data.length > 7) {
      const ivSz = data[7];
      if ([0, 8, 16].includes(ivSz)) {
        settings.ivSize = ivSz > 0 ? ivSz : 16;
        this.defaultIVSize = settings.ivSize;
        if (ivSz === 0 && data.length > 25) {
          const civSz = data[24];
          if (civSz > 0 && data.length >= 25 + civSz) {
            settings.constantIV = data.slice(25, 25 + civSz);
            this.constantIV = settings.constantIV;
          }
        }
      }
    }

    if (this.currentTrackId > 0) this.trackEncSettings.set(this.currentTrackId, settings);
  }

  // ── Moof Processing ────────────────────────────────────────────────────────
  _processMoof(moof) {
    const p    = new MP4Parser(moof.data);
    const all  = p.listAtoms();

    this.trackInfos = [];

    // First pass: calc total encryption overhead
    this.totalEncryptionOverhead = 0;
    for (const a of all) {
      if (a.typeStr() !== 'traf') continue;
      const tp = new MP4Parser(a.data);
      const ta = tp.listAtoms();
      for (const x of ta) {
        if (['senc','saiz','saio'].includes(x.typeStr()))
          this.totalEncryptionOverhead += x.size;
      }
    }

    // Second pass: process
    const parts = [];
    for (const a of all) {
      if (a.typeStr() === 'traf') parts.push(this._processTraf(a).pack());
      else parts.push(a.pack());
    }
    const data = Buffer.concat(parts);
    return new MP4Atom(moof.type, data.length + 8, data);
  }

  _processTraf(traf) {
    const p    = new MP4Parser(traf.data);
    const all  = p.listAtoms();
    const parts = [];
    let tfhdTrackId = 0;
    let sampleCount = 0;
    let trunDataOffset = 0;
    let sampleInfo  = [];
    let trackDefaultSampleSize = 0;

    for (const a of all) {
      switch (a.typeStr()) {
        case 'tfhd':
          parts.push(a.pack());
          this._parseTfhd(a);
          trackDefaultSampleSize = this.defaultSampleSize;
          tfhdTrackId = a.data.readUInt32BE(4);
          break;
        case 'trun': {
          const [sc, doff] = this._processTrun(a);
          sampleCount    = sc;
          trunDataOffset = doff;
          parts.push(this._modifyTrun(a).pack());
          break;
        }
        case 'senc':
          sampleInfo = this._parseSenc(a, sampleCount);
          break;
        case 'saiz': case 'saio':
          break; // strip
        default:
          parts.push(a.pack());
      }
    }

    if (tfhdTrackId > 0) {
      const trackKey  = this._getKeyForTrack(tfhdTrackId);
      const trackEnc  = this.trackEncSettings.get(tfhdTrackId) || {};
      this.trackInfos.push({
        dataOffset: trunDataOffset,
        sampleSizes: [...this.trunSampleSizes],
        sampleInfo,
        key: trackKey,
        defaultSampleSize: trackDefaultSampleSize,
        trackId: tfhdTrackId,
        cryptByteBlock: trackEnc.cryptByteBlock !== undefined ? trackEnc.cryptByteBlock : this.cryptByteBlock,
        skipByteBlock:  trackEnc.skipByteBlock  !== undefined ? trackEnc.skipByteBlock  : this.skipByteBlock,
        constantIV:     trackEnc.constantIV     !== undefined ? trackEnc.constantIV     : this.constantIV,
      });
      this.currentKey        = trackKey;
      this.currentSampleInfo = sampleInfo;
    }

    const data = Buffer.concat(parts);
    return new MP4Atom(traf.type, data.length + 8, data);
  }

  _parseTfhd(tfhd) {
    const flags  = tfhd.data.readUInt32BE(0) & 0xFFFFFF;
    let offset = 8; // version+flags(4) + track_id(4)
    if (flags & 0x000001) offset += 8; // base-data-offset
    if (flags & 0x000002) offset += 4; // sample-description-index
    if (flags & 0x000008) offset += 4; // default-sample-duration
    if (flags & 0x000010) {
      if (offset + 4 <= tfhd.data.length)
        this.defaultSampleSize = tfhd.data.readUInt32BE(offset);
      offset += 4;
    }
  }

  _processTrun(trun) {
    const flags       = trun.data.readUInt32BE(0) & 0xFFFFFF;
    const sampleCount = trun.data.readUInt32BE(4);
    let offset = 8;
    let dataOffset = 0;

    if (flags & 0x000001) { dataOffset = trun.data.readInt32BE(offset); offset += 4; }
    if (flags & 0x000004) offset += 4; // first-sample-flags

    this.trunSampleSizes = [];
    for (let i = 0; i < sampleCount; i++) {
      if (flags & 0x000100) offset += 4; // duration
      if (flags & 0x000200) {
        this.trunSampleSizes.push(trun.data.readUInt32BE(offset));
        offset += 4;
      } else {
        this.trunSampleSizes.push(0);
      }
      if (flags & 0x000400) offset += 4; // flags
      if (flags & 0x000800) offset += 4; // composition-time-offset
    }
    return [sampleCount, dataOffset];
  }

  _modifyTrun(trun) {
    const data  = Buffer.from(trun.data);
    const flags = data.readUInt32BE(0) & 0xFFFFFF;
    if (flags & 0x000001) {
      const cur = data.readInt32BE(8);
      data.writeInt32BE(cur - this.totalEncryptionOverhead, 8);
    }
    return new MP4Atom(trun.type, data.length + 8, data);
  }

  _parseSidx(sidx) { return sidx; } // minimal — just return as-is

  _processSidx(sidx) {
    const data = Buffer.from(sidx.data);
    if (data.length >= 36) {
      const cur = data.readUInt32BE(32);
      const refType = cur >>> 31;
      const refSize = (cur & 0x7FFFFFFF) - this.totalEncryptionOverhead;
      data.writeUInt32BE((refType << 31) | refSize, 32);
    }
    return new MP4Atom(sidx.type, data.length + 8, data);
  }

  _parseSenc(senc, sampleCount) {
    const data  = senc.data;
    const flags = data.readUInt32BE(0) & 0xFFFFFF;
    let pos = 4;

    const actualCount = data.readUInt32BE(pos); pos += 4;
    const count = actualCount || sampleCount;

    const ivSize = this.defaultIVSize;
    const useConstIV = this.encryptionScheme === 'cbcs' && this.constantIV !== null;
    const samples = [];

    for (let i = 0; i < count; i++) {
      let iv;
      if (useConstIV) {
        iv = this.constantIV;
      } else {
        if (pos + ivSize > data.length) break;
        iv = data.slice(pos, pos + ivSize);
        pos += ivSize;
      }

      const subSamples = [];
      if ((flags & 0x000002) && pos + 2 <= data.length) {
        const subCount = data.readUInt16BE(pos); pos += 2;
        for (let j = 0; j < subCount; j++) {
          if (pos + 6 > data.length) break;
          const clearBytes     = data.readUInt16BE(pos);
          const encryptedBytes = data.readUInt32BE(pos + 2);
          subSamples.push({ clearBytes, encryptedBytes });
          pos += 6;
        }
      }
      samples.push({ iv, subSamples, isEncrypted: true });
    }
    return samples;
  }

  // ── mdat Decryption ────────────────────────────────────────────────────────
  _decryptMdat(mdat) {
    if (this.trackInfos.length > 0) return this._decryptMdatMultiTrack(mdat);

    if (!this.currentKey || !this.currentSampleInfo.length) return mdat;

    const mdatData = mdat.data;
    const result   = [];
    let pos = 0;

    for (let i = 0; i < this.currentSampleInfo.length; i++) {
      if (pos >= mdatData.length) break;
      let sz = this.trunSampleSizes[i] || 0;
      if (sz === 0) sz = this.defaultSampleSize || (mdatData.length - pos);
      const sample    = mdatData.slice(pos, pos + sz);
      result.push(this._decryptSample(sample, this.currentSampleInfo[i], this.currentKey,
        this.cryptByteBlock, this.skipByteBlock, this.constantIV));
      pos += sz;
    }
    const dec = Buffer.concat(result);
    return new MP4Atom(mdat.type, dec.length + 8, dec);
  }

  _decryptMdatMultiTrack(mdat) {
    const mdatData   = mdat.data;
    const sorted     = [...this.trackInfos].sort((a, b) => a.dataOffset - b.dataOffset);
    const firstOff   = sorted[0].dataOffset;
    const result     = Buffer.from(mdatData);

    for (const ti of sorted) {
      if (!ti.key || !ti.sampleInfo.length) continue;
      let pos = ti.dataOffset - firstOff;
      for (let i = 0; i < ti.sampleInfo.length; i++) {
        let sz = ti.sampleSizes[i] || 0;
        if (sz === 0) sz = ti.defaultSampleSize || 0;
        if (sz === 0) continue;
        if (pos + sz > mdatData.length) break;
        const sample    = mdatData.slice(pos, pos + sz);
        const decrypted = this._decryptSample(sample, ti.sampleInfo[i], ti.key,
          ti.cryptByteBlock, ti.skipByteBlock, ti.constantIV);
        decrypted.copy(result, pos);
        pos += sz;
      }
    }
    return new MP4Atom(mdat.type, result.length + 8, result);
  }

  // ── Sample Decryption ──────────────────────────────────────────────────────
  _decryptSample(sample, info, key, cryptByteBlock, skipByteBlock, constantIV) {
    if (!info.isEncrypted || !key) return sample;
    switch (this.encryptionScheme) {
      case 'cbcs': return this._decryptCBCS(sample, info, key, cryptByteBlock, skipByteBlock, constantIV);
      case 'cbc1': return this._decryptCBC1(sample, info, key);
      default:     return this._decryptCENC(sample, info, key); // cenc / cens
    }
  }

  _decryptCENC(sample, info, key) {
    if (!info.isEncrypted) return sample;
    const iv = info.iv;
    if (!info.subSamples.length) return aesCtrDecrypt(key, iv, sample);

    const result = [];
    let pos = 0;
    for (const { clearBytes, encryptedBytes } of info.subSamples) {
      result.push(sample.slice(pos, pos + clearBytes));
      pos += clearBytes;
      result.push(aesCtrDecrypt(key, iv, sample.slice(pos, pos + encryptedBytes)));
      pos += encryptedBytes;
    }
    if (pos < sample.length) result.push(aesCtrDecrypt(key, iv, sample.slice(pos)));
    return Buffer.concat(result);
  }

  _decryptCBC1(sample, info, key) {
    if (!info.isEncrypted) return sample;
    const iv = info.iv;
    if (!info.subSamples.length) return aesCbcDecrypt(key, iv, sample);

    const result = [];
    let pos = 0;
    for (const { clearBytes, encryptedBytes } of info.subSamples) {
      result.push(sample.slice(pos, pos + clearBytes));
      pos += clearBytes;
      result.push(aesCbcDecrypt(key, iv, sample.slice(pos, pos + encryptedBytes)));
      pos += encryptedBytes;
    }
    if (pos < sample.length) result.push(sample.slice(pos));
    return Buffer.concat(result);
  }

  _decryptCBCS(sample, info, key, crypt, skip, constantIV) {
    if (!info.isEncrypted) return sample;
    const iv = constantIV || info.iv;
    if (!info.subSamples.length) return decryptCBCSPattern(sample, key, iv, crypt, skip);

    const result = [];
    let pos = 0;
    for (const { clearBytes, encryptedBytes } of info.subSamples) {
      result.push(sample.slice(pos, pos + clearBytes));
      pos += clearBytes;
      result.push(decryptCBCSPattern(sample.slice(pos, pos + encryptedBytes), key, iv, crypt, skip));
      pos += encryptedBytes;
    }
    if (pos < sample.length) result.push(sample.slice(pos));
    return Buffer.concat(result);
  }

  // ── Key Lookup ─────────────────────────────────────────────────────────────
  _getKeyForTrack(trackId) {
    if (this.extractedKids.has(trackId)) {
      const kid = this.extractedKids.get(trackId);
      if (kid.every(b => b === 0)) {
        if (this.keyMap.size === 1) return [...this.keyMap.values()][0];
      } else {
        for (const [k, v] of this.keyMap) {
          if (k.length === kid.length && kid.equals(k)) return v;
        }
      }
    }
    if (this.keyMap.size === 1) return [...this.keyMap.values()][0];
    const trackBuf = Buffer.allocUnsafe(4);
    trackBuf.writeUInt32BE(trackId, 0);
    for (const [k, v] of this.keyMap) {
      if (k.slice(-4).equals(trackBuf)) return v;
    }
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build key map from hex strings.
 * Accepts comma-separated lists for multi-key DRM.
 */
function buildKeyMap(keyIdHex, keyHex) {
  const kids = (keyIdHex || '').split(',').map(s => s.trim()).filter(Boolean);
  const keys = (keyHex   || '').split(',').map(s => s.trim()).filter(Boolean);
  const map  = new Map();
  for (let i = 0; i < Math.min(kids.length, keys.length); i++) {
    map.set(Buffer.from(kids[i].replace(/-/g,''), 'hex'), Buffer.from(keys[i].replace(/-/g,''), 'hex'));
  }
  return map;
}

/**
 * Decrypt a CENC-encrypted fMP4 segment.
 * @param {Buffer} initSegment  - Initialization segment (moov box)
 * @param {Buffer} segContent   - Media segment (moof+mdat)
 * @param {string} keyId        - Hex key ID (32 chars), comma-separated for multi-key
 * @param {string} key          - Hex key (32 chars), comma-separated for multi-key
 * @param {boolean} includeInit - Whether to include moov/ftyp in output
 * @returns {Buffer}
 */
function decryptSegment(initSegment, segContent, keyId, key, includeInit = true) {
  const keyMap   = buildKeyMap(keyId, key);
  const dec      = new MP4Decrypter(keyMap);
  const combined = Buffer.concat([initSegment, segContent]);
  return dec.decryptSegment(combined, includeInit);
}

/**
 * Process init segment only — strips encryption boxes, keeps moov structure.
 * Use for EXT-X-MAP.
 */
function processInitSegment(initSegment, keyId, key) {
  const keyMap = buildKeyMap(keyId, key);
  const dec    = new MP4Decrypter(keyMap);
  return dec.processInitOnly(initSegment);
}

module.exports = { decryptSegment, processInitSegment, MP4Decrypter, buildKeyMap };
