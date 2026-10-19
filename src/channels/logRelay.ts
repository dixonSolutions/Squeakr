/**
 * Every session log line, poured into each channel's message channel.
 *
 * What a voice client is sent — session logs (speech in / out, tools,
 * pipeline), tool activity, agent status, the agent's lines — through a
 * broadcast tap (not a listener: nobody counts as present because of it),
 * plus every turn from any surface (event bus `user_turn`). Lines are batched
 * into one post per couple of seconds so a busy agent stays under the
 * platforms' rate limits; nothing is dropped.
 */

import { childLogger } from '../log.js';
import { tapVoiceBroadcasts } from '../mcp/server/voiceToolHandlers.js';
import { subscribeEvents } from '../state/eventBus.js';
import { chunkText } from './format.js';
import type { ChannelOutbound } from './hub.js';

const log = childLogger('channels:logs');

const FLUSH_MS = 2_000;
const MAX_POST = 1_900;

/** One line for a payload, or null for what is not a log (heartbeats, state flags). */
export function logLine(payload: unknown): string | null {
  const m = payload as Record<string, unknown> | null;
  if (!m || typeof m['type'] !== 'string') return null;
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string).trim() : '');
  const first = (t: string) => t.split('\n')[0]!.slice(0, 300);
  switch (m['type']) {
    case 'session_log': {
      const level = str('level');
      const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📝';
      const detail = str('detail');
      return `${icon} \`${str('subcategory') || 'log'}\` ${first(str('summary'))}${detail ? ` — ${first(detail)}` : ''}`;
    }
    case 'tool_activity': {
      const phase = str('phase');
      const icon = phase === 'error' ? '❌' : phase === 'done' ? '✅' : '🔧';
      const detail = str('detail');
      return `${icon} ${str('label') || str('tool')}${detail ? `: ${first(detail)}` : ''}`;
    }
    case 'voice_agent_status':
      return `· ${str('provider_name') || 'agent'} ${str('state')}${str('session_id') ? ` (session ${str('session_id').slice(0, 8)})` : ''}`;
    case 'speak':
      return str('text') || null;
    case 'narration':
      return str('text') ? `📣 ${str('text')}` : null;
    case 'error':
      return str('message') ? `❌ ${str('message')}` : null;
    case 'user_turn':
      return str('text') ? `🎙️ \`${str('source') || 'turn'}\` ${str('text')}` : null;
    case 'agent_audio': {
      const label = str('label') || str('stream_id');
      if (str('op') === 'open') return `🔊 agent audio \`${str('mode') || 'queue'}\` ${label}`;
      if (str('op') === 'stop') return `🔇 agent audio ${str('stream_id')} stopped`;
      return null;
    }
    case 'agent_files': {
      const files = Array.isArray(m['files']) ? (m['files'] as Array<{ name?: string; path?: string; url?: string }>) : [];
      const names = files.map((f) => f.name ?? (f.path ? f.path.split('/').pop() : f.url) ?? 'file');
      return names.length ? `📎 agent sent ${names.join(', ')}` : null;
    }
    default:
      return null;
  }
}

export interface LogTarget {
  key: string;
  out: ChannelOutbound;
}

export class LogRelay {
  private readonly queues = new Map<string, { out: ChannelOutbound; lines: string[]; timer: NodeJS.Timeout | null; posting: Promise<void> }>();
  private readonly stops: Array<() => void> = [];

  /**
   * `targets(type)` is asked on every line, so a changed message channel
   * applies at once — and can leave out a conversation already getting that
   * kind of line (the agent's replies, where it is a listener).
   */
  constructor(private readonly targets: (type: string) => LogTarget[]) {}

  start(tap = tapVoiceBroadcasts, events = subscribeEvents): void {
    const typeOf = (p: unknown) => String((p as { type?: unknown } | null)?.type ?? '');
    this.stops.push(tap((payload) => this.push(logLine(payload), typeOf(payload))));
    this.stops.push(events((e) => (e.type === 'user_turn' || e.type === 'agent_files' ? this.push(logLine(e), e.type) : undefined)));
  }

  push(line: string | null, type = ''): void {
    if (!line) return;
    for (const t of this.targets(type)) {
      let q = this.queues.get(t.key);
      if (!q) {
        q = { out: t.out, lines: [], timer: null, posting: Promise.resolve() };
        this.queues.set(t.key, q);
      }
      q.out = t.out;
      q.lines.push(line);
      q.timer ??= setTimeout(() => this.flush(t.key), FLUSH_MS);
    }
  }

  private flush(key: string): void {
    const q = this.queues.get(key);
    if (!q) return;
    q.timer = null;
    const text = q.lines.splice(0).join('\n');
    if (!text) return;
    q.posting = q.posting.then(async () => {
      for (const part of chunkText(text, MAX_POST)) {
        await q.out.send(part).catch((err: unknown) => log.debug({ err, key }, 'posting session logs failed'));
      }
    });
  }

  stop(): void {
    for (const s of this.stops.splice(0)) s();
    for (const [key, q] of this.queues) {
      if (q.timer) clearTimeout(q.timer);
      this.flush(key);
    }
  }
}
