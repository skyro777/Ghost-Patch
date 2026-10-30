/**
 * GhostPatch — upload storage + janitor.
 * Job files live in db/uploads/<jobId>/ and are auto-deleted after TTL.
 */

import path from 'node:path';
import { mkdir, rm, readdir, stat, statfs } from 'node:fs/promises';
import { db } from '@/lib/db';

const UPLOAD_ROOT = path.join(process.cwd(), 'db', 'uploads');
export const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — streamed to disk server-side, no RAM pressure
export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // files live ≤ 2h
const JANITOR_INTERVAL_MS = 15 * 60 * 1000;

export function jobDir(jobId: string): string {
  return path.join(UPLOAD_ROOT, jobId);
}
export function inputPath(jobId: string): string {
  return path.join(jobDir(jobId), 'input.mp4');
}
export function incomingPath(jobId: string): string {
  return path.join(jobDir(jobId), 'incoming.part');
}
export function workPath(jobId: string, tag: string): string {
  return path.join(jobDir(jobId), `work-${tag}.mp4`);
}
export function outputPath(jobId: string): string {
  return path.join(jobDir(jobId), 'output.mp4');
}

export async function ensureJobDir(jobId: string): Promise<void> {
  await mkdir(jobDir(jobId), { recursive: true });
}

export async function cleanupJob(jobId: string): Promise<void> {
  await rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {});
}

/** Sanitize a user filename into a safe download basename. */
export function safeBaseName(name: string): string {
  const base = (name || 'video').replace(/\.[^.]+$/, '');
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'video').slice(0, 60);
}

// ── disk-space guard ─────────────────────────────────────────────────────────

/** Thrown when the volume backing db/ cannot make room for a job. */
export class DiskSpaceError extends Error {
  code = 'DISK_FULL' as const;
  constructor(neededBytes: number) {
    super(
      `Server storage is too full to take this job (needs ~${Math.round(
        neededBytes / (1024 * 1024),
      )} MB free). Old files auto-delete after ~2 hours — try again soon or use a smaller file.`,
    );
    this.name = 'DiskSpaceError';
  }
}

/** Best-effort free-space probe of the volume that holds job files. */
export async function freeBytes(): Promise<number> {
  const probe = async (p: string): Promise<number | null> => {
    try {
      const s = await statfs(p);
      return s.bsize * s.bavail;
    } catch {
      return null;
    }
  };
  const free =
    (await probe(UPLOAD_ROOT)) ??
    (await probe(path.dirname(UPLOAD_ROOT))) ??
    (await probe(process.cwd()));
  return free ?? Number.MAX_SAFE_INTEGER; // unknown → never block
}

/**
 * Make sure `neededBytes` are free before accepting new work.
 *
 * Jobs are ephemeral by design (≤2h TTL), so when the disk gets tight the
 * OLDEST jobs are evicted first. `exceptJobId` is never evicted — pass the id
 * of the job we are checking for. Throws DiskSpaceError when still short.
 */
export async function ensureDiskSpace(
  neededBytes: number,
  exceptJobId?: string,
): Promise<void> {
  if ((await freeBytes()) >= neededBytes) return;

  const oldest = await db.job.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const job of oldest) {
    if ((await freeBytes()) >= neededBytes) break;
    if (job.id === exceptJobId) continue;
    await cleanupJob(job.id);
    await db.job.delete({ where: { id: job.id } }).catch(() => {});
  }

  if ((await freeBytes()) < neededBytes) {
    throw new DiskSpaceError(neededBytes);
  }
}

// ── janitor ─────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __gpJanitor?: boolean };

export function startJanitor(): void {
  if (g.__gpJanitor) return;
  g.__gpJanitor = true;
  const sweep = async () => {
    try {
      const cutoff = new Date(Date.now() - JOB_TTL_MS);
      const stale = await db.job.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
      });
      for (const job of stale) {
        await cleanupJob(job.id);
        await db.job.delete({ where: { id: job.id } }).catch(() => {});
      }
      // also remove orphaned directories (e.g. rows already deleted)
      try {
        const entries = await readdir(UPLOAD_ROOT);
        for (const id of entries) {
          const dir = path.join(UPLOAD_ROOT, id);
          const info = await stat(dir).catch(() => null);
          if (info && Date.now() - info.mtimeMs > JOB_TTL_MS) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        }
      } catch {
        /* root may not exist yet */
      }
    } catch {
      /* janitor must never crash the process */
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), JANITOR_INTERVAL_MS);
  // don't hold the event loop open in dev
  if (typeof timer.unref === 'function') timer.unref();
}
