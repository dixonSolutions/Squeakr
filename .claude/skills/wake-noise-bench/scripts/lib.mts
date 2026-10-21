/**
 * Shared pieces of the wake / noise bench (see ../SKILL.md): the committed
 * clips, synthetic noise, mixing at a measured SNR, the shipped denoiser,
 * the bridge's Vosk and a Whisper server. Run every script from the repo root
 * with `node --import tsx` — they import the shipped TypeScript from src/.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpusDecoder, parseOpusHead, readOggPackets, resamplePcm16 } from '../../../../src/channels/audio.js';
import { loadDenoiser } from '../../../../src/channels/denoise.js';
import { squeakrHome } from '../../../../src/serve/voskPaths.js';

export const ROOT = resolve(import.meta.dirname, '../../../..');
export const R = 48_000;

// ── args ──────────────────────────────────────────────────────────────────
export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
/** The corpus: the committed one, or one generate-corpus.mts made (`--bench DIR`). */
export const BENCH = resolve(arg('bench', join(ROOT, 'docs/data/wake-bench')));
export const OUT = resolve(arg('out', join(tmpdir(), 'squeakr-wake-bench')));
mkdirSync(OUT, { recursive: true });

// ── the committed clips ─────────────────────────────────────────────────────
export interface Clip {
  id: string;
  file: string;
  set: 'commands' | 'babble' | 'wake';
  text: string;
  voice: string;
  split?: 'dev' | 'test';
  kind?: 'pos' | 'near' | 'talk';
  phrase?: string | null;
  form?: string | null;
}
export interface Manifest {
  phrases: Array<{ phrase: string; role: 'start' | 'end' | 'cancel' }>;
  clips: Clip[];
}
let loaded: Manifest | null = null;
function load(): Manifest {
  return (loaded ??= JSON.parse(readFileSync(join(BENCH, 'manifest.json'), 'utf-8')) as Manifest);
}
export const manifest = (): Clip[] => load().clips;
/** The phrases the corpus tests, each with its role (wakeSpotting.ts PhraseRole). */
export const phrases = () => load().phrases;

const cache = new Map<string, Float32Array>();
/** A committed clip as 48 kHz mono float (−1..1). */
export function audio(clip: Clip): Float32Array {
  let a = cache.get(clip.id);
  if (a) return a;
  const packets = readOggPackets(readFileSync(join(BENCH, clip.file)));
  const head = parseOpusHead(packets[0]!);
  const dec = new OpusDecoder(1);
  const pcm = Buffer.concat(packets.slice(2).filter((p) => p.length).map((p) => dec.decode(p))).subarray(head.preSkip * 2);
  dec.close();
  a = Float32Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
  cache.set(clip.id, a);
  return a;
}

// ── noise ───────────────────────────────────────────────────────────────────
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** RMS over the speech itself: 20 ms frames within 35 dB of the loudest. */
export function activeRms(x: Float32Array): number {
  const f = R / 50, e: number[] = [];
  for (let i = 0; i + f <= x.length; i += f) {
    let s = 0;
    for (let j = i; j < i + f; j++) s += x[j]! * x[j]!;
    e.push(s / f);
  }
  const max = Math.max(...e), act = e.filter((v) => v > max * 10 ** -3.5);
  return Math.sqrt(act.reduce((a, b) => a + b, 0) / act.length);
}

function biquad(x: Float32Array, type: 'lp' | 'hp' | 'bp', f0: number, Q = 0.707): Float32Array {
  const w = (2 * Math.PI * f0) / R, a = Math.sin(w) / (2 * Q), c = Math.cos(w);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : type === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [a, 0, -a];
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a, y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * 20 s of each noise, deterministic, RMS 0.1: mouse, keyboard, fan, vacuum,
 * traffic, siren, hammer, music, babble (four people talking — the committed
 * babble clips) and blanket (all of them at once).
 */
export function noises(): Record<string, Float32Array> {
  const N = R * 20;
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const white = () => rnd() * 2 - 1;
  const norm = (x: Float32Array) => { const g = 0.1 / (rms(x) || 1); for (let i = 0; i < x.length; i++) x[i]! *= g; return x; };
  const pink = (n: number) => {
    const y = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = white();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      y[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    }
    return y;
  };
  const brown = (n: number) => { const y = new Float32Array(n); let l = 0; for (let i = 0; i < n; i++) { l = (l + 0.02 * white()) / 1.02; y[i] = l; } return y; };
  const click = (y: Float32Array, at: number, amp: number, f1: number, f2: number, decayMs: number) => {
    const len = Math.round((R * decayMs * 5) / 1000);
    for (let k = 0; k < len && at + k < y.length; k++) {
      const t = k / R, env = Math.exp(-t / (decayMs / 1000));
      y[at + k]! += amp * env * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.5 * white());
    }
  };
  const n: Record<string, Float32Array> = {};
  { const y = new Float32Array(N); let t = 0.1;
    while (t < 19.5) { const at = Math.round(t * R), a = 0.6 + 0.4 * rnd();
      click(y, at, a, 3800, 6200, 1.2); click(y, at + Math.round(R * (0.07 + 0.05 * rnd())), a * 0.7, 4200, 7000, 1);
      if (rnd() < 0.25) { click(y, at + ((R * 0.18) | 0), a, 3800, 6200, 1.2); click(y, at + ((R * 0.25) | 0), a * 0.7, 4200, 7000, 1); }
      if (rnd() < 0.3) for (let k = 0; k < 12; k++) click(y, at + Math.round(R * (0.4 + k * 0.025)), 0.25, 2500, 5000, 0.6);
      t += 0.25 + rnd() * 0.6; }
    n.mouse = norm(y); }
  { const y = new Float32Array(N); let t = 0.05;
    while (t < 19.7) { const burst = 4 + ((rnd() * 14) | 0);
      for (let k = 0; k < burst; k++) { const at = Math.round((t + k * (0.08 + 0.06 * rnd())) * R);
        click(y, at, 0.5 + 0.5 * rnd(), 1800 + 900 * rnd(), 4500, 3); click(y, at + ((R * 0.04) | 0), 0.3, 2400, 5200, 2);
        if (rnd() < 0.15) click(y, at, 0.9, 700, 1500, 8); }
      t += burst * 0.12 + 0.3 + rnd() * 0.8; }
    n.keyboard = norm(y); }
  { const p = biquad(pink(N), 'lp', 2500);
    for (let i = 0; i < N; i++) { const t = i / R; p[i]! += 0.04 * (Math.sin(2 * Math.PI * 100 * t) + 0.5 * Math.sin(2 * Math.PI * 200 * t) + 0.3 * Math.sin(2 * Math.PI * 300 * t)); }
    n.fan = norm(p); }
  { const y = biquad(Float32Array.from({ length: N }, white), 'bp', 1200, 0.5), b = brown(N);
    for (let i = 0; i < N; i++) { const t = i / R; y[i] = 0.6 * y[i]! + 2 * b[i]! + 0.15 * Math.sin(2 * Math.PI * (950 + 15 * Math.sin(2 * Math.PI * 0.7 * t)) * t) + 0.05 * Math.sin(2 * Math.PI * 1900 * t); }
    n.vacuum = norm(y); }
  { const y = brown(N); for (let i = 0; i < N; i++) y[i]! *= 0.5 + 0.5 * Math.sin((Math.PI * i) / (R * 5)) ** 2; n.traffic = norm(biquad(y, 'hp', 30)); }
  { const y = new Float32Array(N); let ph = 0;
    for (let i = 0; i < N; i++) { const t = i / R, f = 900 + 500 * Math.sin(2 * Math.PI * 0.25 * t); ph += (2 * Math.PI * f) / R; y[i] = Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph); }
    n.siren = norm(y); }
  { const y = new Float32Array(N); let t = 0.2;
    while (t < 19.6) { click(y, Math.round(t * R), 1, 180, 2600, 25); click(y, Math.round(t * R), 0.4, 3300, 5100, 40); t += 0.35 + rnd() * 0.5; }
    n.hammer = norm(y); }
  { const y = new Float32Array(N), chords = [[220, 277, 330], [196, 247, 294], [175, 220, 262], [196, 247, 294]];
    for (let i = 0; i < N; i++) { const t = i / R, ch = chords[Math.floor(t / 2) % 4]!; let s = 0;
      for (const f of ch) for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t) / h;
      y[i] = 0.15 * s; const beat = t % 0.5; y[i]! += 0.8 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * (60 + 80 * Math.exp(-beat * 40)) * beat);
      const hh = (t + 0.25) % 0.5; y[i]! += 0.15 * Math.exp(-hh * 200) * white(); }
    n.music = norm(y); }
  { const y = new Float32Array(N), babble = manifest().filter((c) => c.set === 'babble');
    babble.forEach((clip, k) => { const c = audio(clip), g = 0.1 / rms(c); let o = Math.round(k * 0.7 * R);
      while (o < N) { for (let i = 0; i < c.length && o + i < N; i++) y[o + i]! += c[i]! * g; o += c.length + Math.round(R * (0.3 + rnd())); } });
    n.babble = norm(y); }
  { const y = new Float32Array(N); for (const k of Object.keys(n)) for (let i = 0; i < N; i++) y[i]! += n[k]![i]!; n.blanket = norm(y); }
  return n;
}

/**
 * `speech` after `lead` seconds of noise, `tail` seconds after it, the noise
 * at `snr` dB below the speech's active RMS (null: no noise). A limiter keeps
 * peaks below clipping, as a mic's gain control would; it scales speech and
 * noise alike, so the SNR holds.
 */
export function mix(speech: Float32Array, noise: Float32Array | null, snr: number | null, offset: number, lead = 1, tail = 0.8): Float32Array {
  const L = Math.round(R * lead), len = L + speech.length + Math.round(R * tail), x = new Float32Array(len);
  if (noise && snr !== null) {
    const g = activeRms(speech) / 10 ** (snr / 20) / 0.1;
    for (let i = 0; i < len; i++) x[i] = noise[(offset + i) % noise.length]! * g;
  }
  for (let i = 0; i < speech.length; i++) x[L + i]! += speech[i]!;
  let pk = 0;
  for (const v of x) pk = Math.max(pk, Math.abs(v));
  if (pk > 0.95) for (let i = 0; i < len; i++) x[i]! *= 0.95 / pk;
  return x;
}
/** A deterministic, well-spread start into a 20 s noise for clip `k`. */
export const offsetFor = (k: number) => (k * 104729 * 7) % (R * 18);

// ── denoise ─────────────────────────────────────────────────────────────────
const toPcm16 = (x: Float32Array) => { const b = Buffer.alloc(x.length * 2); for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767))), i * 2); return b; };
const fromPcm16 = (b: Buffer) => Float32Array.from({ length: b.length >> 1 }, (_, i) => b.readInt16LE(i * 2) / 32768);

const factory = await loadDenoiser();
/**
 * The shipped call denoiser (src/channels/denoise.ts — 40 % mix, 20 ms late)
 * over the whole buffer in Discord-sized 20 ms packets, then the 20 ms it
 * delays by trimmed so the speech stays where it was.
 */
export function denoise(x: Float32Array): Float32Array {
  if (!factory) throw new Error('@jitsi/rnnoise-wasm is not installed — run npm install');
  const d = factory(), pcm = toPcm16(x), out: Buffer[] = [];
  for (let o = 0; o < pcm.length; o += 1920) out.push(d.process(pcm.subarray(o, o + 1920)));
  d.close();
  const y = fromPcm16(Buffer.concat(out));
  return y.subarray(960);
}

/** 48 kHz float → the 16 kHz PCM16 the speech pipeline takes, resampled exactly as the bridge does. */
export const to16k = (x: Float32Array) => resamplePcm16(toPcm16(x), R, 16_000);

// ── engines ─────────────────────────────────────────────────────────────────
interface VoskRecognizer {
  setWords(on: boolean): unknown;
  acceptWaveform(pcm: Buffer): boolean;
  resultString(): string | null;
  partialResult(): { partial: string } | null;
  finalResult(): { text?: string; result?: Array<{ word: string; conf: number }> } | string | null;
  reset(): unknown;
}
let voskModel: { vosk: any; model: object } | null = null;
/** The bridge's Vosk (vosk-koffi) on the model it unpacks for calls. */
export async function vosk(grammar: string[] | null): Promise<VoskRecognizer> {
  if (!voskModel) {
    const mod: any = await import('vosk-koffi');
    const v = mod.Model ? mod : mod.default;
    v.setLogLevel(-1);
    const dir = [process.env.VOSK_MODEL_DIR, join(squeakrHome(), 'vosk', 'server-model')].find((d) => d && existsSync(join(d, 'am')));
    if (!dir) throw new Error('No Vosk model directory — set VOSK_MODEL_DIR, or start the bridge once so it unpacks one (see SKILL.md)');
    voskModel = { vosk: v, model: new v.Model(dir) };
  }
  const { vosk: v, model } = voskModel;
  const rec = new v.Recognizer(grammar ? { model, sampleRate: 16_000, grammar } : { model, sampleRate: 16_000 }) as VoskRecognizer;
  rec.setWords(true);
  return rec;
}

export const WHISPER_URL = process.env.WHISPER_URL ?? 'http://127.0.0.1:8770';
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'Systran/faster-whisper-base.en';
/** One transcription through an OpenAI-compatible server (the bridge's local_whisper), retried on a dropped connection. */
export async function whisper(pcm16k: Buffer): Promise<string> {
  const wav = Buffer.alloc(44 + pcm16k.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm16k.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm16k.length, 40); pcm16k.copy(wav, 44);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
      fd.append('model', WHISPER_MODEL);
      fd.append('language', 'en');
      fd.append('temperature', '0');
      const r = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`whisper ${r.status} ${await r.text()}`);
      return ((await r.json()) as { text?: string }).text ?? '';
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

export const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
/** Word error rate of `hyp` against `ref`. */
export function wer(ref: string, hyp: string): number {
  const a = normText(ref).split(' '), b = normText(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]! / a.length;
}

/** Run `fn` over `jobs` with `n` at a time. */
export async function pool<T>(jobs: T[], n: number, fn: (job: T) => Promise<void>): Promise<void> {
  const queue = [...jobs];
  await Promise.all(Array.from({ length: n }, async () => { for (let j; (j = queue.shift()) !== undefined; ) await fn(j); }));
}

/** Noise conditions: harsh (where things break) and moderate (an ordinary noisy room). */
export const CONDITIONS = {
  harsh: [['clean', null, null], ['fan', 'fan', 5], ['vacuum', 'vacuum', 0], ['music', 'music', 0], ['babble', 'babble', 10], ['blanket', 'blanket', 5], ['mouse', 'mouse', 0]],
  moderate: [['fan15', 'fan', 15], ['babble20', 'babble', 20], ['blanket15', 'blanket', 15], ['music10', 'music', 10]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string | null, number | null]>>;
export function conditions(): Array<readonly [string, string | null, number | null]> {
  const which = arg('conditions', 'harsh');
  return which === 'all' ? [...CONDITIONS.harsh, ...CONDITIONS.moderate] : [...CONDITIONS[which as keyof typeof CONDITIONS]];
}
