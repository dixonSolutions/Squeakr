/**
 * Voice I/O tool handlers for the Squeakr MCP server.
 *
 * The voice agent calls these tools to interact with the user over voice:
 *   speak(text)         — push text to TTS, forward audio to PWA
 *   done()              — signal PWA to re-arm mic for next wake word
 *   next_voice_turn()   — long-poll dequeue of next user utterance
 *
 * The `speak` path mirrors the llm_intelligence `onSpeak` callback: it sends
 * { type: "speak", text } to all connected WebSocket clients.
 *
 * See docs/16-mcp-server-agent-as-brain.md.
 */

import { childLogger } from '../../log.js';
import { getConfig } from '../../config.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { STREAM_TURN_HINT, voiceTurnQueue } from './turnQueue.js';
import { getActiveProvider } from '../../providers/agents/registry.js';
import { getActiveVoiceAgent } from '../../executor/voiceAgent.js';
import { recordTurn } from '../../state/turns.js';
import { markVoiceTurnStarted, markVoiceTurnFinished } from '../../state/agentBusy.js';
import {
  withListener,
  listenerBlock,
  isListening,
  effectiveAwayPolicy,
  awayPollDelay,
  chargeAwayBudget,
  AWAY_POLL_FLOOR_MS,
  type ListenerBlock,
} from '../../state/awayPolicy.js';
import {
  recordAgentSpeech,
  recordTranscriptEvent,
  transcriptClientConnected,
  transcriptClientDisconnected,
} from '../../logging/transcripts.js';

const log = childLogger('mcp:server:voiceTools');

voiceTurnQueue.setQueuedWithoutWaiterHandler((queueLen) => {
  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'user_turn',
    phase: 'start',
    label: 'User turn queued',
    detail: `${queueLen} pending — voice agent not in next_voice_turn()`,
  });
  log.info({ queueLen }, 'user turn queued while voice agent busy (not polling)');
});

voiceTurnQueue.setToolsInterruptedHandler((delivery, turn) => {
  // Dismiss any approval/question card the user has effectively answered by
  // speaking. `meta` is the ApprovalRequest the registry attached.
  for (const wait of delivery.aborted) {
    const request = wait.meta as { request_id?: string } | undefined;
    if (!request?.request_id) continue;
    void notifyPhone({
      type: 'approval_cancelled',
      request_id: request.request_id,
      reason: 'user_turn',
    });
  }

  const tools = [...delivery.aborted, ...delivery.annotated].map((w) => w.tool);
  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'user_turn',
    phase: 'start',
    label:
      delivery.aborted.length > 0
        ? 'User turn delivered — wait released'
        : 'User turn attached to running work',
    detail: turn.text.slice(0, 120),
  });
  log.info(
    { tools, aborted: delivery.aborted.length, annotated: delivery.annotated.length },
    'user turn delivered through in-flight Squeakr tool(s)',
  );
});

/**
 * Tracks whether the current voice turn produced any speak() calls.
 * Used by the voice-agent exit fallback so mute agents still get TTS.
 *
 * Cleared when:
 *   - a new voice-agent process is spawned, or
 *   - next_voice_turn() delivers a real follow-up turn to the same process
 * NOT cleared when a follow-up is merely queued while the agent is mid-turn /
 * on done() — otherwise exit-fallback thinks the agent was silent and speaks
 * the agent’s internal assistant/planning text after a normal speak→done turn.
 */
let spokeThisTurn = false;

/** Reset at the start of a new agent-handled user turn. */
export function resetTurnSpeakTracking(): void {
  spokeThisTurn = false;
}

export function hadSpeakThisTurn(): boolean {
  return spokeThisTurn;
}

// ── Session broadcast registry ────────────────────────────────────────────
//
// WebSocket connections register here so speak() can push audio.

type SendFn = (payload: unknown) => void;

const activeSessions = new Set<SendFn>();

export const NO_VOICE_SESSION_ERROR =
  'No active phone voice session — speak/done/next_voice_turn only work while the PWA voice session is live. Use normal text in the desktop IDE.';

/**
 * Anything the agent says while the user is away, kept for the catch-up
 * digest they hear on reconnect (docs/36 §3.5). Bounded: a long unattended run
 * must not grow this without limit.
 */
const MAX_BUFFERED_SPEECH = 40;
const bufferedSpeech: Array<{ at: string; text: string }> = [];

export function bufferedAwaySpeech(): ReadonlyArray<{ at: string; text: string }> {
  return bufferedSpeech;
}

export function clearBufferedAwaySpeech(): void {
  bufferedSpeech.length = 0;
}

function bufferAwaySpeech(text: string): void {
  bufferedSpeech.push({ at: new Date().toISOString(), text });
  if (bufferedSpeech.length > MAX_BUFFERED_SPEECH) bufferedSpeech.shift();
}

export function hasActiveVoiceSession(): boolean {
  return activeSessions.size > 0;
}

export function getActiveVoiceSessionCount(): number {
  return activeSessions.size;
}

/**
 * Register a live voice client. `client` names it in the session transcript
 * ("phone", "audio pipe"); the transcript opens with the first client and
 * closes shortly after the last one leaves (logging/transcripts.ts).
 */
export function registerVoiceSession(send: SendFn, client = 'phone'): () => void {
  activeSessions.add(send);
  transcriptClientConnected(client);
  log.debug({ sessions: activeSessions.size, client }, 'voice session registered');
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    activeSessions.delete(send);
    transcriptClientDisconnected(client);
    log.debug({ sessions: activeSessions.size, client }, 'voice session unregistered');
  };
}

const taps = new Set<SendFn>();

/**
 * See everything voice clients are sent — session logs, tool activity, the
 * agent's lines — without being one: a tap is not a listener, so nobody
 * counts as present because of it (channels pour it into a chat).
 */
export function tapVoiceBroadcasts(fn: SendFn): () => void {
  taps.add(fn);
  return () => {
    taps.delete(fn);
  };
}

export function broadcastToVoiceSessions(payload: unknown): void {
  for (const tap of taps) {
    try {
      tap(payload);
    } catch (err) {
      log.warn({ err }, 'voice broadcast tap failed');
    }
  }
  for (const send of activeSessions) {
    try {
      send(payload);
    } catch (err) {
      log.warn({ err }, 'broadcast to session failed');
    }
  }
}

const turnCompleteHooks = new Set<() => void>();

/** Called when the agent invokes done() — clears server-side turn state. */
export function registerTurnCompleteHook(fn: () => void): () => void {
  turnCompleteHooks.add(fn);
  return () => {
    turnCompleteHooks.delete(fn);
  };
}

function notifyTurnComplete(): void {
  for (const fn of turnCompleteHooks) {
    try {
      fn();
    } catch (err) {
      log.warn({ err }, 'turn complete hook failed');
    }
  }
}

// ── Voice agent status broadcast ──────────────────────────────────────────

export interface VoiceAgentStatusPayload {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId?: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
}

/**
 * The coding agent behind this run, sent with every status broadcast.
 *
 * The PWA used to hardcode "Cursor agent starting…" in its session log, which
 * was simply wrong for Codex and Claude Code — and read as if Squeakr were
 * announcing its own internals. Shipping the provider identity with the event
 * means the log always names the CLI that is actually running.
 */
function activeAgentIdentity(): { id: string; displayName: string } {
  const provider = getActiveProvider();
  return { id: provider.id, displayName: provider.displayName };
}

/** Push voice agent lifecycle to all connected PWA sessions (debug/monitor). */
export function broadcastVoiceAgentStatus(payload: VoiceAgentStatusPayload): void {
  log.info(
    {
      runId: payload.runId,
      pid: payload.pid,
      sessionId: payload.sessionId,
      mcpSessionId: payload.mcpSessionId,
      state: payload.state,
    },
    'voice agent status',
  );

  const agent = activeAgentIdentity();
  recordTranscriptEvent(
    `${agent.displayName} ${payload.state}` +
      (payload.pid ? ` (pid ${payload.pid})` : '') +
      (payload.project ? ` — project ${payload.project}` : ''),
  );
  broadcastToVoiceSessions({
    type: 'voice_agent_status',
    run_id: payload.runId,
    pid: payload.pid,
    session_id: payload.sessionId,
    mcp_session_id: payload.mcpSessionId ?? null,
    state: payload.state,
    project: payload.project,
    provider: agent.id,
    provider_name: agent.displayName,
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────

export interface SpeakArgs {
  text: string;
  /** When false, plays TTS but does not count as the agent having spoken this turn. */
  countTowardTurn?: boolean;
}

export interface SpeakResult {
  ok: boolean;
  sessions: number;
  error?: string;
  message?: string;
  /** Turns the user has spoken that the agent has not collected yet. */
  pending_user_turns?: number;
  /** False when nobody heard this line — it was kept for the catch-up digest. */
  delivered?: boolean;
  buffered?: boolean;
  /** Presence and the away policy, on every squeakr result (docs/36 §3.1). */
  listener?: ListenerBlock;
}

/**
 * Tell the agent about anything the user said while it was busy.
 *
 * The interrupt hook (pendingWaits.ts) covers turns that arrive while the agent
 * is inside one of OUR tools. It cannot cover the common case: the agent doing
 * its own research with its own Read/Grep/Bash tools, where no Squeakr tool
 * is in flight and the turn simply lands in the buffer. Live testing showed the
 * agent then finishes its previous answer and calls done() — the user's
 * interruption is heard nowhere until the following turn.
 *
 * speak() is the one tool the agent calls constantly (once per sentence), so
 * hanging the notice off its result surfaces a buffered turn within one
 * sentence, without polling and without interrupting the work.
 *
 * The turn is NOT consumed here — next_voice_turn() stays the single point of
 * delivery, so a turn can never be handed out twice.
 */
function pendingTurnNotice(result: { message?: string; pending_user_turns?: number }): void {
  const pending = voiceTurnQueue.size;
  if (pending === 0) return;
  result.pending_user_turns = pending;
  result.message =
    `The user has spoken ${pending} time${pending === 1 ? '' : 's'} while you were working. ` +
    'Call next_voice_turn() NOW to receive it before continuing — it may change what they want. ' +
    'Do not call done() with turns still pending.';
}

/**
 * speak(text) — called by the voice agent to deliver a response to the user.
 * Broadcasts { type: "speak", text } to all connected PWA sessions.
 */
export function handleSpeak(args: SpeakArgs): SpeakResult {
  const text = (args.text ?? '').trim();
  if (!text) {
    return withListener({ ok: false, sessions: 0 });
  }
  if (!hasActiveVoiceSession()) {
    /**
     * Not an error any more. A `speak` with nobody listening used to come back
     * as NO_VOICE_SESSION with a message telling the agent to "use normal
     * text", so in practice it answered into a void and exited after its
     * current step — whatever the user's away policy said. Now the line is
     * kept for the catch-up digest and the agent is told to carry on.
     */
    bufferAwaySpeech(text);
    recordAgentSpeech(text, 'unheard');
    log.info(
      { text: text.slice(0, 80), policy: effectiveAwayPolicy() },
      'speak buffered — nobody listening',
    );
    return withListener({
      ok: true,
      sessions: 0,
      delivered: false,
      buffered: true,
      message:
        'Nobody is listening right now — this line was saved for the catch-up ' +
        'summary the user hears when they come back. Keep going per the listener policy.',
    });
  }

  if (args.countTowardTurn !== false) {
    spokeThisTurn = true;
  }
  log.info({ text: text.slice(0, 80), sessions: activeSessions.size }, 'speak called');
  recordAgentSpeech(text);
  // eslint-disable-next-line no-console
  console.log(`[voice] ◀ speak: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`);
  broadcastToVoiceSessions({ type: 'speak', text });
  broadcastToVoiceSessions({ type: 'assistant_transcript', text });
  // Keep what was actually said — this is the only record of a spoken reply.
  const speaking = getActiveVoiceAgent();
  if (speaking?.project) {
    recordTurn({ project: speaking.project, sessionId: speaking.sessionId ?? null, role: 'agent', text });
  }

  const result: SpeakResult = { ok: true, sessions: activeSessions.size, delivered: true };
  pendingTurnNotice(result);
  return withListener(result);
}

export interface DoneResult {
  ok: boolean;
  error?: string;
  message?: string;
  pending_user_turns?: number;
  listener?: ListenerBlock;
}

/**
 * done() — called by the voice agent when it has finished speaking.
 * Sends turn_complete; the PWA re-arms after queued TTS has finished.
 */
export function handleDone(): DoneResult {
  if (!hasActiveVoiceSession()) {
    // With nobody listening there is no mic to re-arm, so done() is simply
    // the end of the run. Returning an error here made the agent retry.
    return withListener({
      ok: true,
      message:
        'Nobody is listening — the turn is closed. If work remains and the ' +
        'policy is keep_working, carry on; otherwise this run may end.',
    });
  }

  // Ending the turn with an uncollected utterance means the user is ignored
  // until they speak again. Surface it rather than silently re-arming.
  const result: DoneResult = { ok: true };
  pendingTurnNotice(result);
  if (result.pending_user_turns) {
    log.warn({ pending: result.pending_user_turns }, 'done() called with user turns still queued');
  }

  broadcastVoiceTurnIdle();
  return withListener(result);
}

/** Mark the turn complete — PWA waits for queued speech before re-arming. */
export function broadcastVoiceTurnIdle(): void {
  markVoiceTurnFinished();
  // Do not clear spokeThisTurn here — voiceAgent exit still needs it.
  log.info('voice turn complete — PWA will re-arm after queued speech');
  // eslint-disable-next-line no-console
  console.log('[voice] ✓ done — finishing queued speech before mic re-arms');
  broadcastToVoiceSessions({ type: 'thinking', value: false });
  broadcastToVoiceSessions({ type: 'turn_complete' });
  notifyTurnComplete();
}

export interface NextVoiceTurnArgs {
  /** Maximum milliseconds to wait for a turn (default 30 000, max 60 000). */
  timeout_ms?: number;
}

export interface NextVoiceTurnResult {
  /** The transcribed text, or null if timeout elapsed with no turn. */
  turn: string | null;
  /** Whether the turn should interrupt in-progress work. */
  is_interrupt: boolean;
  /** ISO timestamp the turn was received, or null on timeout. */
  received_at: string | null;
  /** Turns still buffered after this dequeue. */
  queue_depth: number;
  /** `voice` (a finished turn), `typed`, or `stream` (piped audio, may be partial). */
  /** How the turn arrived: phone, desk, rest… or `stream` (direct audio pipe, may be partial). */
  source?: string;
  /** Streamed turns only: audio segments merged into this turn. */
  segments?: number;
  /** Streamed turns only: how to treat a turn that may be mid-thought. */
  stream_hint?: string;
  /** Uploaded media in this turn (docs/46): ids for view_media, and how the user wants it delivered. */
  media_ids?: string[];
  media_delivery?: 'path' | 'inline';
  error?: string;
  message?: string;
  listener?: ListenerBlock;
  /**
   * Set while nobody is listening: how long the bridge will make the next poll
   * wait. The floor is enforced server-side, not left to the agent's goodwill —
   * an agent looping on "no turn" burns the user's tokens for as long as they
   * are gone.
   */
  retry_after_ms?: number;
  /**
   * Attached to the first turn after the user comes back: how long they were
   * away and what happened meanwhile, so the agent can tell them in its own
   * words instead of the bridge speaking over it (docs/36 §3.5).
   */
  reconnected?: {
    away_ms: number;
    digest: string | null;
    spoken_while_away: Array<{ at: string; text: string }>;
  };
  /**
   * When the user barged in during TTS: what they heard (especially last_heard_words),
   * plus lines cut off / not spoken. The agent keeps running — do not stop workers.
   */
  tts_interrupt?: {
    heard_complete: string[];
    heard_partial: string | null;
    not_spoken: string[];
    partial_words_estimate?: string | null;
    /** Last ~10 words the user heard aloud — treat as ground truth for continuity. */
    last_heard_words?: string;
  };
}

const MAX_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 30_000;

/**
 * next_voice_turn() — long-poll dequeue.
 * The voice agent calls this in a loop to receive the user's next utterance.
 * Returns immediately if a turn is already queued; otherwise suspends up to timeout_ms.
 */
export async function handleNextVoiceTurn(
  args: NextVoiceTurnArgs,
): Promise<NextVoiceTurnResult> {
  const configuredDefault =
    getConfig().settings.voice.workerPollTimeoutMs ?? DEFAULT_POLL_MS;
  const timeoutMs = Math.min(
    args.timeout_ms != null && args.timeout_ms > 0 ? args.timeout_ms : configuredDefault,
    MAX_POLL_MS,
  );

  if (!hasActiveVoiceSession()) {
    // Count this against the unattended budget before waiting, so a runaway
    // loop is caught on its own next call rather than after it finishes.
    const verdict = chargeAwayBudget();
    await awayPollDelay(timeoutMs);
    return withListener({
      turn: null,
      is_interrupt: false,
      received_at: null,
      queue_depth: 0,
      retry_after_ms: AWAY_POLL_FLOOR_MS,
      message:
        verdict.exceeded && verdict.message
          ? verdict.message
          : 'Nobody is listening. There will be no turns until the user comes back — ' +
            'do not poll in a tight loop; follow the listener policy instead.',
    });
  }

  const wasAway = !isListening();
  const turn = await voiceTurnQueue.dequeue(timeoutMs);

  if (!turn) {
    return withListener({ turn: null, is_interrupt: false, received_at: null, queue_depth: 0 });
  }

  // New utterance handed to this agent process — re-arm mute-exit fallback.
  resetTurnSpeakTracking();
  markVoiceTurnStarted();

  // Only signal thinking once a real user turn has arrived — not on every poll start.
  broadcastToVoiceSessions({ type: 'thinking', value: true });

  broadcastToVoiceSessions({
    type: 'tool_activity',
    tool: 'next_voice_turn',
    phase: 'done',
    label: 'Agent received turn',
    detail: turn.text.slice(0, 120),
  });

  const reconnected = buildReconnectBlock(wasAway);

  return withListener({
    turn: turn.text,
    is_interrupt: turn.isInterrupt,
    received_at: turn.receivedAt,
    queue_depth: voiceTurnQueue.size,
    source: turn.source,
    ...(turn.source === 'stream'
      ? { segments: turn.segments ?? 1, stream_hint: STREAM_TURN_HINT }
      : {}),
    ...(turn.ttsInterrupt ? { tts_interrupt: turn.ttsInterrupt } : {}),
    ...(turn.media ? { media_ids: turn.media.ids, media_delivery: turn.media.delivery } : {}),
    ...(reconnected ? { reconnected } : {}),
  });
}

/** Digest supplier, injected so this module does not depend on the executor. */
type DigestFn = () => { text: string } | null;
let digestFn: DigestFn = () => null;

export function setReconnectDigestSource(fn: DigestFn): void {
  digestFn = fn;
}

/**
 * Everything the user missed, handed to the agent with the first turn after
 * they come back. The agent retells it in its own words; the bridge does not
 * speak it, so the user is not talked over the moment they say something.
 */
function buildReconnectBlock(wasAway: boolean): NextVoiceTurnResult['reconnected'] {
  const spoken = [...bufferedAwaySpeech()];
  const digest = digestFn();
  if (!wasAway && spoken.length === 0 && !digest) return undefined;

  const block = {
    away_ms: listenerBlock().away_ms,
    digest: digest?.text ?? null,
    spoken_while_away: spoken,
  };
  clearBufferedAwaySpeech();
  return block;
}
