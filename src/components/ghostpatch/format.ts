/** GhostPatch — small display formatters. */

export function formatBytes(
  bytes: number | null | undefined,
  digits = 1,
): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[unit]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  if (!Number.isFinite(sec)) return '∞';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || Number.isNaN(fps)) return '—';
  return `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`;
}

export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!width || !height) return '—';
  return `${width}×${height}`;
}

export function formatBitrate(
  sizeBytes: number,
  durationSec: number | null | undefined,
): string | null {
  if (!durationSec || durationSec <= 0) return null;
  const mbps = (sizeBytes * 8) / durationSec / 1_000_000;
  if (!Number.isFinite(mbps) || mbps <= 0) return null;
  return `~${mbps.toFixed(1)} Mbps`;
}
