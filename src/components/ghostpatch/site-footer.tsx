'use client';

import { Ghost } from 'lucide-react';

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-zinc-900 bg-black/40">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
              <Ghost className="size-[18px] text-amber-400" />
            </span>
            <div>
              <p className="text-sm font-semibold text-zinc-100">GhostPatch</p>
              <p className="text-xs text-zinc-500">Your 4K, actually 4K.</p>
            </div>
          </div>

          <nav
            className="flex items-center gap-6 text-sm text-zinc-400"
            aria-label="Footer"
          >
            <a
              href="#how"
              className="inline-flex min-h-11 items-center transition-colors hover:text-zinc-100"
            >
              How it works
            </a>
            <a
              href="#faq"
              className="inline-flex min-h-11 items-center transition-colors hover:text-zinc-100"
            >
              FAQ
            </a>
          </nav>
        </div>

        <div className="mt-8 flex flex-col justify-between gap-3 border-t border-zinc-900 pt-6 md:flex-row md:items-center">
          <p className="max-w-2xl text-xs leading-relaxed text-zinc-600">
            Not affiliated with TikTok. Use responsibly. No method is 100% —
            TikTok can change its pipeline at any time.
          </p>
          <p className="shrink-0 text-xs text-zinc-600">v1.0 · Engine v1-ghost</p>
        </div>
      </div>
    </footer>
  );
}
