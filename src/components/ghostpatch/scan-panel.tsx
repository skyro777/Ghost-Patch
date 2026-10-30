'use client';

import {
  AudioLines,
  Binary,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Clock,
  Film,
  Gauge,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ScanMeta } from './api';
import {
  formatBitrate,
  formatBytes,
  formatDuration,
  formatFps,
  formatResolution,
} from './format';

const HEALTH: Record<
  ScanMeta['health'],
  { label: string; icon: LucideIcon; className: string }
> = {
  good: {
    label: 'Looks great',
    icon: CircleCheck,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  },
  warn: {
    label: 'Workable — see notes',
    icon: TriangleAlert,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  },
  bad: {
    label: 'Needs converting',
    icon: CircleAlert,
    className: 'border-red-500/30 bg-red-500/10 text-red-400',
  },
};

function codecLabel(meta: ScanMeta): string {
  switch (meta.codec) {
    case 'h264':
      return 'H.264';
    case 'hevc':
      return 'HEVC';
    case 'other':
      return meta.container ? `Other (${meta.container})` : 'Other';
    default:
      return 'Unknown';
  }
}

/** Pre-flight readout returned by POST /api/scan. */
export function ScanPanel({ meta, size }: { meta: ScanMeta; size: number }) {
  const bitrate = formatBitrate(size, meta.durationSec);
  const health = HEALTH[meta.health] ?? HEALTH.warn;
  const HealthIcon = health.icon;

  const chips: { label: string; value: string; sub?: string; icon: LucideIcon }[] = [
    {
      label: 'Size',
      value: formatBytes(size),
      sub: bitrate ?? undefined,
      icon: Clapperboard,
    },
    {
      label: 'Resolution',
      value: formatResolution(meta.width, meta.height),
      icon: Film,
    },
    { label: 'FPS', value: formatFps(meta.fps), icon: Gauge },
    { label: 'Duration', value: formatDuration(meta.durationSec), icon: Clock },
    { label: 'Codec', value: codecLabel(meta), icon: Binary },
    {
      label: 'Audio',
      value: meta.hasAudio ? 'Present' : 'None',
      icon: AudioLines,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {chips.map((chip) => (
          <div
            key={chip.label}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <chip.icon className="size-3 shrink-0" aria-hidden />
              {chip.label}
            </div>
            <p className="mt-1.5 truncate text-sm font-semibold text-zinc-100">
              {chip.value}
            </p>
            {chip.sub && <p className="text-[10px] text-zinc-600">{chip.sub}</p>}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <span
          className={cn(
            'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
            health.className,
          )}
        >
          <HealthIcon className="size-3.5" aria-hidden />
          {health.label}
        </span>

        {meta.notes.length > 0 && (
          <ul className="space-y-1">
            {meta.notes.map((note) => (
              <li
                key={note}
                className="flex items-start gap-1.5 text-xs leading-relaxed text-zinc-500"
              >
                <Info
                  className="mt-0.5 size-3 shrink-0 text-zinc-600"
                  aria-hidden
                />
                {note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
