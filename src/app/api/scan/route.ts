import { NextResponse } from 'next/server';
import { inspectSlices } from '@/lib/mp4';
import { MAX_FILE_BYTES, startJanitor } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_SLICE_BYTES = 6 * 1024 * 1024; // 4 MB base64 ≈ 5.4 MB — allow slack

export async function POST(req: Request) {
  startJanitor();
  try {
    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name : '';
    const size = Number(body?.size);
    const headB64 = typeof body?.headB64 === 'string' ? body.headB64 : '';
    const tailB64 = typeof body?.tailB64 === 'string' ? body.tailB64 : '';

    if (!Number.isFinite(size) || size < 16 || size > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: 'File must be between 16 bytes and 500 MB.' }, { status: 400 });
    }
    if (!headB64 || headB64.length > MAX_SLICE_BYTES * 2) {
      return NextResponse.json({ ok: false, error: 'Missing or oversized scan payload.' }, { status: 400 });
    }

    const head = Buffer.from(headB64, 'base64');
    const tail = tailB64 ? Buffer.from(tailB64, 'base64') : Buffer.alloc(0);

    const result = inspectSlices(head, tail, size);
    const meta = result?.meta ?? null;
    if (!meta) {
      return NextResponse.json({
        ok: false,
        error: 'Could not read MP4/MOV metadata from this file. Make sure it is a valid MP4 or MOV — or use the Convert engine after creating the job.',
      }, { status: 422 });
    }

    // health grade + guidance notes
    const notes: string[] = [];
    let health: 'good' | 'warn' | 'bad' = 'good';
    const v = meta.video;
    if (v?.codec === 'other' || !v) {
      health = 'bad';
      notes.push('This video codec can\'t be patched directly — use "Convert HEVC → H.264" (it handles anything ffmpeg can read).');
    } else if (v.codec === 'hevc') {
      health = 'warn';
      notes.push('HEVC detected — TikTok prefers H.264. "Convert HEVC → H.264" is suggested for your file.');
    }
    if (v && (v.width > 4096 || v.height > 4096)) {
      health = 'bad';
      notes.push('TikTok accepts at most 4096px per side — pick "Re-encode 4K Max" to downscale.');
    }
    if (!meta.audio) {
      if (health === 'good') health = 'warn';
      notes.push('No audio track — we\'ll add a silent one automatically so the ghost fingerprint can attach.');
    }
    if (v && v.fps > 0 && v.fps < 23) {
      if (health === 'good') health = 'warn';
      notes.push('TikTok needs at least ~23fps.');
    }
    if (v && v.fps >= 100) {
      notes.push('High frame rate source — the Inflate profile doubles the reported FPS signal. Only pick it for true 120fps clips.');
    }
    if (meta.fragmented) {
      notes.push('Fragmented MP4 — we\'ll normalize it automatically with a lossless remux.');
    }
    if (!meta.faststart && !meta.fragmented) {
      notes.push('moov atom sits at the file end — we\'ll fix that automatically with a lossless faststart remux.');
    }
    if (size > 350 * 1024 * 1024) {
      if (health === 'good') health = 'warn';
      notes.push('Above ~350 MB, TikTok playback can lag for viewers — consider trimming or a re-encode engine.');
    }

    return NextResponse.json({
      ok: true,
      meta: {
        codec: v ? v.codec : null,
        container: meta.container,
        width: v ? v.width : null,
        height: v ? v.height : null,
        fps: v ? v.fps : null,
        frameCount: v ? v.frameCount : null,
        durationSec: v ? v.durationSec : null,
        hasAudio: !!meta.audio,
        faststart: meta.faststart,
        moovAtEnd: meta.moovAtEnd,
        health,
        notes,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Scan failed — invalid request payload.' }, { status: 400 });
  }
}
