/**
 * GhostPatch — processing pipeline.
 *
 * Flow per engine mode:
 *   ghost / zero / inflate : [lossless faststart remux if needed] → patch
 *   convert-h264           : ffmpeg H.264 convert → [silent audio] → patch
 *   encode-1080 / encode-4k: ffmpeg normalize → [silent audio] → patch
 * All modes finish with a v1/v2/v3 container patch + symptom verification.
 * The video stream is NEVER re-encoded in patch-only modes (bit-exact copy).
 */

import { stat, rename } from 'node:fs/promises';
import { db } from '@/lib/db';
import {
  inspectFile, patchFile, verifyPatched, ensureFaststart, encodeH264, addSilentAudio,
  type PatchProfileId,
} from '@/lib/mp4';
import { progressGet, progressInit, progressLog, progressSet, withSlot } from '@/lib/jobState';
import { incomingPath, inputPath, workPath, outputPath } from '@/lib/uploads';

export const ENGINE_MODES = ['ghost', 'zero', 'inflate', 'convert-h264', 'encode-1080', 'encode-4k'] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];

const PROFILE_BY_MODE: Record<EngineMode, PatchProfileId> = {
  ghost: 'v1-ghost',
  zero: 'v2-zero',
  inflate: 'v3-inflate',
  'convert-h264': 'v1-ghost',
  'encode-1080': 'v1-ghost',
  'encode-4k': 'v1-ghost',
};

function humanizeError(raw: string): string {
  const m = raw.match(/^([A-Z0-9_]+):\s*(.*)$/);
  const code = m ? m[1] : '';
  const rest = m ? m[2] : raw;
  switch (code) {
    case 'CORRUPT_MP4':
    case 'BAD_MOOV':
    case 'NO_MOOV':
      return `This file's MP4 structure can't be read (${rest}). Try the Convert engine, which re-encodes into a clean container.`;
    case 'LAYOUT':
    case 'UNSUPPORTED_TRACK':
    case 'BAD_TRACK':
    case 'TOO_MANY_SAMPLES':
      return `This container isn't directly patchable (${rest}). Use Convert HEVC → H.264 or a re-encode engine — they normalize the container first.`;
    case 'NOT_FASTSTART':
      return 'The moov atom sits after the media data. This should have been auto-fixed — please retry.';
    case 'FFMPEG_SPAWN_FAILED':
      return `The video engine failed to start (${rest}).`;
    default:
      if (raw.startsWith('FFMPEG_')) return `Video engine error: ${rest}`;
      return rest || 'Processing failed.';
  }
}

async function fileSize(p: string): Promise<number> {
  return (await stat(p)).size;
}

/** Kick off a job (fire-and-forget with a concurrency slot). */
export function startJob(jobId: string): void {
  progressInit(jobId);
  void withSlot(() => runJob(jobId)).catch(() => {
    /* runJob never throws — it writes failures to the DB */
  });
}

async function runJob(jobId: string): Promise<void> {
  const log = (line: string) => progressLog(jobId, line);
  try {
    const job = await db.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    const mode = job.engineMode as EngineMode;
    const profile = PROFILE_BY_MODE[mode] ?? 'v1-ghost';

    await db.job.update({ where: { id: jobId }, data: { status: 'PROCESSING', profileVersion: profile } });
    progressSet(jobId, { stage: 'Scanning', progress: 55 });
    log('Scanning container…');

    let current = inputPath(jobId);
    let meta = await inspectFile(current);
    log(
      `Source: ${meta.video ? `${meta.video.codec.toUpperCase()} ${meta.video.width}×${meta.video.height} @ ${meta.video.fps.toFixed(2)}fps, ${meta.video.frameCount} frames` : 'no video track'}${meta.audio ? ' · audio ✔' : ' · no audio'}`,
    );

    // ── engine pre-steps ────────────────────────────────────────────────
    if (mode === 'convert-h264' || mode === 'encode-1080' || mode === 'encode-4k') {
      const encodeMode = mode === 'convert-h264' ? 'convert' : mode === 'encode-1080' ? '1080' : '4k';
      progressSet(jobId, { stage: 'Encoding (ffmpeg)', progress: 62 });
      log(`Re-encoding with ffmpeg (${encodeMode} preset — this can take a while)…`);
      const work = workPath(jobId, 'encode');
      await encodeH264(current, work, encodeMode, meta, (line) => {
        if (line.startsWith('frame=') || line.includes('time=')) return; // keep log tidy
        log(`ffmpeg: ${line.slice(0, 160)}`);
      });
      current = work;
      meta = await inspectFile(current);
      log(`Encoded: ${meta.video?.codec.toUpperCase()} ${meta.video?.width}×${meta.video?.height} @ ${(meta.video?.fps ?? 0).toFixed(2)}fps`);
    } else if (!meta.faststart || meta.fragmented) {
      // patch-only modes still need a clean classic MP4 layout
      progressSet(jobId, { stage: 'Remuxing (lossless)', progress: 60 });
      log(meta.fragmented
        ? 'Fragmented MP4 — remuxing into a classic container (no re-encode)…'
        : 'moov atom at file end — remuxing to faststart (no re-encode)…');
      const work = workPath(jobId, 'faststart');
      const remuxed = await ensureFaststart(current, work, (line) => log(`ffmpeg: ${line.slice(0, 160)}`));
      if (remuxed) {
        current = work;
        meta = await inspectFile(current);
        log('Faststart remux done — every frame copied bit-exact.');
      }
    }

    // ── silent-audio carrier for the ghost fingerprint ──────────────────
    if (profile === 'v1-ghost' && !meta.audio) {
      progressSet(jobId, { stage: 'Adding silent audio', progress: 68 });
      log('No audio track — adding a silent one so the ghost fingerprint can attach (video untouched)…');
      const work = workPath(jobId, 'audio');
      await addSilentAudio(current, work, (line) => log(`ffmpeg: ${line.slice(0, 160)}`));
      current = work;
      meta = await inspectFile(current);
      log('Silent AAC track added.');
    }

    // ── patch ───────────────────────────────────────────────────────────
    progressSet(jobId, { stage: 'Patching container', progress: 78 });
    log(`Applying ${profile} patch profile…`);
    const result = await patchFile(current, outputPath(jobId), profile);
    for (const op of result.opsApplied) log(`✓ ${op}`);
    for (const w of result.warnings) log(`⚠ ${w}`);
    log(`Patch complete — ${result.outputBytes.toLocaleString()} bytes (video stream copied bit-exact).`);

    // ── verify ──────────────────────────────────────────────────────────
    progressSet(jobId, { stage: 'Verifying', progress: 90 });
    log('Verifying symptoms (duration/fps signals + full decode parity)…');
    const report = await verifyPatched(result.metaBefore, outputPath(jobId), profile, await fileSize(current));
    for (const c of report.checks) log(`${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`);
    log(report.pass ? 'Verification PASSED — the patched file carries the fingerprint.' : 'Verification found weak symptoms — the file is safe, but consider another profile if TikTok still compresses.');

    const outSize = await fileSize(outputPath(jobId));
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'DONE',
        outputSize: outSize,
        verifyReport: JSON.stringify(report),
        meta: JSON.stringify(meta),
        completedAt: new Date(),
      },
    });
    await db.stat.upsert({
      where: { id: 'global' },
      create: { id: 'global', patchesDone: 1 },
      update: { patchesDone: { increment: 1 } },
    });
    progressSet(jobId, { stage: 'Done', progress: 100, done: true });
  } catch (err) {
    const message = humanizeError(String((err as Error)?.message ?? err));
    try {
      progressLog(jobId, `✗ ${message}`);
    } catch { /* ignore */ }
    await db.job.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: message, completedAt: new Date() },
    }).catch(() => {});
    progressSet(jobId, { stage: 'Failed', progress: 100, done: true, error: message });
  }
}

/** Assemble incoming.part → input.mp4 once all chunks arrived. */
export async function assembleUpload(jobId: string, expectedBytes: number): Promise<void> {
  const got = await fileSize(incomingPath(jobId)).catch(() => 0);
  if (got !== expectedBytes) {
    throw new Error(`UPLOAD_INCOMPLETE: received ${got.toLocaleString()} of ${expectedBytes.toLocaleString()} bytes`);
  }
  await rename(incomingPath(jobId), inputPath(jobId));
}
