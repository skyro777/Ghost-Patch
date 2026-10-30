'use client';

import { useCallback, useRef, useState } from 'react';
import { CloudUpload } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Click-or-drag file target. The clickable surface is a native <label htmlFor>
 * pointing at the hidden input — the browser opens the file picker WITHOUT any
 * JavaScript, so picking survives React handler loss (HMR hiccups) and any
 * programmatic-click suppression. Keyboard users get an Enter/Space backup and
 * drag & drop keeps working. Validation itself lives in the parent Optimizer,
 * which surfaces rejections as an inline alert (not just a corner toast).
 */
export const GHOSTPATCH_FILE_INPUT_ID = 'ghostpatch-file-input';

export function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <label
      htmlFor={GHOSTPATCH_FILE_INPUT_ID}
      role="button"
      tabIndex={0}
      aria-label="Choose a video file to patch"
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'group block cursor-pointer rounded-xl border-2 border-dashed px-6 py-16 text-center outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-amber-500/40',
        dragOver
          ? 'border-amber-400 bg-amber-500/5 shadow-[0_0_60px_-15px_rgba(251,191,36,0.35)]'
          : 'border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900/40',
      )}
    >
      <input
        ref={inputRef}
        id={GHOSTPATCH_FILE_INPUT_ID}
        type="file"
        accept=".mp4,.mov,.m4v,video/mp4,video/quicktime,video/x-m4v"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.currentTarget.value = '';
        }}
      />

      <span
        className={cn(
          'mx-auto flex size-16 items-center justify-center rounded-full border transition-colors',
          dragOver
            ? 'border-amber-400/60 bg-amber-500/10 text-amber-300'
            : 'border-zinc-700 bg-zinc-900 text-zinc-400 group-hover:text-zinc-200',
        )}
      >
        <CloudUpload className="size-8" aria-hidden />
      </span>

      <p className="mt-5 text-lg font-semibold text-zinc-100">
        Drop your 4K video here
      </p>
      <p className="mt-1.5 text-sm text-zinc-500">
        or click to browse · MP4 / MOV — H.264 or HEVC · up to 500 MB
      </p>
    </label>
  );
}
