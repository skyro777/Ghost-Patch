'use client';

/**
 * Segmented downloader — built for the preview gateway, which kills
 * long-lived streaming responses (whole-file downloads stall around ~100 MB)
 * and 403s HEAD requests.
 *
 *   • NEVER issues HEAD: size probe ladder is ?meta=1 → `Range: bytes=0-0`
 *     Content-Range parse → the size the job record already knows.
 *   • Fetches in query-slice segments (?offset=N&length=M), sized to ~8s of
 *     measured throughput, capped at 24 MB; auto-switches to the classic
 *     Range dialect after 2 failed segment attempts.
 *   • Per-segment retries (5 attempts, 1/2/4/8s backoff), 25s no-progress
 *     watchdog, 403/429/408 treated as transient gateway hiccups.
 *   • Resume keeps already fetched pieces; Retry/Resume never re-downloads.
 *   • Chromium: streams straight to disk via File System Access (picker
 *     opened while user-activation is fresh; positioned writes). If disk
 *     writes break, Resume restarts cleanly in memory mode — never corrupts.
 *   • Elsewhere: in-memory parts assembled into a Blob + <a download>.
 */

import { useCallback, useRef, useState } from 'react';

/* ── types ─────────────────────────────────────────────────────────── */

export type DownloadPhase = 'idle' | 'fetch' | 'done' | 'error' | 'cancelled';

export interface DownloadState {
  phase: DownloadPhase;
  received: number;
  total: number;
  pct: number;
  speedBps: number;
  etaSec: number | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  noRangeSupport: boolean;
}

interface FetchError extends Error {
  expired?: boolean;
  noRange?: boolean;
  stalled?: boolean;
}

type ShowSavePicker = (opts: { suggestedName?: string }) => Promise<FileSystemFileHandleLike>;

interface FileSystemFileHandleLike {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<FileSystemWritableLike>;
}

interface FileSystemWritableLike {
  write(chunk: { type?: string; position?: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
}

interface SavePickerWindow {
  showSaveFilePicker?: ShowSavePicker;
}

/* ── tuning ────────────────────────────────────────────────────────── */

const MAX_SEGMENT_BYTES = 24 * 1024 * 1024; // hard cap per slice fetch
const MIN_SEGMENT_BYTES = 1 * 1024 * 1024;
const TARGET_SEGMENT_MS = 8_000; // aim for ~8s per segment
const PROBE_BYTES = 1 * 1024 * 1024; // first slice doubles as throughput probe
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
const WATCHDOG_STALL_MS = 25_000; // no bytes for 25s → hard abort + retry
const QS_FAILURES_BEFORE_RANGE = 2;
const TRANSIENT_STATUS = new Set([403, 408, 429]);

const INITIAL_STATE: DownloadState = {
  phase: 'idle',
  received: 0,
  total: 0,
  pct: 0,
  speedBps: 0,
  etaSec: null,
  attempt: 1,
  maxAttempts: MAX_ATTEMPTS,
  error: null,
  noRangeSupport: false,
};

function getSavePicker(): ShowSavePicker | null {
  const w = window as unknown as SavePickerWindow;
  return typeof w.showSaveFilePicker === 'function'
    ? w.showSaveFilePicker.bind(window)
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── downloader ────────────────────────────────────────────────────── */

export class SegmentedDownloader {
  private state: DownloadState = { ...INITIAL_STATE };
  private readonly onUpdate: (s: DownloadState) => void;

  private readonly url: string;
  private readonly fileName: string;
  private readonly expectedTotal: number;

  private total = 0;
  private pos = 0;
  private parts: Uint8Array[] = [];
  private cancelled = false;
  private running = false;
  private finished = false;
  private fatal: string | null = null;

  private handle: FileSystemFileHandleLike | null = null;
  private writable: FileSystemWritableLike | null = null;
  private useFsAccess = false;
  private diskFailed = false;

  private useRange = false; // query-slice primary, Range fallback dialect
  private qsFailures = 0;
  noRangeSupport = false;

  private controller: AbortController | null = null;
  private speedEmaBps = 0;

  constructor(
    url: string,
    fileName: string,
    expectedTotal: number,
    onUpdate: (s: DownloadState) => void,
  ) {
    this.url = url;
    this.fileName = fileName;
    this.expectedTotal = expectedTotal;
    this.onUpdate = onUpdate;
  }

  /* state plumbing */

  private emit(patch: Partial<DownloadState>, force = false): void {
    this.state = { ...this.state, ...patch };
    this.onUpdate({ ...this.state });
  }

  private pct(): number {
    return this.total > 0 ? Math.min(100, Math.floor((this.pos / this.total) * 100)) : 0;
  }

  private noteSpeed(bytes: number, ms: number): void {
    if (bytes <= 0 || ms <= 0) return;
    const bps = (bytes / ms) * 1000;
    this.speedEmaBps = this.speedEmaBps === 0 ? bps : this.speedEmaBps * 0.7 + bps * 0.3;
    this.emit({ speedBps: Math.round(this.speedEmaBps) });
  }

  private segmentBytes(): number {
    if (this.speedEmaBps <= 0) return 4 * 1024 * 1024;
    const target = Math.round((this.speedEmaBps / 1000) * TARGET_SEGMENT_MS);
    return Math.max(MIN_SEGMENT_BYTES, Math.min(MAX_SEGMENT_BYTES, target));
  }

  private expiredError(): FetchError {
    const err = new Error(
      'The patched file expired on the server (files auto-delete after ~2 hours). Patch the video again.',
    ) as FetchError;
    err.expired = true;
    return err;
  }

  private diskError(): Error {
    this.diskFailed = true;
    return new Error(
      'Could not write the file to disk. Tap Resume — the download will restart in browser memory instead.',
    );
  }

  /* probe ladder — NO HEAD anywhere */

  private async probe(): Promise<void> {
    let total = 0;

    /* ladder 1: ?meta=1 (plain GET — the gateway 403s HEAD) */
    try {
      const res = await fetch(`${this.url}${this.url.includes('?') ? '&' : '?'}meta=1`, {
        cache: 'no-store',
        signal: this.controller?.signal,
      });
      if (res.status === 404 || res.status === 410) throw this.expiredError();
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean; size?: number };
        if (data?.ok && Number.isFinite(data.size) && (data.size as number) > 0) {
          total = data.size as number;
        }
      }
    } catch (err) {
      if ((err as FetchError).expired) throw err;
    }

    /* ladder 2: 1-byte Range GET → parse `Content-Range: bytes 0-0/TOTAL` */
    if (total === 0) {
      try {
        const res = await fetch(this.url, {
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
          signal: this.controller?.signal,
        });
        if (res.status === 404 || res.status === 410) throw this.expiredError();
        const cr = res.headers.get('content-range');
        if (res.status === 206 && cr) {
          const m = /\/(\d+)\s*$/.exec(cr);
          if (m) total = Number(m[1]);
        }
      } catch (err) {
        if ((err as FetchError).expired) throw err;
      }
    }

    /* ladder 3: the size the job record already knows */
    if (total === 0 && this.expectedTotal && this.expectedTotal > 0) {
      total = this.expectedTotal;
    }

    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('Could not read the file info. Check the connection and try again.');
    }
    this.total = total;

    /* first slice doubles as the throughput probe */
    const probeLen = Math.min(PROBE_BYTES, this.total);
    const t0 = performance.now();
    const buf = await this.fetchSliceWithProgress(0, probeLen);
    this.noteSpeed(buf.length, performance.now() - t0);
    await this.store(0, buf);
    this.pos = buf.length;
    this.emit({ received: this.pos, total: this.total, pct: this.pct() }, true);
  }

  /* storage: disk-streamed (Chromium) or in-memory parts (everywhere else) */

  private async store(start: number, buf: Uint8Array): Promise<void> {
    if (this.useFsAccess && this.handle) {
      if (!this.writable) {
        try {
          this.writable = await this.handle.createWritable({ keepExistingData: true });
        } catch {
          throw this.diskError();
        }
      }
      try {
        await this.writable.write({ type: 'write', position: start, data: buf });
      } catch {
        this.writable = null;
        throw this.diskError();
      }
      this.parts = []; // the disk path never accumulates memory
    } else {
      this.parts.push(buf);
    }
  }

  /** Offer the OS save dialog while user activation is still fresh. */
  private async openPicker(): Promise<void> {
    const picker = getSavePicker();
    if (!picker || this.handle) return;
    try {
      this.handle = await picker({ suggestedName: this.fileName });
      this.useFsAccess = true;
    } catch (err) {
      this.handle = null;
      this.useFsAccess = false;
      if ((err as DOMException)?.name === 'AbortError') {
        this.cancelled = true; // user closed the picker → cancel the download
      }
    }
  }

  /* slice fetchers — query-slice primary, Range fallback dialect */

  private async fetchSliceQs(start: number, len: number): Promise<Uint8Array> {
    const res = await fetch(`${this.url}?offset=${start}&length=${len}`, {
      cache: 'no-store',
      signal: this.controller?.signal,
    });
    return this.consumeSliceResponse(res, start, len, false);
  }

  private async fetchSliceRange(start: number, len: number): Promise<Uint8Array> {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${start + len - 1}` },
      cache: 'no-store',
      signal: this.controller?.signal,
    });
    return this.consumeSliceResponse(res, start, len, true);
  }

  private async consumeSliceResponse(
    res: Response,
    start: number,
    len: number,
    viaRange: boolean,
  ): Promise<Uint8Array> {
    if (res.status === 404 || res.status === 410) throw this.expiredError();
    if (res.status === 416) throw new Error('Unexpected response. Retrying.');

    if (viaRange && res.status === 200 && start > 0) {
      // server ignored the Range header and wants to send the whole file
      const err = new Error('Server does not support ranged downloads.') as FetchError;
      err.noRange = true;
      this.noRangeSupport = true;
      this.emit({ noRangeSupport: true });
      throw err;
    }
    if (!res.ok && res.status !== 206) {
      const err = new Error(
        TRANSIENT_STATUS.has(res.status)
          ? 'The gateway hiccuped mid-download. Retrying keeps what we already have.'
          : `Download failed (${res.status}).`,
      ) as FetchError;
      if (TRANSIENT_STATUS.has(res.status)) err.stalled = true;
      throw err;
    }

    return this.readBodyWithWatchdog(res, start, len);
  }

  /** Read a response body with per-chunk progress + no-progress watchdog. */
  private async readBodyWithWatchdog(
    res: Response,
    start: number,
    len: number,
  ): Promise<Uint8Array> {
    const reader = res.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      this.emitProgress(start + buf.length);
      return buf;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        this.controller?.abort(new DOMException('stalled', 'AbortError'));
      }, WATCHDOG_STALL_MS);
    };
    armWatchdog();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.cancelled) {
          await reader.cancel().catch(() => {});
          throw new DOMException('cancelled', 'AbortError');
        }
        chunks.push(value);
        received += value.length;
        armWatchdog(); // bytes flowed → watchdog resets
        this.emitProgress(start + received);
      }
    } finally {
      if (watchdog !== null) clearTimeout(watchdog);
    }

    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  private emitProgress(received: number): void {
    const total = this.total || this.expectedTotal;
    const remaining = total > 0 ? Math.max(0, total - received) : 0;
    const etaSec =
      this.speedEmaBps > 0 && remaining > 0 ? Math.round(remaining / this.speedEmaBps) : null;
    this.emit({ received, total, pct: this.pct(), etaSec });
  }

  private async fetchSliceWithProgress(start: number, len: number): Promise<Uint8Array> {
    if (!this.useRange) {
      try {
        const buf = await this.fetchSliceQs(start, len);
        return buf;
      } catch (err) {
        if ((err as FetchError).expired || (err as FetchError).noRange) throw err;
        if ((err as DOMException)?.name === 'AbortError' && this.cancelled) throw err;
        this.qsFailures += 1;
        if (this.qsFailures >= QS_FAILURES_BEFORE_RANGE) this.useRange = true;
        throw err;
      }
    }
    return this.fetchSliceRange(start, len);
  }

  /* main loop: remaining slices with per-segment retries */

  private async run(): Promise<void> {
    while (this.pos < this.total) {
      if (this.cancelled) return;

      const segLen = this.segmentBytes();
      const start = this.pos;
      const len = Math.min(segLen, this.total - start);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (this.cancelled) return;
        try {
          this.emit(
            attempt > 1
              ? { phase: 'fetch', attempt, maxAttempts: MAX_ATTEMPTS, pct: this.pct() }
              : { phase: 'fetch', attempt: 1, maxAttempts: MAX_ATTEMPTS, pct: this.pct() },
            true,
          );
          this.controller = new AbortController();
          const t0 = performance.now();
          const buf = await this.fetchSliceWithProgress(start, len);
          this.noteSpeed(buf.length, performance.now() - t0);

          if (buf.length !== len) {
            // the whole file arrived in one response — only valid from byte 0
            if (start === 0 && buf.length === this.total) {
              await this.store(0, buf);
              this.pos = buf.length;
              break;
            }
            throw new Error('Unexpected response. Retrying.');
          }

          await this.store(start, buf);
          this.pos = start + buf.length;
          this.emit({ received: this.pos, pct: this.pct(), attempt: 1 });
          break; // segment done
        } catch (err) {
          if (this.cancelled) return;
          if ((err as FetchError).expired || (err as FetchError).noRange) throw err;
          if ((err as DOMException)?.name === 'AbortError' && this.cancelled) throw err;

          if (attempt === MAX_ATTEMPTS) {
            const fetchErr = err as FetchError;
            throw new Error(
              fetchErr.message ||
                'The connection kept dropping. Tap Retry to resume — pieces already fetched are kept.',
            );
          }
          await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
          if (this.cancelled) return;
        }
      }
    }
    await this.finish();
  }

  /* finish: close disk stream, or assemble Blob + <a download> */

  private async finish(): Promise<void> {
    if (this.useFsAccess && this.writable) {
      try {
        await this.writable.close();
      } catch {
        this.writable = null;
        throw this.diskError();
      }
    } else {
      const blob = new Blob(this.parts as BlobPart[], { type: 'video/mp4' });
      this.parts = []; // release memory before the click
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = this.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 30_000);
    }
    this.finished = true;
    this.emit({ phase: 'done', pct: 100, received: this.total, error: null }, true);
  }

  /* public controls */

  async start(): Promise<void> {
    if (this.running || this.finished) return;
    this.cancelled = false;
    this.fatal = null;
    this.running = true;
    this.controller = new AbortController();
    try {
      if (this.total === 0) {
        await this.openPicker();
        if (this.cancelled) {
          this.emit(
            { phase: 'cancelled', received: this.pos, total: this.total, pct: this.pct() },
            true,
          );
          return;
        }
        this.controller = new AbortController();
        await this.probe();
      }
      await this.run();
    } catch (err) {
      if (this.cancelled) {
        this.emit(
          { phase: 'cancelled', received: this.pos, total: this.total, pct: this.pct() },
          true,
        );
        return;
      }
      const fetchErr = err as FetchError;
      this.noRangeSupport = fetchErr.noRange === true;
      this.fatal = String(fetchErr.message || 'Download failed.');
      this.emit(
        { phase: 'error', error: this.fatal, noRangeSupport: this.noRangeSupport },
        true,
      );
    } finally {
      this.running = false;
    }
  }

  /** Continue after an error/cancel — keeps already fetched pieces. */
  async retry(): Promise<void> {
    if (this.finished || this.running) return;
    if (this.diskFailed) {
      // disk writes broke — restart cleanly in memory mode (never corrupt output)
      this.diskFailed = false;
      this.useFsAccess = false;
      this.handle = null;
      this.writable = null;
      this.parts = [];
      this.pos = 0;
    }
    if (this.total === 0) {
      await this.start();
      return;
    }
    this.cancelled = false;
    this.fatal = null;
    this.emit({ phase: 'fetch', error: null, attempt: 1, maxAttempts: MAX_ATTEMPTS }, true);
    this.running = true;
    this.controller = new AbortController();
    try {
      await this.run();
    } catch (err) {
      if (this.cancelled) {
        this.emit({ phase: 'cancelled', received: this.pos, pct: this.pct() }, true);
        return;
      }
      this.emit(
        { phase: 'error', error: String((err as Error).message || 'Download failed.') },
        true,
      );
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.controller?.abort(new DOMException('cancelled', 'AbortError'));
    this.emit(
      { phase: 'cancelled', received: this.pos, total: this.total, pct: this.pct() },
      true,
    );
  }
}

/* ── react hook ────────────────────────────────────────────────────── */

export function useSegmentedDownload(
  url: string,
  fileName: string,
  expectedTotal: number,
): {
  dlState: DownloadState;
  start: () => void;
  retry: () => void;
  cancel: () => void;
  reset: () => void;
} {
  const [dlState, setDlState] = useState<DownloadState>({ ...INITIAL_STATE });
  const dlRef = useRef<SegmentedDownloader | null>(null);

  const getDl = useCallback((): SegmentedDownloader => {
    if (!dlRef.current) {
      dlRef.current = new SegmentedDownloader(url, fileName, expectedTotal, setDlState);
    }
    return dlRef.current;
  }, [url, fileName, expectedTotal]);

  const start = useCallback(() => void getDl().start(), [getDl]);
  const retry = useCallback(() => void getDl().retry(), [getDl]);
  const cancel = useCallback(() => getDl().cancel(), [getDl]);
  const reset = useCallback(() => {
    dlRef.current?.cancel();
    dlRef.current = null;
    setDlState({ ...INITIAL_STATE });
  }, []);

  return { dlState, start, retry, cancel, reset };
}
