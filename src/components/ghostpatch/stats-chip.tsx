'use client';

import { useEffect, useState } from 'react';

import { api, STATS_REFRESH_EVENT, type Stats } from './api';

/**
 * Header pill: pulsing amber "engine online" dot + live counters
 * from GET /api/stats. Refreshes whenever a feedback vote lands
 * (window event) so the success rate stays honest.
 */
export function StatsChip() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await api<{ ok: true; stats: Stats }>('/api/stats', {
          cache: 'no-store',
        });
        if (!cancelled) setStats(res.stats);
      } catch {
        // backend warming up — the amber dot keeps glowing regardless
      }
    };

    const onRefresh = () => void load();
    void load();
    window.addEventListener(STATS_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(STATS_REFRESH_EVENT, onRefresh);
    };
  }, []);

  const tooltip = stats
    ? `Engine ${stats.engine.profileVersion} online`
    : 'Engine online';

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 py-1.5 pl-2.5 pr-3 text-xs text-zinc-400"
      title={tooltip}
    >
      <span className="sr-only">{tooltip}</span>
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-amber-400" />
      </span>
      <span className="hidden font-medium text-amber-400/90 sm:inline">
        engine online
      </span>
      {stats && (
        <>
          <span className="hidden text-zinc-700 sm:inline">·</span>
          <span className="hidden whitespace-nowrap sm:inline">
            {stats.patchesDone.toLocaleString('en-US')} videos patched
            {stats.successRate !== null &&
              ` · ${Math.round(stats.successRate)}% stayed sharp`}
          </span>
        </>
      )}
    </div>
  );
}
