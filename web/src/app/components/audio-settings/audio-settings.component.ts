/**
 * Config → Audio & devices (docs/49).
 *
 * Everything on this page belongs to *this device* and lives in localStorage
 * (audio-prefs.ts): which microphone and speaker, how loud the agent is, how
 * fast it talks. Nothing here is sent to the bridge — a headset on the phone
 * means nothing to the laptop sharing the same bridge.
 *
 * Three cards, in the order you would set things up:
 *   1. Microphone — picker, live level, a record-and-play-back check.
 *   2. Speaker — picker where the browser allows it, honest guidance where it
 *      does not (every iOS browser).
 *   3. Agent voice — loudness and speed sliders with a speech test that keeps
 *      playing while you drag them.
 */

import type { OnDestroy, OnInit } from '@angular/core';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PrimeTemplate } from '@openng/optimus-ui/api';
import { Button } from '@openng/optimus-ui/button';
import { Message } from '@openng/optimus-ui/message';
import { Select } from '@openng/optimus-ui/select';
import { SelectButton } from '@openng/optimus-ui/selectbutton';
import { Tag } from '@openng/optimus-ui/tag';
import { ToggleSwitch } from '@openng/optimus-ui/toggleswitch';

import { connectSilentSink, getSharedAudioContext, unlockAudioContext } from '../../../audio.js';
import {
  applyElementSink,
  chooseOutputWithBrowserPrompt,
  getFullLoudnessBus,
  listAudioDevices,
  onAudioDevicesChange,
  outputSelectionSupport,
} from '../../../audio-output.js';
import {
  classifyAudioDevice,
  currentLoudness,
  getAudioPrefs,
  loudnessLabel,
  matchRememberedDevice,
  onAudioPrefsChange,
  speedLabel,
  updateAudioPrefs,
  type AudioDeviceKind,
  type AudioPrefs,
} from '../../../audio-prefs.js';
import { browserTtsCatalogIsEmpty, primeBrowserTtsVoices } from '../../../browser-tts-settings.js';
import { resolveTtsBackend, type IntelligenceAudioConfig } from '../../../intelligence-audio.js';
import { acquireMic, micLeaseCount, onMicDeviceChosen, type MicLease } from '../../../mic-service.js';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { LevelSliderComponent } from './level-slider.component';
import { SpeechTestPlayer, type SpeechTestEngine, type SpeechTestState } from './speech-test-player';

interface DeviceOption {
  label: string;
  value: string;
  kind: AudioDeviceKind;
}

type SampleId = 'short' | 'code' | 'long';

const SAMPLES: Record<SampleId, string> = {
  short: 'Hi, this is your agent. This is how my replies will sound on this device.',
  code:
    'I updated src slash audio dash prefs dot ts and ran the tests. Forty two passed, none failed. ' +
    'Shall I open a pull request?',
  long:
    'Here is a longer sample so you can settle on a speed that works for a real answer. ' +
    'I looked through the failing build, found that the speech scheduler dropped the last chunk of every reply, ' +
    'and fixed it by flushing the stretcher before the stream closes. I also added a test that would have caught it. ' +
    'Everything else is unchanged.',
};

const RECORD_SECONDS = 4;

@Component({
  selector: 'cv-audio-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PrimeTemplate, Button, Message, Select, SelectButton, Tag, ToggleSwitch, LevelSliderComponent],
  templateUrl: './audio-settings.component.html',
  styleUrl: './audio-settings.component.scss',
})
export class AudioSettingsComponent implements OnInit, OnDestroy {
  private readonly bridge = inject(BridgeService);
  private readonly toast = inject(ToastService);
  private readonly voiceProviders = inject(VoiceProvidersService);
  private readonly voiceSession = inject(VoiceSessionService);
  private readonly cdr = inject(ChangeDetectorRef);

  protected readonly prefs = signal<AudioPrefs>(getAudioPrefs());
  protected readonly support = outputSelectionSupport();
  protected readonly isIos = isIosDevice();

  // ── Devices ─────────────────────────────────────────────────────────────

  protected readonly inputs = signal<DeviceOption[]>([]);
  protected readonly outputs = signal<DeviceOption[]>([]);
  protected readonly labelled = signal(false);
  protected readonly defaultInputLabel = signal<string | null>(null);
  protected readonly defaultOutputLabel = signal<string | null>(null);
  protected readonly missingInput = signal<string | null>(null);
  protected readonly missingOutput = signal<string | null>(null);
  protected readonly restartNeeded = signal(false);
  protected loadingDevices = false;

  protected readonly canPickOutput = computed(() => this.support.context || this.support.element);

  protected readonly inputOptions = computed<DeviceOption[]>(() => [
    {
      label: this.defaultInputLabel() ? `System default — ${this.defaultInputLabel()}` : 'System default',
      value: '',
      kind: 'default',
    },
    ...this.inputs(),
  ]);

  protected readonly outputOptions = computed<DeviceOption[]>(() => [
    {
      label: this.defaultOutputLabel() ? `System default — ${this.defaultOutputLabel()}` : 'System default',
      value: '',
      kind: 'default',
    },
    ...this.outputs(),
  ]);

  // ── Mic check ───────────────────────────────────────────────────────────

  protected readonly micLevel = signal(0);
  protected readonly micPeak = signal(0);
  protected readonly micPercent = computed(() => Math.round(this.micLevel() * 100));
  protected readonly recordSeconds = RECORD_SECONDS;
  protected readonly micListening = signal(false);
  protected readonly recording = signal(false);
  protected readonly recordCountdown = signal(0);
  protected readonly playingBack = signal(false);
  private meterLease: MicLease | null = null;
  private meterSource: MediaStreamAudioSourceNode | null = null;
  private meterAnalyser: AnalyserNode | null = null;
  private meterFrame = 0;
  private recorder: MediaRecorder | null = null;
  private playbackEl: HTMLAudioElement | null = null;
  private playbackUrl: string | null = null;

  // ── Speech test ─────────────────────────────────────────────────────────

  protected readonly sampleOptions: Array<{ label: string; value: SampleId }> = [
    { label: 'Short', value: 'short' },
    { label: 'Code', value: 'code' },
    { label: 'Long', value: 'long' },
  ];
  protected sample: SampleId = 'short';
  protected loopTest = true;
  protected readonly testState = signal<SpeechTestState>({ phase: 'idle' });
  protected readonly engine = signal<SpeechTestEngine | null>(null);
  protected readonly engineLabel = signal('Checking…');
  private player: SpeechTestPlayer | null = null;

  protected readonly loudnessText = computed(() => loudnessLabel(this.prefs().loudness));
  protected readonly speedText = computed(() => speedLabel(this.prefs().speed));
  protected readonly boostOnBrowserVoice = computed(
    () => this.engine() === 'browser' && this.prefs().loudness > 50,
  );

  private unsubDevices: (() => void) | null = null;
  private unsubPrefs: (() => void) | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.unsubPrefs = onAudioPrefsChange((p) => {
      this.prefs.set(p);
      this.cdr.markForCheck();
    });
    this.unsubDevices = onAudioDevicesChange(() => void this.refreshDevices());
    void this.refreshDevices();
    void this.resolveEngine();
  }

  ngOnDestroy(): void {
    this.unsubDevices?.();
    this.unsubPrefs?.();
    this.stopMicCheck();
    this.stopPlayback();
    this.recorder?.stop();
    this.player?.dispose();
  }

  // ── Devices ─────────────────────────────────────────────────────────────

  protected async refreshDevices(): Promise<void> {
    this.loadingDevices = true;
    this.cdr.markForCheck();
    try {
      const lists = await listAudioDevices();
      this.labelled.set(lists.labelled);

      const named = (d: MediaDeviceInfo, i: number, noun: string) => d.label || `${noun} ${i + 1}`;
      const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications';

      this.defaultInputLabel.set(stripDefaultPrefix(lists.inputs.find((d) => d.deviceId === 'default')?.label));
      this.defaultOutputLabel.set(stripDefaultPrefix(lists.outputs.find((d) => d.deviceId === 'default')?.label));
      this.inputs.set(
        lists.inputs.filter(real).map((d, i) => ({
          label: named(d, i, 'Microphone'),
          value: d.deviceId,
          kind: classifyAudioDevice(d.label, d.deviceId),
        })),
      );
      this.outputs.set(
        lists.outputs.filter(real).map((d, i) => ({
          label: named(d, i, 'Speaker'),
          value: d.deviceId,
          kind: classifyAudioDevice(d.label, d.deviceId),
        })),
      );
      this.reconcileRemembered(lists.inputs, lists.outputs, lists.labelled);
    } catch (err) {
      this.toast.warn('Could not list audio devices', err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingDevices = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Safari rotates device ids, so a remembered device is re-found by label and
   * its id refreshed. One that is genuinely gone is reported, not silently
   * dropped — it comes back into use when it reconnects.
   */
  private reconcileRemembered(inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[], labelled: boolean): void {
    const p = getAudioPrefs();
    const patch: Partial<AudioPrefs> = {};

    if (p.inputDeviceId) {
      const match = matchRememberedDevice(inputs, p.inputDeviceId, p.inputLabel);
      if (match && match.deviceId !== p.inputDeviceId) patch.inputDeviceId = match.deviceId;
      if (match && match.label && match.label !== p.inputLabel) patch.inputLabel = match.label;
      this.missingInput.set(!match && labelled ? (p.inputLabel ?? 'The chosen microphone') : null);
    } else {
      this.missingInput.set(null);
    }

    if (p.outputDeviceId) {
      const match = matchRememberedDevice(outputs, p.outputDeviceId, p.outputLabel);
      if (match && match.deviceId !== p.outputDeviceId) patch.outputDeviceId = match.deviceId;
      if (match && match.label && match.label !== p.outputLabel) patch.outputLabel = match.label;
      this.missingOutput.set(!match && outputs.length > 0 ? (p.outputLabel ?? 'The chosen speaker') : null);
    } else {
      this.missingOutput.set(null);
    }

    if (Object.keys(patch).length > 0) updateAudioPrefs(patch);
  }

  /** Device names are hidden until the site has the microphone once. */
  protected async revealDeviceNames(): Promise<void> {
    try {
      const lease = await acquireMic();
      await this.refreshDevices();
      lease.release();
    } catch (err) {
      this.toast.warn('Microphone not allowed', err instanceof Error ? err.message : String(err));
    }
  }

  protected async onInputChange(deviceId: string): Promise<void> {
    const device = this.inputs().find((d) => d.value === deviceId);
    const wasChecking = this.micListening();
    // Let go of the meter's own lease so an idle stream can actually be reopened.
    this.stopMicCheck();
    updateAudioPrefs({ inputDeviceId: deviceId || null, inputLabel: device?.label ?? null });
    const { restartNeeded } = onMicDeviceChosen();
    this.restartNeeded.set(restartNeeded || this.voiceSession.conversationActive());
    this.missingInput.set(null);
    if (wasChecking) await this.startMicCheck();
    this.cdr.markForCheck();
  }

  protected onOutputChange(deviceId: string): void {
    const device = this.outputs().find((d) => d.value === deviceId);
    updateAudioPrefs({ outputDeviceId: deviceId || null, outputLabel: device?.label ?? null });
    this.missingOutput.set(null);
    if (this.playbackEl) applyElementSink(this.playbackEl);
  }

  protected async chooseOutputViaBrowser(): Promise<void> {
    const picked = await chooseOutputWithBrowserPrompt();
    if (!picked) return;
    updateAudioPrefs({ outputDeviceId: picked.deviceId, outputLabel: picked.label || null });
    await this.refreshDevices();
  }

  protected deviceIcon(kind: AudioDeviceKind, direction: 'in' | 'out'): string {
    switch (kind) {
      case 'bluetooth':
      case 'headset':
        return 'pi-headphones';
      case 'built-in':
        return this.isIos || /Android/.test(navigator.userAgent) ? 'pi-mobile' : 'pi-desktop';
      case 'default':
        return 'pi-cog';
      default:
        return direction === 'in' ? 'pi-microphone' : 'pi-volume-up';
    }
  }

  protected deviceKindLabel(kind: AudioDeviceKind): string | null {
    switch (kind) {
      case 'bluetooth':
        return 'Bluetooth';
      case 'built-in':
        return 'Built-in';
      case 'headset':
        return 'Wired';
      case 'usb':
        return 'USB';
      default:
        return null;
    }
  }

  protected selectedKind(options: DeviceOption[], value: string | null): AudioDeviceKind {
    return options.find((o) => o.value === (value ?? ''))?.kind ?? 'default';
  }

  // ── Mic check ───────────────────────────────────────────────────────────

  protected async toggleMicCheck(): Promise<void> {
    if (this.micListening()) this.stopMicCheck();
    else await this.startMicCheck();
  }

  private async startMicCheck(): Promise<void> {
    try {
      await unlockAudioContext();
      this.meterLease = await acquireMic();
      const ctx = getSharedAudioContext();
      this.meterSource = ctx.createMediaStreamSource(this.meterLease.stream);
      this.meterAnalyser = ctx.createAnalyser();
      this.meterAnalyser.fftSize = 1024;
      this.meterSource.connect(this.meterAnalyser);
      // Analysers only run when pulled; a muted sink pulls without feeding back.
      connectSilentSink(ctx, this.meterAnalyser);
      this.micListening.set(true);
      this.micPeak.set(0);
      // Names become visible once the mic is open.
      if (!this.labelled()) void this.refreshDevices();
      this.tickMeter();
    } catch (err) {
      this.stopMicCheck();
      this.toast.warn('Could not open the microphone', err instanceof Error ? err.message : String(err));
    }
    this.cdr.markForCheck();
  }

  private tickMeter(): void {
    const analyser = this.meterAnalyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (this.meterAnalyser !== analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) sum += s * s;
      const rms = Math.sqrt(sum / buf.length);
      // dBFS mapped −60…0 onto 0…1 — the range where speech actually moves.
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      this.micLevel.set(this.micLevel() * 0.6 + level * 0.4);
      // Peak marker falls back slowly, so a word's loudest point stays readable.
      this.micPeak.set(Math.max(level, this.micPeak() - 0.006));
      this.cdr.markForCheck();
      this.meterFrame = requestAnimationFrame(tick);
    };
    this.meterFrame = requestAnimationFrame(tick);
  }

  private stopMicCheck(): void {
    cancelAnimationFrame(this.meterFrame);
    this.meterSource?.disconnect();
    this.meterAnalyser?.disconnect();
    this.meterSource = null;
    this.meterAnalyser = null;
    this.meterLease?.release();
    this.meterLease = null;
    this.micListening.set(false);
    this.micLevel.set(0);
    this.micPeak.set(0);
  }

  /** Record a few seconds, then play them back on the chosen speaker. */
  protected async recordAndPlayBack(): Promise<void> {
    if (this.recording()) return;
    if (typeof MediaRecorder === 'undefined') {
      this.toast.warn('Recording is not supported here', 'The level meter still shows the microphone works.');
      return;
    }
    this.stopPlayback();
    this.player?.stop();
    let lease: MicLease | null = null;
    try {
      // Unlock playback now, inside the tap — iOS refuses it after the recording otherwise.
      await unlockAudioContext();
      lease = await acquireMic();
      if (!this.micListening()) await this.startMicCheck();
      const recorder = new MediaRecorder(lease.stream);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
      recorder.start();
      this.recording.set(true);
      for (let left = RECORD_SECONDS; left > 0; left--) {
        this.recordCountdown.set(left);
        this.cdr.markForCheck();
        await sleep(1000);
        if (recorder.state !== 'recording') break;
      }
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      this.recording.set(false);
      this.recorder = null;
      lease.release();
      lease = null;
      await this.playBlob(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    } catch (err) {
      this.recording.set(false);
      this.toast.warn('Recording failed', err instanceof Error ? err.message : String(err));
    } finally {
      lease?.release();
      this.cdr.markForCheck();
    }
  }

  private async playBlob(blob: Blob): Promise<void> {
    this.stopPlayback();
    this.playbackUrl = URL.createObjectURL(blob);
    const el = new Audio(this.playbackUrl);
    el.setAttribute('playsinline', '');
    el.volume = currentLoudness().attenuation;
    applyElementSink(el);
    this.playbackEl = el;
    this.playingBack.set(true);
    el.onended = () => {
      this.stopPlayback();
      this.cdr.markForCheck();
    };
    try {
      await el.play();
    } catch {
      // Autoplay refused (iOS after a long await) — fall back to Web Audio, already unlocked.
      try {
        const ctx = getSharedAudioContext();
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(getFullLoudnessBus());
        src.onended = () => {
          this.playingBack.set(false);
          this.cdr.markForCheck();
        };
        src.start();
      } catch (err) {
        this.stopPlayback();
        this.toast.warn('Could not play the recording', err instanceof Error ? err.message : String(err));
      }
    }
  }

  protected stopPlayback(): void {
    if (this.playbackEl) {
      this.playbackEl.pause();
      this.playbackEl.src = '';
      this.playbackEl = null;
    }
    if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl);
    this.playbackUrl = null;
    this.playingBack.set(false);
  }

  /** Short two-tone chime on the chosen speaker, at the chosen loudness. */
  protected async playTestTone(): Promise<void> {
    await unlockAudioContext();
    const ctx = getSharedAudioContext();
    const now = ctx.currentTime;
    const out = getFullLoudnessBus();
    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = now + i * 0.18;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + 0.5);
    });
  }

  // ── Levels ──────────────────────────────────────────────────────────────

  protected onLoudness(value: number): void {
    updateAudioPrefs({ loudness: value });
    this.player?.onLoudnessChanged();
    this.applyToSession();
  }

  protected onSpeed(value: number): void {
    updateAudioPrefs({ speed: value });
    this.player?.onSpeedChanged();
    this.applyToSession();
  }

  /** Browser voice rate and base volume are resolved per session; refresh them now. */
  private applyToSession(): void {
    this.voiceSession.refreshBrowserTtsOptions();
  }

  // ── Speech test ─────────────────────────────────────────────────────────

  /** Which engine the session would speak with — the test must sound the same. */
  private async resolveEngine(): Promise<void> {
    try {
      const res = await fetch(`${this.bridge.bridgeBase}/api/intelligence/audio`, {
        headers: { Authorization: `Bearer ${this.bridge.appToken}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const config = (await res.json()) as IntelligenceAudioConfig;
      await primeBrowserTtsVoices();
      const backend = resolveTtsBackend(config);
      if (backend === 'server') {
        this.engine.set('server');
        this.engineLabel.set(config.ttsProviderLabel?.trim() || 'Server voice');
      } else if (backend === 'webkit' && !browserTtsCatalogIsEmpty()) {
        this.engine.set('browser');
        this.engineLabel.set('Browser voice');
      } else if (config.ttsAvailable) {
        this.engine.set('server');
        this.engineLabel.set(config.ttsProviderLabel?.trim() || 'Server voice');
      } else {
        this.engine.set(null);
        this.engineLabel.set('No voice available');
      }
    } catch {
      // Bridge unreachable: the browser voice is still testable.
      const browserOk = typeof window !== 'undefined' && !!window.speechSynthesis;
      this.engine.set(browserOk ? 'browser' : null);
      this.engineLabel.set(browserOk ? 'Browser voice (bridge offline)' : 'No voice available');
    }
    this.cdr.markForCheck();
  }

  protected async toggleSpeechTest(): Promise<void> {
    const engine = this.engine();
    if (!engine) return;
    if (this.player?.isRunning) {
      this.player.stop();
      return;
    }
    this.stopPlayback();
    const webkitDefaults = this.voiceProviders.data()?.tts?.webkit ?? { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' };
    if (!this.player) {
      this.player = new SpeechTestPlayer({
        bridgeBase: this.bridge.bridgeBase,
        appToken: this.bridge.appToken,
        engine,
        webkitDefaults,
        onState: (state) => {
          this.testState.set(state);
          this.cdr.markForCheck();
        },
      });
    } else {
      this.player.setOptions({ engine, webkitDefaults });
    }
    this.player.setLoop(this.loopTest);
    await this.player.play(SAMPLES[this.sample]);
  }

  protected onSampleChange(next: SampleId): void {
    this.sample = next;
    if (this.player?.isRunning) void this.player.play(SAMPLES[next]);
  }

  protected onLoopChange(loop: boolean): void {
    this.loopTest = loop;
    this.player?.setLoop(loop);
  }

  protected get sampleText(): string {
    return SAMPLES[this.sample];
  }

  protected readonly testRunning = computed(() => {
    const s = this.testState();
    return s.phase === 'playing' || s.phase === 'loading';
  });

  protected readonly testProgress = computed(() => {
    const s = this.testState();
    return s.phase === 'playing' ? Math.round(s.progress * 100) : 0;
  });

  /**
   * The browser voice's own name once it is speaking ("Samantha"); server
   * engines report an internal id, so their friendly label from the bridge stays.
   */
  protected readonly testProvider = computed(() => {
    const s = this.testState();
    return s.phase === 'playing' && s.engine === 'browser' ? s.provider : null;
  });

  protected readonly testError = computed(() => {
    const s = this.testState();
    return s.phase === 'error' ? s.message : null;
  });

  protected get micInUseElsewhere(): boolean {
    return micLeaseCount() > (this.meterLease ? 1 : 0);
  }

  protected resetAll(): void {
    this.onLoudness(50);
    this.onSpeed(50);
  }
}

function stripDefaultPrefix(label: string | undefined): string | null {
  if (!label) return null;
  return label.replace(/^Default\s*-\s*/i, '').trim() || null;
}

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
