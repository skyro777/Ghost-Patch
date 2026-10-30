# 🎬 LIVING BUILD PLAN — "GhostPatch" TikTok 4K Quality-Preserving Video Optimizer

> **THIS IS THE MASTER PLAN FOR THE NEXT BUILD PROMPT. DO NOT BUILD DURING THE RESEARCH SESSION.**
> Research completed 2026-10-24 · Verified verdict: **MOSTLY TRUE — technique works** (see `/home/z/my-project/research/VERDICT.md`)
> Next prompt should say: *"Execute Phase 1 of /home/z/my-project/TIKTOK-4K-BYPASS-BUILD-PLAN.md"*

---

## 0. MISSION

Build a production-ready web app (single `/` route, Next.js 16 App Router, this sandbox) that takes a user's high-quality 4K/60fps MP4/MOV and outputs a **container-patched version** that, when uploaded to TikTok via the **web/TikTok Studio path with proper settings**, is published with **near-zero additional compression** — preserving 4K-class resolution, 60fps (up to 120fps), and original bitrate. The patch performs **NO re-encoding of the video stream** (frames are byte-preserved); it forges TikTok's own "already-transcoded" container fingerprint so TikTok's ingest classifier skips or minimally applies its transcode.

**Working product name:** GhostPatch (rename freely). Tagline: *"Your 4K, actually 4K on TikTok."*

---

## 1. VERIFIED TECHNICAL FOUNDATION (why this works — condensed)

Evidence chain (full details + sources in `/home/z/my-project/research/VERDICT.md` and `/home/z/my-project/worklog.md` Tasks 1–3c):

1. TikTok re-encodes **every** normal upload into a delivery ladder (typical crush: 540–720p, even 15fps for "weak-signal" files — forensic proof: RTXFury's own "before" sample is 406×720@15fps 1.05Mbps).
2. TikTok's ingest classifier **reads MP4 sample tables & metadata FIRST** to pick a transcode profile (bitrate signal, fps from `mdhd` timescale ÷ `stts` deltas, duration from `mvhd`).
3. The patch forges the fingerprint of TikTok's OWN post-transcode output (ByteDance "EVC" encoder watermark, ghost/null sample tails, unknown durations, `edts` removal) → the classifier believes the file is already processed → transcode **skipped or minimal** → TikTok's CDN serves/stores the near-original (independently verified: TikTok retains `*_original.mp4` byte-identical on CDN).
4. Independently confirmed working: `youpzdev/tiktok-prep` author confirmed **4K + 120fps retained** (2026-10-18) and a user confirmed ghost-sample publishing (2026-10-17); the method scene has 100K+ view YouTube tutorials; RTXFury runs a 41,270-member Discord.
5. ⚠️ It is an **ARMS RACE**: TikTok periodically counter-patches (kroma-web variant dead; tiktok-prep regressed Aug→Sep 2026 then recovered). Success is NOT guaranteed per upload. → Engine must be **profile-versioned** with a kill-switch (§6).

**Upload discipline that MUST be coached in-product** (all verified):
- Upload via **tiktok.com web upload or TikTok Studio** — never the mobile app (app pre-compresses; iOS: pick from **Files app**, not gallery)
- Enable **"Upload HD"** (per-post, More options) + **"Allow high-quality uploads"** (Settings → Content preferences); Data Saver OFF
- Visibility **"Everyone"** (not "Only Me")
- **Never edit in-app** after upload (no sounds, trim, filters, text — forces server re-render)
- Export guidance: MP4/MOV, H.264 or HEVC, ≥1080p, **constant 60fps**, 10–40 Mbps, ≤500MB recommended (RTXFury caps premium at 500MB "to avoid playback lag on TikTok")
- Patched file shows **"0 seconds" duration locally — this is NORMAL and expected**

---

## 2. THE ENGINE — exact byte-level patch specification

### 2.1 Core library (TypeScript, no external deps): `src/lib/mp4/`

**`boxTree.ts`** — full ISOBMFF parser:
- Walk top-level boxes; recurse into containers: `moov, trak, mdia, minf, stbl, edts, udta, meta(handled: version/flags + children), ilst, moof, traf, dinf, mvex` — NEVER naive ASCII byte-search (collision risk inside `mdat`; agent 3-c verified this pitfall).
- Support `size==1` (64-bit largesize) and `size==0` (box extends to EOF).
- Represent as tree: `{ type, start, size, headerSize, children?, data? }`. Mpid parsing of `stsd` entry boxes (`avc1`, `hev1`, `mp4a`, `btrt`), `stts`, `stsz`, `stco/co64`, `stsc`, `elst`.
- **Read-only reference implementations to port from** (already in sandbox):
  - `/home/z/my-project/research/repo-clones/tiktok-prep_mp4boxes.py` + `tiktok-prep_mp4mask.py` (Python, most complete)
  - `/home/z/my-project/research/repo-clones/mp4patcher.js` (JS, 397 lines, null-frame mode)

**`inspector.ts`** — pre-flight scan (pure, used by API & optionally client):
- codec (from `stsd` entry type: `avc1`→H.264, `hev1/hvc1`→HEVC), width/height (`stsd` visual sample entry), fps (`mdhd` timescale ÷ avg `stts` delta — NOT `<video>` element, which misreads 120fps as 30), duration (`mvhd`), bitrate estimate (size×8/duration), audio presence, **faststart check** (`moov` offset < `mdat` offset), container brand (`ftyp`), health grade (codec ok / resolution / fps / moov position).

**`patcher.ts`** — patch operations (ALL preserve original media bytes; every op logged for the job record):

| # | Operation | Details (byte-exact) |
|---|---|---|
| P1 | `setMvhdUnknownDuration` | Rewrite `mvhd` as **version 1** (or keep v0), duration = `0xFFFFFFFFFFFFFFFF` (v1) / `0` (v0). v0 field offsets: timescale u32 BE @box+20, duration u32 @box+24. v1: timescale u32 @box+28, duration u64 @box+32. (From glitchfl/hamzavfx/tiktok-prep.) |
| P2 | `zeroTrackDurations` | `tkhd` duration u32 @box+28 (v0) / u64 @box+36 (v1) → 0; `mdhd` timescale+duration → 0 (v0: @box+20/+24; v1: @box+28/+32). **Never touch `stts`** — the contradiction IS the exploit. |
| P3 | `removeEdts` | Strip `edts` box from every `trak`; decrement parent `trak` size; chunk offsets unaffected (edts sits in moov, before mdat → must recalc offsets if moov size changes: easiest = rebuild file: `[ftyp][patched moov][free? removed][mdat]`). |
| P4 | `addGhostAudioSamples` | If AAC track exists: append **9 ghost samples per real sample** (10× count). Each ghost = 8 bytes `00 00 00 04 00 00 00 00`, **1-tick duration** each, all in ONE new chunk placed **after all top-level boxes (outside mdat)**. Update: `stts` (append/merge entry `(N,1)`), `stsz` (append 8s), `stsc` (new final chunk), `stco/co64` (append new chunk offset), `mdhd`/`tkhd` durations **unchanged** (contradiction). Note: tail is invalid AAC (audio decode errors at tail are EXPECTED; video decode must stay 100%). |
| P5 | `addNullVideoTail` | bitonito Mode 3: append N null video samples — `stts` append `(N, 1500)`; `stsz` append 8-byte entries; single 8-byte stub chunk outside mdat; recalc offsets. (Real TikTok output reference: `stts [(784,512),(8573,1500)]`, stsz 9357 entries vs 784 real.) |
| P6 | `scaleTimescale` | `mdhd` timescale ×2 (60fps→"120") or ×4 (120fps), duration kept or scaled (variants: ut0ku ×2/×4; glitchfl "TikTok rule" ×(30/fps); glitchfl legacy → normalize to 30000). |
| P7 | `setTooTag` | `udta/meta/ilst/©too` = compact JSON: `{"aid":"0","libevc":"0","trans_type":"-2","te_is_reencode":"0","br_ul":"<target_bps>","br_max":"<max_bps>"}` (reference real-TikTok values for study: `{"aid":"0","libevc":"1","trans_type":"4","te_is_reencode":"1"}`). Keep/preserve `btrt` boxes in `stsd`. |
| P8 | `stripEmptyFreeBox` | Remove empty `free` box before `mdat`; recalc `stco/co64`. |
| P9 | `ensureFaststart` | If `moov` after `mdat`: remux via ffmpeg `-c copy -movflags +faststart` first (no re-encode). |

**`profiles.ts`** — Engine profiles (versioned, stored in DB, referenced by version string in job record):

| Profile | Recipe | Use case | Status |
|---|---|---|---|
| **v1-ghost** (default "Ghost") | P9 → P1 → P3 → P4 → P8 → P7 | The verified tiktok-prep "Stealth" recipe (no re-encode, any resolution incl. 4K/120fps source) | PRIMARY |
| **v2-zero** ("Zero") | P9 → P1 → P2 → P3 → P8 | Simplest (glitchfl) — zeroed durations; fallback if v1 degrades | FALLBACK |
| **v3-inflate** ("Inflate") | P9 → P6 (×2 or ×4) → P3 | ut0ku 120fps variant — for 60/120fps retention | FALLBACK |
| **v4-nulltail** ("NullTail") | P9 → P1 → P3 → P5 → P8 | bitonito null-frame tail variant | EXPERIMENTAL |

**`verifier.ts`** — post-patch symptom validation (run automatically on every job; store report in job record):
- ffprobe: format duration ≈ 0 / N/A ✓; fps reads garbage or inflated ✓
- ffmpeg decode: `ffmpeg -v error -i out.mp4 -map 0:v -f null -` → **video frame count == original** (audio tail errors allowed on v1/v4)
- file plays "0 seconds" (expected symptom, surface in UI copy)
- If verification fails → job marked FAILED with reason; never serve a broken output.

**`ffmpeg.ts`** — spawn `/usr/bin/ffmpeg` (7.1.5 present) for engine encode modes:

| Mode | Command template |
|---|---|
| Normalize ≤1080p (tiktok-prep "Stealth" encode) | `ffmpeg -i in -map 0:v:0 -map 0:a:0? -c:v libx264 -profile:v main -level 5.2 -preset medium -refs 1 -bf 3 -g <2×fps> -keyint_min <fps> -b:v <target> -maxrate <2×target> -bufsize <3×target> -c:a aac -b:a 200k -ar 48000 -movflags +faststart out.mp4` (target = input_size×8/mvhd_duration; fallback 0.232 bits/pixel) |
| Normalize 4K/120 "Max" | `-c:v libx264 -profile:v main -level 6.0 -preset slow -refs 4 -crf 14 -maxrate 240M -bufsize 240M` (cap 3840×2160, 120fps, never upscale) |
| HEVC→H.264 convert | `-c:v libx264 -profile:v high -crf 16 -preset medium` + patch ops |
| Faststart remux | `-c copy -movflags +faststart` |

(SEI `evc0 v1.4.2.2-20260920` keyframe watermark is encode-mode-only (needs x264 SEI injection) — defer to Phase 3; patch-only profiles work without it per tiktok-prep's no-encode path & RTXFury "Original" engine.)

---

## 3. ARCHITECTURE (this sandbox)

```
Browser (single / route)                 Next.js 16 (port 3000)
┌──────────────────────────┐            ┌─────────────────────────────┐
│ Dropzone → preflight scan│──POST──▶   │ /api/scan      (FFI: small)  │
│ Chunked upload (2–8MB)   │──PUT───▶   │ /api/jobs/:id/chunk          │
│ Poll progress            │──GET───▶   │ /api/jobs/:id                │
│ Download patched file    │──GET───▶   │ /api/jobs/:id/download       │
│ Report outcome 👍/👎      │──POST──▶   │ /api/jobs/:id/feedback       │
└──────────────────────────┘            │ /api/analyze (Phase 2)       │
                                        │ /api/stats (public counters) │
                                        └──────────────┬──────────────┬─┘
                                          src/lib/mp4  │  ffmpeg spawn │
                                          Prisma SQLite│  (child_process)
```

- **API routes only, no server actions** (rule). Large files: client slices into chunks → `PUT /api/jobs/:id/chunk?index=n&total=N` streams to disk (`/home/z/my-project/db/uploads/<jobId>/`) → server assembles → process. This mirrors RTXFury's Railway chunked design and dodges body limits.
- Job queue: simple in-process async queue (memory) + DB status (`QUEUED→SCANNED→UPLOADING→PROCESSING→VERIFYING→DONE|FAILED`); progress % = chunks received + pipeline stage; SSE or polling (polling is fine; WebSocket mini-service unnecessary for MVP).
- ffmpeg access via `child_process.spawn` in route handlers (`export const runtime = 'nodejs'`). ffmpeg 7.1.5 confirmed at `/usr/bin/ffmpeg`.
- Cleanup cron: delete job files after 1–2h (also on job GET if expired).
- No auth for MVP (anonymous daily limits by IP via DB). Phase 3: Discord OAuth tiers like RTXFury.

### Prisma schema (`prisma/schema.prisma`, SQLite in `db/`)

```prisma
model Job {
  id            String   @id @default(cuid())
  status        String            // QUEUED|SCANNED|UPLOADING|PROCESSING|VERIFYING|DONE|FAILED
  error         String?
  originalName  String
  sizeBytes     Int
  meta          String            // JSON: codec,w,h,fps,duration,faststart,audio,health
  engineMode    String            // patch-ghost|patch-zero|patch-inflate|patch-nulltail|encode-1080|encode-4k|convert-h264
  profileVersion String           // engine profile id used
  outputSize    Int?
  verifyReport  String?           // JSON: symptoms checked
  feedback      String?           // worked | compressed | not_posted | null
  ipHash        String?
  createdAt     DateTime @default(now())
  completedAt   DateTime?
}
model EngineProfile {
  id        String  @id                    // "v1-ghost"
  version   Int
  recipe    String                         // JSON patch recipe
  active    Boolean @default(true)         // kill-switch
  notes     String?
  createdAt DateTime @default(now())
}
model Stat { id String @id @default("global"); patchesDone Int @default(0); feedbackGood Int @default(0); feedbackBad Int @default(0) }
```

---

## 4. UI/UX SPEC (single `/` route, dark "gaming" theme — NO blue/indigo)

**Theme:** near-black `#0a0a0b` background, **amber/orange accent** (fits RTX/fury aesthetic), emerald for success states. All existing shadcn/ui components; Lucide icons; framer-motion micro-transitions; sticky footer (`min-h-screen flex flex-col` + `mt-auto`); fully responsive mobile-first; touch targets ≥44px.

**Page structure (top→bottom):**
1. **Header** (sticky): logo mark (Ghost icon + "GhostPatch"), nav anchors (Optimizer / How it works / FAQ), GitHub-style stats chip (`patches done` live from `/api/stats`)
2. **Hero**: H1 "Your 4K, actually 4K on TikTok." sub: "TikTok crushes every upload to ~720p. GhostPatch re-codes your MP4 container — not your pixels — so TikTok skips its compression. No re-encoding. Zero quality loss." CTA scroll to dropzone. Small trust row: "Verified technique · Open recipe · Works with TikTok Studio & web upload"
3. **Dropzone card** (the core): drag/drop + click, accept `.mp4/.mov/.m4v`; after pick → **pre-flight scan panel** (Size / Resolution / Duration / FPS / Codec / Health chip green-amber-red based on caps: codec H.264✓/HEVC△(suggest convert)/other✗, ≤500MB, ≤2160p, fps 24–120, faststart ✓/remux-needed); engine mode selector (radio cards):
   - 🥇 **Ghost (recommended)** — v1-ghost patch, no re-encode, keeps everything
   - Zero / Inflate / NullTail — "advanced variants (try if Ghost gets compressed)"
   - **Convert HEVC→H.264 first** (auto-suggested when HEVC detected)
   - **Re-encode 1080p / 4K Max** (ffmpeg normalize + patch; for messy sources)
4. **Progress card**: chunk upload %, pipeline stages (Upload → Scan → Patch → Verify), live log lines, cancel button
5. **Result card**: big Download button (`ghostpatch-<name>.mp4`), verified-symptoms checklist (duration reads 0s ✓ expected, frames intact ✓), **UPLOAD CHECKLIST** (numbered, copy-to-clipboard): ① Download the file ② Go to tiktok.com → Upload (or TikTok Studio) on DESKTOP ③ Turn ON "Upload HD" / enable "Allow high-quality uploads" ④ Visibility: Everyone ⑤ Do NOT trim/add sounds/filters in-app ⑥ (iOS) pick file from Files app ⑦ Post — then verify with the Analyzer (Phase 2) or by downloading your posted video. Feedback buttons: "Worked 👍 / Got compressed 👎" (feeds profile success-rate).
6. **Before/After compare slider** (own demo assets: generate with ffmpeg `testsrc2` — one side 406×720@15 1Mbps, other 2160×1216@60 8Mbps, same content)
7. **How it works** (3 cards, honest): ① TikTok's classifier reads your file's metadata first ② We forge the fingerprint of TikTok's own transcoded output (unknown duration, ghost samples, stripped edit lists — frames untouched) ③ The classifier skips the re-encode → your near-original is what TikTok stores & serves. Include the "0 seconds is normal" callout.
8. **FAQ** (from verified findings): Is this guaranteed? (No — TikTok can change processing anytime; that's why multiple profiles + feedback loop); Does it work from the phone app? (No — app pre-compresses); Why 0 seconds duration?; Recommended export settings; 120fps?; Is my video uploaded anywhere? (deleted after 1h); Legal/not affiliated.
9. **Footer** (sticky-to-bottom): links, "Not affiliated with TikTok. Use responsibly.", v1.0

**Long-list handling**: FAQ accordion; live job log `max-h-96 overflow-y-auto` custom scrollbar.

---

## 5. API CONTRACT

```
POST /api/scan        { fileMeta }                  → light scan info (client also parses boxes locally)
POST /api/jobs        { name, size, engineMode }    → { jobId, chunkSize, totalChunks }
PUT  /api/jobs/:id/chunk?index=n  (binary body)    → { received: n+1 }
POST /api/jobs/:id/process                          → starts pipeline → { status }
GET  /api/jobs/:id                                  → { status, progress, stage, meta, verifyReport?, error? }
GET  /api/jobs/:id/download                        → streams patched mp4 (Content-Disposition)
POST /api/jobs/:id/feedback  { verdict }            → { ok } (updates Stat + profile success rate)
GET  /api/stats                                     → { patchesDone, successRate, engine: profileVersion+active }
```
All routes: `runtime = 'nodejs'`, JSON errors with actionable messages, 10 req/min/IP on job creation (in-memory limiter).

---

## 6. ARMS-RACE STRATEGY (critical — methods decay)

1. **Versioned profiles** in DB; job records store `profileVersion` → correlate with feedback.
2. **Feedback loop**: 👍/👎 per job → per-profile success rate on `/api/stats`; UI shows live "profile health".
3. **Kill-switch**: `EngineProfile.active=false` flips default to best-rated fallback profile instantly.
4. **Harvest protocol** (documented in-app "How we keep it working"): when users report compression, they can submit the TikTok-served file → admin diffs its atoms against our recipe (repeating exactly what tiktok-prep did Aug→Sep 2026) → ship new profile version.
5. Honest disclaimers everywhere (no guarantees; TikTok's choice).

---

## 7. BUILD PHASES (for next prompts)

### Phase 1 — MVP ✅ **DONE (2026-10-24, see worklog Tasks 1-a…6)**
Built as "GhostPatch": src/lib/mp4 engine (boxTree/inspector/patcher/verifier/ffmpeg; profiles v1-ghost/v2-zero/v3-inflate; MD5-proven bit-exact video preservation), pipeline (auto faststart remux, HEVC convert, 1080/4K encode, silent-audio carrier for no-audio files), 8 API routes (chunked upload, janitor, rate limits), full dark+amber single-page UI (scan panel, 6 engine cards, live log, result + 7-step checklist, feedback loop, stats chip). All browser-E2E verified. Deviations: used Next API routes only (no mini-service needed); ghost tail = raw bytes after mdat (faithful to reference).

### Phase 1.5 (optional polish, next prompt candidates)
- Before/after compare slider with ffmpeg-generated demo assets (testsrc2 406×720@15 vs 2160×1216@60)
- "Patch another" analytics; download MD5 shown for user verification
- TikTok link Analyzer (/api/analyze) — Phase 2 core

### Phase 2 — Trust & polish
Compare slider w/ generated demo assets; profiles v3/v4; encode modes (1080/4K-Max/HEVC→H.264); **Analyzer** (`/api/analyze?url=`: resolve TikTok post → fetch delivered video → ffprobe → show real published res/fps/bitrate vs source; use oEmbed + public tikwm-style endpoints; handle geo-blocks gracefully — sandbox egress is HK); guides section; success-rate dashboard.

### Phase 3 — Growth
Discord OAuth tiers (free 3/day, booster, premium — mirror RTXFury model); auto-post via TikTok Content Posting API (`/v2/post/publish/inbox/video/init/` + chunked FILE_UPLOAD — the "clean path", or Zernio-style integration); SEI evc0 watermark in encode modes; admin profile mgmt + harvest diffing tool.

---

## 8. RISKS & LEGAL

- **Not affiliated with TikTok** — say it in footer & FAQ. This tool only modifies the **user's own file's container metadata** (no DRM circumvention, no platform access, no scraping required for core function).
- **No guarantees** — TikTok may change processing anytime (kroma precedent); disclaimers + kill-switch mitigate.
- **ToS gray zone** — metadata patching is not hacking; it's file preparation. Keep telemetry minimal (no video retention >1h, IP hashes only).
- Don't use RTXFury's name/assets/branding. Open recipe (tiktok-prep is CC-NC — do NOT copy code verbatim into a commercial product; port the *technique* with original implementation and note inspiration).

---

## 9. SANDBOX REFERENCE ARTIFACTS (all verified, all local)

| Path | Contents |
|---|---|
| `/home/z/my-project/research/VERDICT.md` | Full evidence verdict (read first) |
| `/home/z/my-project/worklog.md` | Tasks 1–3c detailed logs with all source URLs |
| `/home/z/my-project/research/rtxfury/` | RTXFury site capture (HTML/JS/config) |
| `/home/z/my-project/research/proof-videos/` | `after_patched.mp4` (2160×1216@60 7.4Mbps clean) + `before_compressed.mp4` (406×720@15 1Mbps) |
| `/home/z/my-project/research/repo-clones/` | `mp4patcher.js`; `tiktok-prep_{app.py, mp4boxes.py, mp4mask.py, SPEC.md, README.en.md}` ← **port the patcher from these** |
| `/home/z/my-project/research/tiktok-specs/` | Official TikTok API docs extracts (~20 files) |
| `/home/z/my-project/research/mp4test/` | Agent 3-c's local patch experiments (base/zeroed/scaled.mp4 + patch_test.py) |

**Key upstream sources:** github.com/youpzdev/tiktok-prep · github.com/bitonito/Tiktok-upload-method- · github.com/glitchfl/TikTok-FPS-Compression-Bypasser · github.com/ut0ku/120fps-method · github.com/dyokism/kroma-web (dead variant) · voidaep.dev/guides/tiktok-upload-method · tikhaze.com/guides/upload-tiktok-high-quality-no-compression · developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide · rtxfury.xyz/patcher (live)

---

## 10. DEFINITION OF DONE (Phase 1)

- [ ] User can drop a 4K60 MP4 (≤500MB), see pre-flight scan, pick Ghost profile, upload in chunks, watch progress, download patched file
- [ ] Patched file: ffprobe duration reads 0/N-A, fps garbage/0; ffmpeg decodes all original video frames; size ≈ original (±remux)
- [ ] Upload checklist + "0 seconds is normal" coaching visible on result card
- [ ] Feedback 👍/👎 stored; `/api/stats` live counters
- [ ] Sticky footer, responsive, dark amber theme, lint clean, dev.log clean, agent-browser E2E verified
- [ ] Worklog appended; this plan updated with "Phase 1 done + deviations"
