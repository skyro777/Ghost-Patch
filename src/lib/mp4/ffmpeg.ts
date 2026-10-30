/**
 * GhostPatch MP4 engine — ffmpeg/ffprobe wrappers + encode engine modes.
 *
 * ffmpeg 7.1.5 is available in this sandbox at /usr/bin/ffmpeg. All spawns use
 * child_process with argument arrays (no shell), so filenames are safe.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as FS } from 'node:fs';
import { access } from 'node:fs/promises';
import type { VideoMeta } from './types';
import { inspectFile } from './inspector';

const FFMPEG_BIN = process.env.GHOSTPATCH_FFMPEG ?? (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
const FFPROBE_BIN = process.env.GHOSTPATCH_FFPROBE ?? (existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : 'ffprobe');

function run(bin: string, args: string[], onLine?: (line: string) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err.push(d);
      if (onLine) {
        const text = d.toString('utf8');
        for (const line of text.split(/[\r\n]+/)) {
          const t = line.trim();
          if (t) onLine(t);
        }
      }
    });
    child.on('error', (e) => reject(new Error(`FFMPEG_SPAWN_FAILED: ${e.message}`)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.split('\n').slice(-8).join('\n').trim();
        reject(new Error(`FFMPEG_EXIT_${code}: ${tail || 'no stderr'}`));
      }
    });
  });
}

/** ffprobe JSON (format + streams). Throws FFMPEG_* on failure. */
export async function ffprobeJson(path: string): Promise<any> {
  const { stdout } = await run(FFPROBE_BIN, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('FFPROBE_BAD_JSON');
  }
}

/** Exact decoded video frame count (ffprobe -count_frames). */
export async function countVideoFrames(path: string): Promise<number> {
  const { stdout } = await run(FFPROBE_BIN, [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-print_format', 'json', '-show_entries', 'stream=nb_read_frames', path,
  ]);
  try {
    const j = JSON.parse(stdout);
    const n = parseInt(String(j?.streams?.[0]?.nb_read_frames ?? ''), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** Run an arbitrary ffmpeg command; `onLine` receives stderr progress lines. */
export async function runFfmpeg(args: string[], onLine?: (line: string) => void): Promise<void> {
  await run(FFMPEG_BIN, ['-hide_banner', '-y', ...args], onLine);
}

/**
 * Losslessly remux to faststart (moov before mdat) when needed.
 * Returns true when a remux happened (output written), false when the input
 * was already faststart and non-fragmented (nothing written).
 */
export async function ensureFaststart(input: string, output: string, onLine?: (line: string) => void): Promise<boolean> {
  const meta = await inspectFile(input);
  if (meta.faststart && !meta.fragmented) return false;
  await runFfmpeg(['-i', input, '-c', 'copy', '-movflags', '+faststart', output], onLine);
  return true;
}

export type EncodeMode = 'convert' | '1080' | '4k';

/**
 * Re-encode to a TikTok-friendly H.264 MP4 (also the path for HEVC/MKV/WebM
 * sources and fragmented files — ffmpeg normalizes everything):
 *  - convert: keep resolution, H.264 High CRF16 (for HEVC/odd sources)
 *  - 1080  : cap 1920×1080-class (portrait 1080×1920), Main L5.2, ABR from source
 *  - 4k    : cap 3840×2160-class, Main L6.0, slow preset, CRF14 240M ceiling
 * Never upscales, never raises fps. Output is faststart.
 */
export async function encodeH264(
  input: string,
  output: string,
  mode: EncodeMode,
  meta: VideoMeta | null,
  onLine?: (line: string) => void,
): Promise<void> {
  const args: string[] = ['-i', input, '-map', '0:v:0', '-map', '0:a?'];

  const w = meta?.video?.width ?? 0;
  const h = meta?.video?.height ?? 0;
  let scaleFilter: string | null = null;
  if (mode !== 'convert' && w > 0 && h > 0) {
    const capLong = mode === '4k' ? 3840 : 1920;
    const capShort = mode === '4k' ? 2160 : 1080;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    if (long > capLong || short > capShort) {
      const [bw, bh] = w >= h ? [capLong, capShort] : [capShort, capLong];
      scaleFilter = `scale=${bw}:${bh}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    }
  }
  if (scaleFilter) args.push('-vf', scaleFilter);

  if (mode === 'convert') {
    args.push('-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '16');
  } else if (mode === '1080') {
    const fps = meta?.video?.fps ?? 60;
    const dur = meta?.video?.durationSec ?? 0;
    const bitrate = meta?.video?.bitrateBps ?? 0;
    let target = 8_000_000;
    if (dur > 0 && bitrate > 0) {
      target = bitrate;
      if (scaleFilter && w > 0 && h > 0) {
        const [bw, bh] = w >= h ? [1920, 1080] : [1080, 1920];
        const outPixels = (Math.min(bw, w) * Math.min(bh, h));
        target = (bitrate * outPixels) / (w * h);
      }
      target = Math.min(40_000_000, Math.max(4_000_000, target));
    }
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    args.push(
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '5.2', '-preset', 'medium',
      '-refs', '1', '-bf', '3',
      '-g', String(Math.max(24, Math.round(2 * fps))),
      '-keyint_min', String(Math.max(12, Math.round(fps))),
      '-b:v', k(target), '-maxrate', k(target * 2), '-bufsize', k(target * 3),
    );
  } else {
    args.push('-c:v', 'libx264', '-profile:v', 'main', '-level', '6.0', '-preset', 'slow', '-refs', '4', '-crf', '14', '-maxrate', '240M', '-bufsize', '240M');
  }

  args.push('-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', mode === '4k' ? '320k' : '192k', '-ar', '48000');
  args.push('-movflags', '+faststart', output);

  await runFfmpeg(args, onLine);
}

/** Cheap existence probe used by the pipeline before spawning. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Losslessly add a silent AAC track to a video-only file (video stream is
 * stream-copied, never re-encoded). The v1-ghost fingerprint needs an audio
 * track to carry its ghost samples, so silent-audio makes it work on any file.
 */
export async function addSilentAudio(
  input: string,
  output: string,
  onLine?: (line: string) => void,
): Promise<void> {
  await runFfmpeg(
    [
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-i', input,
      '-map', '1:v:0', '-map', '0:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k',
      '-shortest', '-movflags', '+faststart',
      output,
    ],
    onLine,
  );
}
