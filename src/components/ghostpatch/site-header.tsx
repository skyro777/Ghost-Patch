'use client';

import { Ghost } from 'lucide-react';

import { StatsChip } from './stats-chip';

const NAV_ITEMS = [
  { label: 'Optimizer', href: '#optimizer' },
  { label: 'How it works', href: '#how' },
  { label: 'FAQ', href: '#faq' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-900 bg-black/60 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
        <a
          href="#top"
          className="flex shrink-0 items-center gap-2.5"
          aria-label="GhostPatch — back to top"
        >
          <span className="flex size-8 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
            <Ghost className="size-[18px] text-amber-400" />
          </span>
          <span className="text-base font-bold tracking-tight text-zinc-100">
            GhostPatch
          </span>
        </a>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex min-h-11 items-center text-sm text-zinc-400 transition-colors hover:text-zinc-100"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <StatsChip />
      </div>
    </header>
  );
}
