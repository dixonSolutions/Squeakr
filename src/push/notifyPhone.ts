/**
 * Unified phone notification — WebSocket (instant UI) + push (background / app closed).
 */

import { pushToPhone, isControlSocketOpen } from '../state/controlSocket.js';
import { listPushSubscriptions } from '../state/pushStore.js';
import { sendWebPush } from './webPush.js';
import { sendApnsPush } from './apns.js';
import { childLogger } from '../log.js';
import { publishEvent } from '../state/eventBus.js';
import { getActiveProvider } from '../providers/agents/registry.js';

const log = childLogger('notify-phone');

export interface NotifyResult {
  ws: boolean;
  webPush: number;
  apns: number;
}

function pushPayloadForType(msg: Record<string, unknown>): {
  title: string;
  body: string;
  tag: string;
  url: string;
  voip: boolean;
} | null {
  const type = msg['type'] as string | undefined;
  switch (type) {
    case 'user_input_request': {
      const q = String(msg['question'] ?? `${agentDisplayName()} needs your answer`);
      return {
        title: 'Squeakr',
        body: q.slice(0, 180),
        tag: `approval-${msg['request_id'] ?? 'input'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'plan_approval_request': {
      const title = String(msg['title'] ?? 'Plan ready for review');
      return {
        title: 'Squeakr — Plan',
        body: title.slice(0, 180),
        tag: `plan-${msg['request_id'] ?? 'plan'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'permission_request': {
      const summary = String(msg['summary'] ?? msg['tool_name'] ?? 'an action');
      return {
        title: 'Squeakr — Permission',
        body: `Allow ${summary}?`.slice(0, 180),
        tag: `permission-${msg['request_id'] ?? 'permission'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'secret_input_request': {
      const prompt = String(msg['prompt'] ?? 'Password needed');
      return {
        title: 'Squeakr — Password needed',
        body: prompt.slice(0, 180),
        tag: `secret-${msg['request_id'] ?? 'secret'}`,
        url: '/?tab=voice',
        voip: true,
      };
    }
    case 'away_finished': {
      const summary = String(msg['summary'] ?? 'Work finished while you were away.');
      return {
        title: 'Squeakr — Finished while you were away',
        body: summary.slice(0, 180),
        tag: `away-finished-${msg['run_id'] ?? 'run'}`,
        url: '/?tab=voice',
        voip: false,
      };
    }
    case 'narration': {
      const kind = msg['kind'] as string | undefined;
      if (kind !== 'job_done' && kind !== 'job_error') return null;
      const text = String(msg['text'] ?? (kind === 'job_done' ? 'Job finished' : 'Job failed'));
      return {
        title: kind === 'job_done' ? 'Squeakr — Done' : 'Squeakr — Error',
        body: text.slice(0, 180),
        tag: `narration-${kind}`,
        url: '/?tab=voice',
        voip: false,
      };
    }
    case 'media_show': {
      // show_media / show_images / send_files (docs/48). Only a batch that
      // opens on the screen is worth waking the phone for; tray items wait.
      if (msg['open_id'] == null) return null;
      const caption = msg['caption'] as string | undefined;
      const items = Array.isArray(msg['items']) ? (msg['items'] as Array<{ kind?: string }>) : [];
      const kind = items[0]?.kind === 'video' ? 'a video' : items[0]?.kind === 'audio' ? 'audio' : 'screenshots';
      return {
        title: 'Squeakr',
        // Provider parity (docs/39 Part B): never a hardcoded vendor name.
        body: caption?.slice(0, 180) ?? `${agentDisplayName()} sent you ${kind}`,
        tag: `media-${msg['batch_id'] ?? 'batch'}`,
        url: '/?tab=voice',
        voip: false,
      };
    }
    case 'auth_required': {
      const displayName = String(msg['displayName'] ?? 'Your agent');
      return {
        title: 'Squeakr — Sign-in needed',
        body: `${displayName} needs you to sign in before it can keep working.`,
        tag: 'auth-required',
        url: '/?tab=voice',
        voip: true,
      };
    }
    default:
      return null;
  }
}

/** Display name of the CLI actually running — never a hardcoded vendor. */
function agentDisplayName(): string {
  try {
    return getActiveProvider().displayName;
  } catch {
    return 'Your agent';
  }
}

function shouldSendPush(msg: Record<string, unknown>): boolean {
  return pushPayloadForType(msg) !== null;
}

/**
 * Deliver to connected PWA (WebSocket) and push subscriptions when appropriate.
 * Critical events (approvals, job done, images) always attempt push even if WS is open.
 */
export async function notifyPhone(payload: object): Promise<NotifyResult> {
  const msg = payload as Record<string, unknown>;
  // Desk clients (/ws/events) see everything the phone is told — approvals,
  // narration, images — without registering as the phone.
  if (typeof msg['type'] === 'string') publishEvent(msg as { type: string });
  const ws = pushToPhone(payload);
  const result: NotifyResult = { ws, webPush: 0, apns: 0 };

  if (!shouldSendPush(msg)) {
    return result;
  }

  const pushMeta = pushPayloadForType(msg)!;
  const pushBody = {
    ...msg,
    title: pushMeta.title,
    body: pushMeta.body,
    tag: pushMeta.tag,
    url: pushMeta.url,
  };

  const type = msg['type'] as string | undefined;
  const alwaysPush =
    type === 'user_input_request' ||
    type === 'plan_approval_request' ||
    type === 'permission_request' ||
    type === 'secret_input_request' ||
    type === 'away_finished' ||
    type === 'auth_required';

  // Approvals always push (user may be on another app). Skip others if WS live.
  if (ws && isControlSocketOpen() && !alwaysPush) {
    log.debug({ type }, 'notifyPhone: WS delivered, skipping push');
    return result;
  }

  const subs = listPushSubscriptions();
  for (const sub of subs) {
    if (sub.platform === 'web' && sub.p256dh && sub.auth) {
      const ok = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushBody,
      );
      if (ok) result.webPush++;
    } else if (sub.platform === 'ios_voip' && sub.token) {
      const ok = await sendApnsPush(sub.token, pushBody, 'voip');
      if (ok) result.apns++;
    } else if (sub.platform === 'ios' && sub.token) {
      const ok = await sendApnsPush(sub.token, pushBody, 'alert');
      if (ok) result.apns++;
    }
  }

  if (result.webPush + result.apns > 0) {
    log.info(
      { type: msg['type'], webPush: result.webPush, apns: result.apns },
      'push notifications sent',
    );
  }

  return result;
}
