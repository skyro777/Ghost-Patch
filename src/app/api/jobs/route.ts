import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { ENGINE_MODES, type EngineMode } from '@/lib/pipeline';
import { CHUNK_SIZE, MAX_FILE_BYTES, ensureDiskSpace, ensureJobDir, startJanitor } from '@/lib/uploads';
import { rateLimit } from '@/lib/jobState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_NAME_LEN = 180;

export async function POST(req: Request) {
  startJanitor();
  try {
    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.slice(0, MAX_NAME_LEN) : '';
    const size = Number(body?.size);
    const engineMode = String(body?.engineMode ?? '');

    if (!name || !/^[\s\S]+\.(mp4|mov|m4v|mp4v)$/i.test(name)) {
      return NextResponse.json({ ok: false, error: 'Only MP4 / MOV / M4V files are supported.' }, { status: 400 });
    }
    if (!Number.isFinite(size) || size < 16 || size > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: 'File must be between 16 bytes and 500 MB.' }, { status: 400 });
    }
    if (!(ENGINE_MODES as readonly string[]).includes(engineMode)) {
      return NextResponse.json({ ok: false, error: 'Unknown engine mode.' }, { status: 400 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    if (!rateLimit(`jobs:${ip}`, 15)) {
      return NextResponse.json({ ok: false, error: 'Too many jobs from this address — try again in about an hour.' }, { status: 429 });
    }

    // A job transiently needs ~2.2× its size on disk (upload + work copy +
    // patched output). Make room BEFORE accepting the upload — a disk that
    // fills mid-patch truncates the output and stalls the later download.
    try {
      await ensureDiskSpace(Math.round(size * 2.2) + 128 * 1024 * 1024);
    } catch (err) {
      if ((err as { code?: string })?.code === 'DISK_FULL') {
        return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 507 });
      }
      throw err;
    }

    const job = await db.job.create({
      data: {
        status: 'CREATED',
        originalName: name,
        sizeBytes: Math.round(size),
        engineMode: engineMode as EngineMode,
        ipHash: createHash('sha256').update(ip).digest('hex').slice(0, 16),
      },
    });
    await ensureJobDir(job.id);

    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    return NextResponse.json({ ok: true, jobId: job.id, chunkSize: CHUNK_SIZE, totalChunks });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not create job.' }, { status: 500 });
  }
}
