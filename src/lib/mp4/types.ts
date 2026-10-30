/**
 * GhostPatch MP4 engine — shared types.
 *
 * This library patches ISOBMFF/MP4 container metadata (never media bytes) so
 * that TikTok's ingest classifier mistakes the file for one it already
 * transcoded. Technique researched from public sources (youpzdev/tiktok-prep,
 * bitonito, glitchfl, ut0ku); this implementation is original TypeScript.
 */

/** A parsed ISOBMFF box. All offsets are ABSOLUTE file offsets. */
export interface BoxNode {
  type: string; // 4cc, decoded latin1 (may contain '\xA9too' style tags)
  start: number; // absolute offset of the box header (size field)
  size: number; // total box size including header (effective size: size==0 resolved to region end)
  headerSize: number; // 8, or 16 when a 64-bit largesize header was used
  dataStart: number; // absolute offset of the payload (start + headerSize)
  dataEnd: number; // absolute offset one past the payload (start + size)
  children?: BoxNode[]; // present only for container boxes we recurse into
  zeroSize?: boolean; // size field was 0 (box extends to end of region/file)
}

/** Per-track info extracted from a trak box. */
export interface TrackInfo {
  isVideo: boolean;
  isAudio: boolean;
  codec: string; // stsd entry 4cc: avc1/avc3/hev1/hvc1/mp4a...
  timescale: number; // mdhd timescale
  duration: number; // mdhd duration (ticks)
  sampleCount: number; // stsz sample count
  width?: number;
  height?: number;
  hasEdts: boolean;
  hasBtrt: boolean; // stsd first entry carries a btrt (bitrate hint) child
}

/** High-level container metadata used for pre-flight scans and verification. */
export interface VideoMeta {
  container: string; // 'mp4' | 'mov' (derived from ftyp major brand)
  faststart: boolean; // moov sits before the first mdat
  moovAtEnd: boolean; // mdat sits before moov (needs remux before patching)
  fragmented: boolean; // fMP4 (moof/traf) — needs a lossless remux before patching
  moovOffset: number;
  moovSize: number;
  mdatOffset: number; // -1 when unknown
  mdatSize: number; // -1 when unknown
  video: {
    codec: 'h264' | 'hevc' | 'other';
    width: number;
    height: number;
    fps: number;
    frameCount: number;
    durationSec: number; // video track mdhd duration / timescale
    bitrateBps: number; // fileSize * 8 / durationSec
  } | null;
  audio: {
    codec: string; // stsd 4cc (mp4a...)
    sampleRate: number;
    channels: number;
    sampleCount: number;
  } | null;
}

/** One verification check result. */
export interface PatchCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** Post-patch symptom verification report. */
export interface VerifyReport {
  pass: boolean;
  checks: PatchCheck[];
}

/** Engine patch profile (versioned — arms-race fallbacks). */
export type PatchProfileId = 'v1-ghost' | 'v2-zero' | 'v3-inflate';
