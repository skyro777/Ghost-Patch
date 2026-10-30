'use client';

import { CircleQuestionMark } from 'lucide-react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Reveal } from './reveal';

const ITEMS: { q: string; a: string }[] = [
  {
    q: 'Does this really stop TikTok from compressing my video?',
    a: 'TikTok re-encodes every upload by default. GhostPatch rewrites your MP4’s container metadata — not your pixels — to mimic the fingerprint of TikTok’s own transcoded output, so the ingest classifier skips or barely touches your file. Frames stay byte-identical.',
  },
  {
    q: 'Is it guaranteed?',
    a: 'No — and anyone promising that is lying. TikTok can change processing anytime. We ship multiple patch profiles, a community success-rate meter, and instant profile kill-switches. If one stops working, we fail over.',
  },
  {
    q: 'Why does my patched file show 0 seconds duration?',
    a: 'Expected. The movie duration atom is set to “unknown” — part of the forged fingerprint. Local players may show 0:00 but every frame is intact and TikTok plays it perfectly.',
  },
  {
    q: 'How exactly should I upload to TikTok?',
    a: 'Desktop web only: tiktok.com → Upload, or TikTok Studio. Enable “Upload HD” (plus Settings → Content preferences → Allow high-quality uploads). Visibility “Everyone”. Never trim, add sounds or filters in-app. On iPhone, pick the file from the Files app — not the gallery.',
  },
  {
    q: 'What export settings work best?',
    a: 'MP4 or MOV, H.264 (or HEVC — pick the converter), 1080p to 4K, constant 60fps, 10–40 Mbps, under 500 MB. Patch the final cut — never edit after patching.',
  },
  {
    q: 'Can I publish 120fps?',
    a: 'If your source is true 120fps, use the Inflate profile. Note: 120fps exceeds TikTok’s official 60fps cap — community tests confirm it can survive, but it’s the most fragile trick in the toolbox.',
  },
  {
    q: 'What happens to my video?',
    a: 'Processing runs on our server; files are auto-deleted within an hour. We never post, share, or train on anything.',
  },
  {
    q: 'Is this affiliated with TikTok?',
    a: 'No. GhostPatch is an independent tool. Not affiliated, endorsed, or sponsored. Use responsibly.',
  },
];

export function Faq() {
  return (
    <section
      id="faq"
      className="scroll-mt-20 border-t border-zinc-900/80 py-16 md:py-24"
    >
      <div className="mx-auto max-w-3xl px-4">
        <Reveal className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
            <CircleQuestionMark className="size-3" aria-hidden />
            FAQ
          </span>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-zinc-100 md:text-4xl">
            Questions, answered honestly
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400 md:text-base">
            No guarantees, no fine print hidden in the footer. Here’s exactly
            how it is.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <Accordion
            type="single"
            collapsible
            className="mt-10 rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 backdrop-blur sm:px-6"
          >
            {ITEMS.map((item, i) => (
              <AccordionItem
                key={item.q}
                value={`item-${i}`}
                className="border-zinc-800"
              >
                <AccordionTrigger className="text-left text-sm font-medium text-zinc-200 hover:no-underline hover:text-amber-200 sm:text-base">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-zinc-400">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
