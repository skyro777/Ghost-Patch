import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const verdict = String(body?.verdict ?? '');
    if (verdict !== 'worked' && verdict !== 'compressed') {
      return NextResponse.json({ ok: false, error: 'Invalid verdict.' }, { status: 400 });
    }

    const job = await db.job.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ ok: false, error: 'Job not found.' }, { status: 404 });
    if (job.feedback) {
      return NextResponse.json({ ok: true }); // already voted
    }

    await db.job.update({ where: { id }, data: { feedback: verdict } });
    await db.stat.upsert({
      where: { id: 'global' },
      create: { id: 'global', feedbackGood: verdict === 'worked' ? 1 : 0, feedbackBad: verdict === 'compressed' ? 1 : 0 },
      update:
        verdict === 'worked'
          ? { feedbackGood: { increment: 1 } }
          : { feedbackBad: { increment: 1 } },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not save feedback.' }, { status: 500 });
  }
}
