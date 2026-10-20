/**
 * Serving display items to the phone (docs/48).
 *
 *   GET /api/display/:id?k=KEY
 *
 * - A finished file is served with `Range` support, so a long video seeks and
 *   starts playing before it has downloaded — nothing is read into memory.
 * - A **live** file (one another agent is still writing) is streamed as it
 *   grows: the response starts at byte 0, follows the file while it grows, and
 *   ends when the agent calls `media_control(finish)` and the reader has
 *   caught up, when the file has not grown for `LIVE_IDLE_MS`, or when the
 *   item is removed. Browsers play a progressive MP3, Ogg, WebM or ADTS AAC
 *   response while it is still arriving.
 * - `url` items redirect; `data` items are served from memory.
 *
 * The key in `?k=` is the item's own, not the app token: `<video>` cannot send
 * a Bearer header, and a leaked key opens one item until it self-destructs.
 */

import { createReadStream, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDisplayRegistry, type DisplayItem, type DisplayRegistry } from './registry.js';
import { resolveAllowedImagePath } from '../mcp/server/imageRegistry.js';
import { childLogger } from '../log.js';

const log = childLogger('display:serve');

/** A live file that has not grown for this long is taken as done (for this response). */
export const LIVE_IDLE_MS = 30_000;
const LIVE_POLL_MS = 200;
const LIVE_CHUNK = 64 * 1024;

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single `bytes=` range against a known size. Returns null for no
 * usable range (serve the whole thing) and 'unsatisfiable' for a range that
 * starts past the end. Multi-range requests are answered with the whole file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { start, end };
}

export interface LiveTailOptions {
  /** Still being written? Checked every poll. */
  isLive: () => boolean;
  /** Item still exists? A removed item ends the stream. */
  exists: () => boolean;
  idleMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Follow a file as it grows, yielding new bytes. Waits for the file to appear
 * if the writer has not created it yet.
 */
export async function* tailFile(path: string, opts: LiveTailOptions): AsyncGenerator<Buffer> {
  const idleMs = opts.idleMs ?? LIVE_IDLE_MS;
  const pollMs = opts.pollMs ?? LIVE_POLL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  let lastGrowth = now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    while (!handle) {
      try {
        handle = await open(path, 'r');
      } catch {
        if (!opts.exists() || now() - lastGrowth > idleMs) return;
        await sleep(pollMs);
      }
    }
    let pos = 0;
    const buf = Buffer.alloc(LIVE_CHUNK);
    for (;;) {
      if (!opts.exists()) return;
      // Read the "finished" flag before the size: a finish that lands between
      // the two still gets one more full pass, so no tail bytes are lost.
      const live = opts.isLive();
      const { size } = await handle.stat();
      if (size > pos) {
        while (pos < size) {
          const { bytesRead } = await handle.read(buf, 0, Math.min(LIVE_CHUNK, size - pos), pos);
          if (bytesRead === 0) break;
          pos += bytesRead;
          yield Buffer.from(buf.subarray(0, bytesRead));
        }
        lastGrowth = now();
        continue;
      }
      if (!live) return;
      if (now() - lastGrowth > idleMs) return;
      await sleep(pollMs);
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sendBuffer(reply: FastifyReply, bytes: Buffer, mime: string, rangeHeader: string | undefined) {
  const range = parseRange(rangeHeader, bytes.length);
  reply.header('Content-Type', mime).header('Accept-Ranges', 'bytes');
  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
  }
  if (range) {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`)
      .send(bytes.subarray(range.start, range.end + 1));
  }
  return reply.send(bytes);
}

export async function serveDisplayItem(
  item: DisplayItem,
  reply: FastifyReply,
  rangeHeader: string | undefined,
  registry: DisplayRegistry,
): Promise<FastifyReply> {
  reply.header('Cache-Control', 'private, no-store');
  const { source } = item;

  if (source.type === 'url') return reply.redirect(source.url);
  if (source.type === 'data') return sendBuffer(reply, source.bytes, item.mime, rangeHeader);

  // Re-check on every request: a file swapped for a link after it was shown
  // must not escape the allowlist.
  const path = resolveAllowedImagePath(source.path, { allowMissing: item.live });
  if (!path) return reply.code(404).send({ error: 'File is no longer available' });

  if (item.live && !item.liveFinished) {
    const stream = Readable.from(
      tailFile(path, {
        isLive: () => !item.liveFinished,
        exists: () => registry.get(item.id) !== null,
      }),
    );
    stream.on('error', (err) => log.warn({ err, id: item.id }, 'live media stream failed'));
    return reply.header('Content-Type', item.mime).send(stream);
  }

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return reply.code(404).send({ error: 'File is no longer available' });
  }
  const range = parseRange(rangeHeader, size);
  reply.header('Content-Type', item.mime).header('Accept-Ranges', 'bytes');
  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  if (range) {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', String(range.end - range.start + 1))
      .send(createReadStream(path, { start: range.start, end: range.end }));
  }
  return reply.header('Content-Length', String(size)).send(createReadStream(path));
}

/** Route paths the auth gate lets through on the item key instead of the app token. */
export const DISPLAY_ROUTE_PREFIX = '/api/display/';

export function registerDisplayRoutes(app: FastifyInstance, registry: DisplayRegistry = getDisplayRegistry()): void {
  app.get<{ Params: { id: string }; Querystring: { k?: string } }>('/api/display/:id', async (req, reply) => {
    const key = typeof req.query.k === 'string' ? req.query.k : '';
    if (!key) return reply.code(401).send({ error: 'Missing access key' });
    const item = registry.getWithKey(req.params.id, key);
    if (!item) return reply.code(404).send({ error: 'Media not found or self-destructed' });
    return serveDisplayItem(item, reply, req.headers.range, registry);
  });
}
