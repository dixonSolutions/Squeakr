# 49 — Audio devices and levels

Config → **Audio & devices** chooses the microphone and speaker on *this
device*, sets how loud and how fast the agent talks, and has a speech test to
tune both by ear. Config → **Listening & controls** gets a wake-sensitivity
slider in place of the old percentage box and presets.

## Where it lives

| Setting | Stored | Why |
|---|---|---|
| Microphone, speaker | `localStorage` `sq-audio-prefs` | A headset on the phone means nothing to the laptop on the same bridge |
| Loudness, speech speed | `localStorage` `sq-audio-prefs` | A speaker that needs a boost on one device is deafening on another |
| Wake sensitivity | `config.json` `settings.voice.wakeWords.wakeConfidenceThreshold` | It already lived there, and the editor client reads it too |

`web/src/audio-prefs.ts` owns the storage and every slider mapping. Every
slider is 0–100, and **50 is always the default**, so the middle means "as
shipped" and the mapping to real units is in one tested place.

| Slider | 0 | 50 | 100 |
|---|---|---|---|
| Loudness | silent | unity gain | +12 dB, limited |
| Speech speed | ½× | 1× | 2× |
| Wake sensitivity | threshold 0.85 (strict) | 0.45 (shipped default) | 0.15 (very sensitive) |

Below the middle, loudness follows a square curve, which sounds even to the
ear. Above it, the gain is linear in dB. Speed is exponential, so each side of
the middle feels the same. A legacy threshold (0.65 balanced, 0.8 strict)
lands on the slider and round-trips.

## Loudness: attenuation and boost

`splitLoudness()` splits the gain into an **attenuation** (≤ 1) and a
**boost** (≥ 1). Each half is applied where it can be applied:

- **Attenuation** goes into `resolveBrowserTtsOptions().volume`. That value is
  both the browser voice's utterance volume and the TTS pile's base volume for
  server speech, so both engines get the same attenuation without touching the
  session code.
- **Boost** needs Web Audio. `web/src/audio-output.ts` builds one output bus on
  the shared AudioContext:

  ```
  full (attenuation) → boost (gain ≥ 1) → limiter → make-up trim → speaker
  ```

  Server speech, which already carries its attenuation, connects to
  `getOutputBus()` (the boost stage). Sounds with no volume of their own, such
  as chimes and agent audio streams (docs/47), connect to
  `getFullLoudnessBus()`.

The limiter is a `DynamicsCompressorNode` at −3 dB, ratio 20, hard knee. Web
Audio adds automatic make-up gain, `(1 / full-range gain)^0.6` per the spec,
which would push the limited signal straight back over full scale. The trim
stage undoes it. At or below the default, the limiter is ratio 1 (transparent).

**Browser voices cannot be boosted.** `SpeechSynthesisUtterance.volume` stops
at 1 and speechSynthesis never touches Web Audio. The page says so when a
browser voice is in use and the slider is above the middle.

## Speech speed without the chipmunk effect

- **Browser voices**: the speed multiplies the voice's own rate in
  `resolveBrowserTtsOptions()`. A voice tuned to 1.1 stays 10 % faster than its
  neighbours.
- **Server speech, whole file in an `<audio>` element**: `playbackRate` with
  `preservesPitch`.
- **Server speech, streamed PCM or decoded on iOS**: these play through
  `AudioBufferSourceNode`, where `playbackRate` would also change the pitch.
  `web/src/time-stretch.ts` does WSOLA (waveform-similarity overlap-add):
  30 ms Hann frames at 50 % overlap, read `speed`× faster than they are
  written, each nudged by up to ±8 ms to where the waveform lines up with the
  previous frame. `Pcm16Stretcher` sits in front of the PCM scheduler: bytes
  in, bytes out, with an odd byte carried across network chunks. The scheduler
  is unchanged. Speed 1 is a pass-through.

Agent audio streams (music, recordings, effects) are **not** stretched. Only
`server-tts.ts` applies the speed.

## Choosing devices

**Microphone.** `mic-service.ts` opens the chosen device as
`deviceId: { ideal }`, so an unplugged headset falls back to the system default
instead of failing. A stale id that an engine still rejects is retried once
without it. A permission refusal is never retried, because that would prompt
twice. Changing the device drops an idle shared stream so the next borrower
opens the new one. A stream that a session is using cannot be swapped under its
audio graphs, so the page asks for a restart.

Wake words, server speech-to-text and the Vosk spotters all borrow that stream.
The browser's own dictation (webkit `SpeechRecognition`) always uses the system
default; the platform offers no way to choose.

**Speaker.**

| Engine | Context (`AudioContext.setSinkId`) | Elements (`HTMLMediaElement.setSinkId`) | Lists speakers |
|---|---|---|---|
| Chromium 110+ (desktop, Android) | yes | yes | after mic permission |
| Firefox 116+ | no | yes | only via `selectAudioOutput()`, offered as "Choose speaker" |
| Safari, every iOS browser | no | no | no |

The sink is set at context creation (`new AudioContext({ sinkId })`) and
followed live, so everything on the shared context moves with it, including
audio that bypasses the bus. Server speech `<audio>` elements, cues and the
mic-check playback call `applyElementSink()`. speechSynthesis always plays on
the system default.

**iOS.** The OS routes audio. The page explains Control Center → AirPlay rather
than showing a dead picker. Picking the Bluetooth headset's microphone does
work, and iOS then moves playback to the headset's hands-free profile.

**Remembering.** The id and the label are both stored. Chrome keeps ids stable
per origin; Safari rotates them, so a device is found again by label and its
id is refreshed. A remembered device that is not connected is reported ("…is
not connected — using the system default until it is back"). It is not
forgotten: it comes back into use when it reconnects.

`classifyAudioDevice()` guesses Bluetooth, built-in, wired or USB from the
label, because browsers expose no transport type. It is used only for icons
and badges.

## The page

1. **Microphone**: the picker, a live level meter (−60…0 dBFS, with the speech
   band marked), and **Record & play back**. The last records 4 s and plays it
   on the chosen speaker, which checks both directions at once.
2. **Speaker**: the picker or the platform's guidance, plus a test tone.
3. **Agent voice**: the loudness and speed sliders (`cv-level-slider`: centre
   tick, magnetic middle, one-tap reset) and the **speech test**. The test uses
   the engine the session would use (`resolveTtsBackend` on
   `/api/intelligence/audio`). A server clip is synthesized once and replayed
   from memory. With **Repeat while I adjust** on, the sliders apply while it
   plays: loudness glides, and speed re-stretches from the current position.
   Browser voices restart from the last word boundary, because an utterance
   cannot change in flight.

Slider changes call `VoiceSessionService.refreshBrowserTtsOptions()`, so a
running session picks up the new browser rate and base volume on its next line.

## Tests

- `web/src/audio-prefs.test.ts`: the mappings, label text, storage
  normalisation, device matching and classification.
- `web/src/time-stretch.test.ts`: length is input ÷ speed; pitch is kept at
  ½×–2×; no level ripple or clicks at frame joins; streaming in odd chunk sizes
  matches one-shot processing; PCM16 byte carry.
- `web/src/audio-output.test.ts`: the limiter keeps a +12 dB full-scale signal
  under 0 dBFS once the spec's make-up gain is undone.
- `scripts/live-audio-settings-test.mjs`: Playwright against a throwaway bridge
  with Chrome's fake devices. It taps everything that reaches a speaker and
  measures:
  - mic choice, `getUserMedia` constraint and reload persistence
  - the meter and record & play back
  - speaker sink switching
  - −12 dB, default and +12 dB (peak under full scale)
  - 2× and ½× duration with the pitch unchanged
  - a live loudness change during the test
  - a real streamed session reply at 2× and boosted
  - the wake slider saving 0.15

  Run it with:

  ```
  PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/live-audio-settings-test.mjs
  ```

  Set `CHROMIUM_PATH` to use a cached browser, and `SHOTS_DIR` for phone-width
  screenshots.

## Not covered

- The transcript fallback pile in `tts-fallback.ts` speaks browser lines
  without the profile's rate. It predates this change and is owned by another
  lock; it is the rare path for text that arrives with no active playback.
- Agent audio streams (docs/47) connect straight to `ctx.destination`. They
  follow the speaker choice but not the loudness slider until their `output()`
  connects to `getFullLoudnessBus()`, a one-line change once both branches are
  on main.
