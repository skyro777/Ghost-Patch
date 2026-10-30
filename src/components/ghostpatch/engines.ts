import {
  Gauge,
  Ghost,
  Hourglass,
  MonitorPlay,
  RefreshCw,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { EngineMode } from './api';

export type EngineDef = {
  id: EngineMode;
  name: string;
  icon: LucideIcon;
  tagline: string;
  /** Solid amber "Recommended" badge. */
  recommended?: boolean;
  /** Muted "Advanced" badge — try if the primary profiles fail. */
  advanced?: boolean;
  /** Honest tag: this profile re-encodes the video stream. */
  reencodes?: boolean;
};

export const ENGINES: EngineDef[] = [
  {
    id: 'ghost',
    name: 'Ghost Patch',
    icon: Ghost,
    tagline:
      'No re-encode. Forges TikTok’s post-transcode fingerprint. Keeps 4K & 60fps exactly.',
    recommended: true,
  },
  {
    id: 'zero',
    name: 'Zero Duration',
    icon: Hourglass,
    tagline:
      'Advanced variant. Zeroes timing atoms. Try if Ghost gets compressed.',
    advanced: true,
  },
  {
    id: 'inflate',
    name: 'Inflate FPS',
    icon: Gauge,
    tagline: 'Advanced. Doubles reported FPS (60→120). For 120fps sources.',
    advanced: true,
  },
  {
    id: 'convert-h264',
    name: 'Convert HEVC → H.264',
    icon: RefreshCw,
    tagline:
      'Re-encodes HEVC to H.264, then applies the Ghost patch. TikTok trusts H.264 most.',
    reencodes: true,
  },
  {
    id: 'encode-1080',
    name: 'Re-encode 1080p',
    icon: MonitorPlay,
    tagline: 'Normalize + patch. For messy sources.',
    reencodes: true,
  },
  {
    id: 'encode-4k',
    name: 'Re-encode 4K Max',
    icon: Zap,
    tagline: 'H.264 Main L6.0 CRF14 + patch. For final 4K masters.',
    reencodes: true,
  },
];
