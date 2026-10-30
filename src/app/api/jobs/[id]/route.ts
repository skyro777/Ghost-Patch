import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { progressGet } from '@/lib/jobState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_MS = 5 * 60 * 1000;

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let job = await db.job.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 });

    // Server restarted mid-processing (progress lost + no completion) → fail it
    if (
      (job.status === 'PROCESSING' || job.status === 'UPLOADING') &&
      !progressGet(id) &&
      Date.now() - job.createdAt.getTime() > STALE_MS
    ) {
      const error = 'Processing was interrupted (server restarted). Please retry — your file was not modified.';
      await db.job.update({ where: { id }, data: { status: 'FAILED', error, completedAt: new Date() } });
      job = { ...job, status: 'FAILED', error };
    }

    const p = progressGet(id);
    const status = job.status;
    const active = status === 'PROCESSING' || status === 'UPLOADING';

    return NextResponse.json({
      ok: true,
      job: {
        id: job.id,
        status,
        progress: p && active ? p.progress : status === 'DONE' ? 100 : p?.progress ?? (status === 'FAILED' ? 100 : 50),
        stage: p?.stage ?? (status === 'DONE' ? 'Done' : status === 'FAILED' ? 'Failed' : 'Queued'),
        log: p?.log ?? [],
        meta: parseJson<object>(job.meta),
        engineMode: job.engineMode,
        outputSize: job.outputSize,
        verifyReport: parseJson<{ pass: boolean; checks: Array<{ name: string; pass: boolean; detail: string }> }>(job.verifyReport),
        error: job.error,
        downloadUrl: status === 'DONE' ? `/api/jobs/${job.id}/download` : null,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not read job.' }, { status: 500 });
  }
}
