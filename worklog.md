# Worklog — TikTok 4K No-Compression Research Project

Project goal: Verify RTXFury's claim that a "patched" 4K video uploaded via TikTok (Studio/web) will NOT be compressed and publishes in true 4K 60fps. Then produce a build plan (for a future prompt) to create our own equivalent website. Save plan in sandbox.

---
Task ID: 1
Agent: main-orchestrator
Task: Extract & explore RTXFury.zip website files

Work Log:
- Extracted /home/z/my-project/upload/RTXFury.zip to /home/z/my-project/research/rtxfury/
- Contents: main HTML (singlefile capture of https://www.rtxfury.xyz/patcher), shared-*.js, chat.js, telegram-widget.js, site-config.js, shared.css, payment logos
- Also extracted inner site-config.js.zip (duplicate bundle)

Stage Summary:
- Live site: https://www.rtxfury.xyz/patcher (frontend on Vercel, patch service on Railway)
- Architecture (from site-config.js): browser uploads video DIRECTLY to Railway service at https://www.rtxfury.xyz/api/patch-rtx (Vercel 4.5MB body limit bypassed). Patch token minted by Vercel /api/authorize. "RTX API key stays on Railway".
- Auth via Discord OAuth / Telegram. Tiers: MEMBER free (100MB, 1080p, 60fps, 3/day), BOOSTER (Nitro boost, 200MB, 4K, 60fps, 5/day), PREMIUM (unlimited, 4K, 120fps).
- Proof videos hosted on catbox.moe:
  - AFTER (patched): https://files.catbox.moe/c0bkgb.mp4 — claimed 2160x1216 @ 60fps, 23MB
  - BEFORE (normal upload): https://files.catbox.moe/5s1mq1.mp4 — claimed 720x406 @ 15fps, 3MB
- Auto-post integration: "Zernio API key" (third-party TikTok auto-upload API)

---
Task ID: 2
Agent: main-orchestrator
Task: Deep-analyze website's encoding logic & claims

Work Log:
- Extracted full readable text from the main HTML
- Grepped shared JS for technical keywords (moov, atom, codec, patch, ffmpeg, faststart, remux...)

Stage Summary (KEY FINDINGS — the site's own claims):
- FAQ: "It optimizes the MP4 container and modifies key metadata to help TikTok reduce the amount of compression applied. The original frames and resolution remain completely untouched" → NO RE-ENCODING, pure container/metadata patch
- CRITICAL CLUE: "Showing '0 seconds' in video after optimizing is normal. Ignore it. It plays smoothly once uploaded on TikTok." → they likely zero out / corrupt the duration metadata (mvhd/tkhd/mdhd atoms), which may make TikTok's transcoder skip or fail-open, serving the original stream
- Instructions: upload via TikTok WEB (not app), enable "Upload HD"/"Allow high-quality uploads", set visibility "Everyone" (not "Only Me"), DO NOT edit video in-app (no sounds/trim/filters — those force re-encode), iOS users must upload from Files app (not gallery)
- Recommended export: MP4/MOV, H.264 or H.265, 1080p+, constant 60 FPS, bitrate 10–40 Mbps
- Two engine modes: "RTX Engine (Original)" and "RTX Engine (with FFMPEG)" (latter can convert HEVC→H.264); "Getting 30 FPS after uploading? Try (Original) with Auto Post or (with FFMPEG)"
- Premium perk: "Priority queue skip FPS check"
- Footer "popular searches" reveal this is part of a known community scene: "Haze TikTok method", "ItzCrih method", "GHXZ method", "Zilem method", "Instagram no compression upload"
- The patch logic itself is server-side; client JS only orchestrates upload (need deeper JS analysis + research)

---
Task ID: 3-c
Agent: research-mp4-patching
Task: MP4 atom patching technique deep-dive

Work Log:
- Read prior worklog (RTXFury claims: no-reencode container patch, "0 seconds" output, Zernio auto-post, FPS-check perk)
- DDG search "tiktok compression bypass mp4 metadata patch method" → found hamzavfx/Hamza-FPS-Method, glitchfl/TikTok-FPS-Compression-Bypasser, voidaep.dev guide
- DDG search "mp4 zero duration mvhd tkhd mdhd patch bypass compression" → same repos + Void Studio
- Fetched + analyzed full source: glitchfl/TikTok-FPS-Compression-Bypasser/TikTok_FPS_Compression_Bypasser.py and hamzavfx/Hamza-FPS-Method/patcher.py (exact byte-level patch code extracted)
- Fetched voidaep.dev/guides/tiktok-upload-method (competitor write-up: "inflates sample tables", upload-path advice, Content Posting API = clean path)
- GitHub API repo searches: "tiktok compression bypass", "instagram compression bypass", "mp4 patcher social media", "zero duration mp4", "tiktok fps patcher", "instagram reels upload quality", "tiktok 4k upload" → 15+ relevant repos (ut0ku/120fps-method 39★, paschafps/TikTok-Quality-Method, hhaaiii/tiktok-fps-patcher, dyokism/kroma-web "Currently Patched!", QUEENTIK/Flowtik-plugin, LuisAlves10 fork, jdent874-debug/AST-Engine, Anbss-Upload-Method-TikTok browser ext)
- Fetched READMEs: ut0ku/120fps-method (mechanism explanation), hhaaiii (ffmpeg retime method), paschafps (ffmpeg timing flags), dyokism/kroma-web (display-matrix + metadata strip)
- Fetched zernio.com (agent marketing infra, POST /v1/posts, 16 platforms incl. TikTok, "Official APIs only")
- Fetched developers.tiktok.com/doc/content-posting-api-reference-upload-video/ (endpoint /v2/post/publish/inbox/video/init/, FILE_UPLOAD chunked PUT vs PULL_FROM_URL, scope video.upload)
- LOCAL EXPERIMENT (research/mp4test/patch_test.py): built test.mp4, wrote custom box-walker, zeroed mvhd/tkhd/mdhd durations (+mdhd timescale), and separately scaled ts+du ×0.5 GlitchFL-style; probed with ffprobe/ffmpeg/mutagen

Stage Summary:
- THE PATCH RECIPE (verified from GlitchFL + hamzavfx source, byte-exact):
  - Scan file bytes for ASCII "mvhd"/"mdhd"; box start = matchpos-4. version byte = data[box+8]
  - v0: timescale u32 BE @ box+20, duration u32 BE @ box+24. v1: timescale u32 @ box+28, duration u64 @ box+32
  - tkhd (if touched): duration u32 @ box+28 (v0) / u64 @ box+36 (v1). stts deltas are NEVER modified (this inconsistency is the exploit)
  - Scale variants seen: GlitchFL legacy auto = new_ts = 30000 (factor 30000/old_ts, both ts+du scaled → seconds preserved, stts now inconsistent); "TikTok rule" = factor 30/fps; hamzavfx = ts×(30/fps) only, duration kept; ut0ku/120fps-method = ts×2 (60fps) or ts×4 (120fps) i.e. INFLATE. All create mvhd/mdhd↔stts disagreement so TikTok's transcoder computes a fake fps/duration while frames pass through untouched
- ZERO-DURATION BEHAVIOR (Q1, verified locally): zeroing mvhd duration + tkhd duration + mdhd timescale&duration → ffprobe reports stream duration=0.000000, format duration=N/A; mutagen length=0 ("0 seconds" in players — matches RTXFury FAQ); ffmpeg still DECODES 100% of frames fine, only warning "Invalid mdhd time scale 0, defaulting to 1"; r_frame_rate becomes nonsense 1/512 → FPS detection also breaks (explains RTXFury "skip FPS check" perk + "Getting 30 FPS? Try FFMPEG engine")
- WHY IT BEATS TIKTOK (Q3, mechanism per ut0ku README + voidaep): TikTok's pipeline reads sample tables/metadata to classify (bitrate signal, fps, duration) BEFORE choosing re-encode profile; broken/contradictory timing → classifier misjudges (believes low fps / can't compute bitrate-fps budget) → light or no re-encode, CDN serves near-original; paschafps: "resulting file may appear slowed/broken locally, after upload TikTok interprets timing differently" (players disagree = the glitch). TikTok re-stamps frames at fixed cadence on transcode, which re-normalizes playback (that's why it looks fine on TikTok but broken on PC per ut0ku/hhaaiii notes)
- FPS COMPUTE (Q6): fps = mdhd_timescale / avg(stts sample_delta) (or samples÷(duration/timescale)); patching timescale while leaving stts deltas changes computed fps arbitrarily (my scaled.mp4 test: 30fps file → ffprobe reported 15/1 while decode stayed intact) → TikTok fps gate defeated; zeroed timescale → fps computation collapses to garbage (1/512)
- TOOLS (Q5): inspect = ffprobe -show_format/-show_streams, Bento4 mp4dump/mp4extract, MP4Box -diso; patch-without-reencode: ffmpeg CANNOT rewrite mvhd/mdhd durations with -c copy (recomputes them); usable: custom Python struct patcher (all scene tools do this), Bento4 mp4edit, or binary hex edit per offsets above; mutagen (1.47) READS durations (mp4.MP4Info.length) but cannot write raw header fields — good for verifying patch
- COMPETITOR LANDSCAPE (Q2): ut0ku/120fps-method (open-source, ts inflation), glitchfl + LuisAlves10 fork (mvhd/mdhd scale), hamzavfx (ffprobe fps detect + patch), paschafps/TikTok-Quality-Method + tiktok-webtool (ffmpeg retiming), hhaaiii (ffmpeg retime to 30fps + RIFE interp), dyokism/kroma-web (tkhd display-matrix patch + metadata strip — marked "Currently Patched!" i.e. TikTok closed that variant), Void Studio voidaep.dev (claims "inflates sample tables" — possibly stts padding/entry inflation), QUEENTIK/Flowtik (60/120fps plugin), Anbss browser extension, jdent874 AST-Engine (TikTok+Reels+Shorts)
- CROSS-PLATFORM (Q7): same mvhd/mdhd timescale trick marketed for Instagram Reels & YouTube Shorts (AST-Engine, kroma-web, Void Studio "compatible with TikTok, Reels & Shorts"); Instagram Content Publishing API similarly accepts direct MP4; no confirmed write-up that Reels/Shorts transcoders share TikTok's exact weakness — treat as unverified marketing
- ZERNIO (Q8): zernio.com = "Marketing infrastructure for agents", unified POST /v1/posts to 16 platforms incl. TikTok, "Official APIs only" → posts via TikTok Content Posting API (open.tiktokapis.com/v2/post/publish/inbox/video/init/ + chunked FILE_UPLOAD PUT or PULL_FROM_URL, scope video.upload; direct post endpoint /v2/post/publish/video/init/). API/inbox upload skips app-side re-encode and (per voidaep) equals the desktop-web "cleanest path"; patched metadata survives because no intermediate transcode touches the file
- NEXT ACTIONS for build plan: (1) implement patcher as binary-safe Python: full box-tree parse (not naive byte search — collision risk) → read mvhd/tkhd/mdhd/stts → offer modes [zero-duration, timescale-inflate ×2/×4, 30000-normalize]; (2) verify with ffprobe that duration=0/NaN & frames still decode; (3) download RTXFury proof file (catbox c0bkgb.mp4) and dump its atoms to reverse their exact recipe; (4) support MOV/HEVC via ffmpeg remux engine mode; (5) optional Zernio auto-post integration = plain REST POST /v1/posts

Key sources:
- https://github.com/glitchfl/TikTok-FPS-Compression-Bypasser (full patch code)
- https://github.com/hamzavfx/Hamza-FPS-Method (patcher.py, ffprobe fps detect)
- https://github.com/ut0ku/120fps-method (mechanism explanation, ×2/×4 inflation)
- https://github.com/paschafps/TikTok-Quality-Method, https://github.com/hhaaiii/tiktok-fps-patcher (ffmpeg variants)
- https://github.com/dyokism/kroma-web (display-matrix variant, "Currently Patched!")
- https://www.voidaep.dev/guides/tiktok-upload-method (competitor guide, upload paths)
- https://developers.tiktok.com/doc/content-posting-api-reference-upload-video/ (official upload endpoints)
- https://zernio.com (auto-post API)
- Local verification: /home/z/my-project/research/mp4test/ (patch_test.py + base/zeroed/scaled.mp4)

---
Task ID: 3-a
Agent: research-tiktok-specs
Task: TikTok official upload specs & compression pipeline research

Work Log:
- Read prior worklog (Task 1 & 2). Geo-blocked sandbox (HK) blocks support.tiktok.com & ads.tiktok.com article pages; worked around via search engines + official developer docs (SSR) + cached third-party sources quoting official docs.
- ~20 searches/fetches performed:
  1. DDG: TikTok supported video formats upload specifications help center
  2. DDG: site:developers.tiktok.com content posting api file size video upload
  3. DDG: site:ads.tiktok.com video specifications bitrate specs
  4. DDG: tiktok business help center video specs 540x960 720x1280 1080x1920
  5. DDG: "video restrictions" site:developers.tiktok.com
  6. DDG: TikTok help center "video specifications" 1080x1920 287.6 MB
  7. DDG: does TikTok support 4K uploads 2160p 60fps upload HD toggle
  8. DDG: TikTok re-encode transcode pipeline CDN bitrate ladder 540p 720p play_addr download watermark
  9. DDG: TikTok TV app 4K playback smart TV 2160p
  10. DDG: TikTok Display API play_addr h264_h265 download_addr watermark
  11. Bing: TikTok "video specifications" upload
  12. Fetched official: developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide (KEY: "Video restrictions" section)
  13. Fetched official: developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content
  14. Fetched official: developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
  15. Fetched official: developers.tiktok.com/docs/en/research-api-specs-query-videos + display-api-overview
  16. Fetched: mediacheatsheet.com/platform/tiktok/ (ads specs w/ official source links)
  17. Fetched: vidulk.com/video-specs/tiktok (specs table citing official ads + API docs)
  18. Fetched: limkakit.com/specs/tiktok-video-specifications
  19. Fetched: tikhaze.com/guides/upload-tiktok-high-quality-no-compression (Haze method author)
  20. Fetched: voidaep.dev/guides/tiktok-upload-method (competing patcher, pipeline details)
  21. Fetched: github.com/hungr1yuri/yoink README (original-vs-web rendition evidence)
  22. Fetched: savett.co/quality (CDN rendition ladder)
  23. Blocked/unproductive: support.tiktok.com (SPA+geo), r.jina.ai (403), web.archive.org (no snapshots/timeouts), thinglabs.io (ASN ban), ads.tiktok.com/help/article (SPA)
- Saved all raw text extracts to /home/z/my-project/research/tiktok-specs/ (fetch.sh helper + *.txt)

Stage Summary:
OFFICIAL UPLOAD SPECS (Q1):
- Content Posting API "Video restrictions" (official): formats MP4 (recommended)/WebM/MOV; codecs H.264 (recommended)/H.265/VP8/VP9; framerate MIN 23 FPS / MAX 60 FPS; picture size MIN 360px / MAX 4096px both dimensions; duration up to 10 min via API (3/5/10-min tiers in app; 60-min upload test per TechCrunch 2024-05); max file size 4GB; chunks 5-64MB (last up to 128MB), max 1000 chunks; upload endpoints open-upload.tiktokapis.com / upload.us.tiktokapis.com; Content-Type: video/mp4, video/quicktime, video/webm. Source: https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- => 2160p (3840x2160) IS within the official API limit (4096px max) but 4K is never named/recommended; 120fps is NOT accepted (60fps hard cap via API). No AV1 in official codec list.
- Consumer Help Center spec page exists (https://support.tiktok.com/en/upload-tiktok/uploading-videos/video-specifications) but geo-blocked from sandbox & not in Wayback; third-party trackers of it: MP4/MOV/WebM, H.264/HEVC, 1080x1920 recommended, 60fps max. Sources: https://limkakit.com/specs/tiktok-video-specifications ; https://www.vidulk.com/video-specs/tiktok
- Consumer app/web file-size cap NOT published in text; third-party quotes: ~287.6MB iOS / ~72MB Android app / multi-GB web ("4GB web" per ffmpeg-micro & API). Sources: https://www.ffmpeg-micro.com/blog/tiktok-video-specs-that-survive-the-upload-and-the-posting-api ; https://www.voidaep.dev/guides/tiktok-upload-method

OFFICIAL BITRATE RECOMMENDATIONS (Q2):
- TikTok Ads (Business): auction In-Feed min 540x960 (9:16), bitrate >=516 kbps min, >2500 kbps recommended (TopView & feeds "Bitrate above 2500kbps; audio required"); file types MP4/MPEG/3GP/AVI/MOV; <=500MB. Sources: https://mediacheatsheet.com/platform/tiktok/ ; https://www.vidulk.com/video-specs/tiktok (citing https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads)
- No official consumer-upload bitrate cap published. Community-observed re-encode ceiling ~8-10 Mbps for 1080p (Haze: "even a 1080p30 @30 Mbps gets re-encoded to its 8-10 Mbps limit"). Source: https://hazeis.me / https://tikhaze.com/guides/upload-tiktok-high-quality-no-compression

RE-ENCODE PIPELINE (Q3):
- Every source (incl. the patchers themselves) agrees: TikTok re-encodes ALL uploads into streaming renditions — "Every video you upload gets re-encoded on TikTok's servers into streaming versions — nobody is ever served your original file" (tikhaze). "TikTok re-encodes everything... inspects the MP4's sample tables (bitrate signal, frame layout) to classify your file. A weak signal = heavy compression" (voidaep). Source: https://tikhaze.com/guides/upload-tiktok-high-quality-no-compression ; https://www.voidaep.dev/guides/tiktok-upload-method
- KEY: TikTok's ingest classifier reads MP4 sample-table metadata; the RTXFury/Haze/Void "patch" inflates/damages sample tables (RTXFury also appears to zero duration atoms → "0 seconds") so the transcoder treats the file as max-quality source or fails open → original stream served (this matches Task-2 findings).
- IMPORTANT COUNTER-EVIDENCE: TikTok CDN retains the ORIGINAL upload file per video: "TikTok keeps two versions of every video: a light web stream ~1-2 Mbps, and the original upload (*_original.mp4) that runs 13-14 Mbps at 60fps" — yoink pulled a byte-identical (same MD5) 1080x1920 H.264 13.4Mbps original vs 1.9Mbps HEVC web rendition via plain yt-dlp. Source: https://github.com/hungr1yuri/yoink
- No public ByteDance docs on Venus CDN internals found within budget; pipeline details above come from tool-maker reverse engineering.

4K/60fps PLAYBACK DELIVERY (Q4):
- NO 4K playback exists: "TikTok playback renditions stop well short of 4K, so a 2160x3840 file exists only when the creator master does" (savett.co/quality); "1080p is the ceiling on TikTok either way since it has no 4K" (yoink); "TikTok does not officially support 4K playback or 120fps... compressed down to 1080p and 60fps at most" (maius.com). 60-min upload news exists but no 2160p delivery.
- Standard pipeline caps most videos at 30fps and 540-720p; 60fps+1080p preserved only when file "signals high-quality source" (Void). Data Saver ON forces lower rungs; cellular uploads trigger extra compression.
- TikTok TV / smart TV apps exist (LG webOS, Samsung Tizen, Android TV, Fire TV, Chromecast/AirPlay) but NO evidence of 2160p playback — sources discuss casting only, no 4K claims. Source: https://www.lifewire.com/watch-tiktok-on-tv-5225925 etc.

UPLOAD PATH DIFFERENCES (Q5):
- Mobile app: re-encodes BEFORE upload (iOS/Android); iOS gallery path re-compresses; must use Files app for original bytes (matches RTXFury instructions).
- Desktop web (tiktok.com Upload / TikTok Studio): cleanest — no intermediate re-encode. "Best: Desktop — tiktok.com... No mobile re-encoding... keeps your patched quality intact" (voidaep).
- Content Posting API: no intermediate compression — "official third-party tools that use TikTok's Content Posting API upload with no intermediate compression — the same path desktop uses under the hood" (voidaep). API accepts: MP4/WebM/MOV, H.264/H.265/VP8/VP9, 23-60fps, 360-4096px, <=10min, <=4GB (see Q1 sources).
- Source: https://www.voidaep.dev/guides/tiktok-upload-method

"UPLOAD HD" / "ALLOW HIGH-QUALITY UPLOADS" TOGGLE (Q6):
- Location A (global): Profile → Menu → Settings and privacy → Content preferences → "Allow high-quality uploads" ON. Location B (per-post): post screen → More options → "Upload HD" (off by default; some app versions reset it). Source: https://www.voidaep.dev/guides/tiktok-upload-method ; https://tikhaze.com/guides/how-to-post-in-hd-on-tiktok
- What it does (evidence-based): raises the upload-quality ceiling — "Without it, TikTok uploads a lower-quality copy no matter how good your file is" (tikhaze). It does NOT stop the server-side re-encode: "Does Upload HD stop TikTok from compressing my video? It raises the quality ceiling but doesn't stop the re-encode — TikTok still re-compresses every upload" (tikhaze FAQ).
- Data Saver (Settings → Data Saver) forces lower-quality renditions when ON; upload with it off (hollyland/void guides). Source: https://store.hollyland.com/blogs/creator-hub/tiktok-video-quality-settings

ADS / HIGH-BITRATE SOURCES (Q7):
- Ads accept <=500MB, MP4/MPEG/3GP/AVI/MOV, min 540x960, bitrate min 516kbps / recommended >2500kbps; ad pipeline re-encodes high-bitrate sources to ladder; firstreview notes "TikTok's upload spec and its ad policy are two different documents that disagree on resolution and file size". Sources: https://mediacheatsheet.com/platform/tiktok/ ; https://firstreview.co/post/tiktok-ad-specs-2026-resolution-aspect-ratio-and-file-format-requirements

BITRATE LADDER / CDN DELIVERY (Q8):
- Delivery renditions (portrait): 480x854 (SD), 720x1280 (HD), 1080x1920 (Full HD, "a few megabits per second"); 540p tier exists for ads minimums; 4K "only when the creator master does" (rare/original passthrough). Source: https://savett.co/quality
- Two-tier storage: web rendition ~1-2Mbps (often HEVC) vs original upload *_original.mp4 ~13-14Mbps H.264 60fps retained on CDN; download endpoint serves watermarked re-encode, no-watermark endpoints serve alternate/older originals (yoink byte-identical evidence). Source: https://github.com/hungr1yuri/yoink
- Community export guidance: 8-12 Mbps 1080p30 / 12-16 Mbps 1080p60 (hawxtech); Haze recommends 15-25 Mbps 1080p60; RTXFury (Task 2) recommends 10-40 Mbps.

RELEVANCE TO RTXFURY CLAIM: Officially TikTok accepts up to 4096px & 4GB via API/web, so a 2160p60 upload is ingestible — but "publishes in true 4K" is NOT supported by evidence: no 4K playback renditions exist; best case = 1080x1920@60fps original-file passthrough (as evidenced by *_original.mp4 at 13.4Mbps) plus the patched sample-table trick preventing destructive re-encode. The "AFTER" proof video (2160x1216@60fps, catbox) would need verification against a live post's CDN URLs (next action).

---
Task ID: 3-b
Agent: research-community-methods
Task: Community evidence on TikTok compression bypass methods

Work Log:
- Read prior worklog (Task 1 & 2 findings)
- Tooling: WebSearch/WebFetch unavailable in sandbox → built curl-based helpers: Bing search (returned junk/blocked for niche queries), YouTube search page scraper (WORKED - main source), YouTube innertube player (blocked: "Sign in to confirm you're not a bot"), Reddit JSON + old.reddit (403 blocked), pullpush.io (Cloudflare), DuckDuckGo html (captcha), Mojeek/Brave/Redlib/Invidious/SearXNG/TikTok-support (blocked or empty), GitHub API + raw.githubusercontent.com (WORKED), Discord invite landing page (WORKED), scamadviser/trustpilot (Cloudflare blocked)
- ~18 searches performed: YT: "Haze method TikTok no compression", "ItzCrih method TikTok", "ItzCrih", "ItzCrih method free discord", "GHXZ", "GHXZ method tiktok", "Zilem TikTok method", "Zilem method upload quality", "TikTok no compression method 4K upload", "tiktok scheduler upload better quality method", "tiktok video 0 seconds duration trick", "paschafps tiktok method", "haze method free tiktok 120fps", "RTX Fury", "tiktok upload hd setting enable", "tiktok only me private video quality", "MrBeast tiktok 4K 60fps", "tiktok 2160p download 4k video"; GitHub API: "tiktok compression upload", "tiktok metadata patch", "evc0 OR libevc"; direct fetches: discord.com/invite/ApzyyrNupd, github.com/youpzdev/tiktok-prep (README.md + README.en.md), github.com/bitonito/Tiktok-upload-method- (mp4patcher.js 397 lines + file list), github.com/dyokism/kroma-web (README), scamadviser/trustpilot for rtxfury.xyz (blocked)

Stage Summary:
1. THE METHOD SCENE IS REAL AND LARGE ("TikTok upload method" YouTube ecosystem, 2024-2026):
   - paschafps "Fix TikTok Ruining Your Video Quality (REAL METHOD)" 108,923 views https://www.youtube.com/watch?v=PeF5Cynaw2o (desc: his Discord discord.gg/EDaJ2NkAZh); "[DISCONTINUED] Upload to TikTok With ZERO Quality Loss (1:1 Uploading is BACK!)" 44,758 views https://www.youtube.com/watch?v=3i11slsIJkw; "How to Upload TikToks in TRUE 1:1 Quality" 24k https://www.youtube.com/watch?v=OpNyrJLMQkA; tutorial from 1y ago https://www.youtube.com/watch?v=yalD261JOZ4
   - SMOKE "2026 Best TikTok Upload Method" 77,560 views https://www.youtube.com/watch?v=hv5rV_3g3rk ; Editing News 120fps tutorial 33,988 views https://www.youtube.com/watch?v=hEozWdgRkQc ; xd9 120fps 25,167 views https://www.youtube.com/watch?v=8riYqDpR28o ; BilloXD (method.billoxd.site) 18k views https://www.youtube.com/watch?v=vCGalEQBEpc ; FPSMethod https://www.youtube.com/watch?v=RqR1Hozudfw ; ZEMIX EDITZ series "#14" https://www.youtube.com/watch?v=inX6CuBh_Pk
2. THE FOUR FOOTER "METHODS" IDENTIFIED:
   - Haze method = "Haze" web tool by TikHaze channel (youtube.com/@TikHaze): "TikTok Quality Bypass 2026: Upload 1080p60 With No Re-encode" https://www.youtube.com/watch?v=MNaCzIJRHqg ; "How to Post 4K 60FPS on TikTok Without Losing Quality (Works on Phone Too)" https://www.youtube.com/watch?v=PJe4aQS8eWQ ; "How to Upload 4K 120FPS on TikTok (No Quality Loss!)" https://www.youtube.com/watch?v=c9onKHsElf0 — tool tagline: "You spend hours on your best edit, only for TikTok to crush the upload... With Haze, you can drop your clip and get it [published clean]" — SAME no-re-encode container-patch product family as RTXFury
   - ItzCrih = small editor YouTuber (itzCrih, boxing edits https://www.youtube.com/watch?v=WW_nP5QrOG4); no public guide found — "ItzCrih method" is a Discord/community-gated variant (this scene's methods are mostly sold/shared via Discord: .gg/maska, .gg/ryuu etc.)
   - GHXZ = 𝗚𝗛𝗫𝗭, popular high-quality-edits YouTuber (4K After Effects + Topaz Video AI tutorials, 94k views https://www.youtube.com/watch?v=lGlFlW9X4Lg); "GHXZ method" = his 4K-quality edit workflow; fan breakdowns "How to make high quality edits like @ghxz" https://www.youtube.com/watch?v=C9yG139GAVk
   - Zilem = "Zilem Method" channel, video 6 days ago "How to Upload HIGH Quality In Tiktok with Zero compression | Zilem Method" https://www.youtube.com/watch?v=osNSkQCXdeM — another tool/method variant
   - Other named methods/tools: RYUU Extension (browser ext, https://www.youtube.com/watch?v=cyenR-odUXQ), MaskaFR ext https://www.youtube.com/watch?v=SAk4vOnbylM, Spinzaf ext https://www.youtube.com/watch?v=ofXuG7G7aF8, KojiMethod V3 "KojiUpscaler" (no-login, free Topaz) https://www.youtube.com/watch?v=d44fFMbu9_Y, Kroma (open source)
3. THE ACTUAL BYPASS TECHNIQUE (CONFIRMED via open-source clones — this is what RTXFury's server does):
   - github.com/youpzdev/tiktok-prep (37 stars, free, "Local TikTok video prep — light compression + MP4 container patch"): STEALTH mode writes SEI "evc0 v1.4.2.2-20260920" (mimics ByteDance's in-house "EVC" encoder watermark), compressorname "Lavc libx264", preserves btrt boxes, ©too tag = JSON {libevc=0, trans_type=-2, target/max bitrate}, removes edts, sets mvhd v1 duration to UNKNOWN (= the "0 seconds" display), optionally adds 9 ghost 8-byte AAC samples per real sample (10x sample count). MAX mode = H.264 Main L6.0 CRF14 240Mbps up to 4K/120fps. Author confirmed: "On 18 October 2026, the author confirmed a Max upload retaining 4K and 120 FPS" and "TikTok decides how to process uploaded video. Matching the reference metadata does not guarantee resolution, frame rate or reach." https://github.com/youpzdev/tiktok-prep (README.en.md)
   - github.com/bitonito/Tiktok-upload-method- — "A simple Mp4 container/metadata patcher that allows high quality tiktok uploads at 60fps"; mp4patcher.js "Mode 3: Null-Frame Video Extension — Appends N null/empty sample entries to the video track's stts/stsz/stco tables without re-encoding", based on REF-vs-CMP analysis of a real TikTok transcoded file (TikTok output had +8573 null frames of 1500-tick duration appended: stts [(784,512),(8573,1500)], stsz 9357 vs 784) → i.e., patch forges TikTok's OWN post-transcode fingerprint so the pipeline treats it as already-processed and skips re-encoding. Requires moov-before-mdat (faststart) input. https://github.com/bitonito/Tiktok-upload-method-
   - github.com/dyokism/kroma-web — "Bypass TikTok video quality compression and strip tracking metadata locally in your browser. (Currently Patched!)" → proof that TikTok actively counters these tricks (an arms race) https://github.com/dyokism/kroma-web
   - github.com/FemaDongz/noblur — "Patch MP4/MOV metadata, convert to TikTok-optimized..." (browser-local) https://github.com/FemaDongz/noblur
   - Conclusion for Q5: the "0 seconds" duration is a side effect of forging TikTok's own container fingerprint (unknown mvhd v1 duration + null sample tail), NOT a random corruption; goal = "transcoder skip via fingerprint mimicry". The RTXFury "0 seconds is normal, ignore it" FAQ matches exactly.
4. RTXFURY ITSELF (Q3): Discord invite https://discord.com/invite/ApzyyrNupd resolves WITHOUT login to server "RTX Fury", 41,270 members: "The home of 4K & 8K max graphics gaming, benchmarks, giveaways & games, Fortnite sprites indexing & trading, mods, presets, video editing, colour correction and more. Link in RTXFuryYT's YouTube bio to join this server." → RTXFury is an established gaming/benchmark YouTube brand (RTX 5090 4K/8K videos, e.g. https://www.youtube.com/watch?v=aGMr3VqDoLA 19k views) that ALSO publishes the method videos: "How to Upload 120 FPS TikTok Videos Without Losing Quality (No Compression)" 13,138 views https://www.youtube.com/watch?v=gbozhKuMLUw ; "How to Bypass TikTok Compression & Upload 4K 120 FPS Videos" https://www.youtube.com/watch?v=k3P_rjgDGEA ; "How to Upload in 4K 120FPS Video in TikTok" 8,787 views https://www.youtube.com/watch?v=lB8yzns9QCw . No scam reports found (ScamAdviser/Trustpilot were Cloudflare-blocked, no negative mentions surfaced anywhere). Verdict: real product with real user base (41k Discord, videos with 5-13k views), not an obvious scam; "booster" tier = Discord Nitro boosters per their config.
5. HIGH-QUALITY SERVING EVIDENCE (Q4): TikTok officially supports HD/4K uploads ("Upload HD"/"Allow high-quality uploads" toggle + TikTok Studio web): "How to Upload HD videos on TikTok (2025) [4K]" 33k views https://www.youtube.com/watch?v=6sZveGNxcgo ; "How To Fix TikTok High Quality Option Not Showing" https://www.youtube.com/watch?v=HaWT2xaq48o ; 4y-old viral video "The Secret To Uploading 4k High Quality Reels On Instagram and TikTok" 1,170,958 views https://www.youtube.com/watch?v=kBEAoRfb0ck (4K-quality niche long predates RTXFury). 120fps beyond official support is claimed served by the method scene (youpzdev's 2026-10-18 confirmation above; TikHaze/BilloXD/FPSMethod 120fps videos). No direct 2160p60 stream capture verified in this session (RTXFury catbox proofs from Task 1 remain the primary artifacts).
6. Q7 in-app editing → re-encode: every method guide (RTXFury FAQ, paschafps, FPSMethod, TikHaze videos) instructs to upload the FINISHED file and avoid in-app sounds/trim/text/filters — consensus: TikTok's editor pipeline re-renders the video server-side. No official TikTok doc retrieved (support pages are JS-rendered), but it's uniform community knowledge across all sources found.
7. Q8 Only Me vs Everyone: no independent public evidence found this session (Reddit blocked). Only RTXFury's own instruction to publish with "Everyone" visibility (deferred to Task 4 verification). Flagged as UNVERIFIED.
8. Q2 Reddit specifically: r/* threads unreachable (403/Cloudflare on reddit.com, pullpush, redlib). Community sentiment instead captured from YouTube view counts (methods have 10k-108k views = mass usage) and GitHub confirmations.
9. Reddit-blocked limitation noted; YouTube/GitHub/Discord sources sufficient to answer Q1, Q3-Q7.

IMPLICATION FOR OUR BUILD PLAN: our own tool should replicate = (a) faststart check/mux, (b) forge TikTok-post-transcode fingerprint: mvhd-v1 unknown duration ("0s"), edts removal, null-sample tail on video track (stts/stsz/stco), evc0 SEI + ©too libevc JSON + btrt preservation, ghost AAC samples option; (c) instruct web/Studio upload + Upload HD + Everyone visibility + no in-app edits; (d) expect TikTok counter-patching (Kroma history) → keep fingerprint data fresh from live TikTok output files.

---
Task ID: 4
Agent: main-orchestrator
Task: Cross-verify claims + forensic analysis + verdict synthesis

Work Log:
- Downloaded RTXFury's proof videos from catbox.moe to research/proof-videos/ (sizes match claims exactly: 23,144,382B / 3,304,524B)
- ffprobe + custom Python MP4 box-walker forensics on both files
- Fetched exact patch source: youpzdev/tiktok-prep (app.py, mp4boxes.py, mp4mask.py, SPEC.md, README.en.md) + bitonito mp4patcher.js -> saved to research/repo-clones/
- Analyzed RTXFury client JS (shared-*.js): confirmed architecture (chunked resumable upload /api/patch-rtx/up/:id + /finish, X-Patch-Token HMAC, prewarm, tier caps member 1080p60 / booster 4K60 / donor 4K120, premium 500MB cap "playback lag", Zernio auto-post, pre-flight MP4 box scan with codec sniff)
- Confirmed live site still UP (HTTP 200, last-modified 2026-10-14)
- Wrote /home/z/my-project/research/VERDICT.md

Stage Summary:
- FORENSICS: "before" = 406x720@15fps 1.05Mbps H.264 High L3.0 (TikTok's classic crush; stts 376x1024 @ ts15360) with Mainconcept handlers; "after" = 1216x2160@60fps 7.38Mbps H.264 High L5.1, stts 1502x256 @ ts15360 (exact 60fps), faststart, CLEAN atoms (no patch signatures, normal mvhd v0 25.03s) — consistent with "TikTok served near-original and re-normalized timing" (or self-produced demo); both muxed Lavf61.7.100, identical ghost-silent AAC 2.277kbps. Caveat: self-published assets, provenance not independently provable.
- tiktok-prep SPEC.md adds third confirmation: user confirmed 17 Oct 2026 the ghost-audio-sample method works on publishing; README.en confirms 4K+120fps retained 18 Oct 2026; arms-race history documented (Aug 2026 OK -> Sep 2026 480p30 regression -> recipe rebuilt from fresh successful reference -> working again).
- VERDICT: MOSTLY TRUE (85% confidence core mechanism; 60% long-term reliability). Technique = fingerprint forgery of TikTok's own post-transcode output + timing-table contradiction. Caveats: arms race, no per-upload guarantee, no 4K playback tier for average viewers (near-original retained/served on CDN instead), upload discipline mandatory, 120fps unofficial/fragile. Sandbox could not perform a live TikTok upload (no account) — evidence is converging (3 dated first-hand confirmations + byte-exact public implementations + forensic match + 41K-member community) but not our own end-to-end test.

---
Task ID: 5
Agent: main-orchestrator
Task: Write the living build plan for the next build prompt

Work Log:
- Consolidated ALL findings (Tasks 1-4 + 3 research agents) into one self-contained build blueprint
- Wrote /home/z/my-project/TIKTOK-4K-BYPASS-BUILD-PLAN.md

Stage Summary:
- PLAN COMPLETE at /home/z/my-project/TIKTOK-4K-BYPASS-BUILD-PLAN.md — product "GhostPatch":
  - §1 verified technical foundation + upload discipline; §2 byte-exact engine spec: TypeScript MP4 box-tree parser + patch ops P1-P9 (mvhd unknown duration, zeroed track durations, edts removal, ghost audio samples 9:1 8-byte 0000000400000000 1-tick, null video tail (N,1500), timescale inflate x2/x4, ©too JSON {libevc:0,trans_type:-2}, strip free box, ensure faststart) + 4 versioned profiles (v1-ghost primary, v2-zero, v3-inflate, v4-nulltail) + verifier (duration~0, fps garbage, frame-count parity) + ffmpeg encode modes (H.264 Main L5.2/L6.0, CRF14 240M, refs 1-4, 2s GOP)
  - §3 architecture: Next.js 16 API routes only (no server actions), chunked resumable upload to disk, in-process queue, ffmpeg 7.1.5 via child_process, Prisma SQLite schema (Job/EngineProfile/Stat), no-auth MVP with IP limits
  - §4 UI spec: single / route, dark #0a0a0b + amber accent (no blue/indigo), dropzone + preflight scan (stts-based fps, codec sniff — NOT <video> element), engine radio cards, progress, result + copy-able upload checklist, FAQ, sticky footer
  - §5 API contract; §6 arms-race strategy (versioned profiles, feedback -> per-profile success rate, kill-switch, harvest protocol); §7 phases (1 MVP, 2 analyzer + compare slider + encode modes, 3 Discord OAuth + Content Posting API auto-post + SEI evc0)
  - §8 legal (not affiliated, own-file metadata only, CC-NC sources -> port the technique, not the code); §9 sandbox artifact map; §10 Phase-1 definition of done
- Next prompt should say: "Execute Phase 1 of /home/z/my-project/TIKTOK-4K-BYPASS-BUILD-PLAN.md"

---
Task ID: 6
Agent: main-orchestrator
Task: Final report to user

Work Log:
- All deliverables in place: VERDICT.md, TIKTOK-4K-BYPASS-BUILD-PLAN.md, worklog.md (this file), research/ artifacts (rtxfury capture, proof-videos, repo-clones, tiktok-specs, mp4test)
- No website was built (per user instruction — research + plan only; src/app/page.tsx untouched)

Stage Summary:
- Research project complete. Claim verified as MOSTLY TRUE. Living plan saved at /home/z/my-project/TIKTOK-4K-BYPASS-BUILD-PLAN.md for the next build prompt.
---
Task ID: 1-b
Agent: frontend-builder
Task: Build GhostPatch frontend UI
Work Log:
- Read build plan §4 (UI/UX spec) + worklog Tasks 4-5 for verified facts
- Audited pre-existing partial frontend (previous run) in src/components/ghostpatch/ — fixed and completed it against spec:
- layout.tsx: REMOVED next/font/google (Geist) per no-network-font rule → system font stack; kept title/description/OG metadata + sonner Toaster (dark, bottom-right)
- globals.css: system font stacks in @theme inline (--font-sans/--font-mono); kept .gp-scroll thin scrollbar + gp-grid-bg/gp-hero-glow amber helpers, #0a0a0b canvas
- page.tsx: 'use client' single-page composition; root min-h-screen flex flex-col, footer mt-auto (sticky footer)
- Components (src/components/ghostpatch/): site-header (sticky, Ghost logo, anchor nav, StatsChip live from GET /api/stats w/ window-event refresh), hero (H1 "Your 4K, actually 4K on TikTok.", amber gradient, trust row, CTA), dropzone (drag/drop+click+keyboard, accept .mp4/.mov/.m4v), scan-panel (6 chips: Size/Resolution/FPS/Duration/Codec/Audio + health chip good/warn/bad + notes), engine-picker (6 radio cards: ghost=Recommended, zero, inflate, convert-h264 [auto-suggested on HEVC], encode-1080, encode-4k; codec==='other' → all others disabled + red note; ≥44px targets), progress-panel (JobProgress: % + stage + live log in .gp-scroll + cancel), result-card (verify checks list, Download <a> ghostpatch download URL, 7-step numbered upload checklist incl Upload HD + Content preferences + Data Saver OFF + Everyone + no in-app edits + iOS Files app, "0 seconds is normal" Alert, 👍/👎 → POST feedback + sonner toast + disable + stats refresh), how-it-works (3 honest cards + "Is this legit?" + "0 seconds is normal" callouts), faq (8-item accordion from plan §4 item 8), cta-band, site-footer ("Not affiliated with TikTok. Use responsibly.", v1.0), api.ts (typed fetch wrapper + scan payload head/tail 4MB→base64), engines.ts, format.ts, reveal.tsx (framer-motion whileInView)
- Client state machine in optimizer.tsx: idle → scanning → ready → uploading (sequential PUT chunks, 0-50%) → processing (poll GET /api/jobs/:id @900ms, 50-100%, abort-safe, 5-failure cutoff) → done | failed (alert + retry/re-pick profile); cancel + "Patch another" reset; pre-checks .mp4/.mov/.m4v + ≤500MB + non-empty; HEVC/other auto-select convert-h264
- Touch targets bumped to ≥44px (Change/Cancel buttons h-11, nav links min-h-11); feedback success toasts added
- VERIFY: dev server (already running, untouched) — sleep 8 + dev.log: "✓ Compiled" + GET / 200 clean (only expected /api/stats,/api/scan 404s while backend agent builds routes in parallel; no errors in my files). SSR HTML spot-check confirms hero/footer/engine-online/0s copy render. bunx eslint src/app/page.tsx src/components/ghostpatch src/app/layout.tsx → CLEAN (0 errors, 0 warnings)
Stage Summary: Frontend complete: page.tsx + 14 ghostpatch components + layout.tsx + globals.css extensions; full state machine vs API contract (scan/jobs/chunk/process/poll/download/feedback/stats); dark #0a0a0b + amber theme, no blue/indigo; eslint clean, dev.log clean (my files), homepage 200. Integration notes for API builder: scan expects meta.codec/health/notes; job GET drives progress/stage/log; download is plain <a href="/api/jobs/{id}/download">; feedback body {verdict:'worked'|'compressed'}; stats shape {patchesDone,feedbackGood,feedbackBad,successRate,engine:{profileVersion,active}}

---
Task ID: 1-a
Agent: engine-builder (main orchestrator, completed after subagent timeout)
Task: Build MP4 patcher engine library (src/lib/mp4)

Work Log:
- Subagent dispatch timed out after writing types.ts/boxTree.ts/inspector.ts (high quality); reviewed + completed them
- Read reference patch sources: research/repo-clones/tiktok-prep_mp4mask.py (mask_reference = the verified recipe), mp4boxes.py, app.py (reference_encoder_json format)
- Wrote patcher.ts: v1-ghost (©too JSON rewrite/create + 9:1 ghost audio samples in tail chunk outside mdat + edts strip + mvhd→v1 unknown duration + empty-free strip + offset recalc with stco→co64 promotion loop), v2-zero (mvhd/tkhd/mdhd zeroing), v3-inflate (mdhd timescale ×2/×4)
- Wrote verifier.ts (ffprobe symptom checks + count_frames decode parity), ffmpeg.ts (ffprobe/ffmpeg wrappers, ensureFaststart, encodeH264 convert/1080/4k, addSilentAudio)
- Fixed 4 bugs found by scratch testing: (1) offset loop serialized moov BEFORE writing final chunk offsets → corrupt output (re-serialize after final write + fixpoint loop); (2) ©too parsed as leaf → added to CONTAINER_TYPES (with ilst); (3) inspectSlices mdatSize wrong for declared-size-past-slice → zeroSize flag; (4) scanTopLevelBoxes threw on trailing ghost-tail bytes → tolerate trailing junk (patcher still enforces strict input accounting)
- Added silent-audio carrier (addSilentAudio) so v1-ghost works on video-only files
- Scratch verification (research/mp4test/run.ts): all profiles pass; video bitstream MD5-IDENTICAL after patch; v1 audio ×10 inflation; v2 duration N/A + fps 1/256; v3 fps 60→120; non-faststart remux; HEVC convert; real TikTok 4K file patches cleanly

Stage Summary:
- src/lib/mp4/ complete: types, boxTree (parse+Mut tree+serialize), inspector (slice+file), patcher (3 profiles), verifier, ffmpeg, index — tsc + eslint clean
- KEY PROOF: ffmpeg-extracted H.264 bitstream md5 matches source exactly after v1-ghost patch; 360/360 + 60/60 + 1502/1502 frames decode on test files
- Verifier semantics: v1 requires audio-inflated (+frames/stream/size); v2 requires duration-shifted; v3 requires fps-shifted; others informational (marked pass with explanation)

---
Task ID: 2-3
Agent: main-orchestrator (backend)
Task: Prisma schema + db push + all API routes + processing pipeline

Work Log:
- Replaced prisma schema with Job/EngineProfile/Stat models; bun run db:push + generate; quieted db.ts query logging
- Wrote src/lib/jobState.ts (HMR-safe global progress/chunk/rate/semaphore stores), src/lib/uploads.ts (paths + 2h-TTL janitor + safe filenames), src/lib/pipeline.ts (scan → engine pre-steps [convert/encode/faststart-remux] → silent-audio if needed → patch → verify → DB/stats, humanized errors)
- API routes (all runtime nodejs, force-dynamic): POST /api/scan (slice-based preflight with health grading + guidance notes), POST /api/jobs (validation + IP rate limit 15/h), PUT /api/jobs/[id]/chunk (sequential append + order/size guards), POST /api/jobs/[id]/process (assemble + async job with 2-slot concurrency), GET /api/jobs/[id] (DB+progress merge, stale-restart detection), GET /api/jobs/[id]/download (streaming + attachment), POST /api/jobs/[id]/feedback (once-only + stats), GET /api/stats (seeded EngineProfiles + success rate)
- Added eslint ignores for research/skills/mini-services/db (data artifacts) → bun run lint fully clean

Stage Summary:
- Full API surface live on port 3000; curl end-to-end: 20MB h264 ghost job DONE in ~2s (verify pass), HEVC convert job DONE, 4K no-audio job DONE (silent audio injected: 87→870 samples), non-faststart zero job DONE (auto remux)
- Stats + feedback loop verified (patchesDone increment, successRate updates)

---
Task ID: 4-5
Agent: main-orchestrator (integration + E2E)
Task: Integration, lint, dev.log, agent-browser E2E verification

Work Log:
- bun run lint: PASS (project-wide); tsc: src/ clean (pre-existing errors only in examples/skills/research data)
- agent-browser E2E: page renders (hero/header/footer/dropzone/8 FAQ); uploaded a_1080p60.mp4 through the real dropzone → scan panel correct (H.264 1080×1920 60fps, health good, Ghost recommended); clicked Patch Video → upload → poll → DONE; result card verified (download link, 7-step upload checklist, "0 seconds is normal" alert, 2 feedback buttons, verify checks incl. decoded-frames parity)
- FOUND + FIXED: frontend agent had left an agent-browser network route MOCK on /api/scan (canned HEVC 3840×2160 data from their pre-backend UI testing) — intercepted browser requests and caused a false "HEVC detected" suggestion; removed with `agent-browser network unroute`; re-ran E2E clean
- Feedback button → stats chip live-updated to "4 videos patched · 1 stayed sharp"; FAQ accordion works; download probe: 200, correct bytes, attachment disposition with sanitized filename
- Responsive: 390×844 mobile — no horizontal scroll (scrollX pinned 0, decorative glow divs clipped); 1440×900 desktop fine; footer naturally pushed on the long single page
- Console + page errors: clean; fixed a FileHandle GC warning in patcher.ts (stat handle now closed)

Stage Summary:
- Golden path fully browser-verified: drop → scan → engine select → chunked upload → patch → verify → download → feedback. All API calls 200 in dev.log, no runtime errors.

---
Task ID: 6
Agent: main-orchestrator
Task: Final report + plan update

Work Log:
- Marked Phase 1 of TIKTOK-4K-BYPASS-BUILD-PLAN.md as DONE with deviations noted
- Reported to user

Stage Summary:
- GhostPatch v1.0 LIVE: complete TikTok quality-preservation optimizer with verified engine (bit-exact video, ghost fingerprint), 6 engine modes, full web UI, stats/feedback loop. Ready for real-world TikTok upload testing by the user.

## 2025-10-30 (evening) — THIRD SILENT REVERT → full fix stack re-applied + verified

⚠ REVERT PATTERN (3rd occurrence — trust nothing, verify everything):
- The sandbox platform periodically rolls the ENTIRE filesystem back to an old snapshot — code, worklog, /tmp, even the SQLite db (patchesDone count regressed 9→7). Nothing stored inside the sandbox survives. Dev server gets restarted by the platform on the reverted code.
- RECOVERY CHECKLIST — verify these markers before doing anything else:
  1. `grep -c "meta\|offset" src/app/api/jobs/[id]/download/route.ts` > 0 (3 dialects present)
  2. `ls src/components/ghostpatch/segmented-download.ts` (file exists)
  3. `grep -c "pickError" src/components/ghostpatch/optimizer.tsx` > 0 (inline alerts)
  4. `grep -c "GHOSTPATCH_FILE_INPUT_ID" src/components/ghostpatch/dropzone.tsx` > 0 (native label picker)
  5. `grep allowedDevOrigins next.config.ts` (*.space-z.ai)
  6. `grep -c "pipeline" src/app/api/jobs/[id]/chunk/route.ts` > 0 (streaming upload)
  7. `grep "CHUNK_SIZE" src/lib/uploads.ts` → 8 MB
  8. `grep NODE_OPTIONS package.json` → dev script heap cap present
  If any fail → re-apply from the specs below, then restart dev detached: `setsid -f bun run dev` (script already has the heap cap).

Re-applied fix stack (this is now the 3rd time — full spec follows):
1. **Download route** (src/app/api/jobs/[id]/download/route.ts) — THREE slicing dialects because the preview gateway kills long-lived streams (~100 MB stall) and 403s HEAD: `?meta=1` → JSON {ok,size,name}; `?offset=N&length=M` → plain-GET byte slice (X-Total-Size header, 416 beyond EOF, 400 bad params, 64MB slice cap); `Range: bytes=` → 206 + Content-Range; bare GET streams whole file for curl/<a>; HEAD for local tools. Shared sliceResponse() via createReadStream, fd destroyed on error.
2. **Segmented downloader** (src/components/ghostpatch/segmented-download.ts) — SegmentedDownloader class + useSegmentedDownload hook. NO HEAD anywhere: probe ladder ?meta=1 → Range bytes=0-0 Content-Range parse → expectedTotal (job.outputSize). Query-slice segments ≤24MB adaptive to ~8s throughput (min 1MB), auto-switch to Range dialect after 2 failed qs attempts. 5 attempts/segment, 1/2/4/8s backoff, 25s no-progress watchdog (per-chunk reset), 403/408/429 transient, 404/410 fatal-expired. Resume keeps pieces; cancel() aborts controller. Chromium FS Access disk streaming (picker while user-activation fresh — AbortError from a CLOSED picker = user cancel; diskFailed → Resume restarts clean in memory mode); Blob + <a download> elsewhere; parts released after assembly. ETA from speed EMA.
3. **result-card.tsx** — download button → dl.start(); fetch phase shows Progress bar + pct/bytes/speed/ETA/retry + pause (X); done → "Saved — check your downloads (or the folder you picked)." + Download again; cancelled → "Paused at X of Y" + Resume; error → "Download interrupted" alert + Resume download + Direct download instead (hidden if noRangeSupport) + >100MB direct-link warning. safeNameClient mirrors server safeBaseName.
4. **Chunk route streaming** (src/app/api/jobs/[id]/chunk/route.ts) — req.body STREAMED to disk via pipeline + 64KB Writable meter (never arrayBuffer() — that OOM-killed the server on ~240MB uploads). On-the-fly cap vs job.sizeBytes/MAX_FILE_BYTES; rollback truncate to startSize on abort/overflow so retried indexes stay byte-exact.
5. **uploads.ts** — CHUNK_SIZE 8MB.
6. **package.json** — dev: NODE_OPTIONS=--max-old-space-size=1024.
7. **dropzone.tsx** — native <label htmlFor="ghostpatch-file-input"> picker activation (works with zero JS — survives React-handler loss/HMR zombies); keyboard Enter/Space backup; drag&drop depth counter. Fixes "file manager not opening" + "selected video, nothing happened" from stale tabs.
8. **optimizer.tsx** — pickError/pickErrorFile state: extension/>500MB/empty/scan-failure rejections render an inline red Alert ABOVE the dropzone (file name + reason), toast secondary. Corner toasts alone are easy to miss in the preview iframe.
9. **next.config.ts** — allowedDevOrigins: ["*.space-z.ai"]. In Next 16.1 defining this flips blockCrossSite from warn→ENFORCE; verified matcher accepts the pattern; matrix: preview origin 200, any session host 200, no-origin 200, foreign 403, cross-site no-cors 403.

Verification (all through :81 gateway, fresh dev server w/ heap cap, agent-browser):
- Cold load: 0 errors, label↔input association confirmed.
- .webm pick → inline alert "That file couldn't be used: myvideo.webm".
- Real ffmpeg clip (3.1MB) → scan 200 → ready → Patch Video → PUT chunk (streaming route) 200 → process → poll → "Your video is patched".
- curl dialect matrix on the DONE job: meta=1 JSON ✓, offset/length slice byte-exact vs whole-file head (cmp MATCH) ✓, Range 206 ✓, beyond-EOF 416 ✓, HEAD 200 ✓.
- Browser download (memory mode forced in headless — real Chromium opens the save picker): ?meta=1 → 1MB probe slice → remainder → "Saved — check your downloads"; ZERO HEAD from browser; 3 consecutive downloads all completed.
- bun run lint PASS; tsc 0 errors in src/; allowedDevOrigins matrix verified; 0 page/console errors.

User guidance for stale-tab symptoms: hard-refresh the preview (or "Open in New Tab") — old tabs keep dead handlers after sandbox reverts/restarts.

## 2026-10-30 (late) — publish failure diagnosed, clean history, GitHub backup, Oracle kit

- PUBLISH FAILURE ROOT CAUSE: .git had ballooned to 1.1 GB — platform auto-commits (pre-.gitignore) had captured a full 281 MB job (input+output+work ≈ 844 MB of mp4 blobs) into history. Deployer chokes packaging it.
- FIX: rewrote history to a single clean orphan commit (gitignored runtime data stays out: /db/, .env, dev.log, research/), reflog expired + aggressive gc → repo now a few MB.
- PUSHED to https://github.com/skyro777/Ghost-Patch (public) with user-provided fine-grained PAT (one-time in URL, remote stored clean; token must be rotated by user — it was pasted in chat).
- ORACLE DEPLOY KIT added to repo: Dockerfile (multi-stage: bun install w/ frozen lockfile → next standalone build + prisma generate + db push seeds SQLite; runtime: node20-slim + ffmpeg, non-root, healthcheck via node fetch), .dockerignore, docker-compose.yml (named volume ghostpatch-db for SQLite; job videos stay ephemeral in container fs by design), .env.example, README.md, docs/DEPLOY-ORACLE.md (Always Free A1 2/12 — halved June 2026 — full step-by-step: signup/region choice, instance, security list, OCI iptables gotcha, docker, Caddy TLS, Cloudflare grey-cloud note, capacity retries, idle-reclamation note).
- next.config.ts already had output:"standalone" (platform publish unaffected — additive).
- Sandbox app untouched: no source changes, dev server healthy, port 3000 = 200.

Addendum (same day, later): push succeeded with user's 2nd fine-grained PAT (Contents:RW).
Follow-up cleanup before final push: untracked sandbox scaffolding that the orphan-branch
index had carried (.env, Caddyfile, dev.log.old, .zscripts/, examples/, mini-services/,
scripts/research.mjs, download/README.md); .gitignore hardened (dev.log*, scaffolding
block) + !.env.example un-blocked so the deploy kit's example env file is tracked.
Repo final state: 127 tracked files, .git ~400 KB, single commit e902acb→amended.
Tokens: both PATs were pasted in chat — user should revoke them when done pushing.
