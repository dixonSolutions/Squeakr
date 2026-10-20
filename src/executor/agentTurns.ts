/**
 * One entry point for a user turn in the `agent_native` workflow, whichever
 * surface it came from: the phone (`/ws` after STT), the desk
 * socket (`/ws/events`), or `POST /api/turns` (typed in the IDE).
 *
 * Spawn-or-queue, exactly as the phone path always did:
 *   - no voice agent running → spawn the active CLI with the turn as its
 *     opening request (needs an active project);
 *   - agent alive → enqueue; the turn reaches it through next_voice_turn() or
 *     the interrupt hook (mcp/server/pendingWaits.ts).
 *
 * Nothing here is CLI-specific: the provider builds the argv in spawnVoiceAgent.
 */

import { getActiveProvider } from '../providers/agents/registry.js';
import { voiceTurnQueue, type EnqueueDelivery } from '../mcp/server/turnQueue.js';
import { resetTurnSpeakTracking } from '../mcp/server/voiceToolHandlers.js';
import type { TtsInterruptContext } from '../voice/ttsInterrupt.js';
import { getSessionState, resolveProject } from '../state/registry.js';
import { recordTurn } from '../state/turns.js';
import { publishEvent } from '../state/eventBus.js';
import { recordUserTurn } from '../logging/transcripts.js';
import { childLogger } from '../log.js';
import { resolveMediaIds } from '../media/store.js';
import {
  composeTurnText,
  describeMediaForAgent,
  setAttachTargetResolver,
  setInlineSupportResolver,
  takeAttachedMedia,
  type TurnMedia,
} from '../media/delivery.js';
import {
  getActiveVoiceAgent,
  isVoiceAgentRunning,
  refreshProjectForVoice,
  registerVoiceAgentExitHook,
  spawnVoiceAgent,
} from './voiceAgent.js';

const log = childLogger('agent-turns');

/**
 * Where a turn came from. `stream` is the direct audio pipe (docs/41): its
 * turns are segments cut at pauses, which the queue merges and the agent is
 * told may be half a thought.
 */
export type TurnSource = 'phone' | 'desk' | 'rest' | 'stream' | string;

export interface SubmitTurnOptions {
  /** Session key the turn belongs to — voice and desk share 'default'. */
  sessionKey?: string;
  source: TurnSource;
  isInterrupt?: boolean;
  ttsInterrupt?: TtsInterruptContext;
  /** Uploaded media sent with this turn (docs/46). */
  media?: TurnMedia;
}

export interface TurnDelivery {
  /** `spawn` = a new agent process opened with this turn; otherwise how the queue delivered it. */
  delivery: 'spawn' | EnqueueDelivery['kind'];
  project: string;
  run_id: string | null;
  pid: number | null;
  session_id: string | null;
  /** Media ids that went out with the turn, and any that had expired. */
  media_ids?: string[];
  media_missing?: string[];
}

export class TurnError extends Error {
  constructor(
    public readonly code: 'EMPTY' | 'NO_PROJECT' | 'SPAWN_FAILED' | 'MEDIA_GONE',
    message: string,
  ) {
    super(message);
    this.name = 'TurnError';
  }
}

/**
 * The turn's text with its media written in (docs/46): what the user sent
 * with it, then anything they attached to the conversation since the agent
 * last heard from them.
 */
export function withMedia(
  rawText: string,
  media: TurnMedia | undefined,
): { text: string; media: TurnMedia | undefined; missing: string[] } {
  const sent = media && media.ids.length > 0 ? resolveMediaIds(media.ids) : { found: [], missing: [] };
  if (media && media.ids.length > 0 && sent.found.length === 0) {
    throw new TurnError('MEDIA_GONE', 'The uploaded files have expired on the bridge — upload them again.');
  }
  const staged = takeAttachedMedia();
  let text = composeTurnText(rawText, sent.found, media?.delivery ?? 'path');
  if (staged) {
    const block = describeMediaForAgent(staged.assets, staged.delivery, 'attach');
    text = text ? `${text}\n\n${block}` : block;
  }
  const ids = [...sent.found.map((a) => a.id), ...(staged?.assets.map((a) => a.id) ?? [])];
  const inline = media?.delivery === 'inline' || staged?.delivery === 'inline';
  return {
    text,
    media: ids.length > 0 ? { ids, delivery: inline ? 'inline' : 'path' } : undefined,
    missing: sent.missing,
  };
}

export function submitAgentNativeTurn(rawText: string, opts: SubmitTurnOptions): TurnDelivery {
  if (!rawText.trim() && !(opts.media && opts.media.ids.length > 0)) {
    throw new TurnError('EMPTY', 'Turn text is empty.');
  }
  const { text, media, missing } = withMedia(rawText, opts.media);
  const sessionKey = opts.sessionKey ?? 'default';

  const bridgeSession = getSessionState(sessionKey);
  let project = resolveProject(bridgeSession.activeProject ?? '');
  const alreadyRunning = isVoiceAgentRunning();
  let delivery: TurnDelivery['delivery'];

  if (!alreadyRunning) {
    if (!project) {
      throw new TurnError('NO_PROJECT', 'No project is selected. Choose a project first.');
    }
    // New agent process — reset speak tracking and drop orphaned queue items
    // from a previous run that never called next_voice_turn().
    resetTurnSpeakTracking();
    voiceTurnQueue.clear();
    project = refreshProjectForVoice(project);
    try {
      spawnVoiceAgent(project, bridgeSession, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionKey, source: opts.source }, 'voice agent spawn failed');
      throw new TurnError(
        'SPAWN_FAILED',
        `Could not start ${getActiveProvider().displayName}: ${message}`,
      );
    }
    delivery = 'spawn';
  } else {
    // Follow-up while the same agent is still alive: do NOT reset spokeThisTurn
    // (see intelligence/ws.ts history) — tracking resets when next_voice_turn()
    // actually delivers the turn.
    const result = voiceTurnQueue.enqueue(text, {
      isInterrupt: opts.isInterrupt,
      ttsInterrupt: opts.ttsInterrupt,
      source: opts.source,
      ...(media ? { media } : {}),
    });
    delivery = result.kind;
  }

  const va = getActiveVoiceAgent();
  const out: TurnDelivery = {
    delivery,
    project: va?.project ?? project?.name ?? '',
    run_id: va?.runId ?? null,
    pid: va?.pid ?? null,
    session_id: va?.sessionId ?? null,
    ...(media ? { media_ids: media.ids } : {}),
    ...(missing.length > 0 ? { media_missing: missing } : {}),
  };

  log.info(
    { sessionKey, source: opts.source, runId: out.run_id, pid: out.pid, delivery, textLen: text.length, media: media?.ids.length ?? 0 },
    'agent_native turn delivered',
  );
  // Every desk client sees every turn, whichever surface typed or spoke it.
  publishEvent({ type: 'user_turn', text, source: opts.source, delivery, run_id: out.run_id });
  // …and every turn is kept, so a client opened later can replay the thread.
  recordTurn({ project: out.project, sessionId: out.session_id, role: 'user', text, source: opts.source });
  // The session transcript file (logging/transcripts.ts) gets it too.
  recordUserTurn(text, opts.source);
  return out;
}

// Attached media (docs/46) rides out on the voice agent's own MCP session —
// never on a worker's, which would act on it as if it were its own request.
setAttachTargetResolver((sessionKey) => {
  const va = getActiveVoiceAgent();
  return Boolean(va?.mcpSessionId && va.mcpSessionId === sessionKey);
});

// Whether pictures can go straight into the chat is the active CLI's call
// (provider rule: every provider declares mediaInput()).
setInlineSupportResolver(() => {
  const provider = getActiveProvider();
  return { supported: provider.mediaInput().mcpImageResults, cli: provider.displayName };
});

// ── Orphaned turns ───────────────────────────────────────────────────────────
//
// A turn that arrives while the agent process is already on its way out (it
// called done() and then finished instead of polling next_voice_turn()) lands
// in the queue and would sit there until the next turn — which then *clears*
// the queue before spawning. Live-tested on Claude Code from the desk: the
// second typed turn simply vanished. So when a voice agent exits cleanly with
// turns still queued, respawn immediately with them as the opening request;
// the project's resume id keeps it the same conversation.

async function drainQueuedTurns(): Promise<string[]> {
  const texts: string[] = [];
  while (voiceTurnQueue.size > 0) {
    const turn = await voiceTurnQueue.dequeue(1);
    if (!turn) break;
    texts.push(turn.text);
  }
  return texts;
}

registerVoiceAgentExitHook((info) => {
  if (info.stopped || info.exitCode !== 0 || voiceTurnQueue.size === 0) return;
  void drainQueuedTurns().then((texts) => {
    if (texts.length === 0 || isVoiceAgentRunning()) return;
    const text = texts.join('\n\n');
    log.info({ runId: info.runId, turns: texts.length }, 'voice agent exited with turns queued — respawning');
    try {
      submitAgentNativeTurn(text, { source: 'requeue' });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'respawn with queued turn failed');
      publishEvent({ type: 'error', code: 'RESPAWN_FAILED', message: err instanceof Error ? err.message : String(err) });
    }
  });
});
