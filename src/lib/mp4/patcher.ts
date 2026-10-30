/**
 * GhostPatch MP4 engine — container patcher.
 *
 * Rewrites MP4/MOV metadata (media bytes are copied byte-exact, never
 * re-encoded) so TikTok's ingest classifier misreads the file and skips its
 * destructive transcode. Profiles (verified technique, see research/VERDICT.md):
 *
 *  v1-ghost   — the verified "Stealth" recipe (youpzdev/tiktok-prep, confirmed
 *               working Oct 2026): unknown mvhd duration ("0 seconds" symptom),
 *               edts stripped, 9:1 ghost AAC samples in a tail chunk outside
 *               mdat, ©too encoder-JSON tag. btrt boxes PRESERVED.
 *  v2-zero    — minimal glitchfl-style variant: all duration/timescale atoms
 *               zeroed, edts stripped. Fallback when v1 degrades.
 *  v3-inflate — ut0ku-style: video mdhd timescale ×2 (×4 for ≥100fps sources)
 *               so reported fps doubles. No other edits.
 *
 * Original implementation (TypeScript) — the technique was researched from
 * public sources; no code was copied.
 */

import { open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BoxNode, PatchProfileId, VideoMeta } from './types';
import {
  parseBoxes, mutTreeFromParsed, serializeMutTree, makeLeaf, makeBox,
  ccs4, mutIsBox, mutIsLeaf, type MutBox, type MutLeaf, type MutNode,
} from './boxTree';
import { scanTopLevelBoxes, readExact, inspectMoov } from './inspector';

const GHOST_SAMPLE_BYTES = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]); // 8 bytes / ghost
const COPY_CHUNK = 8 * 1024 * 1024;

export interface PatchOptions {
  /** total audio sample multiplier for v1-ghost (10 → 9 ghosts per real sample) */
  ghostMultiplier?: number;
  /** v3-inflate timescale factor (default: fps>=100 ? 4 : 2) */
  inflateFactor?: number;
  /** override the ©too JSON (v1-ghost only) */
  tooJson?: string | null;
}

export interface PatchResult {
  profile: PatchProfileId;
  opsApplied: string[];
  warnings: string[];
  metaBefore: VideoMeta;
  outputBytes: number;
  ghostSamples: number;
}

// ---------------------------------------------------------------------------
// small buffer helpers
// ---------------------------------------------------------------------------

function u32(buf: Buffer, off: number): number { return buf.readUInt32BE(off); }
function w32(buf: Buffer, off: number, v: number): void { buf.writeUInt32BE(v >>> 0, off); }
function u64(buf: Buffer, off: number): number { return Number(buf.readBigUInt64BE(off)); }
function w64(buf: Buffer, off: number, v: number | bigint): void { buf.writeBigUInt64BE(BigInt(v), off); }

// ---------------------------------------------------------------------------
// track model
// ---------------------------------------------------------------------------

interface TrackModel {
  trak: MutBox;
  isVideo: boolean;
  isAudio: boolean;
  tkhd: MutLeaf;
  mdhd: MutLeaf;
  stsd: MutLeaf;
  stsz: MutLeaf;
  stts: MutLeaf;
  stsc: MutLeaf;
  offsetBox: MutLeaf; // stco or co64
  offsetIs64: boolean;
  chunks: number[]; // ORIGINAL chunk offsets (recalc always starts from these)
  sampleCount: number; // original sample count
  descriptionIndex: number; // last stsc entry's sample-description index
  ghost: boolean; // this track received ghost samples
}

function asBox(n: MutNode | undefined, what: string): MutBox {
  if (!n || !mutIsBox(n)) throw new Error(`BAD_TRACK: missing ${what} container`);
  return n;
}
function asLeaf(n: MutNode | undefined, what: string): MutLeaf {
  if (!n || !mutIsLeaf(n)) throw new Error(`BAD_TRACK: ${what} is not a leaf box`);
  return n;
}

/**
 * Build + strictly validate a track (port of the reference `_reference_tables`
 * checks): tables exist and are consistent, chunk offsets point inside mdat.
 * Strict validation guarantees we never silently corrupt a file.
 */
function buildTrack(trak: MutBox, mdatStart: number, mdatEnd: number): TrackModel | null {
  const mdia = asBox(trak.children.find((c) => ccs4(c.type) === 'mdia'), 'mdia');
  const hdlr = asLeaf(mdia.children.find((c) => ccs4(c.type) === 'hdlr'), 'hdlr');
  if (hdlr.raw.length < 12) throw new Error('BAD_TRACK: short hdlr');
  const handler = hdlr.raw.toString('latin1', 8, 12);
  const isVideo = handler === 'vide';
  const isAudio = handler === 'soun';
  if (!isVideo && !isAudio) throw new Error(`UNSUPPORTED_TRACK: handler '${handler}' (use the converter engine)`);

  const tkhd = asLeaf(trak.children.find((c) => ccs4(c.type) === 'tkhd'), 'tkhd');
  const mdhd = asLeaf(mdia.children.find((c) => ccs4(c.type) === 'mdhd'), 'mdhd');
  const minf = asBox(mdia.children.find((c) => ccs4(c.type) === 'minf'), 'minf');
  const stbl = asBox(minf.children.find((c) => ccs4(c.type) === 'stbl'), 'stbl');

  const stsd = asLeaf(stbl.children.find((c) => ccs4(c.type) === 'stsd'), 'stsd');
  const stsz = asLeaf(stbl.children.find((c) => ccs4(c.type) === 'stsz'), 'stsz');
  const stts = asLeaf(stbl.children.find((c) => ccs4(c.type) === 'stts'), 'stts');
  const stsc = asLeaf(stbl.children.find((c) => ccs4(c.type) === 'stsc'), 'stsc');
  const stcoNode = stbl.children.find((c) => ccs4(c.type) === 'stco');
  const co64Node = stbl.children.find((c) => ccs4(c.type) === 'co64');
  if (stcoNode && co64Node) throw new Error('BAD_TRACK: both stco and co64 present');
  const offsetBox = asLeaf(stcoNode ?? co64Node, stcoNode ? 'stco' : 'co64');
  const offsetIs64 = ccs4(offsetBox.type) === 'co64';

  // ---- table consistency (strict) ----
  if (stsd.raw.length < 8) throw new Error('BAD_TRACK: short stsd');
  const entryCount = u32(stsd.raw, 4);

  if (stsz.raw.length < 12) throw new Error('BAD_TRACK: short stsz');
  const fixedSize = u32(stsz.raw, 4);
  const sampleCount = u32(stsz.raw, 8);
  const stszExpected = fixedSize === 0 ? 12 + sampleCount * 4 : 12;
  if (stsz.raw.length !== stszExpected) throw new Error('BAD_TRACK: corrupted stsz table');
  if (fixedSize !== 0 && stsz.raw.length !== 12 && stsz.raw.length !== 12) throw new Error('BAD_TRACK: corrupted stsz table');

  if (stts.raw.length < 8) throw new Error('BAD_TRACK: short stts');
  const sttsCount = u32(stts.raw, 4);
  if (stts.raw.length !== 8 + sttsCount * 8) throw new Error('BAD_TRACK: corrupted stts table');
  let sttsSamples = 0;
  for (let i = 0; i < sttsCount; i++) {
    sttsSamples += u32(stts.raw, 8 + i * 8);
  }
  if (sttsSamples !== sampleCount) throw new Error('BAD_TRACK: stts/stsz sample counts disagree');

  if (stsc.raw.length < 8) throw new Error('BAD_TRACK: short stsc');
  const stscCount = u32(stsc.raw, 4);
  if (stsc.raw.length !== 8 + stscCount * 12) throw new Error('BAD_TRACK: corrupted stsc table');
  const stscEntries: Array<[number, number, number]> = [];
  for (let i = 0; i < stscCount; i++) {
    stscEntries.push([u32(stsc.raw, 8 + i * 12), u32(stsc.raw, 12 + i * 12), u32(stsc.raw, 16 + i * 12)]);
  }

  if (offsetBox.raw.length < 8) throw new Error('BAD_TRACK: short stco');
  const chunkCount = u32(offsetBox.raw, 4);
  const offWidth = offsetIs64 ? 8 : 4;
  if (offsetBox.raw.length !== 8 + chunkCount * offWidth) throw new Error('BAD_TRACK: corrupted stco table');
  const chunks: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push(offsetIs64 ? u64(offsetBox.raw, 8 + i * 8) : u32(offsetBox.raw, 8 + i * 4));
  }

  if (sampleCount > 0) {
    if (chunkCount === 0 || stscEntries.length === 0 || stscEntries[0][0] !== 1) {
      throw new Error('BAD_TRACK: no first-chunk stsc record');
    }
    let prev = 0;
    for (const [first, perChunk, desc] of stscEntries) {
      if (first <= prev || first > chunkCount || perChunk === 0 || desc < 1 || desc > entryCount) {
        throw new Error('BAD_TRACK: corrupted stsc records');
      }
      prev = first;
    }
    // chunk data must lie inside mdat and cover all samples exactly once
    let sampleIndex = 0;
    let mappingIndex = 0;
    for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex++) {
      while (mappingIndex + 1 < stscEntries.length && stscEntries[mappingIndex + 1][0] <= chunkIndex) mappingIndex++;
      const perChunk = stscEntries[mappingIndex][1];
      if (sampleIndex + perChunk > sampleCount) throw new Error('BAD_TRACK: chunks reference missing samples');
      let byteSize = 0;
      if (fixedSize !== 0) byteSize = fixedSize * perChunk;
      else {
        for (let k = 0; k < perChunk; k++) byteSize += u32(stsz.raw, 12 + (sampleIndex + k) * 4);
      }
      const off = chunks[chunkIndex - 1];
      if (off < mdatStart || off + byteSize > mdatEnd) throw new Error('BAD_TRACK: chunk outside mdat bounds');
      sampleIndex += perChunk;
    }
    if (sampleIndex !== sampleCount) throw new Error('BAD_TRACK: not all samples bound to chunks');
  }

  return {
    trak,
    isVideo,
    isAudio,
    tkhd,
    mdhd,
    stsd,
    stsz,
    stts,
    stsc,
    offsetBox,
    offsetIs64,
    chunks,
    sampleCount,
    descriptionIndex: stscEntries.length ? stscEntries[stscEntries.length - 1][2] : 1,
    ghost: false,
  };
}

// ---------------------------------------------------------------------------
// table mutations
// ---------------------------------------------------------------------------

/** Append `n` samples of `size` bytes to stsz (expands constant-size tables). */
function stszAppend(box: MutLeaf, n: number, size: number): void {
  const fixedSize = u32(box.raw, 4);
  const count = u32(box.raw, 8);
  let d = box.raw;
  if (fixedSize !== 0) {
    // constant-size table → expand into an explicit per-sample table
    const table = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) w32(table, i * 4, fixedSize);
    const head = Buffer.alloc(8);
    w32(head, 0, 0);
    w32(head, 4, count);
    d = Buffer.concat([box.raw.subarray(0, 4), head, table]);
  }
  const extra = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) w32(extra, i * 4, size);
  w32(d, 8, count + n);
  box.raw = Buffer.concat([d, extra]);
}

/** Append one (count, delta) run to stts. */
function sttsAppend(box: MutLeaf, count: number, delta: number): void {
  const d = box.raw;
  const n = u32(d, 4);
  const entry = Buffer.alloc(8);
  w32(entry, 0, count);
  w32(entry, 4, delta);
  w32(d, 4, n + 1);
  box.raw = Buffer.concat([d, entry]);
}

/** Append one (firstChunk, samplesPerChunk, descIndex) record to stsc. */
function stscAppend(box: MutLeaf, firstChunk: number, perChunk: number, desc: number): void {
  const d = box.raw;
  const n = u32(d, 4);
  const entry = Buffer.alloc(12);
  w32(entry, 0, firstChunk);
  w32(entry, 4, perChunk);
  w32(entry, 8, desc);
  w32(d, 4, n + 1);
  box.raw = Buffer.concat([d, entry]);
}

/** Rewrite stco/co64 payload with `offsets` (respecting the box's width). */
function writeOffsets(box: MutLeaf, offsets: number[]): void {
  const is64 = ccs4(box.type) === 'co64';
  const head = box.raw.subarray(0, 4); // version + flags
  const body = Buffer.alloc(4 + offsets.length * (is64 ? 8 : 4));
  w32(body, 0, offsets.length);
  offsets.forEach((o, i) => {
    if (is64) w64(body, 4 + i * 8, o);
    else w32(body, 4 + i * 4, o);
  });
  box.raw = Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------
// atom-level profile operations
// ---------------------------------------------------------------------------

/** mvhd → version 1 with duration = unknown (0xFFFF…FF) — the "0 seconds" symptom. */
function setMvhdUnknownDuration(moov: MutBox): string {
  const mvhd = moov.children.find((c) => ccs4(c.type) === 'mvhd');
  const leaf = asLeaf(mvhd, 'mvhd');
  const raw = leaf.raw;
  if (raw[0] === 0) {
    if (raw.length < 100) throw new Error('BAD_MVHD: short v0');
    const created = u32(raw, 4);
    const modified = u32(raw, 8);
    const timescale = u32(raw, 12);
    const nb = Buffer.alloc(112);
    nb[0] = 1; // version 1
    raw.copy(nb, 1, 1, 4); // flags
    w64(nb, 4, created);
    w64(nb, 12, modified);
    w32(nb, 20, timescale);
    nb.fill(0xff, 24, 32); // duration: unknown (all-ones 64-bit)
    raw.copy(nb, 32, 20); // rate/volume/matrix/… unchanged
    leaf.raw = nb;
    return 'mvhd → v1 unknown duration (0-second symptom)';
  }
  if (raw[0] === 1) {
    if (raw.length < 112) throw new Error('BAD_MVHD: short v1');
    raw.fill(0xff, 24, 32);
    return 'mvhd duration → unknown (0-second symptom)';
  }
  throw new Error('BAD_MVHD: unsupported version');
}

/** Zero mvhd duration (keeps version). */
function zeroMvhdDuration(moov: MutBox): string {
  const leaf = asLeaf(moov.children.find((c) => ccs4(c.type) === 'mvhd'), 'mvhd');
  if (leaf.raw[0] === 1) {
    if (leaf.raw.length < 112) throw new Error('BAD_MVHD');
    w64(leaf.raw, 24, 0);
  } else {
    if (leaf.raw.length < 20) throw new Error('BAD_MVHD');
    w32(leaf.raw, 16, 0);
  }
  return 'mvhd duration → 0';
}

/** Zero tkhd duration for one track. */
function zeroTkhdDuration(t: TrackModel): void {
  if (t.tkhd.raw[0] === 1) w64(t.tkhd.raw, 28, 0);
  else w32(t.tkhd.raw, 20, 0);
}

/** Zero mdhd timescale + duration for one track. */
function zeroMdhd(t: TrackModel): void {
  if (t.mdhd.raw[0] === 1) {
    w32(t.mdhd.raw, 20, 0);
    w64(t.mdhd.raw, 24, 0);
  } else {
    w32(t.mdhd.raw, 12, 0);
    w32(t.mdhd.raw, 16, 0);
  }
}

/** Multiply mdhd timescale (v3-inflate). */
function inflateMdhd(t: TrackModel, factor: number): number {
  const off = t.mdhd.raw[0] === 1 ? 20 : 12;
  const ts = u32(t.mdhd.raw, off);
  const next = ts * factor;
  if (next >= 2 ** 32) throw new Error('INFLATE_OVERFLOW: timescale exceeds u32');
  w32(t.mdhd.raw, off, next);
  return next;
}

/** Strip edts boxes from every trak. */
function removeAllEdts(traks: MutBox[]): number {
  let removed = 0;
  for (const trak of traks) {
    const before = trak.children.length;
    trak.children = trak.children.filter((c) => ccs4(c.type) !== 'edts');
    if (trak.children.length !== before) removed++;
  }
  return removed;
}

/** Add ghost AAC samples to an audio track (v1-ghost). */
function addGhostSamples(t: TrackModel, multiplier: number): number {
  if (t.sampleCount === 0) return 0;
  const fake = t.sampleCount * (multiplier - 1);
  if (fake <= 0) return 0;
  if (t.sampleCount + fake >= 2 ** 32) throw new Error('TOO_MANY_SAMPLES');
  stszAppend(t.stsz, fake, GHOST_SAMPLE_BYTES.length);
  sttsAppend(t.stts, fake, 1); // one tick each
  stscAppend(t.stsc, t.chunks.length + 1, fake, t.descriptionIndex);
  writeOffsets(t.offsetBox, [...t.chunks, 0]); // real offset filled by the recalc pass
  t.ghost = true;
  return fake;
}

/**
 * Write the ©too encoder-JSON tag (moov/udta/meta/ilst/©too/data). Rewrites an
 * existing tag in place or builds the whole subtree when absent.
 */
function applyTooTag(moov: MutBox, json: string): string {
  const udtaNode = moov.children.find((c) => ccs4(c.type) === 'udta');
  if (udtaNode && mutIsBox(udtaNode)) {
    const metaNode = udtaNode.children.find((c) => ccs4(c.type) === 'meta');
    if (metaNode && mutIsBox(metaNode)) {
      const ilstNode = metaNode.children.find((c) => ccs4(c.type) === 'ilst');
      if (ilstNode && mutIsBox(ilstNode)) {
        const tooNode = ilstNode.children.find((c) => ccs4(c.type) === '©too');
        if (tooNode && mutIsBox(tooNode)) {
          const dataNode = tooNode.children.find((c) => ccs4(c.type) === 'data');
          if (dataNode && mutIsLeaf(dataNode) && dataNode.raw.length >= 8) {
            dataNode.raw = Buffer.concat([dataNode.raw.subarray(0, 8), Buffer.from(json, 'utf8')]);
            return '©too encoder tag rewritten';
          }
        }
      }
    }
  }
  // Build the ffmpeg-style subtree from scratch.
  const dataLeaf = makeLeaf('data', Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(json, 'utf8')]));
  const tooBox = makeBox('©too', [dataLeaf]);
  const ilstBox = makeBox('ilst', [tooBox]);
  const hdlrPayload = Buffer.concat([Buffer.alloc(4), Buffer.from('mdir', 'latin1'), Buffer.from('appl', 'latin1'), Buffer.alloc(13)]);
  const hdlrLeaf = makeLeaf('hdlr', hdlrPayload);
  const metaBox = makeBox('meta', [hdlrLeaf, ilstBox], Buffer.alloc(4)); // fullbox prefix
  const udtaBox = makeBox('udta', [metaBox]);
  moov.children.push(udtaBox);
  return '©too encoder tag created';
}

/** The ©too JSON, matching the verified reference format (2026-08-29 flavour). */
export function encoderTooJson(bitrateBps: number, maxBitrateBps: number): string {
  const enc = (v: string) => JSON.stringify(v);
  return `{"aid":${enc('0')},"libevc":${enc('0')},"trans_type":${enc('-2')},"bitrate":${enc(String(Math.max(1, Math.round(bitrateBps))))},"maxrate":${enc(String(Math.max(1, Math.round(maxBitrateBps))))},"extra":${enc('{}')}}`;
}

// ---------------------------------------------------------------------------
// output assembly
// ---------------------------------------------------------------------------

interface LayoutEntry {
  box: BoxNode;
  isMoov: boolean;
  stripped: boolean; // empty free/skip before mdat → dropped
}

async function copyRange(inFh: FileHandle, outFh: FileHandle, start: number, size: number): Promise<void> {
  const buf = Buffer.alloc(COPY_CHUNK);
  let pos = start;
  let remaining = size;
  while (remaining > 0) {
    const want = Math.min(COPY_CHUNK, remaining);
    const { bytesRead } = await inFh.read(buf, 0, want, pos);
    if (bytesRead <= 0) throw new Error(`SHORT_READ copying ${start}+${size}`);
    await outFh.write(buf.subarray(0, bytesRead));
    pos += bytesRead;
    remaining -= bytesRead;
  }
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  await fh.write(buf);
}

function ghostTailBuffer(count: number): Buffer {
  const out = Buffer.alloc(count * GHOST_SAMPLE_BYTES.length);
  for (let i = 0; i < count; i++) GHOST_SAMPLE_BYTES.copy(out, i * GHOST_SAMPLE_BYTES.length);
  return out;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

export async function patchFile(
  inputPath: string,
  outputPath: string,
  profile: PatchProfileId,
  opts: PatchOptions = {},
): Promise<PatchResult> {
  const opsApplied: string[] = [];
  const warnings: string[] = [];

  const inFh = await open(inputPath, 'r');
  let outFh: FileHandle | null = null;
  const tmpPath = `${outputPath}.part`;
  try {
    const fileSize = (await inFh.stat()).size;
    if (fileSize < 16) throw new Error('CORRUPT_MP4: file too small');
    const { boxes, ftypBrand } = await scanTopLevelBoxes(inFh, fileSize);

    const moovs = boxes.filter((b) => b.type === 'moov');
    const mdats = boxes.filter((b) => b.type === 'mdat');
    if (moovs.length !== 1 || mdats.length !== 1) {
      throw new Error(`LAYOUT: need exactly one moov and one mdat (found ${moovs.length}/${mdats.length}) — re-encode with the converter engine`);
    }
    const moov = moovs[0];
    const mdat = mdats[0];
    const accounted = boxes.reduce((s, b) => s + b.size, 0);
    if (accounted !== fileSize) {
      throw new Error('LAYOUT: trailing bytes outside boxes — re-encode with the converter engine');
    }
    if (moov.start > mdat.start) {
      throw new Error('NOT_FASTSTART: moov sits after mdat (pipeline must remux first)');
    }
    const mdatDataStart = mdat.dataStart;
    const mdatDataEnd = mdat.dataEnd;

    // Parse + make the moov mutable.
    const moovBuf = await readExact(inFh, moov.start, moov.size);
    const parsedTop = parseBoxes(moovBuf, 0, moovBuf.length, 0);
    const parsedMoov = parsedTop.find((n) => n.type === 'moov');
    if (!parsedMoov) throw new Error('BAD_MOOV: moov could not be parsed');
    const moovMut = mutTreeFromParsed(moovBuf, [parsedMoov])[0];
    if (!moovMut || !mutIsBox(moovMut)) throw new Error('BAD_MOOV: moov is not a container');

    const metaBefore = inspectMoov(moovBuf, moov.start, fileSize, mdat.start, mdat.size, ftypBrand, false);
    if (!metaBefore) throw new Error('BAD_MOOV: tracks could not be parsed');

    // Build + validate tracks.
    const trakNodes = moovMut.children.filter((c): c is MutBox => mutIsBox(c) && ccs4(c.type) === 'trak');
    if (trakNodes.length === 0) throw new Error('BAD_MOOV: no trak boxes');
    const tracks: TrackModel[] = [];
    for (const trak of trakNodes) {
      const t = buildTrack(trak, mdatDataStart, mdatDataEnd);
      if (t) tracks.push(t);
    }
    const videoTracks = tracks.filter((t) => t.isVideo);
    const audioTracks = tracks.filter((t) => t.isAudio);
    if (videoTracks.length !== 1) throw new Error(`LAYOUT: need exactly one video track (found ${videoTracks.length})`);
    if (audioTracks.length > 1) throw new Error('LAYOUT: multiple audio tracks — re-encode with the converter engine');
    const video = videoTracks[0];
    const audio = audioTracks[0] ?? null;

    // ---- profile operations ----
    let ghostSamples = 0;

    if (profile === 'v1-ghost') {
      const rate = metaBefore.video && metaBefore.video.durationSec > 0
        ? (fileSize * 8) / metaBefore.video.durationSec
        : 5_000_000;
      const tooJson = opts.tooJson ?? encoderTooJson(rate, rate * 2);
      opsApplied.push(applyTooTag(moovMut, tooJson));

      const multiplier = opts.ghostMultiplier ?? 10;
      if (audio && multiplier > 1) {
        ghostSamples = addGhostSamples(audio, multiplier);
        if (ghostSamples > 0) {
          opsApplied.push(`audio +${ghostSamples.toLocaleString()} ghost samples (×${multiplier} sample count, one-tick tail chunk)`);
        }
      }
      if (ghostSamples === 0) {
        warnings.push('No usable audio track — ghost-sample step skipped (the mvhd/©too patches still apply). For best results include an audio track or use a re-encode engine.');
      }

      const edts = removeAllEdts(trakNodes);
      opsApplied.push(`edts stripped ×${edts} track(s)`);
      opsApplied.push(setMvhdUnknownDuration(moovMut));
    } else if (profile === 'v2-zero') {
      opsApplied.push(zeroMvhdDuration(moovMut));
      for (const t of tracks) {
        zeroTkhdDuration(t);
        zeroMdhd(t);
      }
      opsApplied.push(`tkhd/mdhd zeroed ×${tracks.length} track(s)`);
      const edts = removeAllEdts(trakNodes);
      opsApplied.push(`edts stripped ×${edts} track(s)`);
    } else if (profile === 'v3-inflate') {
      const factor = opts.inflateFactor ?? (metaBefore.video && metaBefore.video.fps >= 100 ? 4 : 2);
      const newTs = inflateMdhd(video, factor);
      opsApplied.push(`video mdhd timescale ${metaBefore.video ? '' : ''}→ ${newTs} (×${factor}: reported fps doubles)`);
    } else {
      throw new Error(`UNKNOWN_PROFILE: ${profile}`);
    }

    // ---- layout: replace moov, strip empty free/skip before mdat ----
    const layout: LayoutEntry[] = boxes.map((b) => ({
      box: b,
      isMoov: b.type === 'moov',
      stripped: (b.type === 'free' || b.type === 'skip') && b.size === b.headerSize && b.start < mdat.start,
    }));
    const strippedCount = layout.filter((l) => l.stripped).length;
    if (strippedCount > 0) opsApplied.push(`${strippedCount} empty free box(es) stripped`);

    // ---- offset recalculation (iterate: stco→co64 promotion changes sizes) ----
    // Each pass: serialize the CURRENT tree (its length fixes the layout),
    // compute shift + tail offset, then write the final chunk offsets into the
    // tree. A stco→co64 promotion changes the moov size, so we loop until the
    // layout is stable — and ALWAYS re-serialize after the last write, since
    // the offsets are written into the tree AFTER the serialization pass.
    let newMoovBuf: Buffer = Buffer.alloc(0);
    let promoted = true;
    let guard = 0;
    while (promoted) {
      if (++guard > tracks.length + 3) throw new Error('OFFSET_RECALC_FAILED');
      promoted = false;
      newMoovBuf = serializeMutTree([moovMut]);

      let pos = 0;
      let newMdatDataStart = -1;
      for (const l of layout) {
        const sz = l.isMoov ? newMoovBuf.length : l.stripped ? 0 : l.box.size;
        if (l.box.type === 'mdat' && newMdatDataStart < 0) newMdatDataStart = pos + l.box.headerSize;
        pos += sz;
      }
      const tailOffset = pos;
      const shift = newMdatDataStart - mdatDataStart;

      for (const t of tracks) {
        const offsets = t.chunks.map((o) => o + shift);
        if (t.ghost) offsets.push(tailOffset);
        if (!t.offsetIs64 && offsets.some((o) => o >= 2 ** 32)) {
          t.offsetBox.type = Buffer.from('co64', 'latin1');
          t.offsetIs64 = true;
          promoted = true;
        }
        writeOffsets(t.offsetBox, offsets);
      }
    }
    // Final offsets are in the tree but not yet in newMoovBuf — re-serialize.
    // (No promotion happened above, so the moov length — and therefore the
    // shift/tail math — is unchanged.)
    const finalMoovBuf = serializeMutTree([moovMut]);
    if (finalMoovBuf.length !== newMoovBuf.length) throw new Error('OFFSET_RECALC_FAILED: moov size changed on final pass');
    newMoovBuf = finalMoovBuf;
    opsApplied.push('chunk offsets recalculated (stco/co64)');

    // ---- write the output ----
    try { await unlink(tmpPath); } catch { /* not there */ }
    outFh = await open(tmpPath, 'w');
    for (const l of layout) {
      if (l.stripped) continue;
      if (l.isMoov) await writeAll(outFh, newMoovBuf);
      else await copyRange(inFh, outFh, l.box.start, l.box.size);
    }
    if (ghostSamples > 0) {
      await writeAll(outFh, ghostTailBuffer(ghostSamples));
      opsApplied.push(`ghost tail chunk appended (${ghostSamples * GHOST_SAMPLE_BYTES.length} bytes)`);
    }
    await outFh.close();
    outFh = null;

    const statFh = await open(tmpPath, 'r');
    let outputBytes = 0;
    try {
      outputBytes = (await statFh.stat()).size;
    } finally {
      await statFh.close();
    }
    await rename(tmpPath, outputPath);

    return {
      profile,
      opsApplied,
      warnings,
      metaBefore,
      outputBytes,
      ghostSamples,
    };
  } finally {
    if (outFh) await outFh.close().catch(() => {});
    await inFh.close().catch(() => {});
  }
}
