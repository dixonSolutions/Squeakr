/**
 * Voice turn queue — bridges incoming STT transcripts to the agent's
 * `next_voice_turn()` polls.
 *
 * Architecture: MCP is a pull protocol. The bridge cannot push voice turns to
 * the agent; incoming turns are enqueued here and the agent calls
 * `next_voice_turn()` to dequeue.
 *
 * Long-poll pattern: if no turn is ready, `dequeue()` suspends until one
 * arrives or the timeout elapses. Latency stays low without busy-polling.
 *
 * Delivery order for one incoming turn:
 *   1. a waiting `next_voice_turn()` poll, else
 *   2. Squeakr's interrupt hook (server/pendingWaits.ts) — whichever of OUR
 *      tools the agent is currently blocked in, else
 *   3. the buffer, for the agent's next poll.
 *
 * Step 2 is protocol-level, so it works identically on Cursor, Codex and
 * Claude Code — nothing here depends on a particular CLI.
 *
 * Streamed input (voice.inputMode = "stream", or `squeakr pipe`) enqueues
 * one turn per audio segment. When several are waiting, a dequeue hands them
 * over together — the agent gets everything said since it last listened,
 * rather than one clause per poll. See docs/41-audio-stream-pipe.md.
 *
 * See docs/16-mcp-server-agent-as-brain.md § 8.1 / § 8.4.
 */

import { childLogger } from '../../log.js';
import type { TtsInterruptContext } from '../../voice/ttsInterrupt.js';
import { interruptPendingWaits, type PendingWait } from './pendingWaits.js';
import type { TurnMedia } from '../../media/delivery.js';

const log = childLogger('mcp:server:turnQueue');

/**
 * Where a turn came from — the TurnSource from executor/agentTurns.ts (phone,
 * desk, rest, …). Only `stream`, the direct audio pipe, changes behaviour.
 */
export type VoiceTurnSource = string;

/**
 * Streamed speech is cut at pauses, not at the end of a request, so the agent
 * has to decide whether it has the whole thought. Turn-based input never
 * needs this — which is why turns are the recommended mode.
 */
export const STREAM_TURN_HINT =
  'Streamed speech: this was cut at a pause and may be only part of what the user is saying. ' +
  'If it reads as unfinished, call next_voice_turn(timeout_ms=2500) to collect the rest before acting; ' +
  'if it is a complete request, handle it normally.';

export interface VoiceTurn {
  text: string;
  source: VoiceTurnSource;
  /** For streamed turns: how many audio segments were merged into this one. */
  segments?: number;
  /** ISO timestamp of when the turn arrived. */
  receivedAt: string;
  /** Whether this turn should interrupt any in-progress work (e.g. "cancel", "stop"). */
  isInterrupt: boolean;
  /** What the user actually heard via TTS before barge-in, if any. */
  ttsInterrupt?: TtsInterruptContext;
  /**
   * Uploaded media that came with the turn (docs/46). The text already lists
   * the paths; this is what next_voice_turn() needs to add the pictures.
   */
  media?: TurnMedia;
}

export interface EnqueueVoiceTurnOptions {
  isInterrupt?: boolean;
  ttsInterrupt?: TtsInterruptContext;
  source?: VoiceTurnSource;
  media?: TurnMedia;
}

export type EnqueueDelivery =
  | { kind: 'waiter' }
  /** Delivered through a blocking Squeakr tool instead of a poll. */
  | { kind: 'tool_interrupt'; aborted: PendingWait[]; annotated: PendingWait[] }
  | { kind: 'queued'; queueLen: number };

interface PendingWaiter {
  resolve: (turn: VoiceTurn | null) => void;
  timer: NodeJS.Timeout;
}

const INTERRUPT_PHRASES = [
  /^(?:please\s+)?(?:stop|cancel|abort|quit)\b/i,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:stop|cancel|abort|quit)\b/i,
];

function detectInterrupt(text: string): boolean {
  return INTERRUPT_PHRASES.some((re) => re.test(text));
}

/**
 * A single shared queue for the default session.
 * Extend to a Map<sessionKey, VoiceTurnQueue> if multi-session is needed.
 */
class VoiceTurnQueue {
  private readonly queue: VoiceTurn[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private interruptFlag = false;
  private interruptFlagAt = 0;
  /** Fired when a turn is buffered because the agent is not in next_voice_turn(). */
  private onQueuedWithoutWaiter: ((queueLen: number) => void) | null = null;
  /** Fired when in-flight Squeakr tool calls received this turn. */
  private onToolsInterrupted:
    | ((delivery: { aborted: PendingWait[]; annotated: PendingWait[] }, turn: VoiceTurn) => void)
    | null = null;

  setQueuedWithoutWaiterHandler(fn: ((queueLen: number) => void) | null): void {
    this.onQueuedWithoutWaiter = fn;
  }

  setToolsInterruptedHandler(
    fn:
      | ((delivery: { aborted: PendingWait[]; annotated: PendingWait[] }, turn: VoiceTurn) => void)
      | null,
  ): void {
    this.onToolsInterrupted = fn;
  }

  /**
   * Push a transcribed turn from the PWA into the queue.
   * If a waiter is already blocking on `dequeue()`, it is woken immediately.
   * Else if any Squeakr tool call is in flight, the turn is delivered
   * through it (resolving user-facing waits, riding along on working ones) —
   * running work is never stopped just because the user spoke.
   * Otherwise the turn is buffered for a later `next_voice_turn()`.
   */
  enqueue(text: string, options?: EnqueueVoiceTurnOptions): EnqueueDelivery {
    const phraseInterrupt = detectInterrupt(text);
    const isInterrupt = Boolean(options?.isInterrupt) || phraseInterrupt;
    if (isInterrupt) {
      this.interruptFlag = true;
      this.interruptFlagAt = Date.now();
      log.info(
        {
          text: text.slice(0, 80),
          ttsBargeIn: Boolean(options?.ttsInterrupt),
        },
        'interrupt turn enqueued',
      );
    }

    const source = options?.source ?? 'phone';
    const turn: VoiceTurn = {
      text,
      source,
      ...(source === 'stream' ? { segments: 1 } : {}),
      receivedAt: new Date().toISOString(),
      isInterrupt,
      ttsInterrupt: options?.ttsInterrupt,
      ...(options?.media && options.media.ids.length > 0 ? { media: options.media } : {}),
    };

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(turn);
      log.debug({ text: text.slice(0, 80) }, 'turn delivered to waiting poll');
      return { kind: 'waiter' };
    }

    // No next_voice_turn waiter — hand the turn to whichever Squeakr tool
    // the agent is sitting in right now. It carries the same stream fields
    // next_voice_turn() returns: a pause-cut fragment must not read as a
    // complete request just because it arrived mid-tool.
    const delivery = interruptPendingWaits({
      user_turn: turn.text,
      is_interrupt: turn.isInterrupt,
      received_at: turn.receivedAt,
      source: turn.source,
      ...(turn.source === 'stream'
        ? { segments: turn.segments ?? 1, stream_hint: STREAM_TURN_HINT }
        : {}),
      tts_interrupt: turn.ttsInterrupt,
    });
    if (delivery.aborted.length > 0 || delivery.annotated.length > 0) {
      log.info(
        {
          aborted: delivery.aborted.map((w) => w.tool),
          annotated: delivery.annotated.map((w) => w.tool),
          text: turn.text.slice(0, 80),
        },
        'turn delivered through in-flight Squeakr tool(s)',
      );
      this.onToolsInterrupted?.(delivery, turn);
      // Annotated tools keep working; the turn still needs to be dequeueable if
      // the agent polls before that work finishes.
      if (delivery.aborted.length === 0) {
        this.queue.push(turn);
        this.onQueuedWithoutWaiter?.(this.queue.length);
      }
      return { kind: 'tool_interrupt', ...delivery };
    }

    this.queue.push(turn);
    log.debug({ queueLen: this.queue.length }, 'turn queued (no waiter)');
    // Voice agent is mid-tool (not polling) — surface pending so status checks notice.
    this.onQueuedWithoutWaiter?.(this.queue.length);
    return { kind: 'queued', queueLen: this.queue.length };
  }

  /**
   * Dequeue the next voice turn, waiting up to `timeoutMs` ms.
   * Returns `null` on timeout (the agent should call again).
   */
  dequeue(timeoutMs = 30_000): Promise<VoiceTurn | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.takeNext());
    }

    return new Promise<VoiceTurn | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.waiters.push({ resolve, timer });
    });
  }

  /**
   * Shift the next turn. Consecutive streamed segments are merged: a thought
   * spoken with pauses arrives as several segments, and handing them to the
   * agent one poll at a time would have it answer half a sentence.
   */
  private takeNext(): VoiceTurn {
    let turn = this.queue.shift()!;
    if (turn.source !== 'stream') return turn;
    while (this.queue[0]?.source === 'stream') {
      const next = this.queue.shift()!;
      turn = {
        ...turn,
        text: `${turn.text} ${next.text}`.trim(),
        segments: (turn.segments ?? 1) + (next.segments ?? 1),
        isInterrupt: turn.isInterrupt || next.isInterrupt,
      };
    }
    return turn;
  }

  /** Check and reset recent user authorization for a destructive stop action. */
  checkAndClearInterrupt(): boolean {
    const v = this.interruptFlag && Date.now() - this.interruptFlagAt <= 120_000;
    this.interruptFlag = false;
    this.interruptFlagAt = 0;
    return v;
  }

  /** Number of turns currently buffered (not yet consumed by the agent). */
  get size(): number {
    return this.queue.length;
  }

  /** Number of agent polls currently suspended waiting for a turn. */
  get waitersCount(): number {
    return this.waiters.length;
  }

  /** Drain buffered turns and cancel waiters (tests / shutdown). */
  clear(): void {
    this.queue.length = 0;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.interruptFlag = false;
    this.interruptFlagAt = 0;
  }
}

export const voiceTurnQueue = new VoiceTurnQueue();
