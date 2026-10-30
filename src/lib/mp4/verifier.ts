/**
 * GhostPatch MP4 engine — post-patch symptom verification.
 *
 * A correct patch has EXPECTED symptoms (that's the whole trick): the duration
 * reads 0 / N/A / shifted, the reported fps may double (v3), the audio sample
 * count inflates ~10× (v1) — while every video frame still decodes and the
 * resolution/codec stay identical. This module proves both halves.
 */

import { stat } from 'node:fs/promises';
import type { PatchProfileId, VerifyReport, VideoMeta } from './types';
import { ffprobeJson, countVideoFrames } from './ffmpeg';

function parseFps(v: unknown): number {
  if (typeof v !== 'string' || !v.includes('/')) return Number.isFinite(Number(v)) ? Number(v) : 0;
  const [num, den] = v.split('/').map((s) => Number(s));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

export async function verifyPatched(
  originalMeta: VideoMeta,
  patchedPath: string,
  profile: PatchProfileId,
  originalSizeBytes: number,
): Promise<VerifyReport> {
  const checks: VerifyReport['checks'] = [];
  const origV = originalMeta.video;
  const origA = originalMeta.audio;

  const fj = await ffprobeJson(patchedPath);
  const fmtDurRaw = fj?.format?.duration;
  const fmtDur = typeof fmtDurRaw === 'string' ? parseFloat(fmtDurRaw) : NaN;
  const vStream = (fj?.streams ?? []).find((s: any) => s.codec_type === 'video');
  const aStream = (fj?.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const vDur = vStream && typeof vStream.duration === 'string' ? parseFloat(vStream.duration) : NaN;
  const origDur = origV?.durationSec ?? 0;

  // 1) duration shifted / zeroed / unknown (required for v2; informational for v1)
  const durShifted =
    Number.isNaN(fmtDur) ||
    fmtDur === 0 ||
    (origDur > 0 && Math.abs(fmtDur - origDur) / origDur > 0.05) ||
    (origDur > 0 && !Number.isNaN(vDur) && Math.abs(vDur - origDur) / origDur > 0.05);
  const durRequired = profile !== 'v1-ghost';
  checks.push({
    name: durRequired ? 'duration-shifted' : 'duration-shifted (info)',
    pass: durRequired ? durShifted : true,
    detail: `container duration: ${Number.isNaN(fmtDur) ? 'N/A' : `${fmtDur.toFixed(2)}s`} (source ${origDur.toFixed(2)}s)${durRequired ? ' — 0/N/A/shifted is the intended symptom' : ' — the v1 patch hides duration from players (mvhd unknown), ffprobe falls back to track durations'}`,
  });

  // 2) reported fps moved (required for v3 — it doubles; informational otherwise)
  const fps = parseFps(vStream?.avg_frame_rate) || parseFps(vStream?.r_frame_rate);
  const origFps = origV?.fps ?? 0;
  const fpsShifted = origFps > 0 && fps > 0 && (fps > origFps * 1.5 || fps < origFps * 0.66);
  const fpsRequired = profile === 'v3-inflate';
  checks.push({
    name: fpsRequired ? 'fps-signal-shifted' : 'fps-signal-shifted (info)',
    pass: fpsRequired ? fpsShifted : true,
    detail: `reported fps: ${fps ? fps.toFixed(2) : 'garbage'} vs source ${origFps.toFixed(2)}${profile === 'v3-inflate' ? ' (inflated by design)' : ' — v1/v2 leave video timing intact by design'}`,
  });

  // 3) every original video frame still decodes
  const frames = await countVideoFrames(patchedPath);
  const framesOk = origV ? frames >= 0 && Math.abs(frames - origV.frameCount) <= 2 : false;
  checks.push({
    name: 'frames-preserved',
    pass: framesOk,
    detail: `decoded ${frames} video frames vs ${origV?.frameCount ?? '?'} in the source (must match ±2)`,
  });

  // 4) resolution + codec untouched
  const expectedCodec = origV?.codec === 'hevc' ? 'hevc' : 'h264';
  const streamOk = !!vStream && !!origV &&
    vStream.codec_name === expectedCodec &&
    Number(vStream.width) === origV.width &&
    Number(vStream.height) === origV.height;
  checks.push({
    name: 'stream-unchanged',
    pass: streamOk,
    detail: vStream
      ? `${vStream.codec_name} ${vStream.width}×${vStream.height} (source ${expectedCodec} ${origV?.width}×${origV?.height})`
      : 'no video stream found in patched file',
  });

  // 5) size sanity (patch adds a small tail; never re-encodes)
  const outSize = (await stat(patchedPath)).size;
  const sizeOk = originalSizeBytes > 0 && outSize >= originalSizeBytes * 0.85 && outSize <= originalSizeBytes * 1.5;
  checks.push({
    name: 'size-sane',
    pass: sizeOk,
    detail: `${(outSize / 1024 / 1024).toFixed(2)} MB out vs ${(originalSizeBytes / 1024 / 1024).toFixed(2)} MB in (patch-only delta expected)`,
  });

  // 6) audio sample inflation (v1-ghost: ~10× sample count signal)
  let audioInflated = false;
  if (profile === 'v1-ghost' && origA) {
    const nb = parseInt(String(aStream?.nb_frames ?? ''), 10);
    audioInflated = Number.isFinite(nb) && nb >= origA.sampleCount * 5;
    checks.push({
      name: 'audio-samples-inflated',
      pass: audioInflated,
      detail: `audio reports ${Number.isFinite(nb) ? nb.toLocaleString() : '?'} samples vs ${origA.sampleCount.toLocaleString()} real (≈10× is the ghost fingerprint)`,
    });
  }

  const pass =
    checks.find((c) => c.name === 'frames-preserved')!.pass &&
    checks.find((c) => c.name === 'stream-unchanged')!.pass &&
    checks.find((c) => c.name === 'size-sane')!.pass &&
    (durShifted || fpsShifted || audioInflated);

  return { pass, checks };
}
