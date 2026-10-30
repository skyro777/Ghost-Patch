import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { startJanitor } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PROFILES = [
  { id: 'v1-ghost', version: 1, recipe: JSON.stringify({ ops: ['too-tag', 'ghost-audio-x10', 'edts-strip', 'mvhd-v1-unknown', 'free-strip'], verified: '2026-10' }), active: true, notes: 'Primary profile — reference-verified recipe' },
  { id: 'v2-zero', version: 1, recipe: JSON.stringify({ ops: ['mvhd-zero', 'tkhd-zero', 'mdhd-zero', 'edts-strip', 'free-strip'], verified: '2026-10' }), active: true, notes: 'Fallback — zeroed timing atoms' },
  { id: 'v3-inflate', version: 1, recipe: JSON.stringify({ ops: ['mdhd-timescale-x2'], verified: '2026-10' }), active: true, notes: 'Fallback — fps signal doubling' },
];

async function ensureSeeded() {
  await db.stat.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} });
  for (const p of DEFAULT_PROFILES) {
    await db.engineProfile.upsert({
      where: { id: p.id },
      create: p,
      update: { active: p.active, recipe: p.recipe, notes: p.notes },
    });
  }
}

export async function GET() {
  startJanitor();
  try {
    await ensureSeeded();
    const stat = await db.stat.findUnique({ where: { id: 'global' } });
    const primary = await db.engineProfile.findUnique({ where: { id: 'v1-ghost' } });
    const total = (stat?.feedbackGood ?? 0) + (stat?.feedbackBad ?? 0);
    return NextResponse.json({
      ok: true,
      stats: {
        patchesDone: stat?.patchesDone ?? 0,
        feedbackGood: stat?.feedbackGood ?? 0,
        feedbackBad: stat?.feedbackBad ?? 0,
        successRate: total > 0 ? Math.round(((stat?.feedbackGood ?? 0) / total) * 100) : null,
        engine: { profileVersion: primary?.id ?? 'v1-ghost', active: primary?.active ?? true },
      },
    });
  } catch {
    return NextResponse.json({
      ok: true,
      stats: { patchesDone: 0, feedbackGood: 0, feedbackBad: 0, successRate: null, engine: { profileVersion: 'v1-ghost', active: true } },
    });
  }
}
