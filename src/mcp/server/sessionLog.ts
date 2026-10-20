/**
 * Live session log events — broadcast to connected WebSocket clients (PWA).
 */

import { broadcastToVoiceSessions } from './voiceToolHandlers.js';

export type SessionLogSubcategory = 'stt' | 'tts' | 'tool' | 'pipeline';
export type SessionLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface SessionLogEvent {
  type: 'session_log';
  subcategory: SessionLogSubcategory;
  level: SessionLogLevel;
  summary: string;
  detail?: string;
  at: number;
}

export function broadcastSessionLog(
  event: Omit<SessionLogEvent, 'type' | 'at'> & { at?: number },
): void {
  broadcastToVoiceSessions({
    type: 'session_log',
    at: event.at ?? Date.now(),
    subcategory: event.subcategory,
    level: event.level,
    summary: event.summary,
    ...(event.detail ? { detail: event.detail } : {}),
  });
}

const SECRET_KEY = /token|password|secret|authorization|bearer|api[_-]?key|credential/i;
const MAX_PREVIEW = 120;

function truncate(value: string, max = MAX_PREVIEW): string {
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((v) => (typeof v === 'string' ? truncate(v) : v));
  }
  return value;
}

function previewRecord(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const safe = redactValue(key, value);
    if (typeof safe === 'object') {
      parts.push(`${key}=…`);
    } else {
      parts.push(`${key}=${String(safe)}`);
    }
  }
  return truncate(parts.join(', '), MAX_PREVIEW);
}

/** Brief args summary for live logs — no secrets, truncated strings. */
export function summarizeToolArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'speak':
      return truncate(String(args['text'] ?? ''), 80);
    case 'spawn_agent':
      return truncate(String(args['instructions'] ?? ''), 80);
    case 'cursor_submit':
      return truncate(String(args['prompt'] ?? ''), 80);
    case 'cursor_ask':
      return truncate(String(args['question'] ?? ''), 80);
    case 'request_user_input':
      return truncate(String(args['question'] ?? ''), 80);
    case 'submit_plan_for_approval':
      return truncate(String(args['title'] ?? ''), 80);
    case 'next_voice_turn':
      return args['timeout_ms'] != null ? `timeout_ms=${args['timeout_ms']}` : '';
    case 'inject':
      return truncate(String(args['message'] ?? ''), 60);
    case 'audio_stream_write': {
      // Never echo a base64 payload into the log.
      const what = args['path'] ?? args['url'] ?? (args['packet'] ? 'packet' : args['data'] ? 'data' : '');
      return truncate(`${String(args['stream_id'] ?? '')} ← ${String(what)}`, 80);
    }
    default:
      return previewRecord(args);
  }
}

function parseToolResultContent(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!first || typeof first !== 'object') return null;
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: truncate(text) };
  }
}

/** Brief result summary for live logs. */
export function summarizeToolResult(tool: string, result: unknown): string {
  const parsed = parseToolResultContent(result);
  if (!parsed) return 'ok';

  if (parsed['error']) {
    return truncate(String(parsed['error']));
  }

  switch (tool) {
    case 'speak':
      return parsed['ok'] ? `ok (${parsed['sessions'] ?? 0} sessions)` : 'failed';
    case 'done':
      return parsed['ok'] ? 'turn complete; mic waits for queued speech' : 'failed';
    case 'next_voice_turn': {
      const turn = parsed['turn'];
      if (turn == null) return 'timeout';
      return truncate(String(turn), 80);
    }
    case 'spawn_agent':
      return typeof parsed['id'] === 'string' ? `id ${parsed['id'].slice(0, 12)}` : 'started';
    case 'request_user_input':
      return truncate(String(parsed['answer'] ?? ''), 80);
    case 'submit_plan_for_approval':
      return String(parsed['decision'] ?? 'responded');
    case 'get_agent_status':
      return truncate(String(parsed['activity'] ?? parsed['status'] ?? ''), 80);
    default:
      return truncate(JSON.stringify(parsed), MAX_PREVIEW);
  }
}
