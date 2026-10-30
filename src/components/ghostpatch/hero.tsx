'use client';

import { motion } from 'framer-motion';
import { ArrowDown, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* backdrop: faint grid + radial amber glow */}
      <div aria-hidden className="gp-grid-bg absolute inset-0" />
      <div
        aria-hidden
        className="gp-hero-glow absolute -top-32 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full blur-3xl"
      />

      <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-20 text-center md:pb-24 md:pt-28">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="flex flex-col items-center"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3.5 py-1.5 text-xs font-medium text-amber-300">
            <Sparkles className="size-3.5" />
            Verified technique · No re-encoding · Frames untouched
          </span>

          <h1 className="mt-7 max-w-3xl text-4xl font-bold tracking-tight text-zinc-100 sm:text-5xl md:text-6xl">
            Your 4K,{' '}
            <span className="bg-linear-to-r from-amber-300 via-amber-400 to-amber-500 bg-clip-text text-transparent">
              actually 4K
            </span>{' '}
            on TikTok.
          </h1>

          <p className="mt-6 max-w-2xl text-base leading-relaxed text-zinc-400 md:text-lg">
            TikTok crushes every upload to ~720p. GhostPatch rewrites your
            MP4’s container — never your pixels — so TikTok’s compressor stands
            down. Upload the patched file and keep true 4K 60fps.
          </p>

          <div className="mt-9 flex flex-col items-center gap-4 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 bg-amber-500 px-8 text-sm font-semibold text-zinc-950 shadow-[0_0_44px_-12px_rgba(251,191,36,0.55)] hover:bg-amber-400"
            >
              <a href="#optimizer">
                Patch my video
                <ArrowDown />
              </a>
            </Button>
            <a
              href="#how"
              className="inline-flex min-h-11 items-center text-sm font-medium text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
            >
              How it works
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
