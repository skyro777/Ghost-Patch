'use client';

import {
  Fingerprint,
  Hourglass,
  ScanSearch,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { Reveal } from './reveal';

const STEPS: {
  icon: LucideIcon;
  step: string;
  title: string;
  body: string;
}[] = [
  {
    icon: ScanSearch,
    step: '01',
    title: 'TikTok scans metadata first',
    body: 'Before compressing, TikTok’s pipeline reads your MP4’s sample tables — duration, frame timing, bitrate signals — to decide how hard to crush it.',
  },
  {
    icon: Fingerprint,
    step: '02',
    title: 'We forge the fingerprint',
    body: 'GhostPatch rewrites those atoms to match TikTok’s own post-transcode output: unknown duration, ghost samples, stripped edit lists. Your frames stay byte-identical.',
  },
  {
    icon: ShieldCheck,
    step: '03',
    title: 'The compressor stands down',
    body: 'Fooled into thinking your file is already processed, TikTok skips the re-encode and keeps your near-original master on its CDN.',
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="scroll-mt-20 border-t border-zinc-900/80 py-16 md:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <Reveal className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
            <Fingerprint className="size-3" aria-hidden />
            HOW IT WORKS
          </span>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">
            Three atoms between you and 720p
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400 md:text-base">
            TikTok’s compressor trusts what it reads in your container. So we
            hand it something worth trusting.
          </p>
        </Reveal>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <Reveal key={step.step} delay={i * 0.08} className="h-full">
              <div className="group h-full rounded-xl border border-zinc-800 bg-zinc-950/60 p-6 backdrop-blur transition-transform duration-300 hover:scale-[1.01]">
                <div className="flex items-center justify-between">
                  <span className="flex size-11 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-400">
                    <step.icon className="size-5" aria-hidden />
                  </span>
                  <span className="font-mono text-xs font-semibold text-zinc-700">
                    {step.step}
                  </span>
                </div>
                <h3 className="mt-5 text-base font-semibold text-zinc-100">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  {step.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.15}>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="flex gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-6 backdrop-blur">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300">
                <ShieldCheck className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold text-zinc-100">
                  Is this legit?
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                  Yes — this exact container-patch technique is verified by the
                  open-source community and used by paid tools in this niche.
                  It’s also a cat-and-mouse game: TikTok can change its pipeline
                  anytime. That’s why GhostPatch ships multiple profiles, a live
                  success rate, and a kill-switch.
                </p>
              </div>
            </div>
            <div className="flex gap-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-6 backdrop-blur">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400">
                <Hourglass className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold text-zinc-100">
                  Patched file shows “0 seconds”? Normal.
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                  The movie duration atom is deliberately set to “unknown” —
                  it’s part of the forged fingerprint. Local players may show
                  0:00, but every frame is intact and TikTok plays it
                  perfectly.
                </p>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
