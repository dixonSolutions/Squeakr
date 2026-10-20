/**
 * Media uploads from the phone (docs/46).
 *
 *   GET  /api/media/capabilities      → what the bridge can do with uploads right now
 *   POST /api/media?name=<file>       → raw file body (any Content-Type), streamed to disk,
 *                                       then transcribed / framed; returns the asset
 *   POST /api/media/:id/pcm           → 16 kHz mono PCM16 the phone decoded itself, for a
 *                                       format the bridge could not (`needs_pcm`)
 *   POST /api/media/attach            → { ids, delivery } stage media for the conversation
 *                                       in flight (rides the agent's next Squeakr tool call)
 *
 * Sending media as a new turn goes through the normal turn paths —
 * `user_turn` on /ws with `media_ids`, or POST /api/turns — so it is
 * spawn-or-queue exactly like a spoken turn.
 */

import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { childLogger } from '../log.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { hasServerSpeechInput } from '../providers/speech/input/service.js';
import { isVoiceAgentRunning } from '../executor/voiceAgent.js';
import { mediaTools } from '../media/decode.js';
import { attachMedia, attachedCount, inlineSupported } from '../media/delivery.js';
import { defaultPipelineDeps, processMedia, transcribeAssetPcm, type PipelineDeps } from '../media/pipeline.js';
import {
  getMedia,
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  resolveMediaIds,
  saveMediaStream,
  viewMedia,
} from '../media/store.js';

const log = childLogger('routes:media');

/** An hour of 16 kHz mono PCM16 is ~115 MB. */
const MAX_PCM_BYTES = 128 * 1024 * 1024;

const AttachBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
  delivery: z.enum(['path', 'inline']).default('path'),
});

export interface MediaRouteOptions {
  /** Where uploads are written (default: `<data>/media/<day>/`). */
  dir?: () => string;
  /** Speech-to-text for recordings (default: the configured chain). */
  pipeline?: PipelineDeps;
}

export async function registerMediaRoutes(app: FastifyInstance, opts: MediaRouteOptions = {}): Promise<void> {
  const pipelineDeps = opts.pipeline ?? defaultPipelineDeps;

  app.get('/api/media/capabilities', async () => {
    const provider = getActiveProvider();
    const media = provider.mediaInput();
    const tools = mediaTools();
    return {
      max_bytes: MAX_MEDIA_BYTES,
      transcription: hasServerSpeechInput(),
      ffmpeg: tools.ffmpeg !== null,
      inline: { supported: media.mcpImageResults, cli: provider.displayName, note: media.note },
      attached: attachedCount(),
      agent_running: isVoiceAgentRunning(),
    };
  });

  // The upload body is streamed straight to disk, so this scope drops the
  // app's buffering parsers (and their 10 MB body limit) for its one route.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));

    scope.post<{ Querystring: { name?: string } }>('/api/media', async (req, reply) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_MEDIA_BYTES) {
        return reply.code(413).send({ error: new MediaTooLargeError(MAX_MEDIA_BYTES).message });
      }
      const name = (req.query.name ?? '').trim() || 'upload';
      let asset;
      try {
        asset = await saveMediaStream(req.raw as Readable, {
          name,
          mime: req.headers['content-type'] ?? null,
          ...(opts.dir ? { dir: opts.dir() } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message, name }, 'media upload failed');
        return reply.code(err instanceof MediaTooLargeError ? 413 : 400).send({ error: message });
      }
      await processMedia(asset, pipelineDeps);
      return viewMedia(asset);
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/media/:id/pcm',
    { bodyLimit: MAX_PCM_BYTES },
    async (req, reply) => {
      const asset = getMedia(req.params.id);
      if (!asset) return reply.code(404).send({ error: 'Upload not found or expired' });
      if (!Buffer.isBuffer(req.body) || req.body.length < 2) {
        return reply.code(400).send({ error: 'Send 16 kHz mono PCM16LE as application/octet-stream' });
      }
      await transcribeAssetPcm(asset, req.body, pipelineDeps);
      return viewMedia(asset);
    },
  );

  app.post<{ Body: unknown }>('/api/media/attach', async (req, reply) => {
    const parsed = AttachBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { found, missing } = resolveMediaIds(parsed.data.ids);
    if (found.length === 0) return reply.code(404).send({ error: 'Uploads not found or expired', missing });
    const count = attachMedia(found.map((a) => a.id), parsed.data.delivery);
    const running = isVoiceAgentRunning();
    return {
      ok: true,
      attached: count,
      ...(missing.length > 0 ? { missing } : {}),
      delivery: parsed.data.delivery === 'inline' && !inlineSupported().supported ? 'path' : parsed.data.delivery,
      // Where it goes next: the running agent's next Squeakr tool call, or the next turn.
      when: running ? 'next_tool_call' : 'next_turn',
    };
  });
}
