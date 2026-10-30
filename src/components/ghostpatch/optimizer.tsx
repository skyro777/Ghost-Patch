'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleX,
  FileVideo,
  LoaderCircle,
  RotateCcw,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  api,
  readScanPayload,
  STATS_REFRESH_EVENT,
  type EngineMode,
  type Job,
  type ScanMeta,
} from './api';
import { ENGINES } from './engines';
import { formatBytes, formatResolution } from './format';
import { Dropzone } from './dropzone';
import { ScanPanel } from './scan-panel';
import { EnginePicker } from './engine-picker';
import { ProgressPanel } from './progress-panel';
import { ResultCard } from './result-card';
import { Reveal } from './reveal';

/**
 * idle → scanning → ready → uploading → processing → done | failed
 * (failed returns to the picker with the same file so a different
 * profile can be retried without re-dropping the video)
 */
type Phase =
  | 'idle'
  | 'scanning'
  | 'ready'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'failed';

const MAX_SIZE_BYTES = 500 * 1024 * 1024;
const OK_EXTENSION = /\.(mp4|mov|m4v)$/i;
const POLL_INTERVAL_MS = 900;
const MAX_POLL_FAILURES = 5;
const UPLOAD_LOG_LINES = 20; // cap client-side upload log spam

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong.';
}

function jobStatusToLabel(status: string | undefined): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued for the engine';
    case 'UPLOADING':
      return 'Uploading';
    case 'PROCESSING':
      return 'Patching container atoms';
    case 'VERIFYING':
      return 'Verifying every frame';
    case 'DONE':
      return 'Finishing up';
    default:
      return 'Starting up';
  }
}

function FileSummary({
  file,
  meta,
  onChangeFile,
}: {
  file: File;
  meta: ScanMeta;
  onChangeFile: () => void;
}) {
  const codec =
    meta.codec === 'h264'
      ? 'H.264'
      : meta.codec === 'hevc'
        ? 'HEVC'
        : 'Other container';
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-400">
          <FileVideo className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">
            {file.name}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {formatBytes(file.size)} · {codec}
            {meta.width && meta.height
              ? ` · ${formatResolution(meta.width, meta.height)}`
              : ''}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onChangeFile}
        className="h-11 shrink-0 border-zinc-700 bg-transparent text-zinc-400 hover:text-zinc-100"
      >
        Change
      </Button>
    </div>
  );
}

export function Optimizer() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<ScanMeta | null>(null);
  const [engineMode, setEngineMode] = useState<EngineMode>('ghost');
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [chunksDone, setChunksDone] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [uploadLog, setUploadLog] = useState<string[]>([]);
  /** Inline rejection reason shown right above the dropzone — corner toasts
   * are easy to miss inside the preview iframe, this one cannot be. */
  const [pickError, setPickError] = useState<string | null>(null);
  const [pickErrorFile, setPickErrorFile] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollBusyRef = useRef(false);
  const pollFailuresRef = useRef(0);
  const aliveRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollBusyRef.current = false;
  }, []);

  // unmount: abort in-flight requests + stop the poll interval
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const resetAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopPolling();
    setPhase('idle');
    setFile(null);
    setMeta(null);
    setJob(null);
    setJobError(null);
    setChunksDone(0);
    setTotalChunks(0);
    setUploadLog([]);
    setEngineMode('ghost');
    setPickError(null);
    setPickErrorFile(null);
  }, [stopPolling]);

  const pushLog = useCallback((line: string) => {
    setUploadLog((prev) => {
      const next = [...prev, line];
      return next.length > UPLOAD_LOG_LINES
        ? next.slice(next.length - UPLOAD_LOG_LINES)
        : next;
    });
  }, []);

  /* ── 1. file picked → client validation → POST /api/scan ─────────── */

  const handleFile = useCallback(
    async (picked: File) => {
      if (!OK_EXTENSION.test(picked.name)) {
        const msg = `“${picked.name}” is not a supported container — GhostPatch needs MP4, MOV or M4V (WebM and MKV need a full convert first).`;
        setPickError(msg);
        setPickErrorFile(picked.name);
        toast.error('Unsupported file type', { description: msg });
        return;
      }
      if (picked.size > MAX_SIZE_BYTES) {
        const msg = `${formatBytes(picked.size)} — the cap is 500 MB so TikTok playback stays smooth. Trim the clip or export a lighter master.`;
        setPickError(`“${picked.name}” is ${msg}`);
        setPickErrorFile(picked.name);
        toast.error('File is too large', { description: msg });
        return;
      }
      if (picked.size === 0) {
        const msg = `“${picked.name}” is empty — pick the video you exported, straight from your editor or camera.`;
        setPickError(msg);
        setPickErrorFile(picked.name);
        toast.error('That file is empty', {
          description:
            'Pick the video you exported — straight from your editor or camera.',
        });
        return;
      }

      abortRef.current?.abort();
      abortRef.current = null;
      stopPolling();
      setFile(picked);
      setMeta(null);
      setJob(null);
      setJobError(null);
      setUploadLog([]);
      setPickError(null);
      setPickErrorFile(null);
      setPhase('scanning');

      try {
        const { headB64, tailB64 } = await readScanPayload(picked);
        const res = await api<{ ok: true; meta: ScanMeta }>('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: picked.name,
            size: picked.size,
            headB64,
            tailB64,
          }),
        });
        if (!aliveRef.current) return;
        setMeta(res.meta);
        setEngineMode(
          res.meta.codec === 'hevc' || res.meta.codec === 'other'
            ? 'convert-h264'
            : 'ghost',
        );
        setPhase('ready');
      } catch (err) {
        if (!aliveRef.current || isAbortError(err)) return;
        const msg = errMessage(err);
        setPickError(`“${picked.name}” could not be scanned — ${msg}`);
        setPickErrorFile(picked.name);
        toast.error('Scan failed', { description: msg });
        setPhase('idle');
        setFile(null);
      }
    },
    [stopPolling],
  );

  /* ── 2. poll GET /api/jobs/:id every 900ms until DONE/FAILED ─────── */

  const startPolling = useCallback(
    (jobId: string, signal: AbortSignal) => {
      stopPolling();
      pollFailuresRef.current = 0;

      const tick = async () => {
        if (pollBusyRef.current || !aliveRef.current) return;
        pollBusyRef.current = true;
        try {
          const res = await api<{ ok: true; job: Job }>(`/api/jobs/${jobId}`, {
            signal,
            cache: 'no-store',
          });
          pollFailuresRef.current = 0;
          if (!aliveRef.current) return;
          setJob(res.job);
          if (res.job.status === 'DONE') {
            stopPolling();
            setPhase('done');
            window.dispatchEvent(new Event(STATS_REFRESH_EVENT));
          } else if (res.job.status === 'FAILED') {
            stopPolling();
            setJobError(
              res.job.error ?? 'The engine failed without a specific error.',
            );
            setPhase('failed');
          }
        } catch (err) {
          if (isAbortError(err) || !aliveRef.current) return;
          pollFailuresRef.current += 1;
          if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
            stopPolling();
            setJobError('Lost connection to the job while it was processing.');
            setPhase('failed');
          }
        } finally {
          pollBusyRef.current = false;
        }
      };

      void tick();
      pollTimerRef.current = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    },
    [stopPolling],
  );

  /* ── 3. create job → sequential chunk upload → process → poll ────── */

  const startPatch = useCallback(async () => {
    if (!file || !engineMode) return;

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    stopPolling();
    setJob(null);
    setJobError(null);
    setUploadLog([]);
    setChunksDone(0);
    setTotalChunks(0);
    setPhase('uploading');

    try {
      const created = await api<{
        ok: true;
        jobId: string;
        chunkSize: number;
        totalChunks: number;
      }>('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          engineMode,
        }),
        signal: controller.signal,
      });

      const { jobId, chunkSize, totalChunks } = created;
      if (!aliveRef.current) return;
      setTotalChunks(totalChunks);
      pushLog(
        `job accepted — uploading in ${totalChunks} chunk${totalChunks === 1 ? '' : 's'}`,
      );

      const logEvery = Math.max(1, Math.ceil(totalChunks / 15));
      for (let i = 0; i < totalChunks; i++) {
        const slice = file.slice(
          i * chunkSize,
          Math.min((i + 1) * chunkSize, file.size),
        );
        const buffer = await slice.arrayBuffer();
        await api(`/api/jobs/${jobId}/chunk?index=${i}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer,
          signal: controller.signal,
        });
        if (!aliveRef.current) return;
        setChunksDone(i + 1);
        if ((i + 1) % logEvery === 0 || i + 1 === totalChunks) {
          pushLog(`uploaded chunk ${i + 1}/${totalChunks}`);
        }
      }
      pushLog('upload complete — engine took over');

      await api(`/api/jobs/${jobId}/process`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!aliveRef.current) return;
      setPhase('processing');
      startPolling(jobId, controller.signal);
    } catch (err) {
      if (!aliveRef.current || isAbortError(err)) return;
      setJobError(errMessage(err));
      setPhase('failed');
    }
  }, [file, engineMode, startPolling, stopPolling, pushLog]);

  /* ── 4. cancel + feedback ─────────────────────────────────────────── */

  const cancel = useCallback(() => {
    resetAll();
    toast('Patch cancelled', {
      description: 'Nothing was kept — pick a file whenever you’re ready.',
    });
  }, [resetAll]);

  const sendFeedback = useCallback(
    async (verdict: 'worked' | 'compressed'): Promise<boolean> => {
      if (!job) return false;
      try {
        await api(`/api/jobs/${job.id}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verdict }),
        });
        window.dispatchEvent(new Event(STATS_REFRESH_EVENT));
        if (verdict === 'worked') {
          toast.success('Logged — glad it stayed sharp', {
            description:
              'Your 👍 just moved the live success rate for this profile.',
          });
        } else {
          toast('Logged — that one got crushed', {
            description:
              'We track success per profile and fail over when one degrades. Try Ghost with a fresh upload.',
          });
        }
        return true;
      } catch (err) {
        toast.error('Feedback didn’t send', { description: errMessage(err) });
        return false;
      }
    },
    [job],
  );

  /* ── derived progress ─────────────────────────────────────────────── */

  const engineName = useMemo(
    () => ENGINES.find((e) => e.id === engineMode)?.name ?? engineMode,
    [engineMode],
  );

  const percent =
    phase === 'uploading'
      ? totalChunks > 0
        ? Math.round((chunksDone / totalChunks) * 50)
        : 1
      : phase === 'processing'
        ? Math.min(100, Math.round(50 + ((job?.progress ?? 0) / 100) * 50))
        : 0;

  const stageLabel =
    phase === 'uploading'
      ? 'Uploading your video'
      : job?.stage && job.stage.trim().length > 0
        ? job.stage
        : jobStatusToLabel(job?.status);

  const logLines = useMemo(
    () => [...uploadLog, ...(job?.log ?? [])],
    [uploadLog, job],
  );

  /* ── render ───────────────────────────────────────────────────────── */

  return (
    <section id="optimizer" className="scroll-mt-20 py-16 md:py-24">
      <div className="mx-auto max-w-6xl px-4">
        <Reveal className="mb-8 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
            <Zap className="size-3" aria-hidden />
            THE OPTIMIZER
          </span>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">
            Patch your video
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400 md:text-base">
            Drop a file — we read its container, suggest a profile, and hand
            back a TikTok-ready master. Patch modes never touch your frames.
          </p>
        </Reveal>

        <Reveal delay={0.08}>
          <Card className="rounded-xl border-zinc-800 bg-zinc-950/60 shadow-none backdrop-blur">
            <CardContent className="px-5 py-6 sm:px-6">
              {phase === 'idle' && (
                <div className="space-y-4">
                  {pickError && (
                    <Alert
                      role="alert"
                      className="border-red-500/30 bg-red-500/[0.06] text-red-300"
                    >
                      <CircleX className="size-4" aria-hidden />
                      <AlertTitle className="text-red-300">
                        That file couldn’t be used
                        {pickErrorFile ? `: ${pickErrorFile}` : ''}
                      </AlertTitle>
                      <AlertDescription className="text-red-200/70">
                        <p>{pickError}</p>
                      </AlertDescription>
                    </Alert>
                  )}
                  <Dropzone onFile={handleFile} />
                </div>
              )}

              {phase === 'scanning' && file && (
                <div className="space-y-6" aria-live="polite">
                  <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <LoaderCircle
                      className="size-5 shrink-0 animate-spin text-amber-400"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">
                        {file.name}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {formatBytes(file.size)} · reading container atoms…
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton
                        key={i}
                        className="h-[76px] rounded-lg bg-zinc-900"
                      />
                    ))}
                  </div>
                </div>
              )}

              {(phase === 'ready' || phase === 'failed') && file && meta && (
                <div className="space-y-6">
                  <FileSummary
                    file={file}
                    meta={meta}
                    onChangeFile={resetAll}
                  />

                  {phase === 'failed' && jobError && (
                    <Alert className="border-red-500/30 bg-red-500/[0.06] text-red-300">
                      <CircleX className="size-4" aria-hidden />
                      <AlertTitle className="text-red-300">
                        The engine hit a snag
                      </AlertTitle>
                      <AlertDescription className="text-red-200/70">
                        <p>{jobError}</p>
                        <p>
                          {/profile/i.test(jobError)
                            ? 'That profile may be the problem — pick a different one below and run it again.'
                            : 'Try again, or switch to a different profile below if it keeps failing.'}
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}

                  <ScanPanel meta={meta} size={file.size} />

                  <EnginePicker
                    meta={meta}
                    fileSize={file.size}
                    value={engineMode}
                    onChange={setEngineMode}
                  />

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="order-2 text-xs text-zinc-600 sm:order-1">
                      Patch profiles never re-encode your frames · file
                      auto-deleted within an hour
                    </p>
                    <div className="order-1 flex gap-3 sm:order-2">
                      {phase === 'failed' && (
                        <Button
                          variant="ghost"
                          onClick={resetAll}
                          className="text-zinc-400 hover:text-zinc-100"
                        >
                          <RotateCcw />
                          Start over
                        </Button>
                      )}
                      <Button
                        onClick={() => void startPatch()}
                        size="lg"
                        className="h-12 bg-amber-500 px-8 text-sm font-semibold text-zinc-950 hover:bg-amber-400"
                      >
                        <Zap />
                        {phase === 'failed' ? 'Try again' : 'Patch Video'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {(phase === 'uploading' || phase === 'processing') && file && (
                <ProgressPanel
                  percent={percent}
                  stageLabel={stageLabel}
                  detail={
                    phase === 'uploading' && totalChunks > 0
                      ? `chunk ${Math.min(chunksDone + 1, totalChunks)} of ${totalChunks} · ${engineName}`
                      : engineName
                  }
                  lines={logLines}
                  onCancel={cancel}
                />
              )}

              {phase === 'done' && job && file && (
                <ResultCard
                  job={job}
                  fileName={file.name}
                  originalSize={file.size}
                  onFeedback={sendFeedback}
                  onReset={resetAll}
                />
              )}
            </CardContent>
          </Card>
        </Reveal>
      </div>
    </section>
  );
}
