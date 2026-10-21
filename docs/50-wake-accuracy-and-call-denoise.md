# 50 — Wake-phrase accuracy and call noise suppression

Two changes, both measured on a noise test bench before they were made:

1. **The wake, submit and cancel spotters no longer fall for look-alikes.**
   One rule (`wakeSpotting.ts`) is shared by the phone and calls; calls also
   confirm a spotted phrase against the transcript before delivering.
2. **Discord call audio is partly denoised** with RNNoise before speech
   recognition (`src/channels/denoise.ts`).

## The problem

The Vosk spotters used a grammar of just the phrase and `[unk]`. With only
two choices, Vosk turned anything near the phrase into the phrase. Partial
results fired with no confidence check, and the submit and cancel spotters
checked none at all. On calls, a spotted phrase opened the capture and the
transcript was delivered **even when it did not contain the phrase**.

Measured with the old rule (dev set below):

| | Real "hey squeaky" heard | Look-alike sentences that fired | Other talk that fired |
|---|---|---|---|
| Spotter | 95.9% | **44.9%** | 7.1% |
| Delivered to the agent on a call | 93.9% | **31.3%** | **6.2%** |

"He squeezed the lemon", "hey sweetie, dinner is ready" and "the kids are
sneaky today" all woke the agent, and on a call the rest of the sentence
became a request.

## What changed

### One spotting rule — `wakeSpotting.ts`

`packages/client/src/wakeSpotting.ts` (phone) and
`src/realtime/wakeSpotting.ts` (bridge) are the same code; the bridge cannot
import the client package. `web/src/wake-spotting-parity.test.ts` fails if they
drift.

- **Decoy grammar.** The grammar is the phrase, its words, 3000 common words
  (`wakeDecoys.ts`), then `[unk]`. Vosk can now hear what was really said.
  The phrase is still one grammar entry, so said in full it still wins.
- **Confidence per word.** Every word of the phrase in a final result must be
  heard at ≥ 0.7. The wake-sensitivity slider still moves this:
  `threshold + 0.25`, clamped 0.5–0.95.
- **Position by role.**
  - The start phrase may have at most 3 confidently heard words before it.
  - The end and cancel phrases must have none after them, because they close
    what was said. Words heard below 0.7 are breath and noise, and are ignored
    for this check.
- **Partial results hold.** A partial match (start phrase only, sensitivity
  below 0.55) fires once it has stayed in the partial for 300 ms of audio. A
  look-alike usually turns into other words in that time.

The decoy words are the most frequent words of twenty public-domain Project
Gutenberg books that appear in at least four of them and in the Vosk model's
vocabulary. The commonly used Google-derived frequency list is not licensed
for commercial use. With 3000 decoys, Chromium builds the recognizer in about
107 ms, against 70 ms for the old two-entry grammar.

### Calls confirm against the transcript — `confirmSpotted`

When the spotter opened a capture, the transcript must now open with the
phrase:

- at most two lead-in words before it ("okay, hey squeaky, …");
- spelled within 0.2 edits per letter, however the words are split ("Hay
  squeaky", "heysqueaky");
- starting with the phrase's first letter, which rules out "a squeaky clean
  kitchen".

Otherwise:

- A **short** utterance (the phrase plus up to two words) is taken as the
  phrase said alone. Transcripts mangle that case most ("Hell is squeaky").
  The capture stays open for the request, and none of its words are
  delivered.
- A **longer** one means the spotter was wrong: the capture closes and nothing
  is delivered.

The old fallback (`misheardPhraseEnd`) is removed. It accepted any early word
near the phrase's last word, so "he is *sneaky* and he is quick" delivered
"and he is quick".

### Call noise suppression — `denoise.ts`

RNNoise (`@jitsi/rnnoise-wasm`, an optional dependency loaded on first use)
runs on each Discord member's 48 kHz audio before the resample to 16 kHz.

- **One suppressor per member for the whole call**, because RNNoise learns
  the room as it goes.
- **Only 40% of the cleaned signal is used.** Fully cleaned audio made
  Whisper worse at ordinary room noise and made it invent sentences out of
  background chatter: 354 invented words against 38 unfiltered.
- **The original is delayed by 960 samples (20 ms)** to line up with RNNoise's
  output. Unaligned, the two comb-filter.
- **Cost:** about 0.45 ms of CPU per 10 ms frame per speaking member.
- **Not on the phone.** The browser's own noise suppression (`audio.ts`)
  already runs there, and adding RNNoise on top would clean the audio twice.

## The bench

The bench lives outside the repo. It needs a local speaches container (Kokoro
voices, Whisper) and the Vosk model.

- **Speech:** generated with Kokoro, 28 voices split into a **dev** half (used
  for tuning) and a **held-out** half with its own sentences.
- **Each half contains:**
  - wake phrases alone, with a command, and after a lead-in;
  - 25 start-phrase and 10 end-phrase look-alikes, each said in 2 voices;
  - everyday sentences.
- **Noise:** 10 synthetic types mixed at a measured SNR, unfiltered and
  through the 40% mix: mouse, keyboard, fan, vacuum, traffic, siren,
  hammering, music, four-person chatter, and all of them at once.
- **Engines:** the bridge's own Vosk (`vosk-koffi`, same model) and Whisper
  `base.en` (the configured provider).
- **Scoring:** the shipped TypeScript (`PhraseDecision`, `confirmSpotted`)
  replays every recorded recognizer stream 20 ms at a time.

### Dev set, new rule

Noise here is harsh: fan at +5 dB, vacuum and music at 0 dB, chatter at
+10 dB, and the blanket of all noises at +5 dB.

| | Real "hey squeaky" | Look-alikes | Other talk |
|---|---|---|---|
| Spotter, all conditions | 85.9% | **5.8%** (was 44.9%) | **0%** (was 7.1%) |
| Spotter, clean | 98.2% | 10.0% | 0% |
| Delivered on a call, all conditions | 66% of wake + command | **0%** (was 31.3%) | **0%** (was 6.2%) |
| Delivered on a call, clean | 100% | 0% | 0% |

The cost is hits in very loud noise. A vacuum as loud as the speaker (0 dB)
drops the spotter to 41% (66% with the 40% denoise). Whisper also garbles the
phrase in loud noise ("Hey swiki", "Face-queaking"), and the transcript check
then refuses it. Loosening that check to 0.3 gained 4 points of hits but
delivered 2.6% of look-alikes, so it stays at 0.2.

The end phrase ("cursor send") improved less: look-alikes fire 15%, against
18% before. Its remaining look-alikes are very close: "curse her and send
her away", "the purse was sent back".

### Noise suppression (transcription, Whisper `base.en`)

Word error rate averaged over 10 noises × 12 commands:

| SNR | Unfiltered | RNNoise 100% | RNNoise 70% | RNNoise 40% |
|---|---|---|---|---|
| +10 dB | 2% | 5% | 2% | 2% |
| +5 dB | 5% | 11% | 6% | 5% |
| 0 dB | 20% | 27% | **17%** | 18% |
| −5 dB | 44% | 45% | **38%** | **38%** |

Where the 40% mix helps:

- music at −5 dB: 44% → 26% WER;
- a siren at −10 dB: 57% → 47%;
- wake words in loud steady noise (−5 dB): 64% → 78% heard.

Where it changes nothing: clicks, typing and hammering, which Whisper already
handles, and other people talking, since RNNoise cannot separate voices.

## Limits

- The voices are synthetic and the noise is mixed digitally: no room echo,
  microphone or Opus compression.
- A look-alike that is short and fools both the spotter *and* the transcript
  check arms the capture: on the dev set, 1.4% of look-alikes in loud
  noise. The next utterance within 10 s is then delivered.
- A phrase that sounds like everyday words ("hey squeaky" ≈ "he squeezed") is
  harder to spot than a distinctive one. A distinctive phrase is the strongest
  defence against false wakes.
