/**
 * Listener envelope — the presence signal that rides on every squeakr tool
 * result (docs/36 §3.1).
 *
 * MCP is pull-only. There is no way for the bridge to push "the user just put
 * their phone down" into a running Cursor, Codex, Claude Code or Codewhale
 * process. The only channel that reaches all four is the result of a tool they
 * already call, which is why the pending-user-turn notice was hung off
 * `speak()` in the first place.
 *
 * This wrapper generalises that: every Squeakr tool result gains a
 * `listener` block with the presence state, how long the user has been away,
 * the policy in force and one line of instruction. An agent that never calls
 * `speak()` — one grinding through its own Read/Bash tools — still learns the
 * user has gone the next time it touches any Squeakr tool.
 *
 * It is also the natural place to charge the unattended tool-call budget:
 * every squeakr call while away is one tick, and the budget verdict comes
 * back in the same envelope.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listenerBlock, chargeAwayBudget, isListening } from '../../state/awayPolicy.js';
import { pendingCount } from '../../state/sessionMailbox.js';
import {
  attachedCount,
  describeMediaForAgent,
  isAttachTarget,
  takeAttachedMedia,
  turnImageBlocks,
} from '../../media/delivery.js';
import { childLogger } from '../../log.js';

const log = childLogger('mcp:listener-envelope');

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface TextContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content?: TextContent[];
  isError?: boolean;
}

/**
 * Tools whose result is not a JSON object the agent reads as state — leaving
 * them alone keeps binary / display payloads untouched.
 */
const SKIP = new Set(['show_images', 'show_media', 'send_files']);

/**
 * Merge the listener block into a tool result, in place where the result is
 * the usual single JSON text block. Anything else is returned untouched: a
 * malformed or non-JSON payload must never be corrupted by this.
 */
export function attachListenerToResult(
  name: string,
  result: unknown,
  sessionKey?: string,
): unknown {
  if (SKIP.has(name)) return result;
  const res = result as ToolResult | null;
  const first = res?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return result; // plain-text result — nothing to merge into
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result;

  const payload = parsed as Record<string, unknown>;
  // A handler that already built its own listener block (the voice tools do)
  // keeps it — theirs is the one that matches what it just decided.
  if (payload['listener'] === undefined) payload['listener'] = listenerBlock();

  /**
   * Mailbox piggyback (docs/37 §2): a message the user sent into this session
   * rides out on the next tool result, so a worker learns about it without
   * having to poll `check_messages()` on a timer.
   */
  if (sessionKey && name !== 'check_messages') {
    const waiting = pendingCount(sessionKey);
    if (waiting > 0) {
      payload['pending_messages'] = waiting;
      payload['pending_messages_message'] =
        `The user sent ${waiting} message${waiting === 1 ? '' : 's'} into this session while you ` +
        'were working. Call check_messages() now — they may change what they want.';
    }
  }

  /**
   * Attached media (docs/46): files the user put into the conversation while
   * the voice agent was working. Same channel as the mailbox — the next
   * Squeakr tool result — with the pictures appended when asked for inline.
   */
  if (attachedCount() > 0 && isAttachTarget(sessionKey)) {
    const staged = takeAttachedMedia();
    if (staged) {
      payload['attached_media'] = describeMediaForAgent(staged.assets, staged.delivery, 'attach');
      payload['attached_media_ids'] = staged.assets.map((a) => a.id);
      const blocks = turnImageBlocks({ ids: staged.assets.map((a) => a.id), delivery: staged.delivery });
      if (blocks.length > 0) res!.content!.push(...blocks);
      log.info({ tool: name, files: staged.assets.length, images: blocks.length / 2 }, 'attached media delivered on a tool result');
    }
  }

  if (!isListening()) {
    const verdict = chargeAwayBudget();
    if (verdict.exceeded) {
      payload['budget_exceeded'] = verdict.reason;
      payload['budget_message'] = verdict.message;
      log.warn({ tool: name, reason: verdict.reason }, 'unattended budget exceeded');
    }
  }

  first.text = JSON.stringify(payload);
  return result;
}

/**
 * Wrap `server.tool` so every registered tool's result carries the envelope.
 * Call once in buildMcpServer, before the tools are registered.
 */
export function instrumentListenerEnvelope(server: McpServer, sessionKey?: string): void {
  const target = server as McpServer & {
    tool: (name: string, description: string, schema: unknown, handler: ToolHandler) => unknown;
  };
  const original = target.tool.bind(target);

  // The SDK's tool() overloads confuse TS when reassigned — the runtime shape
  // is the four-argument form every call site here uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target as any).tool = (name: string, description: string, schema: unknown, handler: ToolHandler) =>
    original(name, description, schema, async (args: Record<string, unknown>) => {
      const result = await handler(args);
      try {
        return attachListenerToResult(name, result, sessionKey);
      } catch (err) {
        log.warn({ err, tool: name }, 'could not attach the listener block');
        return result;
      }
    });
}
