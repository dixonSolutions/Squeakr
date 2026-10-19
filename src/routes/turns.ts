/**
 * Typed turns and agent state for desk clients.
 *
 *   POST /api/turns { text, is_interrupt?, media_ids?, media_delivery? }
 *                                             → spawn-or-queue (agent_native only)
 *   GET  /api/agent/state                     → the same snapshot `/ws/events` sends on auth
 *   GET  /api/jobs?project=&limit=&status=    → job history (same rows as list_jobs_history)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { listTurns } from '../state/turns.js';
import { submitAgentNativeTurn, TurnError } from '../executor/agentTurns.js';
import { deskStateSnapshot } from './eventsSocket.js';
import { getJobsHistory } from '../executor/jobManager.js';
import { childLogger } from '../log.js';

const log = childLogger('routes:turns');

const TurnBody = z
  .object({
    text: z.string().max(20_000).default(''),
    is_interrupt: z.boolean().optional(),
    source: z.string().max(40).optional(),
    /** Uploads from POST /api/media to send with this turn (docs/46). */
    media_ids: z.array(z.string().min(1)).max(20).optional(),
    media_delivery: z.enum(['path', 'inline']).optional(),
  })
  .refine((b) => b.text.trim().length > 0 || (b.media_ids?.length ?? 0) > 0, {
    message: 'Send text, media_ids, or both',
  });

export async function registerTurnRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/turns?project=&session_id=&limit= — the stored transcript, oldest
   * first, so a client that opens later can replay the conversation instead of
   * starting on a blank page.
   */
  app.get<{ Querystring: { project?: string; session_id?: string; limit?: string } }>(
    '/api/turns',
    async (req, reply) => {
      const project = req.query.project?.trim();
      if (!project) return reply.code(400).send({ error: 'Query parameter "project" is required' });
      const limit = Number.parseInt(req.query.limit ?? '', 10);
      const turns = listTurns(project, {
        sessionId: req.query.session_id?.trim() || null,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return { project, turns };
    },
  );

  app.post<{ Body: unknown }>('/api/turns', async (req, reply) => {
    const parsed = TurnBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const workflow = getConfig().settings.workflow.default;
    if (workflow !== 'agent_native') {
      return reply.code(409).send({
        error: `Typed turns need the agent_native workflow (active: ${workflow}). Switch it in Config.`,
      });
    }

    try {
      const { media_ids: mediaIds, media_delivery: mediaDelivery } = parsed.data;
      const delivery = submitAgentNativeTurn(parsed.data.text, {
        source: parsed.data.source ?? 'rest',
        isInterrupt: parsed.data.is_interrupt,
        ...(mediaIds?.length ? { media: { ids: mediaIds, delivery: mediaDelivery ?? 'path' } } : {}),
      });
      return { ok: true, ...delivery };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof TurnError ? err.code : 'ERROR';
      log.warn({ code, err: message }, 'turn rejected');
      const status = code === 'NO_PROJECT' ? 409 : code === 'MEDIA_GONE' ? 410 : code === 'EMPTY' ? 400 : 500;
      return reply.code(status).send({ error: message, code });
    }
  });

  app.get('/api/agent/state', async () => deskStateSnapshot());

  app.get<{ Querystring: { project?: string; limit?: string; status?: string } }>('/api/jobs', async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const status = req.query.status;
    const filter = status === 'done' || status === 'error' || status === 'stopped' ? status : 'all';
    const jobs = getJobsHistory(req.query.project || undefined, limit, filter).map((j) => ({
      id: j.id,
      project: j.project,
      mode: j.mode,
      prompt: j.prompt,
      status: j.status,
      session_id: j.sessionId,
      summary: j.summary,
      error: j.error,
      files_changed: j.diffstat ? (j.diffstat.match(/(\d+) files? changed/)?.[1] ? Number(j.diffstat.match(/(\d+) files? changed/)![1]) : null) : null,
      started_at: j.startedAt,
      finished_at: j.finishedAt,
      elapsed_ms: j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime() : null,
      checkpoint: j.checkpoint,
    }));
    return { jobs };
  });
}
