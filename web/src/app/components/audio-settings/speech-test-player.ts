/**
 * The speech test on Config → Audio & devices (docs/49).
 *
 * Plays a sample in the agent's actual voice — whichever engine the session
 * would pick, through the same output bus, speed stretch and loudness — and
 * lets the sliders change it *while it plays*, so a level is chosen by ear
 * rather than by guessing and starting a session.
 *
 * Server voices: the clip is synthesized once and kept as an AudioBuffer, so
 * replays and loops cost no further synthesis. Moving the speed slider
 * re-stretches from the current position and carries on from there; moving
 * loudness glides the gain stages.
 *
 * Browser voices: speechSynthesis cannot change an utterance in flight, so a
 * change restarts the utterance from the last word boundary it reported.
 */

import { getSharedAudioContext, unlockAudioContext, primeTtsPlaybackUnlock } from '../../../audio.js';
import { getOutputBus } from '../../../audio-output.js';
import { currentLoudness, currentSpeechSpeed } from '../../../audio-prefs.js';
import { resolveBrowserTtsOptions, type WebkitTtsDefaults } from '../../../browser-tts-settings.js';
import { stretchAudioBuffer } from '../../../server-tts.js';

export type SpeechTestEngine = 'server' | 'browser';

export type SpeechTestState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'playing'; engine: SpeechTestEngine; provider: string | null; progress: number }
  | { phase: 'error'; message: string };

export interface SpeechTestOptions {
  bridgeBase: string;
  appToken: string;
  engine: SpeechTestEngine;
  /** Browser voice defaults from the bridge (settings.voice.tts.webkit). */
  webkitDefaults: WebkitTtsDefaults;
  onState: (state: SpeechTestState) => void;
}

interface ClipCache {
  text: string;
  buffer: AudioBuffer;
  provider: string | null;
  /** The last stretch, keyed by speed — dragging back and forth reuses it. */
  stretched: Map<number, AudioBuffer>;
}

export class SpeechTestPlayer {
  private clip: ClipCache | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Position in the *original* clip (seconds) when the current source started. */
  private originStart = 0;
  private startedAt = 0;
  private playingSpeed = 1;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private speedTimer: ReturnType<typeof setTimeout> | null = null;
  private loop = false;
  private running = false;
  private fetchAbort: AbortController | null = null;

  // Browser voice state.
  private utterText = '';
  private utterOffset = 0;
  private utterBoundary = 0;
  private utterGeneration = 0;

  constructor(private opts: SpeechTestOptions) {}

  setOptions(opts: Partial<SpeechTestOptions>): void {
    const engineChanged = opts.engine !== undefined && opts.engine !== this.opts.engine;
    this.opts = { ...this.opts, ...opts };
    if (engineChanged) this.stop();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    if (this.source) this.source.loop = false; // looping is handled on end, so speed changes stay exact
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Must be called from the click handler — iOS only unlocks audio inside a gesture. */
  async play(text: string): Promise<void> {
    this.stop();
    this.running = true;
    void primeTtsPlaybackUnlock();
    if (this.opts.engine === 'browser') {
      this.utterText = text;
      this.speakFrom(0);
      return;
    }
    try {
      await unlockAudioContext();
      const clip = await this.loadClip(text);
      if (!this.running) return;
      this.startServer(clip, 0);
    } catch (err) {
      if (!this.running) return;
      this.running = false;
      this.opts.onState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  stop(): void {
    this.running = false;
    this.fetchAbort?.abort();
    this.fetchAbort = null;
    this.stopSource();
    if (this.speedTimer) clearTimeout(this.speedTimer);
    this.speedTimer = null;
    this.utterGeneration++;
    if (typeof window !== 'undefined' && window.speechSynthesis && this.opts.engine === 'browser') {
      window.speechSynthesis.cancel();
    }
    this.opts.onState({ phase: 'idle' });
  }

  /** Loudness moved — the bus follows by itself; the attenuation stage is ours. */
  onLoudnessChanged(): void {
    if (!this.running) return;
    if (this.gain) {
      const ctx = this.gain.context;
      this.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.gain.gain.setTargetAtTime(currentLoudness().attenuation, ctx.currentTime, 0.03);
    } else if (this.opts.engine === 'browser') {
      this.restartUtterance();
    }
  }

  /** Speed moved — debounced, because a re-stretch is real work. */
  onSpeedChanged(): void {
    if (!this.running) return;
    if (this.speedTimer) clearTimeout(this.speedTimer);
    this.speedTimer = setTimeout(() => {
      this.speedTimer = null;
      if (!this.running) return;
      if (this.opts.engine === 'browser') {
        this.restartUtterance();
      } else if (this.clip) {
        this.startServer(this.clip, this.originPosition());
      }
    }, 120);
  }

  /** Forget the synthesized clip (the voice or engine changed). */
  invalidate(): void {
    this.clip = null;
  }

  dispose(): void {
    this.stop();
    this.clip = null;
  }

  // ── Server voices ───────────────────────────────────────────────────────

  private async loadClip(text: string): Promise<ClipCache> {
    if (this.clip?.text === text) return this.clip;
    this.opts.onState({ phase: 'loading' });
    const abort = new AbortController();
    this.fetchAbort = abort;
    const res = await fetch(`${this.opts.bridgeBase}/api/intelligence/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.appToken}`, 'Content-Type': 'application/json' },
      // Whole file, not a stream: it is replayed and re-stretched many times.
      body: JSON.stringify({ text }),
      signal: abort.signal,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // keep status text
      }
      throw new Error(detail);
    }
    const provider = res.headers.get('X-Speech-Provider');
    const ctx = getSharedAudioContext();
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    this.clip = { text, buffer, provider, stretched: new Map() };
    return this.clip;
  }

  private stretchedFor(clip: ClipCache, speed: number, fromSec: number): AudioBuffer {
    const ctx = getSharedAudioContext();
    if (fromSec <= 0.01) {
      let full = clip.stretched.get(speed);
      if (!full) {
        full = stretchAudioBuffer(ctx, clip.buffer, speed);
        clip.stretched.clear();
        clip.stretched.set(speed, full);
      }
      return full;
    }
    // Mid-clip speed change: only the rest needs stretching.
    const from = Math.min(clip.buffer.length - 1, Math.round(fromSec * clip.buffer.sampleRate));
    const rest = ctx.createBuffer(clip.buffer.numberOfChannels, clip.buffer.length - from, clip.buffer.sampleRate);
    for (let c = 0; c < clip.buffer.numberOfChannels; c++) {
      rest.getChannelData(c).set(clip.buffer.getChannelData(c).subarray(from));
    }
    return stretchAudioBuffer(ctx, rest, speed);
  }

  private startServer(clip: ClipCache, originSec: number): void {
    this.stopSource();
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const speed = currentSpeechSpeed();
    const buffer = this.stretchedFor(clip, speed, originSec);

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = currentLoudness().attenuation;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(getOutputBus());
    source.onended = () => {
      if (this.source !== source) return;
      this.stopSource();
      if (this.running && this.loop) {
        this.startServer(clip, 0);
      } else if (this.running) {
        this.running = false;
        this.opts.onState({ phase: 'idle' });
      }
    };

    this.source = source;
    this.gain = gain;
    this.originStart = originSec;
    this.startedAt = ctx.currentTime;
    this.playingSpeed = speed;
    source.start();

    this.reportServerProgress();
    this.progressTimer = setInterval(() => this.reportServerProgress(), 100);
  }

  private originPosition(): number {
    if (!this.source) return 0;
    const elapsed = getSharedAudioContext().currentTime - this.startedAt;
    const duration = this.clip?.buffer.duration ?? 0;
    return Math.min(duration, this.originStart + elapsed * this.playingSpeed);
  }

  private reportServerProgress(): void {
    const duration = this.clip?.buffer.duration ?? 0;
    this.opts.onState({
      phase: 'playing',
      engine: 'server',
      provider: this.clip?.provider ?? null,
      progress: duration > 0 ? Math.min(1, this.originPosition() / duration) : 0,
    });
  }

  private stopSource(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // never started
      }
      this.source.disconnect();
      this.source = null;
    }
    this.gain?.disconnect();
    this.gain = null;
  }

  // ── Browser voices ──────────────────────────────────────────────────────

  private restartUtterance(): void {
    this.speakFrom(this.utterOffset + this.utterBoundary);
  }

  private speakFrom(charOffset: number): void {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
    if (!synth) {
      this.running = false;
      this.opts.onState({ phase: 'error', message: 'This browser has no speechSynthesis.' });
      return;
    }
    const generation = ++this.utterGeneration;
    const rest = this.utterText.slice(charOffset);
    if (!rest.trim()) {
      this.finishUtterance(generation);
      return;
    }
    this.utterOffset = charOffset;
    this.utterBoundary = 0;

    const resolved = resolveBrowserTtsOptions(this.opts.webkitDefaults);
    const utter = new SpeechSynthesisUtterance(rest);
    utter.rate = resolved.rate;
    utter.pitch = resolved.pitch;
    utter.volume = resolved.volume;
    utter.lang = resolved.lang;
    if (resolved.voiceURI) {
      const voice = synth.getVoices().find((v) => v.voiceURI === resolved.voiceURI);
      if (voice) utter.voice = voice;
    }
    const report = () =>
      this.opts.onState({
        phase: 'playing',
        engine: 'browser',
        provider: utter.voice?.name ?? null,
        progress: this.utterText.length
          ? Math.min(1, (this.utterOffset + this.utterBoundary) / this.utterText.length)
          : 0,
      });
    utter.onstart = report;
    utter.onboundary = (ev) => {
      if (generation !== this.utterGeneration) return;
      this.utterBoundary = ev.charIndex;
      report();
    };
    utter.onend = () => this.finishUtterance(generation);
    utter.onerror = (ev) => {
      if (generation !== this.utterGeneration) return;
      if (ev.error === 'interrupted' || ev.error === 'canceled') return;
      this.running = false;
      this.opts.onState({ phase: 'error', message: `Browser voice failed: ${ev.error}` });
    };
    synth.cancel();
    synth.speak(utter);
    report();
  }

  private finishUtterance(generation: number): void {
    if (generation !== this.utterGeneration || !this.running) return;
    if (this.loop) {
      this.speakFrom(0);
      return;
    }
    this.running = false;
    this.opts.onState({ phase: 'idle' });
  }
}
