/**
 * GhostPatch — in-memory job state (progress, chunk cursors, rate limits).
 * Survives Next.js dev HMR via globalThis singletons.
 */

export interface JobProgress {
  stage: string;
  progress: number; // 0-100 (server-side band 50-100; upload is client-side 0-50)
  log: string[];
  done: boolean;
  error?: string;
}

interface ChunkCursor {
  next: number; // expected next chunk index
}

const g = globalThis as unknown as {
  __gpProgress?: Map<string, JobProgress>;
  __gpChunks?: Map<string, ChunkCursor>;
  __gpRate?: Map<string, number[]>;
  __gpQueue?: { running: number; queue: Array<() => void>; max: number };
};

export const progressStore: Map<string, JobProgress> =
  g.__gpProgress ?? (g.__gpProgress = new Map());
export const chunkStore: Map<string, ChunkCursor> =
  g.__gpChunks ?? (g.__gpChunks = new Map());
const rateStore: Map<string, number[]> = g.__gpRate ?? (g.__gpRate = new Map());

const MAX_LOG_LINES = 60;

export function progressGet(jobId: string): JobProgress | undefined {
  return progressStore.get(jobId);
}

export function progressInit(jobId: string, stage = 'Queued'): void {
  progressStore.set(jobId, { stage, progress: 50, log: [], done: false });
}

export function progressSet(jobId: string, patch: Partial<Omit<JobProgress, 'log'>>): void {
  const cur = progressStore.get(jobId) ?? { stage: 'Processing', progress: 50, log: [], done: false };
  progressStore.set(jobId, { ...cur, ...patch });
}

export function progressLog(jobId: string, line: string): void {
  const cur = progressStore.get(jobId);
  if (!cur) return;
  cur.log.push(line);
  if (cur.log.length > MAX_LOG_LINES) cur.log.splice(0, cur.log.length - MAX_LOG_LINES);
}

export function progressClear(jobId: string): void {
  progressStore.delete(jobId);
  chunkStore.delete(jobId);
}

// ── chunk cursors ───────────────────────────────────────────────────────────

export function chunkCursor(jobId: string): ChunkCursor {
  let c = chunkStore.get(jobId);
  if (!c) {
    c = { next: 0 };
    chunkStore.set(jobId, c);
  }
  return c;
}

// ── simple IP rate limiting: max `max` events per `windowMs` ────────────────

export function rateLimit(key: string, max = 12, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const arr = (rateStore.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    rateStore.set(key, arr);
    return false;
  }
  arr.push(now);
  rateStore.set(key, arr);
  return true;
}

// ── tiny async semaphore for pipeline concurrency ───────────────────────────

const queue = g.__gpQueue ?? (g.__gpQueue = { running: 0, queue: [], max: 2 });

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (queue.running >= queue.max) {
    await new Promise<void>((resolve) => queue.queue.push(resolve));
  }
  queue.running++;
  try {
    return await fn();
  } finally {
    queue.running--;
    const next = queue.queue.shift();
    if (next) next();
  }
}
