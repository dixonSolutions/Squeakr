# 06 — Voice, Audio, STT & TTS

> Filename kept for link stability. WebRTC / speech-to-speech was removed; this doc
> covers the current cascade audio path.

## Overview

Both workflows (`agent_native` and `llm_intelligence`) share the same PWA audio
pipeline. The phone handles capture and playback; the bridge handles turn routing
and (for `llm_intelligence`) Claude orchestration.

```
Mic → Vosk (wake/end) → STT (WebKit or Transcribe) → /ws/intelligence
                                                              │
Assistant audio ← WebKit TTS or Polly ← speak events ←────────┘
```

## Session class

`web/src/llm-intelligence-session.ts` — used for **both** workflows. Connects to
`/ws/intelligence`, manages wake word gating, VAD, STT buffering, and TTS playback.

Callback types: `web/src/voice-session-types.ts`.

## Wake words (Vosk)

- **Start phrase** (`settings.voice.wakeWords.start`) — activates utterance capture.
- **End phrase** (`settings.voice.wakeWords.end`) — optional submit when VAD is off.
- **Cancel phrase** — aborts capture only; after VAD/end-phrase (while Transcribe runs), use the red **Cancel** button — see [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md).
- Offline WASM grammar spotter — requires COOP/COEP headers (see `webDispatch.ts`).
- Configure in Config tab or `PATCH /api/voice/wake-words`. Set `wakeWordsEnabled: false` for touch-only.

## Turn submit

| Mode | Config | Behavior |
| --- | --- | --- |
| **Silero VAD** (default) | `turnSubmit.vadEnabled: true` | Detect speech end → submit |
| **End phrase** | `vadEnabled: false` | Vosk listens for end phrase |
| **Silence fallback** | `turnSubmit.silenceMs` | Auto-submit after N ms quiet |

### Redemption and the VAD model

`turnSubmit.silenceMs` is passed straight through as Silero's `redemptionMs`, and
the model's frame size quantises it. vad-web still defaults to the **legacy**
model, whose frames are 1536 samples (96 ms):

| Model | Frame | `silenceMs` | Real redemption | Earliest speech-end |
| --- | --- | --- | --- | --- |
| legacy (was) | 96 ms | 1500 | **1 440 ms** | 1 824 ms |
| v5 (now) | 32 ms | 700 | **672 ms** | 1 056 ms |

We select `model: 'v5'` explicitly in `web/src/silero-vad.ts` and ship
`silero_vad_v5.onnx` via the asset globs in `angular.json` — keep those two in
step. v5's finer frames and better accuracy are what make a sub-second
redemption safe; **v5 alone is not a win** (at `silenceMs: 1500` it quantises to
1 472 ms, slightly worse than legacy), so the lowered default is the other half
of the change.

`LlmIntelligenceSession.minSpeechEndMs` (800 ms) discards a speech-end that
arrives too soon after wake. That is safe only because the VAD cannot report one
before `minSpeechMs` + redemption — 864 ms even at the lowest configurable
`silenceMs` of 500. Re-check it if either bound moves.

Hosts that still carry the old `1500` default are migrated to `700` once, on
config load. A `silenceMs` set to anything else is treated as deliberate and left
alone. Note the value also drives the silence-submit timer in the non-VAD,
non-end-phrase mode, which gets correspondingly snappier.

## Model download progress

The two offline models are large and neither library reports progress:
`vosk-browser`'s `createModel(url)` fetches the ~50 MB archive inside its own
worker, and `MicVAD.new()` fetches the ONNX graph and the ONNX Runtime binary
internally. Before this, a first run showed a motionless orb for the length of a
~65 MB transfer, and the VAD assets landed *mid-turn* on the first wake.

`web/src/model-download.ts` fetches them up front through a counting stream and
writes them into the same Cache Storage buckets the service worker reads, so the
library call that follows resolves locally.

| Asset | Size | Cache |
| --- | --- | --- |
| `/vosk/model.tar.gz` | ~50 MB | `squeakr-vosk-v1` |
| `/silero-vad/silero_vad_v5.onnx` | 2.2 MB | `squeakr-models-v1` |
| `/silero-vad/ort-wasm-simd-threaded.wasm` | 13 MB | `squeakr-models-v1` |

`LlmIntelligenceSession.start()` calls `prefetchVoiceModels()` after the
WebSocket authenticates and before the wake phase, so the download happens while
the orb still reads **Preparing**. Vosk is skipped when wake words are off or
cross-origin isolation is missing; Silero is skipped when `vadEnabled: false`.

Progress reaches the UI through `onModelDownload()` →
`VoiceSessionService.modelDownload` → the orb stage in the Voice tab. Emissions
are throttled to ~8/s so change detection is not flooded per network chunk.

Two phases are reported separately, because only one of them can be counted:

- **downloading** — determinate when the server sends `Content-Length`,
  indeterminate (a sweeping bar) when it does not.
- **unpacking** — Vosk un-tars the archive in WASM afterwards. That is several
  silent seconds on a phone with nothing to count, so it gets its own label
  rather than a progress bar frozen at 100%.

Prefetch failure is never fatal: the warning is logged and the library downloads
the asset itself, exactly as it did before.

**Caching notes.** `vosk-browser` also keeps the *extracted* model in IndexedDB
(it mounts `IDBFS` and syncs around the download), so a repeat visit re-reads it
from there and never touches the cached archive. Bump `MODEL_CACHE_NAME` in
`web/public/sw.js` when the bundled model assets change — like `VOSK_CACHE_NAME`
it is deliberately excluded from the activate-time cache sweep.

## STT backends

| Backend | When used |
| --- | --- |
| **WebKit SpeechRecognition** | iPhone Safari / PWA (preferred) |
| **Amazon Transcribe** | Desktop fallback when WebKit unavailable |
| **Typed input** | Voice tab text field (dev / no mic) |

Transcribe: `POST /api/intelligence/transcribe` (bridge proxies with IAM keys).

## TTS backends

| Backend | When used |
| --- | --- |
| **WebKit speechSynthesis** | iPhone Safari tab (preferred) |
| **Amazon Polly** | iOS home-screen PWA, desktop fallback; also `llm_intelligence` transcript fallback |

Polly: `POST /api/intelligence/tts` (bridge proxies with IAM keys).

**iOS audio unlock:** Tap the orb runs `primeTtsPlaybackUnlock()` before any network
prep — resumes `AudioContext` and (on iOS) speaks a silent dummy utterance so later
`speak()` events from the WebSocket are not blocked by Safari autoplay policy.
Home-screen PWAs prefer Polly over WebKit TTS when AWS keys are configured.

## UI sound cues

`web/public/sounds/` — MP3 from [Kenney UI Audio](https://kenney.nl/assets/ui-audio) (CC0).
Regenerate: `bash scripts/prepare-voice-cues.sh`.

| Cue | File | Kenney source | When | Character |
| --- | --- | --- | --- | --- |
| **listening** | `listening.mp3` | `rollover4.wav` | Wake phrase (`onActivated`) | Short beep — mic open |
| **sent** | `sent.mp3` | `click3.wav` | Turn submitted (`onTurnSubmitted`) | Soft boop — message sent |
| **cancel** | `cancel.mp3` | `switch2.wav` | Cancel phrase (`onTurnCancelled`) | Toggle-off — turn discarded |
| **error** | `error.mp3` | Universfield (Pixabay) | TTS failure, disconnect, STT/turn errors | Error tone — pipeline failure |

Playback: `web/src/sound-effects.ts` via `playVoiceCueNow()` — fired in `llm-intelligence-session.ts` at Vosk/VAD recognition, **before** STT flush. Preload on orb tap. Error cue uses `LlmIntelligenceSession.notifyError()` / `VoiceSessionService.notifyVoiceError()`.

Configure error feedback under **Config → Voice → Agent speech (TTS)**:
- `errorSoundEnabled` — play the error earcon (default on)
- `errorSpeakEnabled` — also speak the error message via TTS, independent of `agentSpeechEnabled` (default on; turn off for sound-only alerts)

For **`agent_native`**, primary TTS comes from MCP `speak()` events pushed over
`/ws/intelligence`. For **`llm_intelligence`**, orchestrator `speak` tool + optional
browser TTS fallback (`web/src/tts-fallback.ts`).

## TTS barge-in

User can say the wake phrase during assistant playback. The client **pauses TTS at full
volume** (never ducks), keeps the queue for cancel-resume, and on submit snapshots
`heard_complete` / `heard_partial` / `not_spoken` so Cursor knows what was heard.

Legacy `interruptMode` / `interruptDeafenFactor` config keys are stripped on load — volume
ducking is gone.

Set `settings.voice.tts.agentSpeechEnabled: false` to disable MCP `speak()` playback entirely
(transcripts still appear in the UI).

Configure in Config tab → Voice & Wake Words, or `PATCH /api/voice/tts`.

### Wake-word echo
from the speaker. The client ignores that detection when the **current TTS line**
contains the wake phrase — barge-in stays enabled for real user interrupts.

Full flow, data shapes, and file map: [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md).

Types: `src/voice/ttsInterrupt.ts`, `web/src/tts-interrupt.ts`.

## Browser TTS options

When the WebKit `speechSynthesis` backend is active, each `SpeechSynthesisUtterance` supports:

| Property | Range | Default | Purpose |
| --- | --- | --- | --- |
| `voice` | system voices | — | Timbre / accent (selected by `voiceURI`) |
| `rate` | 0.1–10 (UI: 0.5–2) | `1.02` | Speaking speed |
| `pitch` | 0–2 | `1` | Tone |
| `volume` | 0–1 | `1` | Loudness |
| `lang` | BCP-47 | `en-US` | Language when no voice is set |

**Server defaults** live in `config.json` → `settings.voice.tts.webkit`.

**Per-device overrides** are stored in PWA `localStorage` (`web/src/browser-tts-settings.ts`)
keyed by browser + OS (e.g. `safari-ios`, `chrome-macos`). The Config tab lists all saved
profiles and lets you edit voice/rate/pitch/volume for the current browser.

Preview uses `speechSynthesis.speak()` directly from the Config tab (no bridge round-trip).

## WebSocket endpoints

| Path | Purpose |
| --- | --- |
| `/ws/intelligence` | Voice turns, speak events, tool activity, agent status |
| `/ws/control` | Legacy tool relay + narrator (worker jobs) |

## Mobile session keepalive

While a voice session is active on a **PWA**, `web/src/session-keepalive.ts` keeps the app
in a foreground media session (Screen Wake Lock + silent looping audio + Media Session API).
The **native CallKit app** skips Wake Lock so the display can sleep. Orb visualization
pauses while the screen is off. If the OS suspends the intelligence WebSocket while
backgrounded, the session auto-reconnects when the user returns.

Limits, battery notes, and user guidance: [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md).

## Audio processing

`web/src/audio.ts` — mic capture, echo cancellation, noise gate.
`web/src/mic-denoise.ts` — RNNoise on the PWA microphone (docs/50), one
denoised stream shared by wake words, server STT and the direct audio stream.
`web/src/rnnoise-dsp.ts` — the RNNoise stream itself (40 % mix, 20 ms aligned).
`web/src/silero-vad.ts` — speech-end detection.
`web/src/voice-audio-meter.ts` — orb visualization levels.
`web/src/model-download.ts` — offline model prefetch + progress reporting.

## Related docs

- [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) — barge-in snapshot + wake echo filter
- [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) — voice loop
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — Bedrock orchestrator
- [`13-voice-providers.md`](./13-voice-providers.md) — wake word config
- [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md) — on-screen Speak / Cancel and cancel during Transcribe
- [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) — mobile screen-off / reconnect
