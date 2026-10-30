'use client';

import { TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { EngineMode, ScanMeta } from './api';
import { ENGINES } from './engines';
import { formatBytes, formatFps } from './format';

function Note({
  tone,
  children,
}: {
  tone: 'amber' | 'red';
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed',
        tone === 'amber' &&
          'border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
        tone === 'red' && 'border-red-500/25 bg-red-500/[0.06] text-red-200/90',
      )}
    >
      <TriangleAlert
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          tone === 'amber' ? 'text-amber-400' : 'text-red-400',
        )}
        aria-hidden
      />
      <span>{children}</span>
    </p>
  );
}

/**
 * Radio-card grid of patch profiles. Scan-driven behaviour:
 * - HEVC detected → "Convert HEVC → H.264" highlighted as suggested
 * - non-MP4 codec → only the converter is selectable (with a warning)
 * - fps > 60 → hint on Inflate
 * - size > 350 MB → playback-lag warning under the grid
 */
export function EnginePicker({
  meta,
  fileSize,
  value,
  onChange,
}: {
  meta: ScanMeta;
  fileSize: number;
  value: EngineMode;
  onChange: (mode: EngineMode) => void;
}) {
  const otherContainer = meta.codec === 'other';
  const hevcSuggested = meta.codec === 'hevc';
  const highFps = meta.fps !== null && meta.fps > 60;
  const oversize = fileSize > 350 * 1024 * 1024;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
          Patch profile
        </p>
        <p className="hidden text-[10px] text-zinc-600 sm:block">
          patch modes never re-encode your frames
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Patch profile"
        className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
      >
        {ENGINES.map((engine) => {
          const disabled = otherContainer && engine.id !== 'convert-h264';
          const selected = value === engine.id;
          const suggested = engine.id === 'convert-h264' && hevcSuggested;

          return (
            <button
              key={engine.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(engine.id)}
              className={cn(
                'group relative rounded-xl border p-3.5 text-left outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-amber-500/40',
                selected
                  ? 'border-amber-500/60 bg-amber-500/[0.07] shadow-[0_0_36px_-14px_rgba(251,191,36,0.45)]'
                  : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-600 hover:bg-zinc-900/70',
                disabled &&
                  'cursor-not-allowed opacity-40 hover:border-zinc-800 hover:bg-zinc-900/40',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
                    selected
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                      : 'border-zinc-700/80 bg-zinc-900 text-zinc-400 group-hover:text-zinc-300',
                  )}
                >
                  <engine.icon className="size-[18px]" aria-hidden />
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    selected
                      ? 'border-amber-400'
                      : 'border-zinc-700 group-hover:border-zinc-500',
                  )}
                >
                  {selected && <span className="size-2 rounded-full bg-amber-400" />}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <p className="text-sm font-semibold text-zinc-100">
                  {engine.name}
                </p>
                {engine.recommended && (
                  <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-amber-950">
                    Recommended
                  </span>
                )}
                {suggested && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                    Suggested for your file
                  </span>
                )}
                {engine.advanced && !suggested && (
                  <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                    Advanced
                  </span>
                )}
                {engine.reencodes && (
                  <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
                    re-encodes
                  </span>
                )}
              </div>

              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                {engine.tagline}
              </p>

              {engine.id === 'inflate' && highFps && (
                <p className="mt-2 text-xs font-medium text-amber-400/90">
                  Your source reads {formatFps(meta.fps)} — Inflate is built
                  for this.
                </p>
              )}
            </button>
          );
        })}
      </div>

      {otherContainer && (
        <Note tone="red">
          This file isn’t an MP4-family container
          {meta.container ? ` (${meta.container})` : ''} — patch-only profiles
          have no atoms to rewrite. Only the H.264 converter can process it,
          and the Ghost patch rides along.
        </Note>
      )}
      {oversize && (
        <Note tone="amber">
          {formatBytes(fileSize)} is past the ~350 MB sweet spot — TikTok
          playback can buffer on heavy files. A 1080p re-encode or a shorter
          cut uploads safer.
        </Note>
      )}
    </div>
  );
}
