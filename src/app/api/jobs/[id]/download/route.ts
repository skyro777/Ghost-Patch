import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { outputPath, safeBaseName } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download endpoint — speaks THREE slicing dialects because the preview
 * gateway kills long-lived streaming responses (whole-file streams stall
 * around ~100 MB) and 403s HEAD requests:
 *
 *   1. ?meta=1                     → JSON { ok, size, name } (plain GET probe)
 *   2. ?offset=N&length=M          → plain-GET byte slice, X-Total-Size header
 *   3. Range: bytes=a-b (header)   → classic 206 Partial Content
 *
 * A bare GET (no params) streams the whole file with Content-Length for
 * curl/browser-native <a download> use; HEAD answers size for local tools.
 */
const MAX_SLICE_BYTES = 64 * 1024 * 1024; // hard cap per slice request

function jsonError(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function contentHeaders(filename: string, size: number): Record<string, string> {
  return {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-Total-Size': String(size),
  };
}

/** Stream a byte range as a plain-GET response; fd destroyed on client abort. */
function sliceResponse(
  out: string,
  start: number,
  length: number,
  filename: string,
  totalSize: number,
  status = 200,
): Response {
  const end = start + length - 1; // inclusive, per createReadStream semantics
  const nodeStream = createReadStream(out, { start, end });
  nodeStream.on('error', () => nodeStream.destroy());
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(stream, {
    status,
    headers: {
      ...contentHeaders(filename, totalSize),
      'Content-Length': String(length),
    },
  });
}

function parseRangeHeader(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
    end = Math.min(end, size - 1); // clamp to EOF
  }
  if (start >= size) return { start: -1, end: -1 }; // signal "unsatisfiable"
  return { start, end };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await db.job.findUnique({ where: { id } });
    if (!job) return jsonError('Job not found.', 404);
    if (job.status !== 'DONE') {
      return jsonError('The patched file is not ready yet.', 409);
    }

    const out = outputPath(id);
    const info = await stat(out).catch(() => null);
    if (!info) {
      return jsonError(
        'The patched file expired (files auto-delete after ~2 hours). Please patch again.',
        410,
      );
    }

    const size = info.size;
    const filename = `ghostpatch-${safeBaseName(job.originalName)}.mp4`;
    const url = new URL(req.url);

    /* dialect 1: meta probe — plain GET, no HEAD (the gateway 403s HEAD) */
    if (url.searchParams.get('meta') === '1') {
      return NextResponse.json({ ok: true, size, name: filename });
    }

    /* dialect 2: query-string byte slices */
    const offsetRaw = url.searchParams.get('offset');
    const lengthRaw = url.searchParams.get('length');
    if (offsetRaw !== null || lengthRaw !== null) {
      const offset = Number(offsetRaw);
      const length = Number(lengthRaw);
      if (
        !Number.isInteger(offset) ||
        !Number.isInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > MAX_SLICE_BYTES
      ) {
        return jsonError('Bad slice parameters.', 400);
      }
      if (offset >= size) {
        return jsonError('Requested offset is beyond the end of the file.', 416);
      }
      const realLen = Math.min(length, size - offset);
      return sliceResponse(out, offset, realLen, filename, size);
    }

    /* dialect 3: classic Range header → 206 */
    const rangeHeader = req.headers.get('range');
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, size);
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'X-Total-Size': String(size) },
        });
      }
      if (range.start === -1) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'X-Total-Size': String(size) },
        });
      }
      const length = range.end - range.start + 1;
      const res = sliceResponse(out, range.start, length, filename, size, 206);
      res.headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      return res;
    }

    /* default: whole file (curl / direct <a download>) */
    return sliceResponse(out, 0, size, filename, size);
  } catch {
    return jsonError('Download failed.', 500);
  }
}

export async function HEAD(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const job = await db.job.findUnique({ where: { id } });
    if (!job) return new Response(null, { status: 404 });
    if (job.status !== 'DONE') return new Response(null, { status: 409 });
    const info = await stat(outputPath(id)).catch(() => null);
    if (!info) return new Response(null, { status: 410 });
    const filename = `ghostpatch-${safeBaseName(job.originalName)}.mp4`;
    return new Response(null, {
      status: 200,
      headers: {
        ...contentHeaders(filename, info.size),
        'Content-Length': String(info.size),
      },
    });
  } catch {
    return new Response(null, { status: 500 });
  }
}
