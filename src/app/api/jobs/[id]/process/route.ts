import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { assembleUpload, startJob } from '@/lib/pipeline';
import { ensureDiskSpace } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await db.job.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 });
    if (job.status !== 'UPLOADING' && job.status !== 'CREATED') {
      return NextResponse.json({ ok: false, error: `Job is already ${job.status}.` }, { status: 409 });
    }

    // Patching needs room for a work copy + the patched output on top of the
    // uploaded input. Evict older jobs if the disk got tight; fail cleanly
    // (507) instead of writing a truncated file that stalls downloads.
    try {
      await ensureDiskSpace(job.sizeBytes * 2 + 128 * 1024 * 1024, id);
    } catch (err) {
      if ((err as { code?: string })?.code === 'DISK_FULL') {
        return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 507 });
      }
      throw err;
    }

    try {
      await assembleUpload(id, job.sizeBytes);
    } catch (err) {
      const msg = String((err as Error).message ?? err).replace(/^UPLOAD_INCOMPLETE:\s*/, '');
      return NextResponse.json({ ok: false, error: `Upload incomplete — ${msg}. Please retry.` }, { status: 400 });
    }

    startJob(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not start processing.' }, { status: 500 });
  }
}
