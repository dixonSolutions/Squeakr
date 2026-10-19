/**
 * WebSocket handler for cascade voice workflows (/ws).
 *
 * Supports:
 *   agent_native   — STT → VoiceTurnQueue → squeakr MCP (speak/done)
 *   llm_intelligence — STT → Bedrock Claude orchestrator
 *
 * Phone → Bridge:
 *   { type: "auth", token }
 *   { type: "user_turn", text }     Final STT transcript
 *   { type: "speaking", value }     WebKit TTS state (narrator cadence)
 *
 * Bridge → Phone:
 *   { type: "auth_ok", sessionKey, workflow, wakeWords, turnSubmit, inputMode, model }
 *   { type: "speak", text }         Pipe to WebKit TTS immediately
 *   { type: "thinking", value }     Orchestrator / Cursor busy
 *   { type: "turn_complete" }
 *   { type: "tool_activity", tool, phase, label?, detail? }
 *   { type: "session_log", subcategory, level, summary, detail?, at }
 *   { type: "error", message }
 */

import type { FastifyInstance } from 'fastify';
import { parseWsAuthMessage, verifyWsToken } from '../auth.js';
import { getConfig } from '../config.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import type { WorkflowId } from '../config.js';
import { childLogger } from '../log.js';
import { getNarrator, PhoneRelaySession } from '../executor/narrator.js';
import {
  describeSpeechInputChain,
  hasServerSpeechInput,
  primaryServerSpeechInputId,
} from '../providers/speech/input/service.js';
import { getSpeechInputSpecializer } from '../providers/speech/input/orchestrator.js';
import {
  describeSpeechOutputChain,
  hasServerSpeechOutput,
  primaryServerSpeechOutputId,
  speechOutputLanguage,
} from '../providers/speech/output/service.js';
import { getSpeechOutputSpecializer } from '../providers/speech/output/orchestrator.js';
import { createMemory, type ConversationMemory } from './memory.js';
import { runIntelligenceTurn as runOrchestratorTurn, type OrchestratorCallbacks } from './orchestrator.js';
import { parseTtsInterrupt } from '../voice/ttsInterrupt.js';
import { phrase } from '../voice/phrases.js';
import { getPresence, type PresenceClient } from '../state/presence.js';
import { currentVoskStatus, ensureVoskModel, onVoskStatus } from '../serve/ensureVoskModel.js';
import {
  registerTurnCompleteHook,
  registerVoiceSession,
} from '../mcp/server/voiceToolHandlers.js';
import { reportAgentAudioPlayback } from '../mcp/server/audioStreamToolHandlers.js';
import { submitAgentNativeTurn, TurnError } from '../executor/agentTurns.js';
import { recordAgentSpeech, recordUserTurn } from '../logging/transcripts.js';

const log = childLogger('intelligence:ws');

interface IntelligenceSession {
  memory: ConversationMemory;
  sessionKey: string;
  workflow: WorkflowId;
  busy: boolean;
}

const sessions = new Map<object, IntelligenceSession>();

const WS_OPEN = 1;

function send(socket: { readyState: number; send: (data: string) => void }, payload: unknown): void {
  if (socket.readyState === WS_OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function formatIntelligenceError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('on-demand throughput')) {
    return 'Bedrock model needs an inference profile ID. Set llm.model to us.anthropic.claude-sonnet-4-20250514-v1:0 in config.';
  }
  if (message.includes('AccessDeniedException') || message.includes('not authorized')) {
    return 'Bedrock access denied. Check AWS credentials and model access in the Bedrock console.';
  }
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function formatToolLabel(tool: string, phase: 'start' | 'done' | 'error'): string {
  if (phase === 'error') return `${tool} failed`;
  if (phase === 'done') return `${tool} done`;
  const agent = getActiveProvider().displayName;
  switch (tool) {
    case 'speak':
      return 'Speaking';
    case 'get_status':
    case 'agent_job_status':
      return `Checking ${agent} progress`;
    case 'launch_agent':
    case 'agent_submit':
      return `Sending task to ${agent}`;
    case 'read_output':
      return `Reading ${agent} output`;
    case 'agent_ask':
      return `Asking ${agent}`;
    default:
      return tool.replace(/_/g, ' ');
  }
}

function isCascadeWorkflow(workflow: WorkflowId): boolean {
  return workflow === 'agent_native' || workflow === 'llm_intelligence';
}

export function registerWebSocket(app: FastifyInstance): void {
  app.register(async (wsApp) => {
    wsApp.get('/ws', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      const sessionKey = 'default';
      let relaySession: PhoneRelaySession | null = null;
      let intelSession: IntelligenceSession | null = null;
      let unregisterVoice: (() => void) | null = null;
      let unregisterTurnDone: (() => void) | null = null;
      let presence: PresenceClient | null = null;
      let unsubscribeVosk: (() => void) | null = null;

      log.debug({ sessionKey }, 'ws connection attempt');

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn({ sessionKey }, 'ws auth failed');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;

          relaySession = new PhoneRelaySession((data) => {
            if (socket.readyState === WS_OPEN) {
              socket.send(data);
            }
          });
          void getNarrator().setSession(relaySession);

          const { workflow, voice } = getConfig().settings;
          const workflowId = workflow.default;

          intelSession = {
            memory: createMemory(),
            sessionKey,
            workflow: workflowId,
            busy: false,
          };
          sessions.set(socket, intelSession);

          unregisterVoice = registerVoiceSession((payload) => send(socket, payload), 'phone');
          unregisterTurnDone = registerTurnCompleteHook(() => {
            if (intelSession) intelSession.busy = false;
          });

          const { llm, audio } = workflow.llmIntelligence;
          // The phone only needs "can the bridge answer, and what is it called";
          // the chain picks the actual engine per request.
          const sttFallback = primaryServerSpeechInputId();
          const ttsFallback = primaryServerSpeechOutputId();

          send(socket, {
            type: 'auth_ok',
            sessionKey,
            workflow: workflowId,
            wakeWords: voice.wakeWords,
            turnSubmit: voice.turnSubmit,
            tts: voice.tts,
            wakeWordsEnabled: voice.wakeWordsEnabled !== false,
            // `stream` = pipe the mic to /ws/audio-stream instead of taking turns.
            inputMode: voice.inputMode,
            model: workflowId === 'agent_native' ? getActiveProvider().id : llm.model,
            audio: {
              sttProvider: audio.stt.provider,
              sttFallback,
              sttProviderLabel: sttFallback
                ? (getSpeechInputSpecializer(sttFallback)?.displayName ?? sttFallback)
                : null,
              sttAvailable: hasServerSpeechInput(),
              sttLanguage: audio.stt.language,
              sttChain: describeSpeechInputChain(),

              ttsProvider: audio.tts.provider,
              ttsFallback,
              ttsProviderLabel: ttsFallback
                ? (getSpeechOutputSpecializer(ttsFallback)?.displayName ?? ttsFallback)
                : null,
              ttsAvailable: hasServerSpeechOutput(),
              ttsLanguage: speechOutputLanguage() ?? 'auto',
              ttsChain: describeSpeechOutputChain(),
            },
          });
          presence = getPresence().register({
            kind: 'phone_intelligence',
            ping: () => {
              if (socket.readyState === WS_OPEN) send(socket, { type: 'ping' });
            },
            close: (code, reason) => {
              try {
                socket.close(code, reason);
              } catch {
                socket.terminate?.();
              }
            },
          });

          // The bridge owns the wake-word model (not each client). Send the
          // current preparation status, stream updates, and kick off a one-time
          // preparation if it has not run yet (e.g. a fresh launch with no model
          // installed). The client shows this as launch setup, not a fault.
          send(socket, { type: 'vosk_status', ...currentVoskStatus() });
          unsubscribeVosk = onVoskStatus((status) => {
            if (socket.readyState === WS_OPEN) send(socket, { type: 'vosk_status', ...status });
          });
          void ensureVoskModel().catch(() => {
            /* an error status has already been emitted to subscribers */
          });

          log.info({ sessionKey, workflow: workflowId }, 'ws authenticated');
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          send(socket, { type: 'error', message: 'Invalid JSON' });
          return;
        }

        presence?.alive();

        if (msg['type'] === 'pong') return;

        if (msg['type'] === 'hangup') {
          presence?.hangUp();
          presence = null;
          return;
        }

        if (msg['type'] === 'agent_audio_state') {
          reportAgentAudioPlayback('phone', msg);
          return;
        }

        if (msg['type'] === 'speaking' && typeof msg['value'] === 'boolean') {
          relaySession?.setSpeaking(msg['value']);
          return;
        }

        if (msg['type'] === 'user_turn') {
          const text = typeof msg['text'] === 'string' ? msg['text'].trim() : '';
          if (!text || !intelSession) return;

          log.info(
            { sessionKey, workflow: intelSession.workflow, textLen: text.length },
            'intelligence user_turn',
          );

          if (intelSession.busy && intelSession.workflow !== 'agent_native') {
            send(socket, { type: 'speak', text: phrase('busy') });
            return;
          }

          if (intelSession.workflow === 'agent_native') {
            intelSession.busy = true;
            send(socket, { type: 'thinking', value: true });

            const ttsInterrupt = parseTtsInterrupt(msg['tts_interrupt']);
            const phraseInterrupt = /\b(stop everything|abort|quit)\b/i.test(text);
            const isInterrupt =
              Boolean(msg['is_interrupt']) && phraseInterrupt && !ttsInterrupt;

            // Spawn-or-queue is shared with the desk surfaces (executor/agentTurns.ts).
            try {
              submitAgentNativeTurn(text, { sessionKey, source: 'phone', isInterrupt, ttsInterrupt });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const code = err instanceof TurnError ? err.code : 'ERROR';
              send(socket, {
                type: 'speak',
                text:
                  code === 'NO_PROJECT'
                    ? 'No project is selected. Choose a project in the voice tab first.'
                    : message,
              });
              if (code !== 'NO_PROJECT') send(socket, { type: 'error', message });
              send(socket, { type: 'thinking', value: false });
              send(socket, { type: 'turn_complete' });
              intelSession.busy = false;
            }
            return;
          }

          intelSession.busy = true;
          recordUserTurn(text, 'phone');
          send(socket, { type: 'thinking', value: true });

          const callbacks: OrchestratorCallbacks = {
            onSpeak: (spoken) => {
              recordAgentSpeech(spoken);
              send(socket, { type: 'speak', text: spoken });
              send(socket, { type: 'assistant_transcript', text: spoken });
            },
            onThinking: (active) => send(socket, { type: 'thinking', value: active }),
            onToolActivity: (tool, phase, detail) => {
              send(socket, {
                type: 'tool_activity',
                tool,
                phase,
                label: formatToolLabel(tool, phase),
                detail,
              });
            },
          };

          void runOrchestratorTurn(intelSession.memory, text, sessionKey, callbacks)
            .catch((err: Error) => {
              log.error({ err, sessionKey }, 'intelligence turn failed');
              const message = formatIntelligenceError(err);
              send(socket, { type: 'speak', text: message });
              send(socket, { type: 'error', message });
            })
            .finally(() => {
              if (intelSession) intelSession.busy = false;
              send(socket, { type: 'thinking', value: false });
              send(socket, { type: 'turn_complete' });
            });
          return;
        }

        log.debug({ type: msg['type'] }, 'unhandled ws message');
      });

      socket.on('close', () => {
        presence?.release();
        presence = null;
        unsubscribeVosk?.();
        unsubscribeVosk = null;
        sessions.delete(socket);
        unregisterVoice?.();
        unregisterTurnDone?.();
        unregisterVoice = null;
        unregisterTurnDone = null;
        // Do not kill the voice agent on WS close — user may reconnect; barge-in must not stop Cursor.
        if (relaySession) {
          void getNarrator().setSession(null);
          relaySession = null;
        }
        log.info({ sessionKey }, 'ws closed');
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionKey }, 'ws error');
      });
    });
  });
}

// Exported for tests / future routing guards.
export { isCascadeWorkflow };
