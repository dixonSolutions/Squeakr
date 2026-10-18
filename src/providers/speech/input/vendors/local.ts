/**
 * Self-hosted Whisper — the speech server's `/audio/transcriptions` route.
 *
 * Shares one container with `local_speech` (see ../../server.ts). No API key,
 * no per-minute cost, and the audio never leaves the host.
 */

import { scopeBool, scopeNumber, scopeString } from '../../../scopes.js';
import { decodeOpenAiTranscription, openAiTranscriptionCall } from '../../http.js';
import {
  isSpeechServerConfigured,
  probeSpeechServer,
  speechServerApiBase,
  speechServerSettings,
  speechServerUnavailableDetail,
} from '../../server.js';
import { pcm16ToWav } from '../../wav.js';
import { resolveVendorCall } from '../settings.js';
import type { SpeechInputVendor } from '../types.js';

/** First call after a model change may still be pulling weights. */
const FIRST_RUN_TIMEOUT_MS = 300_000;

export const localSpeechInput: SpeechInputVendor = {
  id: 'local_whisper',
  displayName: 'Self-hosted Whisper',
  description:
    'Whisper on this machine in Docker or Podman. No API key, no per-minute cost, audio never leaves the host.',
  capabilities: {
    kind: 'self_hosted',
    apiKeyEnvVar: null,
    languages: 'whisper',
    languageHint: true,
    sendsAudioOffMachine: false,
    approxUsdPerAudioHour: null,
    liveStreaming: false,
    docsUrl: 'https://speaches.ai/',
  },
  models: [
    {
      id: 'Systran/faster-whisper-small',
      label: 'faster-whisper small (~500 MB)',
      note: 'Runs in real time on a plain CPU. Start here, then move up.',
      recommended: true,
    },
    {
      id: 'Systran/faster-whisper-base.en',
      label: 'faster-whisper base — English (~150 MB)',
      note: 'About 3× faster than small on a CPU; the snappiest for calls, a little less accurate.',
      languages: ['en'],
    },
    {
      id: 'Systran/faster-whisper-medium',
      label: 'faster-whisper medium (~1.5 GB)',
      note: 'Clearly better on technical terms; ~3× slower on CPU.',
    },
    {
      id: 'Systran/faster-distil-whisper-large-v3',
      label: 'distil-whisper large-v3 — English (~1.5 GB)',
      note: 'Large-v3 accuracy at medium speed, English only.',
      languages: ['en'],
    },
    {
      id: 'deepdml/faster-whisper-large-v3-turbo-ct2',
      label: 'faster-whisper large-v3 turbo (~1.6 GB)',
      note: 'Best accuracy per second. Wants a GPU.',
    },
    {
      id: 'Systran/faster-whisper-large-v3',
      label: 'faster-whisper large-v3 (~3 GB)',
      note: 'Highest accuracy. GPU strongly recommended — minutes per turn on CPU.',
    },
  ],
  defaultModel: 'Systran/faster-whisper-small',
  scopes: [
    {
      id: 'prompt',
      label: 'Vocabulary hint',
      kind: 'text',
      default: '',
      placeholder: 'Fastify, tsup, Zod',
      help: 'Names and jargon to bias the transcript toward.',
    },
    {
      id: 'vad_filter',
      label: 'Trim silence before transcribing',
      kind: 'toggle',
      default: true,
      help: 'Drops non-speech regions first. Meaningfully faster on CPU.',
    },
    {
      id: 'temperature',
      label: 'Temperature',
      kind: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.1,
      advanced: true,
    },
  ],

  isConfigured: () => isSpeechServerConfigured(),

  async checkAvailability() {
    const settings = speechServerSettings();
    if (settings.manage === 'external' && !settings.baseUrl?.trim()) {
      return { available: false, detail: 'Set the server URL for the external speech server' };
    }
    const probe = await probeSpeechServer(settings);
    return probe.reachable
      ? { available: true }
      : { available: false, detail: speechServerUnavailableDetail(settings) };
  },

  transport: 'http',
  converter: {
    id: 'local_whisper',
    encode(req) {
      const call = resolveVendorCall(localSpeechInput, req);
      const prompt = scopeString(call.scopes, 'prompt').trim();
      const temperature = scopeNumber(call.scopes, 'temperature', 0);

      return openAiTranscriptionCall({
        baseUrl: speechServerApiBase(),
        model: call.model,
        wav: pcm16ToWav(req.pcm),
        ...(call.language ? { language: call.language } : {}),
        extraFields: {
          vad_filter: String(scopeBool(call.scopes, 'vad_filter', true)),
          ...(prompt ? { prompt } : {}),
          ...(temperature > 0 ? { temperature: String(temperature) } : {}),
        },
        timeoutMs: FIRST_RUN_TIMEOUT_MS,
        ...(call.signal ? { signal: call.signal } : {}),
      });
    },
    async decode(res, req) {
      return {
        text: await decodeOpenAiTranscription(res),
        model: resolveVendorCall(localSpeechInput, req).model,
      };
    },
  },
};
