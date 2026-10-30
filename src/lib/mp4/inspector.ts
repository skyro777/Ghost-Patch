/**
 * GhostPatch MP4 engine — container inspection.
 *
 * Read-only: extracts VideoMeta from the moov (codec, dimensions, fps from
 * the sample tables — NOT from any player), plus faststart detection. All
 * functions are memory-safe for 500 MB files: only box headers and the moov
 * range are ever read.
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BoxNode, TrackInfo, VideoMeta } from './types';
import { parseBoxes } from './boxTree';

const UNKNOWN = -1;

function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}
function readU64(buf: Buffer, off: number): number {
  return Number(buf.readBigUInt64BE(off));
}

/** Bytes of `node`'s payload, assuming `buf` begins at absolute offset `base`. */
function payloadOf(buf: Buffer, base: number, node: BoxNode): Buffer {
  return buf.subarray(node.dataStart - base, node.dataEnd - base);
}

function codecToFamily(fourcc: string): 'h264' | 'hevc' | 'other' {
  if (fourcc === 'avc1' || fourcc === 'avc3' || fourcc === 'avcp' || fourcc === 'davc') return 'h264';
  if (fourcc === 'hvc1' || fourcc === 'hev1' || fourcc === 'dvhe' || fourcc === 'dvh1') return 'hevc';
  return 'other';
}

interface StsdEntry {
  type: string;
  offset: number; // offset of the entry (box header) within the stsd payload
  size: number;
}

/** Walk the sample-description entries of an stsd payload buffer. */
function stsdEntries(payload: Buffer): StsdEntry[] {
  const out: StsdEntry[] = [];
  if (payload.length < 8) return out;
  const count = readU32(payload, 4);
  let pos = 8;
  for (let i = 0; i < count && pos + 8 <= payload.length; i++) {
    const size = readU32(payload, pos);
    const type = payload.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > payload.length) break;
    out.push({ type, offset: pos, size });
    pos += size;
  }
  return out;
}

/** Does the given stsd entry carry a direct child box of `childType`? */
function entryHasChild(payload: Buffer, entry: StsdEntry, headerLen: number, childType: string): boolean {
  let pos = entry.offset + headerLen;
  const end = entry.offset + entry.size;
  while (pos + 8 <= end) {
    const size = readU32(payload, pos);
    const type = payload.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > end) break;
    if (type === childType) return true;
    pos += size;
  }
  return false;
}

/** Visual/AudioSampleEntry constants (offsets from ENTRY start, incl. header). */
const VISUAL_ENTRY_HEADER = 86; // width u16 @+32, height u16 @+34 (ISO 14496-12 §12.1.3)
const AUDIO_ENTRY_HEADER = 36; // channels u16 @+24, samplerate 16.16 @+32

function parseMdhd(payload: Buffer): { timescale: number; duration: number } {
  if (payload.length < 20) return { timescale: 0, duration: 0 };
  const version = payload[0];
  if (version === 1) {
    if (payload.length < 32) return { timescale: 0, duration: 0 };
    return { timescale: readU32(payload, 20), duration: readU64(payload, 24) };
  }
  return { timescale: readU32(payload, 12), duration: readU32(payload, 16) };
}

/** Full per-track details (TrackInfo + the extra numbers VideoMeta needs). */
interface TrackDetails extends TrackInfo {
  fps: number; // mdhd timescale / average stts delta (0 when unknown)
  frameCount: number; // sum of stts counts
  sampleRate: number; // audio only (mp4a entry)
  channels: number; // audio only
}

/** Build TrackDetails for one trak (null when the track is unrecognizable). */
function inspectTrack(buf: Buffer, base: number, trak: BoxNode): TrackDetails | null {
  const children = trak.children ?? [];
  const mdia = children.find((c) => c.type === 'mdia');
  if (!mdia || !mdia.children) return null;
  const mdhd = mdia.children.find((c) => c.type === 'mdhd');
  const hdlr = mdia.children.find((c) => c.type === 'hdlr');
  if (!mdhd || !hdlr) return null;

  const hdlrPayload = payloadOf(buf, base, hdlr);
  const handler = hdlrPayload.length >= 12 ? hdlrPayload.toString('latin1', 8, 12) : '';
  const isVideo = handler === 'vide';
  const isAudio = handler === 'soun';
  if (!isVideo && !isAudio) return null;

  const { timescale, duration } = parseMdhd(payloadOf(buf, base, mdhd));

  let stsd: BoxNode | null = null;
  let stts: BoxNode | null = null;
  let stsz: BoxNode | null = null;
  const minf = (mdia.children ?? []).find((c) => c.type === 'minf');
  const stbl = minf?.children?.find((c) => c.type === 'stbl');
  if (stbl?.children) {
    for (const c of stbl.children) {
      if (c.type === 'stsd' && !stsd) stsd = c;
      else if (c.type === 'stts' && !stts) stts = c;
      else if (c.type === 'stsz' && !stsz) stsz = c;
    }
  }

  const details: TrackDetails = {
    isVideo,
    isAudio,
    codec: '',
    timescale,
    duration,
    sampleCount: 0,
    hasEdts: children.some((c) => c.type === 'edts'),
    hasBtrt: false,
    fps: 0,
    frameCount: 0,
    sampleRate: 0,
    channels: 0,
  };

  if (stsz) {
    const p = payloadOf(buf, base, stsz);
    if (p.length >= 12) details.sampleCount = readU32(p, 8);
  }

  if (stts) {
    const p = payloadOf(buf, base, stts);
    const n = p.length >= 8 ? readU32(p, 4) : 0;
    let ticks = 0;
    let frames = 0;
    for (let i = 0; i < n; i++) {
      const off = 8 + i * 8;
      if (off + 8 > p.length) break;
      const count = readU32(p, off);
      const delta = readU32(p, off + 4);
      ticks += count * delta;
      frames += count;
    }
    details.frameCount = frames;
    if (frames > 0 && ticks > 0) details.fps = timescale / (ticks / frames);
  }

  if (stsd) {
    const p = payloadOf(buf, base, stsd);
    const first = stsdEntries(p)[0];
    if (first) {
      details.codec = first.type;
      if (isVideo) {
        if (first.offset + 36 <= p.length) {
          details.width = p.readUInt16BE(first.offset + 32);
          details.height = p.readUInt16BE(first.offset + 34);
        }
        details.hasBtrt = entryHasChild(p, first, VISUAL_ENTRY_HEADER, 'btrt');
      } else {
        if (first.offset + 36 <= p.length) {
          details.channels = p.readUInt16BE(first.offset + 24);
          details.sampleRate = readU32(p, first.offset + 32) >>> 16; // 16.16 fixed
        }
        details.hasBtrt = entryHasChild(p, first, AUDIO_ENTRY_HEADER, 'btrt');
      }
    }
  }

  return details;
}

/**
 * Parse a full moov box buffer (INCLUDING its 8-byte header) that lives at
 * absolute file offset `moovAbsOffset`. Returns VideoMeta or null when the
 * moov is malformed / has no recognizable tracks.
 */
export function inspectMoov(
  moovBuf: Buffer,
  moovAbsOffset: number,
  fileSize: number,
  mdatOffset: number,
  mdatSize: number,
  ftypBrand: string,
  fragmented = false,
): VideoMeta | null {
  const tree = parseBoxes(moovBuf, 0, moovBuf.length, moovAbsOffset);
  const moov = tree.find((n) => n.type === 'moov' && n.children);
  if (!moov) return null;

  const mvhd = (moov.children ?? []).find((c) => c.type === 'mvhd');
  if (!mvhd) return null;
  const mvhdPayload = payloadOf(moovBuf, moovAbsOffset, mvhd);
  const mvVersion = mvhdPayload.length >= 4 ? mvhdPayload[0] : 0;
  let movieTimescale = 0;
  let movieDuration = 0;
  if (mvVersion === 1 && mvhdPayload.length >= 32) {
    movieTimescale = readU32(mvhdPayload, 20);
    movieDuration = readU64(mvhdPayload, 24);
  } else if (mvhdPayload.length >= 20) {
    movieTimescale = readU32(mvhdPayload, 12);
    movieDuration = readU32(mvhdPayload, 16);
  }
  const movieDurationSec = movieTimescale > 0 ? movieDuration / movieTimescale : 0;

  const traks = (moov.children ?? []).filter((c) => c.type === 'trak');
  let video: TrackDetails | null = null;
  let audio: TrackDetails | null = null;
  for (const trak of traks) {
    const info = inspectTrack(moovBuf, moovAbsOffset, trak);
    if (!info) continue;
    if (info.isVideo && !video) video = info;
    else if (info.isAudio && !audio) audio = info;
  }
  if (!video && !audio) return null;

  let videoMeta: VideoMeta['video'] = null;
  if (video) {
    const durationSec = video.timescale > 0 ? video.duration / video.timescale : 0;
    videoMeta = {
      codec: codecToFamily(video.codec),
      width: video.width ?? 0,
      height: video.height ?? 0,
      fps: Math.round(video.fps * 100) / 100,
      frameCount: video.frameCount || video.sampleCount,
      durationSec: durationSec > 0 ? durationSec : movieDurationSec,
      bitrateBps: durationSec > 0 ? Math.round((fileSize * 8) / durationSec) : 0,
    };
  }

  const faststart = mdatOffset === UNKNOWN ? true : moovAbsOffset < mdatOffset;
  const moovAtEnd = mdatOffset !== UNKNOWN && mdatOffset < moovAbsOffset;

  return {
    container: ftypBrand.startsWith('qt') ? 'mov' : 'mp4',
    faststart,
    moovAtEnd,
    fragmented,
    moovOffset: moovAbsOffset,
    moovSize: moov.size,
    mdatOffset,
    mdatSize,
    video: videoMeta,
    audio: audio
      ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, sampleCount: audio.sampleCount }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Slice-based pre-flight scan (used before/during chunked uploads).
// ---------------------------------------------------------------------------

export interface SliceScanResult {
  meta: VideoMeta | null;
  moovBuf: Buffer | null;
  moovAbsOffset: number; // -1 when not located
}

/**
 * Try to build VideoMeta from a head slice + tail slice of a file (e.g. 4 MB
 * each). Handles faststart files (moov in head) and moov-at-end files (moov
 * in tail, located deterministically via the mdat end offset read from the
 * head slice — never by scanning mdat bytes for box names).
 */
export function inspectSlices(head: Buffer, tail: Buffer, fileSize: number): SliceScanResult {
  const empty: SliceScanResult = { meta: null, moovBuf: null, moovAbsOffset: UNKNOWN };
  if (head.length < 8 || fileSize <= 0) return empty;

  const headTree = parseBoxes(head, 0, head.length, 0);
  const ftyp = headTree.find((n) => n.type === 'ftyp');
  const brand = ftyp && ftyp.dataStart + 4 <= head.length
    ? head.toString('latin1', ftyp.dataStart, ftyp.dataStart + 4)
    : '';

  const mdatNode = headTree.find((n) => n.type === 'mdat');
  let mdatOffset = UNKNOWN;
  let mdatSize = UNKNOWN;
  if (mdatNode) {
    mdatOffset = mdatNode.start;
    // Declared sizes that spill past the slice are still authoritative (we
    // read them from the box header); a size==0 mdat really runs to EOF.
    if (mdatNode.zeroSize) {
      mdatSize = fileSize - mdatOffset;
    } else {
      mdatSize = mdatNode.size;
      if (mdatOffset + mdatSize > fileSize) mdatSize = UNKNOWN;
    }
  }

  // Fragmented MP4 (moof/traf): faststart fMP4 keeps its first moof right after
  // moov, so the head slice reveals it. (inspectFile re-checks authoritatively.)
  const fragmented = headTree.some((n) => n.type === 'moof');

  // 1) moov fully contained in the head slice (faststart layout).
  const moovHead = headTree.find((n) => n.type === 'moov' && n.dataEnd <= head.length && n.children);
  if (moovHead) {
    const moovBuf = head.subarray(moovHead.start, moovHead.dataEnd);
    const meta = inspectMoov(moovBuf, moovHead.start, fileSize, mdatOffset, mdatSize, brand, fragmented);
    return { meta, moovBuf: meta ? moovBuf : null, moovAbsOffset: meta ? moovHead.start : UNKNOWN };
  }

  // 2) moov at end of file: locate it in the tail slice, walking from the
  //    deterministic boundary where the first mdat ends.
  if (mdatOffset === UNKNOWN || mdatSize <= 0) return empty;
  const mdatEnd = mdatOffset + mdatSize;
  if (mdatEnd > fileSize) return empty;
  const tailStart = fileSize - tail.length;
  if (mdatEnd < tailStart) return empty; // hidden boxes we cannot see
  const localStart = mdatEnd - tailStart;

  const tailTree = parseBoxes(tail, localStart, tail.length, tailStart);
  const moovTail = tailTree.find((n) => n.type === 'moov' && n.children);
  if (!moovTail) return empty;
  const moovBuf = tail.subarray(moovTail.start - tailStart, moovTail.dataEnd - tailStart);
  const meta = inspectMoov(moovBuf, moovTail.start, fileSize, mdatOffset, mdatSize, brand, fragmented);
  return { meta, moovBuf: meta ? moovBuf : null, moovAbsOffset: meta ? moovTail.start : UNKNOWN };
}

// ---------------------------------------------------------------------------
// File-based inspection (bounded reads; never loads the whole file).
// ---------------------------------------------------------------------------

export async function readExact(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead <= 0) break;
    got += bytesRead;
  }
  if (got !== length) throw new Error(`SHORT_READ at ${position} (${got}/${length})`);
  return buf;
}

export interface TopLevelScan {
  boxes: BoxNode[];
  ftypBrand: string;
  fileSize: number;
}

/**
 * Walk top-level boxes of a file by reading only 16-byte headers via seek.
 * size==0 resolves to "extends to EOF". Throws CORRUPT_MP4 on junk.
 */
export async function scanTopLevelBoxes(fh: FileHandle, fileSize: number): Promise<TopLevelScan> {
  const boxes: BoxNode[] = [];
  let ftypBrand = '';
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const header = await readExact(fh, pos, Math.min(16, fileSize - pos));
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      size = readU64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < headerSize || pos + size > fileSize) {
      // Trailing junk after the last real box (e.g. our own ghost-sample tail):
      // stop walking instead of throwing so inspection still works. Strict
      // whole-file accounting is enforced by the patcher on its INPUT.
      break;
    }
    if (type === 'ftyp' && !ftypBrand && size >= 12) {
      ftypBrand = header.toString('latin1', 8, 12);
    }
    boxes.push({
      type,
      start: pos,
      size,
      headerSize,
      dataStart: pos + headerSize,
      dataEnd: pos + size,
    });
    pos += size;
  }
  return { boxes, ftypBrand, fileSize };
}

/**
 * Inspect a local MP4/MOV file. Reads ONLY the ftyp + box headers + the moov
 * range — safe for 500 MB inputs. Throws NO_MOOV / CORRUPT_MP4 / BAD_MOOV.
 */
export async function inspectFile(filePath: string): Promise<VideoMeta> {
  const fh = await open(filePath, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize < 8) throw new Error('CORRUPT_MP4: file too small');
    const { boxes, ftypBrand } = await scanTopLevelBoxes(fh, fileSize);
    const moov = boxes.find((b) => b.type === 'moov');
    if (!moov) throw new Error('NO_MOOV: no moov box found');
    const mdat = boxes.find((b) => b.type === 'mdat');
    const moovBuf = await readExact(fh, moov.start, moov.size);
    const fragmented = boxes.some((b) => b.type === 'moof');
    const meta = inspectMoov(
      moovBuf,
      moov.start,
      fileSize,
      mdat ? mdat.start : UNKNOWN,
      mdat ? mdat.size : UNKNOWN,
      ftypBrand,
      fragmented,
    );
    if (!meta) throw new Error('BAD_MOOV: moov could not be parsed');
    return meta;
  } finally {
    await fh.close();
  }
}
