import { NextResponse } from 'next/server';
import { createWriteStream } from 'node:fs';
import { stat, truncate, unlink } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '@/lib/db';
import { chunkCursor } from '@/lib/jobState';
import { incomingPath, MAX_FILE_BYTES } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Chunk upload — STREAMS the request body to disk (never buffers a whole
 * chunk in RAM: the dev server previously OOM-died on ~240 MB uploads when
 * chunks landed via arrayBuffer()). 64 KB write buffers, on-the-fly size
 * cap, and rollback truncate on abort/overflow so a retried index stays
 * byte-exact against the sequential-append cursor.
 */
const WRITE_HIGH_WATER = 64 * 1024;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let appended = 0;
  let startSize = -1;

  try {
    const index = Number(new URL(req.url).searchParams.get('index'));
    if (!Number.isInteger(index) || index < 0) {
      return NextResponse.json({ ok: false, error: 'Bad chunk index.' }, { status: 400 });
    }

    const job = await db.job.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 });
    if (job.status === 'DONE' || job.status === 'PROCESSING' || job.status === 'FAILED') {
      return NextResponse.json(
        { ok: false, error: 'Job already left the upload phase.' },
        { status: 409 },
      );
    }

    const cursor = chunkCursor(id);
    if (index !== cursor.next) {
      return NextResponse.json(
        { ok: false, error: `Chunk out of order — expected index ${cursor.next}.` },
        { status: 409 },
      );
    }

    const inPath = incomingPath(id);
    const cap = Math.min(job.sizeBytes, MAX_FILE_BYTES);
    startSize = await stat(inPath).then((s) => s.size).catch(() => 0);

    if (!req.body) {
      return NextResponse.json({ ok: false, error: 'Empty chunk.' }, { status: 400 });
    }

    /* stream → append at the current end, enforcing the cap on the fly */
    const nodeBody = req.body as unknown as AsyncIterable<Uint8Array>;
    const out = createWriteStream(inPath, { flags: 'a', highWaterMark: WRITE_HIGH_WATER });

    const meter = new Writable({
      highWaterMark: WRITE_HIGH_WATER,
      write(chunk, _enc, cb) {
        appended += chunk.length;
        if (startSize + appended > cap) {
          cb(new Error('Upload exceeds the declared file size.'));
          return;
        }
        if (!out.write(chunk)) {
          out.once('drain', () => cb());
        } else {
          cb();
        }
      },
      final(cb) {
        out.end(cb);
      },
    });

    try {
      await pipeline(nodeBody, meter);
    } catch (streamErr) {
      out.destroy();
      /* rollback the partial append so a retried index stays byte-exact */
      await truncate(inPath, Math.max(0, startSize)).catch(() => {});
      const msg = streamErr instanceof Error ? streamErr.message : '';
      if (/declared file size/.test(msg)) {
        await truncate(inPath, Math.max(0, startSize)).catch(() => {});
        return NextResponse.json(
          { ok: false, error: 'Upload exceeds the declared file size.' },
          { status: 400 },
        );
      }
      throw streamErr; // abort/network error → 500, client retries this index
    }

    if (startSize + appended === 0) {
      await truncate(inPath, Math.max(0, startSize)).catch(() => {});
      return NextResponse.json({ ok: false, error: 'Empty chunk.' }, { status: 400 });
    }

    cursor.next = index + 1;
    if (job.status === 'CREATED') {
      await db.job.update({ where: { id }, data: { status: 'UPLOADING' } });
    }
    return NextResponse.json({ ok: true, received: cursor.next });
  } catch (err) {
    /* safety: never leave a torn tail behind on unexpected failures */
    if (startSize >= 0 && appended > 0) {
      const inPath = incomingPath(id);
      const cur = await stat(inPath).then((s) => s.size).catch(() => -1);
      if (cur > startSize) await truncate(inPath, startSize).catch(() => {});
      if (cur === 0) await unlink(inPath).catch(() => {});
    }
    return NextResponse.json({ ok: false, error: 'Chunk upload failed.' }, { status: 500 });
  }
}
