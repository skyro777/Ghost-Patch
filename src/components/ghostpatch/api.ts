/**
 * GhostPatch — shared API client + types.
 * Talks to the backend contract (POST /api/scan, POST /api/jobs,
 * PUT /api/jobs/:id/chunk, POST /api/jobs/:id/process, GET /api/jobs/:id,
 * GET /api/jobs/:id/download, POST /api/jobs/:id/feedback, GET /api/stats).
 */

export type EngineMode =
  | 'ghost'
  | 'zero'
  | 'inflate'
  | 'convert-h264'
  | 'encode-1080'
  | 'encode-4k';

export type ScanMeta = {
  codec: 'h264' | 'hevc' | 'other' | null;
  container: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  frameCount: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  faststart: boolean;
  moovAtEnd: boolean;
  health: 'good' | 'warn' | 'bad';
  notes: string[];
};

export type JobStatus =
  | 'QUEUED'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'DONE'
  | 'FAILED';

export type VerifyCheck = {
  name: string;
  pass: boolean;
  detail: string;
};

export type VerifyReport = {
  pass: boolean;
  checks: VerifyCheck[];
};

export type Job = {
  id: string;
  status: JobStatus;
  progress: number;
  stage: string;
  log: string[];
  meta: object | null;
  engineMode: string;
  outputSize: number | null;
  verifyReport: VerifyReport | null;
  error: string | null;
  downloadUrl: string | null;
};

export type Stats = {
  patchesDone: number;
  feedbackGood: number;
  feedbackBad: number;
  successRate: number | null;
  engine: { profileVersion: string; active: boolean };
};

/** Window event fired whenever the global stats counters may have changed. */
export const STATS_REFRESH_EVENT = 'gp:stats-refresh';

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function extractError(data: unknown, fallback: string): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { error?: unknown }).error === 'string' &&
    (data as { error: string }).error.length > 0
  ) {
    return (data as { error: string }).error;
  }
  return fallback;
}

/**
 * Fetch wrapper: relative paths, JSON in/out, throws `ApiError` on
 * non-2xx or `{ ok: false }` bodies. AbortError passes through untouched.
 */
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('Network error — could not reach the GhostPatch server.', 0);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // no JSON body — fall through to status handling below
  }

  if (!res.ok) {
    throw new ApiError(
      extractError(data, `Request failed (${res.status})`),
      res.status,
    );
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { ok?: unknown }).ok === false
  ) {
    throw new ApiError(extractError(data, 'Request failed.'), res.status);
  }

  return (data ?? {}) as T;
}

/* ── scan payload helpers ──────────────────────────────────────────── */

const SCAN_EDGE_BYTES = 4 * 1024 * 1024; // read first + last 4 MB
const SCAN_WHOLE_BYTES = 8 * 1024 * 1024; // small files: send everything

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32k — safe for String.fromCharCode.apply
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function readScanPayload(
  file: File,
): Promise<{ headB64: string; tailB64: string }> {
  if (file.size <= SCAN_WHOLE_BYTES) {
    const head = await file.arrayBuffer();
    return { headB64: arrayBufferToBase64(head), tailB64: '' };
  }
  const head = await file.slice(0, SCAN_EDGE_BYTES).arrayBuffer();
  const tail = await file
    .slice(Math.max(0, file.size - SCAN_EDGE_BYTES))
    .arrayBuffer();
  return {
    headB64: arrayBufferToBase64(head),
    tailB64: arrayBufferToBase64(tail),
  };
}
