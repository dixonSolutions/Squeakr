# 47 — Agent Audio Streams

> Added: October 2026

Until now the agent could only reach the user's ears through `speak()` — text
that the phone (or a call) turns into a voice. This lets the agent pipe **its
own audio** into the session: a chime when a build finishes, a recording it
made, a clip it generated, a live PCM feed from a tool. It is the output
counterpart of the direct audio stream (docs/41), which carries the user's mic
the other way.

```text
# one sound, one call
audio_stream_open({ label: "build chime", mode: "async", volume: 0.4, path: "/tmp/chime.wav", close: true })

# a stream kept open and fed over time
audio_stream_open({ label: "radio", format: { sample_rate: 48000 } })   → { stream_id: "aud_3f9c0a1b2e", … }
audio_stream_write({ stream_id: "aud_3f9c0a1b2e", packet: "<base64 PCM>" })   … many times
audio_stream_close({ stream_ids: ["aud_3f9c0a1b2e"] })
```

Agents take seconds between tool calls, so a one-off sound is a single
`audio_stream_open` with the file and `close: true` — a real Claude Code
agent asked by voice to "play the chime while you tell me the build passed,
then play the recording" used three separate calls per sound before that
existed.

Audio the user should *see and control* — a recording on a card with play,
pause and seek, a video's soundtrack, a file still being rendered — belongs to
the media viewer, `show_media` (docs/48, once merged). Audio streams are the
speaker: no UI, in line with (or under) speech.

## The tools

All five are on the `squeakr` MCP server, so every agent CLI (Cursor, Codex,
Claude Code, Codewhale) has them — nothing here is provider-specific.

| Tool | What it does |
| --- | --- |
| `audio_stream_open(label?, mode?, volume?, format?, log?, path \| url \| data?, close?)` | Opens a stream and returns its `stream_id`. Given a file it writes it in the same call, and with `close: true` closes it once written (it still plays to the end) — a one-shot. A bad path is refused before any stream opens; audio that cannot be decoded closes the stream it opened. `format` (`encoding`, `sample_rate`, `channels`) is needed only for raw packets. Fails with `NO_VOICE_SESSION` when nobody is listening. |
| `audio_stream_write(stream_id, path \| url \| data \| packet)` | Appends audio. `path` / `url` / `data` (base64) are whole files; `packet` is base64 raw PCM in the stream's `format`. Returns once the audio is sent, with its length. |
| `audio_stream_close(stream_ids? \| all, drain?)` | Closes any set of your streams — or all of them — in one call. `drain` (default true) lets what was written finish playing; `false` silences it now. |
| `audio_stream_list(include_closed?, include_log?)` | Your streams: mode, audio written, and what each listener reports (`playing` / `ended` / `stopped` / `error`). |
| `audio_stream_log(stream_ids, note?)` | Reads streams' event logs and, with `note`, adds the agent's own line to them. |

### Queue or async

Each stream chooses how it shares the speaker:

| | **`queue`** (default) | **`async`** |
| --- | --- | --- |
| Joins | when its first audio arrives (an empty stream holds nothing up) | when its first audio arrives |
| Starts | when everything queued ahead of it has played | at once |
| Speech sent after it | waits until it has played | plays over it |
| Other streams | queued ones wait their turn behind it | play alongside it |
| Mic / barge-in | like speech: a barge-in pauses it, a cancel resumes it, a new turn drops it | keeps playing; the direct stream (docs/41) pauses sending while it is audible so the agent never transcribes its own audio |
| Typical use | a recording the user asked to hear | a chime, background audio (use a low `volume`) |

A queued stream is literally a line in the phone's speech queue, so a
barge-in's `tts_interrupt` reports it (`🔊 audio "label" (aud_…)`) in
`heard_complete`, `heard_partial` or `not_spoken` like any sentence.

### Ownership and many streams

Streams belong to the MCP session that opened them: another session can
neither write to nor close them (`NOT_OWNER`). One session can hold up to 16
open streams (48 across the bridge). They are closed for the agent — drained,
so what was written still plays — when its MCP session ends, and after
10 minutes without a write (`close_reason: "idle"`).

### What it accepts

Everything is decoded on the bridge to 24 kHz mono PCM16 — the format
streamed TTS already uses — so every listener plays it the same way.

- **Files** (`path`, `url`, `data`): WAV (16-bit PCM or 32-bit float, any
  rate / channel count) and Ogg/Opus are decoded in code; mp3, flac, m4a,
  webm, Ogg/Vorbis and anything else ffmpeg reads need `ffmpeg` on the
  bridge's PATH. `path` must be under an enabled project or the temp
  directory, like `send_files`. Up to 64 MB per write.
- **Packets** (`packet`): raw interleaved `pcm_s16le` or `pcm_f32le` at the
  rate and channel count given to `audio_stream_open`. Packets can be any
  size and may split a sample — the decoder carries the remainder over.
- A stream carries at most 30 minutes of audio.

Writes to one stream always play in the order they were called, even when an
earlier one (an mp3 through ffmpeg) takes longer to decode than a later one.

## Logging

Every stream keeps an event log — `opened`, each `write` (source, format,
length; packets in aggregate), `write_failed`, `playback` as each listener
reports it, the agent's `note`s, and `closed` with its reason. The agent reads
it with `audio_stream_log` or `audio_stream_list(include_log: true)`; logs of
closed streams are kept (the last 32 per session) until the session ends.

The same events go to the bridge log (`voice:agent-audio`, docs/42). Opening,
closing and notes are also written to the session transcript and shown in
the phone's voice log — unless the stream was opened with `log: false`, which
keeps a chatty stream (a live feed) out of the record the user reads. Packet
writes are left out of the per-call tool log so a feed cannot bury it;
failed ones are still logged.

## Where it plays

- **Phone / PWA** (`web/src/agent-audio.ts`): queued streams join the
  speech queue (`TtsPile`), async ones get their own `PcmScheduler` and gain.
  A stream that is still open but has played everything it was given steps
  aside after 1.5 s — so a stream the agent forgot to close never holds the
  speech after it (or the mic) — and joins again, at the back of the queue,
  when more audio comes.
  Chunks are kept as bytes and scheduled only ~2 s ahead of the playhead, so
  a long clip never sits in memory as decoded audio. With *Agent speech* off,
  streams are not played and are reported `stopped`.
- **Voice calls** (Discord, docs/44): a call has one voice and no mixer, so a
  `queue` stream takes its place among the replies and an `async` one goes to
  the front and plays next — it cannot play under speech there. Talking over
  the agent drops queued streams like queued lines.
- **`squeakr pipe`** prints a line when a stream opens; it does not play
  audio. `--json` shows chunk sizes, not their base64.
- **Chat logs** (Discord / Telegram channels with logs on) get one line per
  stream opened or stopped.

A listener that connects after a stream opened does not pick it up.

## Protocol

On the voice-session broadcast (`/ws`, `/ws/audio-stream` with `listen`,
calls), JSON frames:

| Frame | Meaning |
| --- | --- |
| `{ type: "agent_audio", op: "open", stream_id, label, mode, volume, sample_rate: 24000, encoding: "pcm_s16le", log }` | A stream opened. |
| `{ type: "agent_audio", op: "chunk", stream_id, seq, pcm }` | 250 ms of base64 PCM16LE mono. |
| `{ type: "agent_audio", op: "end", stream_id, reason }` | No more audio; play out what you have. |
| `{ type: "agent_audio", op: "stop", stream_id, reason }` | Silence it now and drop the rest. |

The phone answers on `/ws` with
`{ type: "agent_audio_state", stream_id, state, message? }` —
`playing`, `ended`, `stopped` or `error` — which becomes the stream's
`playback` log entries.

## Code

| Where | What |
| --- | --- |
| `src/voice/agentAudio/decode.ts` | Files and packets → 24 kHz mono PCM16 (WAV / Opus in code, the rest via ffmpeg). |
| `src/voice/agentAudio/streams.ts` | The registry: ownership, ordering, limits, idle close, event logs, frames. |
| `src/mcp/server/audioStreamToolHandlers.ts` | Tool arguments → bytes; the shared registry; playback reports. |
| `web/src/agent-audio.ts` | The phone's player. |
| `src/channels/voiceCall.ts` | Playing streams into a call. |

## Testing

- Unit: `src/voice/agentAudio/*.test.ts`, `web/src/agent-audio.test.ts` and
  the agent audio cases in `src/channels/voiceCall.test.ts` (`npm test`).
- End to end: `node scripts/live-agent-audio-test.mjs` starts a bridge, opens
  two real MCP sessions and impersonates the phone on `/ws`: a WAV file and
  raw packets arrive as 24 kHz chunks in order, the second session cannot
  touch the first one's streams, one call closes several, playback reports and
  notes land in the stream log, a stream left open is drained when its session
  ends, and the bridge log and transcript record it all. Runs in
  `.github/workflows/test.yml`.
- In a real browser: `node scripts/live-pwa-agent-audio-test.mjs` (needs
  Playwright, like `live-pwa-stream-test.mjs`) runs the production PWA in
  headless Chromium and mixes `speak()` lines from the stand-in server voice
  with streams. Using the page's own playback reports it checks that a queue
  stream starts when the line ahead ends, the next line is fetched only after
  it, an async stream starts under speech, packets play, `drain: false` stops
  a clip at once, and a stream left open does not hold later speech.
