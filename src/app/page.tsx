'use client';

import { CtaBand } from '@/components/ghostpatch/cta-band';
import { Faq } from '@/components/ghostpatch/faq';
import { Hero } from '@/components/ghostpatch/hero';
import { HowItWorks } from '@/components/ghostpatch/how-it-works';
import { Optimizer } from '@/components/ghostpatch/optimizer';
import { SiteFooter } from '@/components/ghostpatch/site-footer';
import { SiteHeader } from '@/components/ghostpatch/site-header';

export default function Home() {
  return (
    <div
      id="top"
      className="flex min-h-screen flex-col bg-[#0a0a0b] text-zinc-100"
    >
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Optimizer />
        <HowItWorks />
        <Faq />
        <CtaBand />
      </main>
      <SiteFooter />
    </div>
  );
}
