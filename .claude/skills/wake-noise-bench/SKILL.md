---
name: wake-noise-bench
description: Measure Squeakr's wake / submit phrase spotting and call noise suppression against the committed speech corpus mixed with synthetic noise (mouse, keyboard, fan, vacuum, traffic, siren, hammering, music, chatter, all at once). Use before and after changing the wake-phrase rule (wakeSpotting.ts, confirmSpotted in callTurns.ts), the decoy words, the call denoiser (src/channels/denoise.ts) or the speech-to-text model, to test a new wake phrase, or whenever someone asks how accurate wake words / false triggers / noise filtering are.
---

# Wake / noise bench

Replays recorded speech through the **shipped code**: the bridge's Vosk, the
shared `PhraseDecision` rule, the call transcript check `confirmSpotted`, the
call denoiser `CallDenoiser`, and Whisper. It reports how often real phrases
are heard and how often look-alike sentences or ordinary talk set it off.
`docs/50-wake-accuracy-and-call-denoise.md` explains the rule and holds the
reference numbers.

Corpus: `docs/data/wake-bench/` (398 clips, Ogg/Opus, Kokoro voices).
`manifest.json` lists every clip:

| `set` | What it is |
|---|---|
| `wake` | Split into `dev` (14 voices, used for tuning) and `test` (14 *other* voices and sentences, held out). `kind` is `pos` (the phrase: `form` alone / cmd / lead / fast), `near` (a look-alike sentence) or `talk` (ordinary speech). |
| `commands` | 12 spoken commands, for the transcription sweep. |
| `babble` | 6 people talking, mixed into the "babble" noise. |

**Never tune on `test`.** Change things against `dev` and confirm on `test`.
Otherwise the numbers only describe the clips.

## Before you run

Run everything from the repo root.

1. **Dependencies.** Run `npm install --legacy-peer-deps` with install scripts
   enabled. `vosk-koffi` downloads `libvosk.so` in its install script. If
   recording fails with "Failed to load shared library", run
   `npm rebuild vosk-koffi`. `@jitsi/rnnoise-wasm` must be installed for the
   `denoised` variants.
2. **Vosk model.** Set `VOSK_MODEL_DIR` to an unpacked model directory (it
   contains `am/`). Otherwise the bench uses
   `<squeakr home>/vosk/server-model`, which the bridge unpacks the first time
   a call uses the spotter.
3. **Whisper + Kokoro.** You need an OpenAI-compatible speech server; the
   bridge's own one works (Config → Speech → *Pull & start*, speaches on
   `127.0.0.1:8770`).
   - `WHISPER_URL` and `WHISPER_MODEL` default to the bridge's
     `local_whisper` and `Systran/faster-whisper-base.en`. Match the user's
     configured model when the question is about their setup.
   - `TTS_URL` and `TTS_MODEL` are only needed to generate a corpus.
   - Check it is up: `curl -s 127.0.0.1:8770/health`.

Results go to `--out DIR` (default `$TMPDIR/squeakr-wake-bench`). Scripts that
call Whisper resume where they stopped.

## Wake phrases and false triggers

```bash
B=.claude/skills/wake-noise-bench/scripts
# 1. What Vosk hears, per clip, condition and variant (≈15 min per grammar per split)
node --import tsx $B/record-wake.mts --split dev --grammar new
node --import tsx $B/record-wake.mts --split dev --grammar old    # the rule before docs/50, for comparison
# 2. What Whisper hears — only needed for the call path (≈20 min, run it alongside step 1)
node --import tsx $B/transcribe-wake.mts --split dev
# 3. Score
node --import tsx $B/score-wake.mts --split dev                    # shipped rule
node --import tsx $B/score-wake.mts --split dev --grammar old      # old rule on old grammar
```

**`--conditions`:**
- `harsh` (default) is where things break: fan at +5 dB, vacuum and music at
  0 dB, chatter at +10 dB, everything at once at +5 dB, mouse clicks at 0 dB,
  plus clean audio.
- `moderate` is a normal noisy room: fan at +15 dB, chatter at +20 dB,
  everything at +15 dB, music at +10 dB.
- `all` is both.

Each condition runs `raw` and `denoised` (through the shipped call denoiser).

**`score-wake` prints, per phrase and condition:**
- **heard%:** real phrases spotted.
- **look-alikes fired%:** false triggers on near-miss sentences ("he
  squeezed the lemon").
- **other talk fired%:** false triggers on ordinary speech.
- **On a call** (start phrase, when transcripts exist), what happened to each
  utterance:
  - `delivered`: sent to the agent;
  - `armed`: the capture stays open, nothing delivered;
  - `ignored`: the spotter fired, but `confirmSpotted` refused it;
  - `missed`: the spotter never fired.

  For look-alikes and other talk, **`delivered` must stay at 0%**.

`--threshold` mimics the wake-sensitivity slider (0.15–0.85, shipped 0.45).

### Trying a rule change

Rules are replayed from recordings, so most changes need no re-recording.

- **No re-record:** edits to `PhraseDecision` / `spottingRule` (confidence,
  hold time, position limits) or to `confirmSpotted`. Run `score-wake` again
  against the same recordings.
- **Re-record:** changes to the grammar or decoy words (`wakeDecoys.ts`).
- **Re-transcribe:** a different Whisper model.

Keep the phone and bridge copies identical (`packages/client/src/` ↔
`src/realtime/`). `web/src/wake-spotting-parity.test.ts` fails otherwise.

## Noise suppression and transcription

```bash
node --import tsx $B/denoise-sweep.mts                      # ≈60 min: 10 noises × 7 SNRs × 4 mixes × 12 commands
node --import tsx $B/denoise-sweep.mts --mixes 0,0.4 --snrs 5,0,-5   # a quick look
```

**Output:**
- word error rate per SNR and per noise, for each RNNoise mix (0 =
  unfiltered, 0.4 = what calls ship);
- words Whisper **invents** from noise with nobody talking.

A mix that lowers error but invents words is not an improvement: the call
segmenter does send noise-only segments.

## Testing another wake phrase

1. **Check every word of the phrase is in the Vosk model's vocabulary.** An
   unknown word is silently dropped from the grammar, and the phrase can then
   never match. "hey squeakr" scores 0% heard for this reason. Spell it the
   way Vosk knows it ("hey squeaker"), or pick another phrase.
2. **Write a spec.** It has the same format as
   `docs/data/wake-bench/manifest.json`, minus `file`. Include:
   - `phrases` with roles;
   - positives in every `form`;
   - look-alikes: think rhymes and words that share the phrase's sounds;
   - ordinary talk;
   - `babble` clips;
   - `dev` and `test` splits with different voices.

   English Kokoro voices start with `af_`, `am_`, `bf_` or `bm_`.
3. Generate the corpus, then record and score against it:
   ```bash
   node --import tsx $B/generate-corpus.mts --spec spec.json --bench /tmp/my-bench
   node --import tsx $B/record-wake.mts --bench /tmp/my-bench --split dev
   ```
   Pass `--bench /tmp/my-bench` to the other scripts too.

Do not overwrite `docs/data/wake-bench/` unless the committed corpus is
meant to change. Its numbers are quoted in docs/50.

## Reference numbers

From docs/50, **held-out `test` split**:

| | Old rule | Shipped |
|---|---|---|
| "hey squeaky" heard, moderate noise | 100% | 98.9% |
| "hey squeaky" heard, harsh noise | 93.4% | 85.0% |
| Look-alikes fired, moderate | 44.3% | 9.0% |
| Look-alikes fired, harsh | 42.3% | 7.1% |
| Look-alikes **delivered** on a call, moderate | 44.3% | 0% |
| Look-alikes **delivered** on a call, harsh | 29.6% | 0% |
| Other talk delivered on a call, moderate | 3.4% | 0% |
| Other talk delivered on a call, harsh | 4.7% | 0% |
| Wake + command delivered on a call, moderate | 100% | 90.5% |
| Wake + command delivered on a call, harsh | 87.3% | 56.1% |

Results within a couple of points of these mean nothing changed. Each cell
has only 40–60 clips.

## Limits

- **Synthetic audio.** The voices are synthetic and the noise is mixed
  digitally: no room echo and no real microphone. The audio is Opus-coded,
  which matches Discord but not the phone.
- **Not the phone's engine.** The bench runs the bridge's native Vosk. The
  phone runs vosk-browser (WASM) on the same model with the same rule, but
  its timing differs slightly.
- **Look-alikes are adversarial.** They were chosen to sound like the phrase.
  Ordinary-talk numbers are the everyday false-trigger rate.
