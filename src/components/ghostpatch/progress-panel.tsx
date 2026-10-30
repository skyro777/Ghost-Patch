'use client';

import { useEffect, useRef } from 'react';
import { LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/**
 * Live progress card shown while chunks upload (0–50%) and the engine
 * processes (50–100%). Log auto-scrolls; thin custom `.gp-scroll` scrollbar.
 */
export function ProgressPanel({
  percent,
  stageLabel,
  detail,
  lines,
  onCancel,
}: {
  percent: number;
  stageLabel: string;
  detail: string;
  lines: string[];
  onCancel: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className="space-y-5" aria-live="polite">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <LoaderCircle
            className="size-5 shrink-0 animate-spin text-amber-400"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-zinc-100">
              {stageLabel}
            </p>
            <p className="truncate text-xs text-zinc-500">{detail}</p>
          </div>
        </div>
        <p className="shrink-0 text-2xl font-bold tabular-nums text-amber-400">
          {clamped}%
        </p>
      </div>

      <Progress
        value={Math.max(2, clamped)}
        aria-label="Patch progress"
        className="h-2.5 bg-zinc-900 [&_[data-slot=progress-indicator]]:bg-amber-500 [&_[data-slot=progress-indicator]]:shadow-[0_0_16px_rgba(251,191,36,0.45)]"
      />

      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
          Engine log
        </p>
        <div
          ref={logRef}
          className="gp-scroll max-h-64 overflow-y-auto rounded-lg border border-zinc-800 bg-black/70 p-3 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="text-zinc-600">waiting for engine output…</p>
          ) : (
            lines.map((line, i) => (
              <p
                key={`${i}-${line}`}
                className={cn(
                  'whitespace-pre-wrap break-words',
                  i === lines.length - 1 ? 'text-zinc-300' : 'text-zinc-500',
                )}
              >
                <span className="text-zinc-700" aria-hidden>
                  ▸{' '}
                </span>
                {line}
              </p>
            ))
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="h-11 border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <X />
          Cancel
        </Button>
      </div>
    </div>
  );
}
