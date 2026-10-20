/**
 * send_files — hand the user files: a recording, a video, a screenshot, a
 * document. Delivered wherever they are listening — a chat channel posts them
 * as attachments (channels/hub.ts); images also open on the phone
 * (show_images), and video / audio go under its media button (show_media,
 * docs/48). Non-blocking, like show_images.
 *
 * Both tools publish an `agent_files` event with what they sent, so every
 * surface sees the same files.
 */

import { publishEvent } from '../../state/eventBus.js';
import { childLogger } from '../../log.js';
import { SendFilesSchema } from '../schemas.js';
import { resolveAllowedImagePath } from './imageRegistry.js';
import { handleShowImages } from './imageToolHandlers.js';
import { handleShowMedia } from './displayToolHandlers.js';
import { kindFromMime, mimeFromName } from '../../display/registry.js';

const log = childLogger('mcp:server:fileTools');

export interface AgentFileOut {
  path?: string;
  url?: string;
  data?: string;
  mime?: string;
  name?: string;
  caption?: string;
}

/** Tell every surface the agent sent files (paths already checked against the allowlist). */
export function publishAgentFiles(files: AgentFileOut[], caption: string | null): void {
  if (files.length) publishEvent({ type: 'agent_files', files, caption });
}

export function handleSendFiles(args: unknown): { ok: boolean; count: number; error?: string } {
  const parsed = SendFilesSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, count: 0, error: parsed.error.errors.map((e) => e.message).join('; ') };
  }
  const { files, caption } = parsed.data;
  const out: AgentFileOut[] = [];
  for (const f of files) {
    if (f.path) {
      const resolved = resolveAllowedImagePath(f.path);
      if (!resolved) return { ok: false, count: 0, error: `${f.path} is not a readable file under a project or the temp directory` };
      out.push({ ...f, path: resolved });
    } else {
      out.push(f);
    }
  }
  // Images also open on the phone; video and audio wait under its media button.
  const kindOf = (f: AgentFileOut) => {
    const mime = f.mime ?? mimeFromName(f.path ?? f.url ?? f.name ?? '');
    return mime ? kindFromMime(mime) : null;
  };
  const images = out.filter((f) => kindOf(f) === 'image');
  if (images.length) {
    handleShowImages({ images: images.slice(0, 10).map(({ name: _n, ...img }) => img), ...(caption ? { caption } : {}), publish: false });
  }
  const playable = out.filter((f) => kindOf(f) === 'video' || kindOf(f) === 'audio');
  if (playable.length) {
    const shown = handleShowMedia({ items: playable.slice(0, 10), display: 'tray', ...(caption ? { caption } : {}), publish: false });
    if (!shown['ok']) log.warn({ error: shown['error'] }, 'send_files: could not put media on the phone');
  }
  publishAgentFiles(out, caption ?? null);
  log.info({ count: out.length }, 'send_files published');
  return { ok: true, count: out.length };
}
