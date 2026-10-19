/**
 * show_images — push screenshots to the user's phone (non-blocking).
 *
 * Kept for agents and prompts that know it; it is now `show_media` with
 * images only: they open fullscreen for `duration_ms` (default 8 s), then
 * stay under the media button. A new show_images call replaces the previous
 * show_images batch, and leaves whatever show_media put up alone.
 */

import { ShowImagesSchema } from '../schemas.js';
import { handleShowMedia } from './displayToolHandlers.js';

export interface ShowImagesResult {
  ok: boolean;
  count: number;
  delivered: boolean;
  batch_id?: string;
  error?: string;
}

export function handleShowImages(args: unknown): ShowImagesResult {
  const parsed = ShowImagesSchema.safeParse(args);
  if (!parsed.success) {
    const message = parsed.error.errors.map((e) => e.message).join('; ');
    return { ok: false, count: 0, delivered: false, error: message };
  }

  const { images, duration_ms, caption, publish } = parsed.data;
  const result = handleShowMedia(
    {
      items: images.map((img) => ({ ...img, kind: 'image' as const })),
      display: 'fullscreen',
      auto_close_ms: duration_ms ?? 8000,
      ...(caption ? { caption } : {}),
      ...(publish === false ? { publish: false } : {}),
    },
    { origin: 'show_images', replaceOrigin: true },
  );

  if (!result['ok']) {
    return { ok: false, count: 0, delivered: false, error: String(result['error'] ?? 'show_images failed') };
  }
  return {
    ok: true,
    count: images.length,
    delivered: true,
    batch_id: String(result['batch_id']),
  };
}
