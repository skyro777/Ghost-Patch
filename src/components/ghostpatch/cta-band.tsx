'use client';

import { ArrowDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Reveal } from './reveal';

export function CtaBand() {
  return (
    <section className="py-16 md:py-24">
      <div className="mx-auto max-w-6xl px-4">
        <Reveal>
          <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60 px-6 py-14 text-center md:py-16">
            <div
              aria-hidden
              className="gp-hero-glow absolute -top-24 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full blur-3xl"
            />
            <div className="relative">
              <h2 className="text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">
                Ready to keep your pixels?
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400 md:text-base">
                One file. One click. Zero re-encoding. Post it the right way
                and watch TikTok serve your master file, not a crushed copy.
              </p>
              <Button
                asChild
                size="lg"
                className="mt-8 h-12 bg-amber-500 px-8 text-sm font-semibold text-zinc-950 hover:bg-amber-400"
              >
                <a href="#optimizer">
                  Patch my video
                  <ArrowDown />
                </a>
              </Button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
