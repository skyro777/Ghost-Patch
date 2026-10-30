# GhostPatch
**[Click Here to Open Site : https://ghostpatch.space-z.ai](https://ghostpatch.space-z.ai)**

Patch your videos for TikTok without losing quality.

TikTok re-encodes every upload, and sometimes visibly crushes quality. GhostPatch
preps your video so the re-encode stays as close to the original as possible:
it inspects the file (codec, resolution, bitrate, frame rate, moov placement),
recommends the best strategy, then runs the patch — **bit-exact video track,
ghost fingerprint verification, no re-encode quality loss**.

## Features

- 🔍 **Deep scan** — codec / resolution / fps / bitrate / moov detection before
  anything touches your file
- 🎯 **6 patch engine modes** (incl. ghost fingerprint) with a recommended
  default
- 🧩 **Chunked upload (8 MB)** and **segmented, resumable download** — survives
  flaky proxies, no long-lived streaming connections
- 🛡️ **Verification pass** — decoded-frames parity check so you know the patch
  didn't corrupt anything
- 🧹 **Zero-cleanup burden** — job files auto-delete after ~2h (built-in janitor)
- ⚖️ Disk-space guard — refuses new jobs with a clean error (507) instead of
  ever producing truncated files

## Stack

Next.js 16 (App Router, TypeScript) · Tailwind CSS 4 · shadcn/ui · Prisma +
SQLite · ffmpeg

## Run it

### Local dev

```bash
bun install
bun run db:push
bun run dev        # http://localhost:3000
```

Requires `ffmpeg` on PATH (the patch engine).

### Docker (any host, ARM64 or x64)

```bash
docker compose up -d --build
# → http://localhost:3000  (image bundles ffmpeg + migrated SQLite db)
```

Job videos are ephemeral by design (2h TTL) — only the tiny stats counter lives
in SQLite, persisted in the `ghostpatch-db` named volume.

## Deploy free on Oracle Cloud

See **[docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md)** — a step-by-step guide to
running GhostPatch 24/7 on Oracle's Always Free ARM tier (2 OCPU / 12 GB RAM /
200 GB storage / 10 TB egress per month).

## Notes

- Max input size: 500 MB per video (MP4 / MOV).
- Everything runs server-side; files are deleted automatically — nothing is
  kept after ~2 hours.
- Use responsibly and in line with the platforms' terms of service.
