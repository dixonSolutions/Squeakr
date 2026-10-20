/**
 * What happens to an upload after it is on disk (docs/46):
 *
 *   image     → an inline-sized copy for the agent's chat
 *   recording → the raw file, plus a transcript from the configured
 *               speech-to-text chain, saved as `<file>.transcript.txt`
 *   video     → still frames for the chat, plus a transcript of its sound
 *
 * The raw file is always kept and always handed over; the extras are
 * best-effort, and the asset records why one is missing rather than failing
 * the upload.
 */

import { writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { transcribe as transcribeChain, hasServerSpeechInput } from '../providers/speech/input/service.js';
import { isEmptyTranscript } from '../providers/speech/input/transcriptionPrompt.js';
import { STT_SAMPLE_RATE } from '../providers/speech/wav.js';
import { childLogger } from '../log.js';
import {
  decodeToPcm16k,
  extractFrames,
  hasAudioStream,
  hasVideoStream,
  prepareInlineImage,
  probeDuration,
} from './decode.js';
import type { MediaAsset, MediaTranscript } from './store.js';

const log = childLogger('media:pipeline');

/** Speech engines take one utterance; long recordings go in pieces of about this. */
export const TRANSCRIBE_CHUNK_SEC = 120;
/** Search this far either side of a cut for the quietest moment. */
const CUT_SEARCH_SEC = 5;
/** Below this there is nothing an engine could hear. */
const MIN_PCM_BYTES = 3200;

export type TranscribeFn = (
  pcm: Buffer,
) => Promise<{ text: string; provider?: string | null; model?: string | null }>;

export interface PipelineDeps {
  transcribe: TranscribeFn;
  /** False when no server engine is configured — skip straight to `unavailable`. */
  canTranscribe: () => boolean;
}

export const defaultPipelineDeps: PipelineDeps = {
  transcribe: async (pcm) => {
    const out = await transcribeChain(pcm);
    return { text: out.text, provider: out.provider, model: out.model };
  },
  canTranscribe: hasServerSpeechInput,
};

/**
 * Split PCM16 into pieces of about `chunkSec`, cutting in the quietest 50 ms
 * near each boundary so a word is not sliced in half.
 */
export function splitPcm(pcm: Buffer, chunkSec = TRANSCRIBE_CHUNK_SEC, rate = STT_SAMPLE_RATE): Buffer[] {
  const bytesPerSec = rate * 2;
  const target = chunkSec * bytesPerSec;
  if (pcm.length <= target * 1.25) return [pcm];
  const win = Math.floor(rate * 0.05) * 2;
  const search = CUT_SEARCH_SEC * bytesPerSec;
  const out: Buffer[] = [];
  let start = 0;
  while (pcm.length - start > target * 1.25) {
    const ideal = start + target;
    let best = ideal;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let at = Math.max(start + win, ideal - search); at + win <= Math.min(pcm.length, ideal + search); at += win) {
      let energy = 0;
      for (let i = at; i < at + win; i += 2) energy += Math.abs(pcm.readInt16LE(i));
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = at;
      }
    }
    out.push(pcm.subarray(start, best));
    start = best;
  }
  out.push(pcm.subarray(start));
  return out;
}

/** Transcribe PCM of any length through the chain, piece by piece. */
export async function transcribePcm(pcm: Buffer, deps: PipelineDeps): Promise<MediaTranscript> {
  const parts: string[] = [];
  let provider: string | null = null;
  let model: string | null = null;
  for (const piece of splitPcm(pcm)) {
    if (piece.length < MIN_PCM_BYTES) continue;
    const res = await deps.transcribe(piece);
    provider ??= res.provider ?? null;
    model ??= res.model ?? null;
    const text = res.text.trim();
    if (text && !isEmptyTranscript(text)) parts.push(text);
  }
  return { text: parts.join(' ').trim(), provider, model };
}

function transcriptFile(asset: MediaAsset): string {
  return `${asset.path}.transcript.txt`;
}

/**
 * Attach a transcript to an asset from PCM — used both by the pipeline and
 * when the phone posts PCM for a format the bridge could not decode.
 */
export async function transcribeAssetPcm(asset: MediaAsset, pcm: Buffer, deps = defaultPipelineDeps): Promise<MediaAsset> {
  asset.durationSec ??= Math.round((pcm.length / 2 / STT_SAMPLE_RATE) * 10) / 10;
  if (!deps.canTranscribe()) {
    asset.transcriptStatus = 'unavailable';
    asset.transcriptError = 'No speech-to-text engine is configured on the bridge.';
    return asset;
  }
  try {
    const transcript = await transcribePcm(pcm, deps);
    asset.transcript = transcript;
    asset.transcriptError = null;
    asset.transcriptStatus = transcript.text ? 'done' : 'empty';
    if (transcript.text) {
      const file = transcriptFile(asset);
      writeFileSync(file, `${transcript.text}\n`);
      asset.transcriptPath = file;
    }
    log.info({ id: asset.id, chars: transcript.text.length, provider: transcript.provider }, 'media transcribed');
  } catch (err) {
    asset.transcriptStatus = 'failed';
    asset.transcriptError = err instanceof Error ? err.message : String(err);
    log.warn({ id: asset.id, err: asset.transcriptError }, 'media transcription failed');
  }
  return asset;
}

async function transcribeAsset(asset: MediaAsset, deps: PipelineDeps): Promise<void> {
  if (!deps.canTranscribe()) {
    asset.transcriptStatus = 'unavailable';
    asset.transcriptError = 'No speech-to-text engine is configured on the bridge.';
    return;
  }
  const decoded = await decodeToPcm16k(asset.path);
  if (!decoded.ok) {
    asset.transcriptStatus = 'needs_pcm';
    asset.transcriptError = decoded.reason;
    return;
  }
  await transcribeAssetPcm(asset, decoded.pcm, deps);
}

/** Run every derivation an asset's kind calls for. Never throws. */
export async function processMedia(asset: MediaAsset, deps: PipelineDeps = defaultPipelineDeps): Promise<MediaAsset> {
  const stem = basename(asset.path, extname(asset.path));
  const dir = dirname(asset.path);
  try {
    // An audio-only WebM arrives labelled video/webm — it is a recording.
    if (asset.kind === 'video' && !(await hasVideoStream(asset.path))) {
      asset.kind = 'audio';
      asset.mime = asset.mime.replace(/^video\//, 'audio/');
    }
    if (asset.kind === 'image') {
      asset.inline = await prepareInlineImage(asset.path, asset.mime, `${dir}/${stem}.inline.jpg`);
    } else if (asset.kind === 'audio') {
      asset.durationSec = await probeDuration(asset.path);
      await transcribeAsset(asset, deps);
    } else if (asset.kind === 'video') {
      asset.durationSec = await probeDuration(asset.path);
      asset.frames = await extractFrames(asset.path, asset.durationSec, dir, stem);
      if (await hasAudioStream(asset.path)) await transcribeAsset(asset, deps);
    }
  } catch (err) {
    log.warn({ id: asset.id, err: err instanceof Error ? err.message : String(err) }, 'media processing failed');
  }
  return asset;
}
