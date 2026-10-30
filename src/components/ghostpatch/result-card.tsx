'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Ban,
  BadgeCheck,
  CircleCheck,
  CircleX,
  Download,
  Eye,
  FolderOpen,
  MonitorPlay,
  RotateCcw,
  Rocket,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import type { Job } from './api';
import { ENGINES } from './engines';
import { formatBytes } from './format';
import { useSegmentedDownload } from './segmented-download';

const CHECKLIST: { icon: LucideIcon; text: string }[] = [
  {
    icon: Download,
    text: 'Download the patched file (button above)',
  },
  {
    icon: MonitorPlay,
    text: 'On desktop, open tiktok.com → Upload video (or TikTok Studio) — NOT the phone app',
  },
  {
    icon: BadgeCheck,
    text: 'Turn ON “Upload HD” in the upload options — plus Settings → Content preferences → “Allow high-quality uploads”, Data Saver OFF',
  },
  {
    icon: Eye,
    text: 'Set visibility to “Everyone” (not Only Me)',
  },
  {
    icon: Ban,
    text: 'Do NOT trim, add sounds, text or filters inside TikTok (it re-renders your video)',
  },
  {
    icon: FolderOpen,
    text: 'On iPhone? Pick the file from the Files app, never the photo gallery',
  },
  {
    icon: Rocket,
    text: 'Post it — then come back and tell us if it stayed sharp',
  },
];

/* mirrors the server-side safeBaseName so the picker suggests the same name */
function safeNameClient(name: string): string {
  const base = (name || 'video').replace(/\.[^.]+$/, '');
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'video').slice(0, 60);
}

function formatSpeed(bps: number): string | null {
  if (!Number.isFinite(bps) || bps <= 0) return null;
  const mbps = bps / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

function formatEta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}

export function ResultCard({
  job,
  fileName,
  originalSize,
  onFeedback,
  onReset,
}: {
  job: Job;
  fileName: string;
  originalSize: number;
  onFeedback: (verdict: 'worked' | 'compressed') => Promise<boolean>;
  onReset: () => void;
}) {
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'done'>(
    'idle',
  );

  const engine = ENGINES.find((e) => e.id === job.engineMode);
  const downloadUrl = job.downloadUrl ?? `/api/jobs/${job.id}/download`;
  const outFileName = `ghostpatch-${safeNameClient(fileName)}.mp4`;
  const expectedTotal = job.outputSize ?? 0;

  const { dlState, start, retry, cancel, reset } = useSegmentedDownload(
    downloadUrl,
    outFileName,
    expectedTotal,
  );
  const directRisky = expectedTotal > 100 * 1024 * 1024;

  let sizeDelta: string | null = null;
  if (job.outputSize !== null && originalSize > 0) {
    const pct = ((job.outputSize - originalSize) / originalSize) * 100;
    sizeDelta = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs source`;
  }

  const handleFeedback = async (verdict: 'worked' | 'compressed') => {
    if (feedbackState !== 'idle') return;
    setFeedbackState('sending');
    const ok = await onFeedback(verdict);
    setFeedbackState(ok ? 'done' : 'idle');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="space-y-6"
    >
      {/* success header */}
      <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
          <CircleCheck className="size-8 text-emerald-400" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-xl font-bold text-zinc-100">
            Your video is patched
          </h3>
          <p className="mt-0.5 truncate text-sm text-zinc-400">
            {fileName} · {engine?.name ?? job.engineMode} profile
            {job.outputSize !== null && ` · output ${formatBytes(job.outputSize)}`}
          </p>
          {sizeDelta && (
            <p className="mt-0.5 text-xs text-zinc-600">{sizeDelta}</p>
          )}
        </div>
      </div>

      {/* engine verification report */}
      {job.verifyReport && job.verifyReport.checks.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Engine verification
          </p>
          <ul className="mt-3 space-y-2.5">
            {job.verifyReport.checks.map((check) => (
              <li key={check.name} className="flex items-start gap-2.5">
                {check.pass ? (
                  <CircleCheck
                    className="mt-0.5 size-4 shrink-0 text-emerald-400"
                    aria-hidden
                  />
                ) : (
                  <CircleX
                    className="mt-0.5 size-4 shrink-0 text-red-400"
                    aria-hidden
                  />
                )}
                <p className="text-sm leading-relaxed">
                  <span className={check.pass ? 'text-zinc-200' : 'text-red-300'}>
                    {check.name}
                  </span>
                  {check.detail && (
                    <span className="text-zinc-500"> — {check.detail}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* download + restart — segmented fetch that survives the preview gateway */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          size="lg"
          disabled={dlState.phase === 'fetch'}
          onClick={start}
          className="h-12 flex-1 bg-emerald-500 text-sm font-semibold text-emerald-950 hover:bg-emerald-400"
        >
          {dlState.phase === 'fetch' ? (
            <>
              <RotateCcw className="animate-spin" aria-hidden />
              Downloading… {dlState.pct}%
            </>
          ) : (
            <>
              <Download />
              Download patched file
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={onReset}
          className="h-12 border-zinc-800 bg-transparent text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <RotateCcw />
          Patch another video
        </Button>
      </div>

      {dlState.phase === 'fetch' && dlState.total > 0 && (
        <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-zinc-200">
              Fetching in pieces — nothing is lost if the connection dips
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={cancel}
              className="h-8 shrink-0 px-2 text-zinc-400 hover:text-zinc-100"
              aria-label="Pause download"
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          <Progress
            value={dlState.pct}
            aria-label="Download progress"
            className="h-2 bg-zinc-800"
          />
          <p className="text-xs text-zinc-500">
            {dlState.pct}% · {formatBytes(dlState.received)} /{' '}
            {formatBytes(dlState.total)}
            {formatSpeed(dlState.speedBps) && ` · ${formatSpeed(dlState.speedBps)}`}
            {dlState.etaSec !== null &&
              formatEta(dlState.etaSec) &&
              ` · ${formatEta(dlState.etaSec)}`}
            {dlState.attempt > 1 &&
              ` · retry ${dlState.attempt}/${dlState.maxAttempts}`}
          </p>
        </div>
      )}

      {dlState.phase === 'done' && (
        <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CircleCheck className="size-5 shrink-0 text-emerald-400" aria-hidden />
            <p className="text-sm text-emerald-200">
              Saved — check your downloads (or the folder you picked).
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reset();
              start();
            }}
            className="w-fit border-emerald-500/30 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
          >
            <RotateCcw />
            Download again
          </Button>
        </div>
      )}

      {dlState.phase === 'cancelled' && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-zinc-300">
            Paused at {formatBytes(dlState.received)}
            {dlState.total > 0 && ` of ${formatBytes(dlState.total)}`} — pieces
            already fetched are kept.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={retry}
            className="w-fit border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800"
          >
            <Download />
            Resume
          </Button>
        </div>
      )}

      {dlState.phase === 'error' && (
        <Alert className="border-red-500/25 bg-red-500/[0.06] text-red-200">
          <TriangleAlert className="size-4 text-red-400" aria-hidden />
          <AlertTitle className="text-red-200">
            Download interrupted
          </AlertTitle>
          <AlertDescription className="space-y-3 text-red-200/70">
            <p>{dlState.error}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={retry}
                className="border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
              >
                <RotateCcw />
                Resume download
              </Button>
              {!dlState.noRangeSupport && (
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800"
                >
                  <a href={downloadUrl} download>
                    Direct download instead
                  </a>
                </Button>
              )}
            </div>
            {directRisky && (
              <p className="text-xs leading-relaxed">
                Heads up: this file is over ~100 MB — the direct link itself can
                stall on the preview network. “Resume download” fetches it in
                small pieces and keeps what it already got.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* expected-symptom alert */}
      <Alert className="border-amber-500/25 bg-amber-500/[0.06] text-amber-200">
        <TriangleAlert className="size-4 text-amber-400" aria-hidden />
        <AlertTitle className="text-amber-200">
          Shows 0 seconds duration locally?
        </AlertTitle>
        <AlertDescription className="text-amber-200/70">
          <p>
            That’s expected — it’s part of the patch. TikTok plays it perfectly.
          </p>
        </AlertDescription>
      </Alert>

      {/* upload checklist */}
      <div>
        <p className="text-sm font-semibold text-zinc-100">
          The upload checklist{' '}
          <span className="font-normal text-zinc-500">
            — the patch is only half the trick
          </span>
        </p>
        <ol className="mt-3 space-y-2.5">
          {CHECKLIST.map((item, index) => (
            <li
              key={item.text}
              className="flex items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-xs font-bold text-amber-400">
                {index + 1}
              </span>
              <item.icon
                className="mt-0.5 size-4 shrink-0 text-zinc-500"
                aria-hidden
              />
              <p className="text-sm leading-relaxed text-zinc-300">
                {item.text}
              </p>
            </li>
          ))}
        </ol>
      </div>

      <Separator className="bg-zinc-800" />

      {/* feedback */}
      <div className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-100">
            How did it turn out on TikTok?
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            One tap — it keeps the live success rate honest for everyone.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outline"
            disabled={feedbackState !== 'idle'}
            onClick={() => void handleFeedback('worked')}
            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200"
          >
            <ThumbsUp />
            Stayed sharp
          </Button>
          <Button
            variant="outline"
            disabled={feedbackState !== 'idle'}
            onClick={() => void handleFeedback('compressed')}
            className="border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200"
          >
            <ThumbsDown />
            Got compressed
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
